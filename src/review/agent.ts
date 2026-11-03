import {
  Type,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Provider,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from "@earendil-works/pi-ai"
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy"
import { createProvider } from "@earendil-works/pi-ai/models"
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic"
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript"

import { buildUserPrompt, SYSTEM_PROMPT, SYSTEM_PROMPT_REPO, type PromptInput } from "./prompt.js"

export interface Reviewer {
  review(input: PromptInput): Promise<string>
}

/** 智谱 Anthropic 兼容 provider。模型 id 原样发给对端：直连官方端点用裸 id（glm-5.3）。 */
export function zhipuProvider(options: { apiKey: string; baseUrl?: string; models?: string[] }): Provider {
  const apiKey = options.apiKey.trim()
  if (!apiKey) throw new Error("缺少智谱 API key")
  const baseUrl = options.baseUrl?.trim() || "https://open.bigmodel.cn/api/anthropic"
  const ids = options.models?.length ? options.models : ["glm-5.3"]
  const anthropic = anthropicProvider()
  const all = anthropic.getModels()
  const template = all.find((model) => model.id === "claude-sonnet-5") ?? all[0]!
  return createProvider({
    id: "zhipu",
    name: "Zhipu GLM",
    baseUrl,
    auth: {
      apiKey: {
        name: "Zhipu API key",
        resolve: async () => ({ auth: { headers: { Authorization: `Bearer ${apiKey}` } }, source: "zhipu api key" }),
      },
    },
    models: ids.map((id) => ({ ...template, id, name: id, provider: "zhipu", baseUrl })),
    api: anthropicMessagesApi(),
  })
}

/** pi-ai 工具：声明 + 执行器。 */
export interface ExecutableTool extends Tool {
  run(args: Record<string, unknown>): Promise<string>
}

/** 可视化/审计事件流：每次工具调用、最终报告。App 模式落日志，托管模式额外写 Job Summary。 */
export type AgentTraceEvent =
  | { type: "toolCall"; name: string; args: Record<string, unknown>; result: string; isError: boolean }
  | { type: "report"; text: string }

/**
 * 进程内 agent 循环：system prompt + 用户 prompt（diff），模型可调用只读工具
 * 追进仓库实现，直到给出最终报告。不落盘、不常驻，一次 review 一次循环。
 */
export async function runAgent(options: {
  provider: Provider
  model: Model<string>
  input: PromptInput
  tools?: ExecutableTool[]
  maxTurns?: number
  onTrace?: (event: AgentTraceEvent) => void
}): Promise<string> {
  const tools = options.tools ?? []
  const maxTurns = options.maxTurns ?? 16
  const messages: Message[] = [
    { role: "user", content: [{ type: "text", text: buildUserPrompt(options.input) }], timestamp: Date.now() },
  ]
  for (let turn = 0; turn < maxTurns; turn++) {
    const context: Context = { systemPrompt: tools.length > 0 ? SYSTEM_PROMPT_REPO : SYSTEM_PROMPT, messages, tools }
    const message = await options.provider.stream(options.model, normalizeContext(context)).result()
    messages.push(message)
    if (message.stopReason === "error") throw new Error(message.errorMessage ?? "模型请求失败")
    const calls = message.content.filter((block): block is ToolCall => block.type === "toolCall")
    if (calls.length === 0) {
      const report = reportFrom(message)
      options.onTrace?.({ type: "report", text: report })
      return report
    }
    for (const call of calls) {
      const result = await executeToolCall(tools, call)
      messages.push(result)
      options.onTrace?.({
        type: "toolCall",
        name: call.name,
        args: call.arguments,
        result: resultText(result),
        isError: result.isError === true,
      })
    }
  }
  throw new Error(`agent 超过最大轮数 ${maxTurns}，未给出结论`)
}

function resultText(message: ToolResultMessage): string {
  return message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
}

async function executeToolCall(tools: ExecutableTool[], call: ToolCall): Promise<ToolResultMessage> {
  const tool = tools.find((entry) => entry.name === call.name)
  let text: string
  let isError = false
  if (!tool) {
    text = `未知工具 ${call.name}`
    isError = true
  } else {
    try {
      text = await tool.run(call.arguments)
    } catch (error) {
      text = errText(error)
      isError = true
    }
  }
  return {
    role: "toolResult",
    toolCallId: call.id,
    toolName: call.name,
    content: [{ type: "text", text: text.length > 60_000 ? `${text.slice(0, 60_000)}…（已截断）` : text }],
    isError,
    timestamp: Date.now(),
  }
}

function reportFrom(message: AssistantMessage): string {
  const text = message.content
    .filter((block): block is { type: "text"; text: string } => block.type === "text")
    .map((block) => block.text)
    .join("")
    .trim()
  if (!text) throw new Error(`agent 回复为空 (stopReason=${message.stopReason})`)
  return text
}

/** 组装 Reviewer。workdir 存在时给 agent 只读文件工具（托管模式克隆仓库后用）。 */
export function createAgentReviewer(options: {
  apiKey: string
  baseUrl?: string
  model?: string
  timeoutMs?: number
  workdir?: string
  onTrace?: (event: AgentTraceEvent) => void
}): Reviewer {
  const modelId = options.model?.trim() || "glm-5.3"
  const provider = zhipuProvider({ apiKey: options.apiKey, baseUrl: options.baseUrl, models: [modelId] })
  const model = provider.getModels().find((entry) => entry.id === modelId)
  if (!model) throw new Error(`模型不在 zhipu 列表里: ${modelId}`)
  const tools = options.workdir ? readOnlyFileTools(options.workdir) : []
  const timeoutMs = options.timeoutMs ?? 300_000
  return {
    async review(input: PromptInput): Promise<string> {
      const timer = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error("agent 超时")), timeoutMs)
      })
      return Promise.race([
        runAgent({ provider, model, input, tools, onTrace: options.onTrace }),
        timer,
      ])
    },
  }
}

