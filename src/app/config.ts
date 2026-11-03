import { readFileSync } from "node:fs"

export const DEFAULT_TARGETS = "omiapp/omi-backend:cocome"
export const DEFAULT_NOT_BEFORE = "2026-10-28T00:00:00+08:00"
export const DEFAULT_MODEL = "glm-5.3"
export const DEFAULT_ZHIPU_BASE_URL = "https://open.bigmodel.cn/api/anthropic"

export type Target = { repo: string; base: string }

export type Config = {
  appId: string
  installationId: string
  privateKey: string
  targets: Target[]
  ignoredTargets: string[]
  notBefore: Date
  timeoutMs: number
  webhookSecret: string
  listenHost: string
  listenPort: number
  token: string
  databasePath: string
  zhipuApiKey: string
  zhipuBaseUrl: string
  model: string
}

export function parseTargets(raw: string): { targets: Target[]; ignored: string[] } {
  const trimmed = raw.trim()
  if (trimmed === "" || /^(off|none)$/i.test(trimmed)) return { targets: [], ignored: [] }
  const targets: Target[] = []
  const ignored: string[] = []
  for (const piece of trimmed.split(",")) {
    const part = piece.trim()
    if (!part) continue
    const colon = part.indexOf(":")
    const repo = colon >= 0 ? part.slice(0, colon).trim() : ""
    const base = colon >= 0 ? part.slice(colon + 1).trim() : ""
    if (!repo.includes("/") || !base) {
      ignored.push(part)
      continue
    }
    targets.push({ repo, base })
  }
  return { targets, ignored }
}

export function normalizePem(raw: string): string {
  const text = raw.trim()
  if (text.includes("BEGIN") && text.includes("\\n")) return text.replace(/\\n/g, "\n")
  return text
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const appId = env.GITHUB_APP_ID?.trim() ?? ""
  const installationId = env.GITHUB_APP_INSTALLATION_ID?.trim() ?? ""
  const keyFile = env.GITHUB_APP_PRIVATE_KEY_FILE?.trim()
  const inlineKey = env.GITHUB_APP_PRIVATE_KEY
  let privateKey = ""
  if (keyFile) privateKey = normalizePem(readFileSync(keyFile, "utf8"))
  else if (inlineKey) privateKey = normalizePem(inlineKey)

  const parsed = parseTargets(env.REVIEW_TARGETS ?? DEFAULT_TARGETS)
  const notBefore = new Date(env.REVIEW_NOT_BEFORE?.trim() || DEFAULT_NOT_BEFORE)
  if (Number.isNaN(notBefore.getTime())) {
    throw new Error(`REVIEW_NOT_BEFORE 无法解析: ${env.REVIEW_NOT_BEFORE}`)
  }

  const timeoutSeconds = Number(env.REVIEW_TIMEOUT_SECONDS ?? "300")
  const listen = (env.REVIEW_LISTEN ?? "127.0.0.1:8788").trim()
  const colon = listen.lastIndexOf(":")
  const listenHost = colon > 0 ? listen.slice(0, colon) : "127.0.0.1"
  const listenPort = Number(colon > 0 ? listen.slice(colon + 1) : listen)

  return {
    appId,
    installationId,
    privateKey,
    targets: parsed.targets,
    ignoredTargets: parsed.ignored,
    notBefore,
    timeoutMs: Math.max(30, Number.isFinite(timeoutSeconds) ? timeoutSeconds : 300) * 1000,
    webhookSecret: env.GITHUB_WEBHOOK_SECRET ?? "",
    listenHost,
    listenPort: Number.isFinite(listenPort) && listenPort > 0 ? listenPort : 8788,
    token: env.REVIEW_TOKEN?.trim() ?? "",
    databasePath: env.DATABASE_PATH?.trim() || "data/intl-review.sqlite",
    zhipuApiKey: env.ZHIPU_API_KEY?.trim() ?? "",
    zhipuBaseUrl: env.ZHIPU_BASE_URL?.trim() || DEFAULT_ZHIPU_BASE_URL,
    model: env.PI_MODEL?.trim() || DEFAULT_MODEL,
  }
}

export function assertRunnable(cfg: Config): void {
  if (!cfg.webhookSecret) throw new Error("缺少 GITHUB_WEBHOOK_SECRET")
  if (!cfg.appId) throw new Error("缺少 GITHUB_APP_ID")
  if (!cfg.privateKey.includes("BEGIN")) throw new Error("缺少 GitHub App 私钥")
  if (cfg.targets.length === 0) throw new Error("REVIEW_TARGETS 为空")
  if (!cfg.zhipuApiKey) throw new Error("缺少 ZHIPU_API_KEY")
  if (!cfg.model) throw new Error("缺少 PI_MODEL")
}
