import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { promisify } from "node:util"

import { GithubClient } from "../github/client.js"
import type { CheckConclusion } from "../github/types.js"
import { createAgentReviewer, type AgentTraceEvent } from "../review/agent.js"
import { buildComment, checkVerdict, reviewMarker } from "../review/comment.js"

const exec = promisify(execFile)

const DEFAULT_ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/anthropic"
const REVIEW_TIMEOUT_MS = 15 * 60_000

/**
 * GitHub 托管模式入口（Actions runner 上执行）：
 * 浅克隆 PR head 到临时目录 → 带只读工具的 agent 审查 → PR 评论 + check run。
 * 环境变量由 .github/workflows/review.yml 注入，模型与端点可在 workflow inputs 配置。
 */
async function main(): Promise<void> {
  const token = requireEnv("GITHUB_TOKEN")
  const repo = requireEnv("GITHUB_REPOSITORY")
  const prNumber = Number(requireEnv("PR_NUMBER"))
  const headSha = requireEnv("HEAD_SHA")
  const baseRef = process.env.BASE_REF?.trim() ?? ""
  const prTitle = process.env.PR_TITLE?.trim() ?? ""
  const apiKey = requireEnv("ZHIPU_API_KEY")
  const baseUrl = process.env.ZHIPU_BASE_URL?.trim() || DEFAULT_ZHIPU_BASE_URL
  const model = process.env.ZHIPU_MODEL?.trim() || "glm-5.3"

  const github = new GithubClient({ token })
  const key = `${repo}#${prNumber}`
  let checkRunId: number | undefined
  let workdir: string | undefined
  try {
    checkRunId = await startCheck(github, repo, headSha)
    const pulled = await github.getPullDiff(repo, prNumber)
    if (!pulled.diff.trim() && pulled.omittedFiles.length === 0) {
      await finishCheck(github, repo, checkRunId, "success", "没有需要审查的 diff", "没有需要审查的 diff")
      console.log(`[intl-review] ${key} 没有 diff，跳过`)
      return
    }
    workdir = await mkdtemp(join(tmpdir(), "intl-review-"))
    await clonePullHead(token, repo, prNumber, workdir)
    const reviewer = createAgentReviewer({
      apiKey,
      baseUrl,
      model,
      timeoutMs: REVIEW_TIMEOUT_MS,
      workdir,
      onTrace: logTrace,
    })
    const report = await reviewer.review({
      repo,
      number: prNumber,
      title: prTitle,
      base: baseRef,
      sha: headSha,
      diff: pulled.diff,
      omittedFiles: pulled.omittedFiles,
    })
    const body = buildComment({ repo, number: prNumber, base: baseRef, sha: headSha, report })
    const marker = reviewMarker(headSha)
    if (!(await github.hasReviewMarker(repo, prNumber, marker))) {
      await github.createReviewComment(repo, prNumber, headSha, body)
    }
    const verdict = checkVerdict(report)
    await finishCheck(github, repo, checkRunId, verdict.conclusion, verdict.title, report)
    console.log(`[intl-review] ${key} ${headSha.slice(0, 8)} 已审查 check=${verdict.conclusion}`)
  } catch (error) {
    const message = errText(error)
    await finishCheck(
      github,
      repo,
      checkRunId,
      "failure",
      `审查未完成: ${message.slice(0, 120)}`,
      `审查基础设施错误，未得出结论：\n\n${message}`,
    )
    console.error(`[intl-review] ${key} 失败: ${message}`)
    process.exitCode = 1
  } finally {
    if (workdir) await rm(workdir, { recursive: true, force: true }).catch(() => undefined)
  }
}

async function clonePullHead(token: string, repo: string, prNumber: number, workdir: string): Promise<void> {
  const origin = `https://x-access-token:${token}@github.com/${repo}.git`
  await exec("git", ["init", "--quiet", workdir])
  await exec("git", ["-C", workdir, "remote", "add", "origin", origin])
  await exec("git", ["-C", workdir, "fetch", "--depth", "1", "--quiet", "origin", `refs/pull/${prNumber}/head`])
  await exec("git", ["-C", workdir, "checkout", "--quiet", "--detach", "FETCH_HEAD"])
  console.log(`[intl-review] 已克隆 ${repo}#${prNumber} 的 head 到 ${workdir}`)
}

/** check run 创建失败（权限未开等）不阻断评论流程。 */
async function startCheck(github: GithubClient, repo: string, headSha: string): Promise<number | undefined> {
  try {
    return await github.startCheckRun(repo, headSha)
  } catch (error) {
    console.log(`[intl-review] check run 创建失败，退化为仅评论: ${errText(error)}`)
    return undefined
  }
}

async function finishCheck(
  github: GithubClient,
  repo: string,
  checkRunId: number | undefined,
  conclusion: CheckConclusion,
  title: string,
  summary: string,
): Promise<void> {
  if (!checkRunId) return
  try {
    await github.finishCheckRun(repo, checkRunId, conclusion, title, summary)
  } catch (error) {
    console.log(`[intl-review] check run 收尾失败: ${errText(error)}`)
  }
}

/**
 * agent 执行过程打进 Actions 日志，run 页面实时可见：
 * 每次工具调用一个可折叠分组（::group::），出错不折叠、带 ⚠️ 前缀，方便一眼扫到。
 */
function logTrace(event: AgentTraceEvent): void {
  if (event.type !== "toolCall") return
  const args = JSON.stringify(event.args)
  if (event.isError) {
    console.log(`⚠️ ${event.name} ${args} 出错:`)
    console.log(event.result.slice(0, 4000))
    return
  }
  console.log(`::group::${event.name} ${args}`)
  console.log(event.result.slice(0, 4000))
  console.log("::endgroup::")
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`缺少环境变量 ${name}`)
  return value
}

function errText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : ""
  return `${error.message}${cause}`
}

void main()
