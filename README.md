# intl-review

PR 敏感数据加密审查。只回答一个问题：新增代码里，敏感数据（手机号、邮箱、精确地理位置、IP、设备标识、住址、私信内容、社交账号、支付令牌、push token 等）在进入持久化或外发之前，有没有经过**真正的加密**。结论写成 PR 评论，并落一个 `intl-review` check run。

加密函数不写死：代码里出现什么调用，由 agent 自己判断那是不是密码学操作。字段名、注释里出现 `encrypt` 不算，解密不算。

模型走智谱 GLM 的 Anthropic 兼容端点（`ZHIPU_API_KEY` / `ZHIPU_MODEL` / `ZHIPU_BASE_URL`），agent 循环用 [pi-ai](https://github.com/earendil-works/pi) 的抽象。

两种运行模式，共享 `src/review` 的审查核心（prompt、agent 循环、评论/结论解析）：

| | GitHub App 模式 | GitHub 托管模式 |
|---|---|---|
| 代码 | `src/app/`，自建常驻服务 | `src/actions/review.ts` + 根 `action.yml` + `.github/workflows/review.yml` |
| 触发 | App webhook 回调（本机需公网可达，如 ngrok） | GitHub Actions，无自建服务、无常驻进程 |
| 仓库访问 | 只看 diff，不克隆 | 浅克隆 PR head 到临时目录，agent 带 `read_file` / `grep` / `list_dir` 只读工具追实现 |
| 模型配置 | `.env` | workflow inputs，目标仓库 caller 可覆盖模型与端点 |
| 要管理的凭证 | App 私钥 + webhook secret + ZHIPU_API_KEY | 只有 ZHIPU_API_KEY（GITHUB_TOKEN 每次运行自动发） |

## GitHub 托管模式（推荐）

目标仓库（如 omi-backend）放一个薄 caller，完整示例见 `examples/omi-backend-intl-review.yml`：

```yaml
name: intl-review
on:
  pull_request:
    types: [opened, synchronize, reopened]
    branches: [cocome]
jobs:
  review:
    uses: zzy7517/intl-review/.github/workflows/review.yml@master
    secrets:
      ZHIPU_API_KEY: ${{ secrets.ZHIPU_API_KEY }}
    # 可选覆盖：
    # with:
    #   zhipu-model: glm-5.3
    #   zhipu-base-url: https://open.bigmodel.cn/api/anthropic
```

前提只有两条：

1. 目标仓库 Settings → Secrets and variables → Actions 配 `ZHIPU_API_KEY`。
2. 同组织私有仓库（Actions 私有 action / reusable workflow 的组织内共享）。

运行机制：caller 触发 reusable workflow → runner 用短期只读 token 自动下载 intl-review 整仓（根 `action.yml`），`npm ci && npm run build` 后执行 `dist/actions/review.js` → 用 GITHUB_TOKEN（每次运行自动发放的临时 token，无需人工配置）拉 PR diff、浅克隆 PR head、跑 agent、发 PR 评论、落 check run → 临时目录销毁。

**agent 执行过程在 workflow run 页面的日志里实时可见**：每次工具调用一个折叠分组（工具名 + 参数 + 结果摘要），工具出错带 `⚠️` 前缀不折叠，基础设施错误整条 run 标红、check 标 failure。

**阻塞合入**：仓库 Settings → Branches → 分支保护把 required status check 指向 `intl-review`（repo admin 一次性配置）。不配也能跑，只是不阻塞；check 结论映射：未发现问题 → success，发现 N 处 → failure，证据不足 → neutral。

## GitHub App 模式

常驻服务收 webhook，`src/app/`。适合开发调试，或 Actions 不可用时的兜底。

```bash
cp .env.example .env   # GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY_FILE / GITHUB_WEBHOOK_SECRET / ZHIPU_API_KEY
set -a; source .env; set +a
npm install
npm test
npm start              # 默认 127.0.0.1:8788，本机测试走 ngrok 反代
```

- App 权限：Pull requests 读写 + Checks 读写（后者需要 installation 重新授权一次）；不要开 Contents。
- Webhook 指向 `https://<可达地址>/v1/github/webhook`，事件勾 `Pull request`。
- 只处理 `opened` / `synchronize` / `reopened`，仓库和目标分支要在 `REVIEW_TARGETS`（默认 `omiapp/omi-backend:cocome`），PR 创建时间晚于 `REVIEW_NOT_BEFORE`。同一 head sha 只审一次，去重落 `data/intl-review.sqlite`。
- 本机代理环境下启动：`NODE_USE_ENV_PROXY=1 HTTPS_PROXY=http://127.0.0.1:1087 NO_PROXY=localhost,127.0.0.1,open.bigmodel.cn npm start`

## 目录

```
src/app/       GitHub App 模式：webhook 服务、去重存储、配置
src/actions/   GitHub 托管模式入口：runner 上执行的完整流程
src/github/    GitHub API client 与类型（两种模式共用）
src/review/    审查核心：prompt、pi-ai agent 循环、只读工具、评论与结论解析
action.yml     根 composite action，托管模式的构建与执行入口
.github/workflows/review.yml   托管模式 reusable workflow
examples/      目标仓库 caller 示例
```

## 开发

```bash
npm install
npm test    # tsc 编译 + node --test，含 faux provider 的 agent 循环测试
```