const MAX_TOOL_OUTPUT = 60_000

/** 只读文件工具集，全部限制在 workdir 内。 */
export function readOnlyFileTools(workdir: string): ExecutableTool[] {
  const readTool: ExecutableTool = {
    name: "read_file",
    description: "读取仓库内一个文件的内容。path 相对仓库根目录。大文件返回会被截断。",
    parameters: Type.Object({
      path: Type.String({ description: "相对仓库根目录的文件路径" }),
      offset: Type.Optional(Type.Integer({ description: "起始行号，1 起" })),
      limit: Type.Optional(Type.Integer({ description: "最多返回的行数" })),
    }),
    async run(args) {
      const target = safeJoin(workdir, String(args.path ?? ""))
      const content = await readFileContent(target)
      const lines = content.split("\n")
      const offset = Math.max(1, Number(args.offset ?? 1))
      const limit = Math.min(2000, Math.max(1, Number(args.limit ?? 500)))
      const sliced = lines.slice(offset - 1, offset - 1 + limit).join("\n")
      return sliced.length > MAX_TOOL_OUTPUT ? `${sliced.slice(0, MAX_TOOL_OUTPUT)}…（已截断）` : sliced
    },
  }
  const grepTool: ExecutableTool = {
    name: "grep",
    description: "在仓库文本文件里按正则搜索，返回 file:行号: 内容。glob 是路径子串过滤，可选。",
    parameters: Type.Object({
      pattern: Type.String({ description: "正则表达式" }),
      glob: Type.Optional(Type.String({ description: "只搜路径包含该子串的文件" })),
    }),
    async run(args) {
      const pattern = String(args.pattern ?? "")
      const glob = typeof args.glob === "string" ? args.glob : ""
      const regex = new RegExp(pattern)
      const hits: string[] = []
      await walkTextFiles(workdir, async (file) => {
        if (glob && !file.includes(glob)) return
        if (hits.length >= 200) return
        const content = await readFileContent(file)
        const relative = file.slice(workdir.length + 1)
        const lines = content.split("\n")
        for (let i = 0; i < lines.length && hits.length < 200; i++) {
          if (regex.test(lines[i])) hits.push(`${relative}:${i + 1}: ${lines[i].trim()}`)
        }
      })
      const out = hits.join("\n")
      return out.length > MAX_TOOL_OUTPUT ? `${out.slice(0, MAX_TOOL_OUTPUT)}…（已截断）` : out || "（无匹配）"
    },
  }
  const listTool: ExecutableTool = {
    name: "list_dir",
    description: "列出仓库内一个目录的直接子项。",
    parameters: Type.Object({
      path: Type.String({ description: "相对仓库根目录的目录路径，根目录用 ." }),
    }),
    async run(args) {
      const target = safeJoin(workdir, String(args.path ?? "."))
      const entries = await readdirSafe(target)
      const lines = entries.slice(0, 500).map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      return lines.join("\n") || "（空目录）"
    },
  }
  return [readTool, grepTool, listTool]
}

import { readdir, readFile, stat } from "node:fs/promises"
import { join, resolve, sep } from "node:path"

const SKIP_DIRS = new Set([".git", "node_modules", "vendor", ".idea", ".venv", "dist"])
const TEXT_EXTENSIONS = new Set([
  ".go", ".ts", ".tsx", ".js", ".jsx", ".py", ".java", ".kt", ".sql", ".proto",
  ".json", ".yaml", ".yml", ".toml", ".xml", ".md", ".txt", ".env", ".mod", ".sum", ".sh", ".cfg", ".ini", "",
])

function safeJoin(workdir: string, relative: string): string {
  const target = resolve(workdir, relative)
  if (target !== workdir && !target.startsWith(workdir + sep)) throw new Error(`路径越界: ${relative}`)
  return target
}

async function readFileContent(file: string): Promise<string> {
  const info = await stat(file)
  if (info.size > 2_000_000) throw new Error(`文件过大 (${info.size} 字节): ${file.slice(-80)}`)
  return readFile(file, "utf8")
}

async function readdirSafe(dir: string) {
  return readdir(dir, { withFileTypes: true })
}

async function walkTextFiles(root: string, visit: (file: string) => Promise<void>): Promise<void> {
  const entries = await readdir(root, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue
    const full = join(root, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walkTextFiles(full, visit)
    } else if (entry.isFile()) {
      const dot = entry.name.lastIndexOf(".")
      const ext = dot >= 0 ? entry.name.slice(dot).toLowerCase() : ""
      if (TEXT_EXTENSIONS.has(ext)) await visit(full)
    }
  }
}

function errText(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause instanceof Error ? ` (${error.cause.message})` : ""
  return `${error.message}${cause}`
}
