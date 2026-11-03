import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { Type } from "@earendil-works/pi-ai"
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux"

import {
  createAgentReviewer,
  readOnlyFileTools,
  runAgent,
  type AgentTraceEvent,
  type ExecutableTool,
} from "./agent.js"
import type { PromptInput } from "./prompt.js"

const input: PromptInput = {
  repo: "omiapp/demo",
  number: 7,
  title: "测试 PR",
  base: "main",
  sha: "abc123",
  diff: "+INSERT INTO users (phone) VALUES ($1)",
  omittedFiles: [],
}

const echoTool: ExecutableTool = {
  name: "echo",
  description: "测试用回显工具",
  parameters: Type.Object({ text: Type.String() }),
  async run(args) {
    return `echo:${String(args.text)}`
  },
}

type ToolCallEvent = Extract<AgentTraceEvent, { type: "toolCall" }>

describe("runAgent", () => {
  it("工具轮次后给出报告，onTrace 事件完整", async () => {
    const faux = fauxProvider()
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { text: "hi" })]),
      fauxAssistantMessage("### 结论\n未发现问题。"),
    ])
    const events: AgentTraceEvent[] = []
    const report = await runAgent({
      provider: faux.provider,
      model: faux.getModel(),
      input,
      tools: [echoTool],
      onTrace: (event) => events.push(event),
    })
    assert.equal(report, "### 结论\n未发现问题。")
    const toolEvents = events.filter((event): event is ToolCallEvent => event.type === "toolCall")
    assert.equal(toolEvents.length, 1)
    assert.equal(toolEvents[0]!.name, "echo")
    assert.equal(toolEvents[0]!.result, "echo:hi")
    assert.equal(toolEvents[0]!.isError, false)
    assert.equal(events.at(-1)?.type, "report")
  })

  it("stopReason=error 时抛出模型错误", async () => {
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage("x", { stopReason: "error", errorMessage: "模型过载" })])
    await assert.rejects(
      runAgent({ provider: faux.provider, model: faux.getModel(), input }),
      /模型过载/,
    )
  })

  it("空回复抛错", async () => {
    const faux = fauxProvider()
    faux.setResponses([fauxAssistantMessage("")])
    await assert.rejects(
      runAgent({ provider: faux.provider, model: faux.getModel(), input }),
      /agent 回复为空/,
    )
  })

  it("超过最大轮数抛错", async () => {
    const faux = fauxProvider()
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall("echo", { text: "1" })]),
      fauxAssistantMessage([fauxToolCall("echo", { text: "2" })]),
      fauxAssistantMessage([fauxToolCall("echo", { text: "3" })]),
    ])
    await assert.rejects(
      runAgent({ provider: faux.provider, model: faux.getModel(), input, tools: [echoTool], maxTurns: 2 }),
      /超过最大轮数/,
    )
  })

  it("空 API key 在组装 reviewer 时就抛错", () => {
    assert.throws(() => createAgentReviewer({ apiKey: "  " }), /缺少智谱 API key/)
  })
})

describe("readOnlyFileTools", () => {
  it("read/grep/list 全部限制在 workdir 内", async () => {
    const dir = await mkdtemp(join(tmpdir(), "intl-review-agent-"))
    try {
      await writeFile(join(dir, "a.go"), "hello\nphone = 1\n")
      await mkdir(join(dir, "sub"))
      await writeFile(join(dir, "sub", "b.go"), "email = 2\n")
      const tools = new Map(readOnlyFileTools(dir).map((tool) => [tool.name, tool]))
      const read = tools.get("read_file")!
      const grep = tools.get("grep")!
      const list = tools.get("list_dir")!

      assert.match(await read.run({ path: "a.go" }), /phone = 1/)
      assert.equal(await read.run({ path: "a.go", offset: 2, limit: 1 }), "phone = 1")
      assert.match(await read.run({ path: "sub/b.go" }), /email = 2/)
      assert.match(await grep.run({ pattern: "phone" }), /a\.go:2: phone = 1/)
      assert.doesNotMatch(await grep.run({ pattern: "email", glob: "a.go" }), /b\.go/)
      assert.equal(await grep.run({ pattern: "不存在的词xyz" }), "（无匹配）")

      const listed = (await list.run({ path: "." })).split("\n")
      assert.deepEqual(listed.sort(), ["a.go", "sub/"])
      assert.equal(await list.run({ path: "sub" }), "b.go")

      await assert.rejects(read.run({ path: "../escape" }), /路径越界/)
      await assert.rejects(read.run({ path: "missing.go" }), /ENOENT/)
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
})
