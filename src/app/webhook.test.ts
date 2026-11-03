import assert from "node:assert/strict"
import { createHmac } from "node:crypto"
import { test } from "node:test"

import { decideWebhook, verifyGithubSignature } from "./webhook.js"

const targets = [{ repo: "omiapp/omi-backend", base: "cocome" }]
const notBefore = new Date("2026-10-28T00:00:00+08:00")

test("签名不符时拒绝", () => {
  const body = Buffer.from("{}")
  const good = `sha256=${createHmac("sha256", "secret").update(body).digest("hex")}`
  assert.equal(verifyGithubSignature(body, good, "secret"), true)
  assert.equal(verifyGithubSignature(body, good, "other"), false)
  assert.equal(verifyGithubSignature(body, "sha256=00", "secret"), false)
})

test("只接受目标仓库上新建或更新的 PR", () => {
  const opened = decideWebhook("pull_request", payload("opened", "sha-1", "2026-10-28T01:00:00Z"), targets, notBefore)
  assert.equal(opened.action, "review")
  const old = decideWebhook("pull_request", payload("opened", "sha-1", "2026-10-27T00:00:00Z"), targets, notBefore)
  assert.equal(old.action, "ignore")
  const otherBase = decideWebhook(
    "pull_request",
    payload("opened", "sha-1", "2026-10-28T01:00:00Z", "master"),
    targets,
    notBefore,
  )
  assert.equal(otherBase.action, "ignore")
  const closed = decideWebhook("pull_request", payload("closed", "sha-1", "2026-10-28T01:00:00Z"), targets, notBefore)
  assert.equal(closed.action, "ignore")
  const reopened = decideWebhook(
    "pull_request",
    payload("reopened", "sha-1", "2026-10-28T01:00:00Z"),
    targets,
    notBefore,
  )
  assert.equal(reopened.action, "review")
  assert.equal(decideWebhook("ping", {}, targets, notBefore).action, "ping")
})

function payload(action: string, sha: string, createdAt: string, base = "cocome") {
  return {
    action,
    repository: { full_name: "omiapp/omi-backend" },
    pull_request: {
      number: 2,
      title: "t",
      created_at: createdAt,
      head: { sha },
      base: { ref: base },
    },
  }
}
