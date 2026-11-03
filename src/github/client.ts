import { createAppJwt } from "./jwt.js"
import { patchesToDiff, type PullFile } from "../review/diff.js"
import type { CheckConclusion, Github, PullDiff } from "./types.js"

const API_VERSION = "2022-11-28"

type Token = { value: string; expiresAt: number }

export type GithubClientOptions = {
  /** GitHub App 模式：App 凭据换 installation token。 */
  appId?: string
  privateKey?: string
  installationId?: string
  /** GitHub 托管模式：直接注入现成 token（如 Actions 的 GITHUB_TOKEN），跳过 App 认证。 */
  token?: string
  apiBase?: string
  fetch?: typeof fetch
}

export class GithubClient implements Github {
  private readonly apiBase: string
  private readonly fetchImpl: typeof fetch
  private readonly staticToken: string
  private installationId: string
  private token: Token | undefined

  constructor(private readonly options: GithubClientOptions) {
    this.apiBase = (options.apiBase ?? "https://api.github.com").replace(/\/$/, "")
    this.fetchImpl = options.fetch ?? fetch
    this.staticToken = options.token?.trim() ?? ""
    this.installationId = options.installationId?.trim() ?? ""
  }

  async getPullDiff(repo: string, number: number): Promise<PullDiff> {
    const files: PullFile[] = []
    for (let page = 1; page <= 20; page++) {
      const batch = await this.installationJson<unknown[]>(
        "GET",
        `/repos/${repoPath(repo)}/pulls/${number}/files?per_page=100&page=${page}`,
      )
      if (!Array.isArray(batch) || batch.length === 0) break
      for (const item of batch) {
        const file = asRecord(item)
        if (typeof file.filename !== "string") continue
        files.push({
          filename: file.filename,
          status: typeof file.status === "string" ? file.status : "",
          patch: typeof file.patch === "string" ? file.patch : null,
        })
      }
      if (batch.length < 100) break
    }
    return patchesToDiff(files)
  }

  async hasReviewMarker(repo: string, number: number, marker: string): Promise<boolean> {
    for (let page = 1; page <= 3; page++) {
      const batch = await this.installationJson<unknown[]>(
        "GET",
        `/repos/${repoPath(repo)}/pulls/${number}/reviews?per_page=100&page=${page}`,
      )
      if (!Array.isArray(batch) || batch.length === 0) return false
      for (const item of batch) {
        const review = asRecord(item)
        if (typeof review.body === "string" && review.body.includes(marker)) return true
      }
      if (batch.length < 100) return false
    }
    return false
  }

  async createReviewComment(repo: string, number: number, headSha: string, body: string): Promise<void> {
    await this.installationJson("POST", `/repos/${repoPath(repo)}/pulls/${number}/reviews`, {
      commit_id: headSha,
      body,
      event: "COMMENT",
    })
  }

  async startCheckRun(repo: string, headSha: string): Promise<number> {
    const created = await this.installationJson<{ id: number }>(
      "POST",
      `/repos/${repoPath(repo)}/check-runs`,
      { name: "intl-review", head_sha: headSha, status: "in_progress" },
    )
    return created.id
  }

  async finishCheckRun(
    repo: string,
    checkRunId: number,
    conclusion: CheckConclusion,
    title: string,
    summary: string,
  ): Promise<void> {
    await this.installationJson("PATCH", `/repos/${repoPath(repo)}/check-runs/${checkRunId}`, {
      status: "completed",
      conclusion,
      output: { title, summary: summary.length > 60_000 ? `${summary.slice(0, 60_000)}…` : summary },
    })
  }

  private async installationJson<T>(method: string, path: string, body?: unknown): Promise<T> {
    const token = await this.installationToken(path)
    return this.request<T>(method, path, token, body)
  }

  private async installationToken(path: string): Promise<string> {
    if (this.staticToken) return this.staticToken
    const now = Date.now()
    if (this.token && this.token.expiresAt - 60_000 > now) return this.token.value
    if (!this.installationId) {
      const repo = repoFromPath(path)
      if (!repo) throw new Error("无法从请求路径解析仓库，不能查找 installation")
      const found = await this.request<{ id: number }>(
        "GET",
        `/repos/${repoPath(repo)}/installation`,
        createAppJwt(this.options.appId ?? "", this.options.privateKey ?? ""),
      )
      this.installationId = String(found.id)
    }
    const issued = await this.request<{ token: string; expires_at: string }>(
      "POST",
      `/app/installations/${this.installationId}/access_tokens`,
      createAppJwt(this.options.appId ?? "", this.options.privateKey ?? ""),
    )
    const expiresAt = Date.parse(issued.expires_at)
    this.token = {
      value: issued.token,
      expiresAt: Number.isNaN(expiresAt) ? now + 50 * 60_000 : expiresAt,
    }
    return this.token.value
  }

  private async request<T>(method: string, path: string, token: string, body?: unknown): Promise<T> {
    let response: Response
    try {
      response = await this.fetchImpl(`${this.apiBase}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": "intl-review",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? ` (${error.cause.message})` : ""
      throw new Error(`GitHub 请求失败 ${method} ${path}: ${errText(error)}${cause}`)
    }
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`GitHub ${response.status} ${method} ${path}: ${text.slice(0, 300)}`)
    }
    if (!text) return undefined as T
    return JSON.parse(text) as T
  }
}

function repoPath(repo: string): string {
  const slash = repo.indexOf("/")
  const owner = repo.slice(0, slash)
  const name = repo.slice(slash + 1)
  if (!owner || !name || name.includes("/")) throw new Error(`非法仓库名 ${repo}`)
  return `${encodeURIComponent(owner)}/${encodeURIComponent(name)}`
}

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function repoFromPath(path: string): string | undefined {
  const match = /^\/repos\/([^/]+)\/([^/]+)\//.exec(path)
  if (!match) return undefined
  return `${decodeURIComponent(match[1])}/${decodeURIComponent(match[2])}`
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}
