import assert from "node:assert/strict"
import { test } from "node:test"

import { openStore } from "./store.js"

test("同一 head 成功或失败后不再重跑，没跑完的会续跑", () => {
  const store = openStore(":memory:")
  const key = { repo: "omiapp/omi-backend", prNumber: 1, headSha: "aaa", baseRef: "cocome" }
  assert.equal(store.begin(key), "run")
  assert.equal(store.begin(key), "run")
  store.finish(key.repo, key.prNumber, key.headSha, "failed", "", "boom")
  assert.equal(store.begin(key), "skip")
  assert.equal(store.begin({ ...key, headSha: "bbb" }), "run")
})
