import type { Config } from "./config.js"
import type { CheckConclusion, Github, PullRequest } from "../github/types.js"
import { buildComment, checkVerdict, reviewMarker } from "../review/comment.js"
import type { Reviewer } from "../review/agent.js"
import type { Store } from "./store.js"

export type ReviewOutcome = "reviewed" | "skipped" | "duplicate" | "failed" | "ignored"

export class ReviewService {
  private readonly inflight = new Set<string>()

  constructor(
    private readonly cfg: Pick<Config, "notBefore">,
    private readonly github: Github,
    private readonly reviewer: Reviewer,
    private readonly store: Store,
    private readonly log: (message: string) => void = console.log,
  ) {}

  resumeIncomplete(): void {
    for (const row of this.store.listReceived()) {
      void this.review(row.repo, {
        number: row.prNumber,
        title: "",
        headSha: row.headSha,
        baseRef: row.baseRef,
        createdAt: new Date(this.cfg.notBefore.getTime() + 1).toISOString(),
      }).catch((error) => this.log(`[intl-review] 续跑失败: ${error}`))
    }
  }

  async review(repo: string, pr: PullRequest): Promise<ReviewOutcome> {
    const created = Date.parse(pr.createdAt)
    if (Number.isNaN(created) || created <= this.cfg.notBefore.getTime()) return "ignored"
    const flight = `${repo}#${pr.number}@${pr.headSha}`
    if (this.inflight.has(flight)) return "duplicate"
    this.inflight.add(flight)
    const key = `${repo}#${pr.number}`
    let checkRunId: number | undefined
    try {
      if (this.store.begin({ repo, prNumber: pr.number, headSha: pr.headSha, baseRef: pr.baseRef }) === "skip") {
        return "duplicate"
      }
      checkRunId = await this.beginCheck(repo, pr.headSha)
      const pulled = await this.github.getPullDiff(repo, pr.number)
      if (!pulled.diff.trim() && pulled.omittedFiles.length === 0) {
        this.store.finish(repo, pr.number, pr.headSha, "skipped", "没有需要审查的 diff")
        await this.endCheck(repo, checkRunId, "success", "没有需要审查的 diff", "没有需要审查的 diff")
        this.log(`[intl-review] ${key} 跳过，没有需要审查的 diff`)
        return "skipped"
      }
      const report = await this.reviewer.review({
        repo,
        number: pr.number,
        title: pr.title,
        base: pr.baseRef || "",
        sha: pr.headSha,
        diff: pulled.diff,
        omittedFiles: pulled.omittedFiles,
      })
      const body = buildComment({
        repo,
        number: pr.number,
        base: pr.baseRef,
        sha: pr.headSha,
        report,
      })
      const marker = reviewMarker(pr.headSha)
      if (!(await this.github.hasReviewMarker(repo, pr.number, marker))) {
        await this.github.createReviewComment(repo, pr.number, pr.headSha, body)
      }
      const verdict = checkVerdict(report)
      await this.endCheck(repo, checkRunId, verdict.conclusion, verdict.title, report)
      this.store.finish(repo, pr.number, pr.headSha, "done", report)
      this.log(`[intl-review] ${key} ${pr.headSha.slice(0, 8)} 已审查 check=${verdict.conclusion}`)
      return "reviewed"
    } catch (error) {
      const message = errText(error)
      await this.endCheck(
        repo,
        checkRunId,
        "failure",
        `审查未完成: ${message.slice(0, 120)}`,
        `审查基础设施错误，未得出结论：\n\n${message}`,
      )
      try {
        this.store.finish(repo, pr.number, pr.headSha, "failed", "", message)
      } catch (finishError) {
        this.log(`[intl-review] 写入失败状态也失败了: ${finishError}`)
      }
      this.log(`[intl-review] ${key} 失败: ${message}`)
      return "failed"
    } finally {
      this.inflight.delete(flight)
    }
  }

  /** check run 创建失败（App 没开 Checks 权限等）不阻断评论流程。 */
  private async beginCheck(repo: string, headSha: string): Promise<number | undefined> {
    try {
      return await this.github.startCheckRun(repo, headSha)
    } catch (error) {
      this.log(`[intl-review] check run 创建失败，退化为仅评论: ${errText(error)}`)
      return undefined
    }
  }

  private async endCheck(
    repo: string,
    checkRunId: number | undefined,
    conclusion: CheckConclusion,
    title: string,
    summary: string,
  ): Promise<void> {
    if (!checkRunId) return
    try {
      await this.github.finishCheckRun(repo, checkRunId, conclusion, title, summary)
    } catch (error) {
      this.log(`[intl-review] check run 收尾失败: ${errText(error)}`)
    }
  }
}

function errText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : ""
  return `${error.message}${cause}`
}
