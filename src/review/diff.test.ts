import assert from "node:assert/strict"
import { test } from "node:test"

import { patchesToDiff } from "./diff.js"

test("patch 拼成 diff，测试文件和缺失 patch 分开", () => {
  const built = patchesToDiff([
    { filename: "a.go", status: "modified", patch: "@@ -1 +1,2 @@\n context\n+added" },
    { filename: "a_test.go", status: "modified", patch: "@@ -1 +1 @@\n+t" },
    { filename: "big.go", status: "modified", patch: null },
    { filename: "pic.png", status: "added", patch: null },
  ])
  assert.match(built.diff, /a\.go/)
  assert.doesNotMatch(built.diff, /a_test\.go/)
  assert.deepEqual(built.omittedFiles, ["big.go"])
})
