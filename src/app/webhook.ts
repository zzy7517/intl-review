import { createHmac, timingSafeEqual } from "node:crypto"

import type { Target } from "./config.js"
import type { PullRequest } from "../github/types.js"

export type WebhookDecision =
  | { action: "ping" }
  | { action: "ignore"; reason: string }
  | { action: "review"; repo: string; pr: PullRequest }

const REVIEW_ACTIONS = new Set(["opened", "synchronize", "reopened"])

export function verifyGithubSignature(body: Buffer, signature: string | undefined, secret: string): boolean {
  if (!signature?.startsWith("sha256=") || !secret) return false
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`)
  const given = Buffer.from(signature)
  if (expected.length !== given.length) return false
  return timingSafeEqual(expected, given)
}

export function decideWebhook(
  event: string,
  payload: unknown,
  targets: Target[],
  notBefore: Date,
): WebhookDecision {
  if (event === "ping") return { action: "ping" }
  if (event !== "pull_request") return { action: "ignore", reason: `忽略事件 ${event || "unknown"}` }

  const body = asRecord(payload)
  const action = typeof body.action === "string" ? body.action : ""
  if (!REVIEW_ACTIONS.has(action)) return { action: "ignore", reason: `忽略 pull_request.${action || "unknown"}` }

  const repository = asRecord(body.repository)
  const pull = asRecord(body.pull_request)
  const head = asRecord(pull.head)
  const base = asRecord(pull.base)
  const repo = typeof repository.full_name === "string" ? repository.full_name : ""
  const baseRef = typeof base.ref === "string" ? base.ref : ""
  const sha = typeof head.sha === "string" ? head.sha : ""
  const number = typeof pull.number === "number" ? pull.number : 0
  const createdAt = typeof pull.created_at === "string" ? pull.created_at : ""
  if (!repo || !number || !sha || !baseRef) return { action: "ignore", reason: "回调缺少仓库、PR 号或 head sha" }
  if (!targets.some((target) => target.repo === repo && target.base === baseRef)) {
    return { action: "ignore", reason: `${repo}@${baseRef} 不在审查目标里` }
  }
  const created = Date.parse(createdAt)
  if (Number.isNaN(created) || created <= notBefore.getTime()) {
    return { action: "ignore", reason: "PR 创建时间早于起审时间" }
  }
  return {
    action: "review",
    repo,
    pr: {
      number,
      title: typeof pull.title === "string" ? pull.title : "",
      headSha: sha,
      baseRef,
      createdAt,
    },
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {}
}
