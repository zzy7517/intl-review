import { loadConfig, assertRunnable } from "./config.js"
import { GithubClient } from "../github/client.js"
import { loadDotEnv } from "./load-env.js"
import { createAgentReviewer } from "../review/agent.js"
import { startServer } from "./server.js"
import { ReviewService } from "./service.js"
import { openStore } from "./store.js"

loadDotEnv()
const cfg = loadConfig()
for (const ignored of cfg.ignoredTargets) {
  console.log(`[intl-review] 忽略无效审查目标 ${ignored}`)
}
assertRunnable(cfg)

const store = openStore(cfg.databasePath)
const github = new GithubClient({
  appId: cfg.appId,
  privateKey: cfg.privateKey,
  installationId: cfg.installationId,
})
const reviewer = createAgentReviewer({
  apiKey: cfg.zhipuApiKey,
  baseUrl: cfg.zhipuBaseUrl,
  model: cfg.model,
  timeoutMs: cfg.timeoutMs,
})
const service = new ReviewService(cfg, github, reviewer, store)

const server = await startServer({
  host: cfg.listenHost,
  port: cfg.listenPort,
  token: cfg.token,
  webhookSecret: cfg.webhookSecret,
  targets: cfg.targets,
  notBefore: cfg.notBefore,
  service,
  store,
})
console.log(
  `[intl-review] ${cfg.listenHost}:${cfg.listenPort} webhook=/v1/github/webhook model=${cfg.model} targets=${cfg.targets.map((t) => `${t.repo}:${t.base}`).join(",")}`,
)
service.resumeIncomplete()

async function shutdown() {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  process.exit(0)
}
process.on("SIGINT", () => void shutdown())
process.on("SIGTERM", () => void shutdown())
