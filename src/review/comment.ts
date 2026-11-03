export function reviewMarker(sha: string): string {
  return `<!-- encrypt-review ${sha} -->`
}

/** 从 agent 报告的「### 结论」段推断 check run 结论。解析不出来按 neutral 处理。 */
export function checkVerdict(report: string): { conclusion: "success" | "failure" | "neutral"; title: string } {
  const section = /###[^\n]*结论([\s\S]*?)(?=###|$)/.exec(report)?.[1]?.trim() ?? ""
  if (section.includes("未发现问题")) return { conclusion: "success", title: "未发现问题" }
  if (section.includes("证据不足")) return { conclusion: "neutral", title: "证据不足，无法判断" }
  const found = /发现\s*\d+\s*处/.exec(section)
  if (found) {
    const line = section.split("\n").find((piece) => piece.includes("发现")) ?? found[0]
    return { conclusion: "failure", title: line.trim().slice(0, 120) }
  }
  return { conclusion: "neutral", title: "结论无法解析" }
}

export function buildComment(input: {
  repo: string
  number: number
  base: string
  sha: string
  report: string
}): string {
  const sha = input.sha.length > 8 ? input.sha.slice(0, 8) : input.sha
  const body = `${reviewMarker(input.sha)}
## 敏感数据加密审查（intl-review）

${input.repo}#${input.number} ← ${input.base} · ${sha}

${input.report.trim()}

---
Pi agent 只看了 GitHub 返回的 PR diff，没有克隆仓库。
`
  return body.length > 60_000 ? `${body.slice(0, 60_000)}\n…（评论已截断）` : body
}
