const BINARY = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|jar|woff2?|mp4|mov)$/i

/** 测试、依赖锁和 vendor 不送给 agent。这不是加密判断。 */
export function skipFile(file: string): boolean {
  return (
    file.endsWith("_test.go") ||
    file.endsWith(".test.ts") ||
    file.endsWith(".test.tsx") ||
    file.endsWith(".spec.ts") ||
    file.includes("/vendor/") ||
    file.startsWith("vendor/") ||
    file.includes("/node_modules/") ||
    file.endsWith("go.sum") ||
    file.endsWith("package-lock.json") ||
    file.endsWith("yarn.lock") ||
    file.endsWith("pnpm-lock.yaml") ||
    file.endsWith(".lock")
  )
}

export type PullFile = {
  filename: string
  status: string
  patch?: string | null
}

/** 把 Pulls files API 的 patch 拼成统一 diff。没有 patch 的文本文件记入 omitted。 */
export function patchesToDiff(files: PullFile[]): { diff: string; omittedFiles: string[] } {
  const parts: string[] = []
  const omittedFiles: string[] = []
  for (const file of files) {
    if (file.status === "removed" || skipFile(file.filename)) continue
    if (!file.patch) {
      if (!BINARY.test(file.filename)) omittedFiles.push(file.filename)
      continue
    }
    parts.push(
      [
        `diff --git a/${file.filename} b/${file.filename}`,
        `--- a/${file.filename}`,
        `+++ b/${file.filename}`,
        file.patch,
      ].join("\n"),
    )
  }
  return { diff: parts.join("\n"), omittedFiles }
}
