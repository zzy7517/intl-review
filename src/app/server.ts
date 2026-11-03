import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { timingSafeEqual } from "node:crypto"

import type { Target } from "./config.js"
import { decideWebhook, verifyGithubSignature } from "./webhook.js"
import type { ReviewService } from "./service.js"
import type { Store } from "./store.js"

export function startServer(options: {
  host: string
  port: number
  token: string
  webhookSecret: string
  targets: Target[]
  notBefore: Date
  service: ReviewService
  store: Store
}): Promise<ReturnType<typeof createServer>> {
  const server = createServer(async (req, res) => {
    try {
      await route(req, res, options)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      send(res, 500, { message })
    }
  })
  return new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, options.host, () => resolve(server))
  })
}

async function route(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    token: string
    webhookSecret: string
    targets: Target[]
    notBefore: Date
    service: ReviewService
    store: Store
  },
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1")
  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, { ok: true })
    return
  }
  if (req.method === "POST" && url.pathname === "/v1/github/webhook") {
    await webhook(req, res, options)
    return
  }
  if (!authorized(req, options.token)) {
    send(res, 401, { message: "unauthorized" })
    return
  }
  if (req.method === "GET" && url.pathname === "/v1/reviews") {
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get("limit") ?? "50") || 50))
    send(res, 200, options.store.list(limit))
    return
  }
  send(res, 404, { message: "not found" })
}

async function webhook(
  req: IncomingMessage,
  res: ServerResponse,
  options: {
    webhookSecret: string
    targets: Target[]
    notBefore: Date
    service: ReviewService
  },
): Promise<void> {
  const raw = await readBody(req)
  const signature = header(req, "x-hub-signature-256")
  if (!verifyGithubSignature(raw, signature, options.webhookSecret)) {
    send(res, 401, { message: "invalid signature" })
    return
  }
  let payload: unknown
  try {
    payload = JSON.parse(raw.toString("utf8"))
  } catch {
    send(res, 400, { message: "invalid json" })
    return
  }
  const decision = decideWebhook(header(req, "x-github-event") ?? "", payload, options.targets, options.notBefore)
  if (decision.action !== "review") {
    send(res, 200, { ok: true, action: decision.action, reason: "reason" in decision ? decision.reason : "" })
    return
  }
  send(res, 202, { accepted: true, repo: decision.repo, pr: decision.pr.number, sha: decision.pr.headSha })
  void options.service.review(decision.repo, decision.pr).catch((error) => {
    console.error("[intl-review] webhook review", error)
  })
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => {
      chunks.push(chunk)
      if (chunks.reduce((sum, item) => sum + item.length, 0) > 2_000_000) {
        reject(new Error("webhook body 过大"))
      }
    })
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name]
  return Array.isArray(value) ? value[0] : value
}

function authorized(req: IncomingMessage, token: string): boolean {
  if (!token) return true
  const header = req.headers["x-review-token"]
  const given = Array.isArray(header) ? header[0] : header
  if (!given) return false
  const left = Buffer.from(given)
  const right = Buffer.from(token)
  if (left.length !== right.length) return false
  return timingSafeEqual(left, right)
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" })
  res.end(payload)
}
