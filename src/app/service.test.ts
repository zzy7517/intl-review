import assert from "node:assert/strict"
import { test } from "node:test"

import type { Github, PullDiff, PullRequest } from "../github/types.js"
import type { Reviewer } from "../review/agent.js"
import { ReviewService } from "./service.js"
import { openStore } from "./store.js"

const notBefore = new Date("2026-10-28T00:00:00+08:00")

test("同一 sha 不重复评论；新 sha 再审；过早的 PR 忽略", async () => {
  const github = fakeGithub()
  const service = new ReviewService({ notBefore }, github, fakeReviewer("### 结论\n发现 1 处。"), openStore(":memory:"), () => {})

  assert.equal(await service.review("omiapp/omi-backend", pr(2, "sha-1", "2026-10-27T00:00:00Z")), "ignored")
  assert.equal(github.diffs, 0)

  assert.equal(await service.review("omiapp/omi-backend", pr(2, "sha-1", "2026-10-28T01:00:00Z")), "reviewed")
  assert.equal(await service.review("omiapp/omi-backend", pr(2, "sha-1", "2026-10-28T01:00:00Z")), "duplicate")
  assert.equal(github.diffs, 1)
  assert.match(github.bodies[0] ?? "", /encrypt-review sha-1/)

  assert.equal(await service.review("omiapp/omi-backend", pr(2, "sha-2", "2026-10-28T02:00:00Z")), "reviewed")
  assert.equal(github.diffs, 2)
})

test("agent 失败记 failed，下次回调不再打", async () => {
  const github = fakeGithub()
  const reviewer: Reviewer = {
    review: async () => {
      throw new Error("model down")
    },
  }
  const service = new ReviewService({ notBefore }, github, reviewer, openStore(":memory:"), () => {})
  const pull = pr(3, "sha-3", "2026-10-28T01:00:00Z")
  assert.equal(await service.review("omiapp/omi-backend", pull), "failed")
  assert.equal(github.bodies.length, 0)
  assert.equal(await service.review("omiapp/omi-backend", pull), "duplicate")
  assert.equal(github.diffs, 1)
  assert.deepEqual(github.conclusions, ["failure"])
})

test("check run 结论随报告变化：未发现问题 success，发现 N 处 failure，证据不足 neutral", async () => {
  const cases: [string, string][] = [
    ["### 结论\n未发现问题。", "success"],
    ["### 结论\n发现 2 处敏感数据疑似在未加密的情况下被持久化或外发。", "failure"],
    ["### 结论\n证据不足，无法判断。", "neutral"],
  ]
  for (const [report, expected] of cases) {
    const github = fakeGithub()
    const service = new ReviewService({ notBefore }, github, fakeReviewer(report), openStore(":memory:"), () => {})
    assert.equal(await service.review("omiapp/omi-backend", pr(4, `sha-${expected}`, "2026-10-28T01:00:00Z")), "reviewed")
    assert.deepEqual(github.conclusions, [expected])
  }
})

function pr(number: number, sha: string, createdAt: string): PullRequest {
  return { number, title: "t", headSha: sha, baseRef: "cocome", createdAt }
}

function fakeReviewer(report: string): Reviewer {
  return { review: async () => report }
}

function fakeGithub(): Github & { diffs: number; bodies: string[]; conclusions: string[] } {
  return {
    diffs: 0,
    bodies: [],
    conclusions: [],
    async getPullDiff(): Promise<PullDiff> {
      this.diffs++
      return { diff: "+ email := in.Email\n", omittedFiles: [] }
    },
    async hasReviewMarker(_repo, _number, marker) {
      return this.bodies.some((body) => body.includes(marker))
    },
    async createReviewComment(_repo, _number, _sha, body) {
      this.bodies.push(body)
    },
    async startCheckRun() {
      return 1
    },
    async finishCheckRun(_repo, _id, conclusion) {
      this.conclusions.push(conclusion)
    },
  }
}
