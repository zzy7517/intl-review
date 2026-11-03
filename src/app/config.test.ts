import assert from "node:assert/strict"
import { test } from "node:test"

import { loadConfig, parseTargets } from "./config.js"

test("parseTargets 解析仓库和分支", () => {
  const parsed = parseTargets("omiapp/omi-backend:cocome, bad, omiapp/intl-gift:feature/ai")
  assert.deepEqual(parsed.targets, [
    { repo: "omiapp/omi-backend", base: "cocome" },
    { repo: "omiapp/intl-gift", base: "feature/ai" },
  ])
  assert.deepEqual(parsed.ignored, ["bad"])
})

test("off 表示关闭", () => {
  assert.deepEqual(parseTargets("off"), { targets: [], ignored: [] })
})

test("默认起审时间是北京时间 2026-10-28", () => {
  const cfg = loadConfig({})
  assert.equal(cfg.notBefore.toISOString(), "2026-10-27T16:00:00.000Z")
  assert.equal(cfg.targets[0]?.repo, "omiapp/omi-backend")
  assert.equal(cfg.model, "glm-5.3")
  assert.equal(cfg.zhipuBaseUrl, "https://open.bigmodel.cn/api/anthropic")
})
