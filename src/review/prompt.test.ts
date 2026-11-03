import assert from "node:assert/strict"
import { test } from "node:test"

import { SYSTEM_PROMPT, buildUserPrompt } from "./prompt.js"

test("审查说明不指定加密函数名", () => {
  assert.doesNotMatch(SYSTEM_PROMPT, /EncryptField|aes256/)
  assert.match(SYSTEM_PROMPT, /不要预设/)
})

test("超长 diff 会截断并告诉 agent", () => {
  const prompt = buildUserPrompt({
    repo: "omiapp/omi-backend",
    number: 1,
    title: "t",
    base: "cocome",
    sha: "abc",
    diff: "x".repeat(100_001),
    omittedFiles: ["gone.go"],
  })
  assert.match(prompt, /截断/)
  assert.match(prompt, /gone\.go/)
  assert.ok(prompt.length < 100_001 + 2000)
})
