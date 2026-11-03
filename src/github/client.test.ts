import assert from "node:assert/strict"
import { createServer } from "node:http"
import { generateKeyPairSync } from "node:crypto"
import { test } from "node:test"

import { GithubClient } from "./client.js"

test("用 installation token 取 patch 并发表 review，不访问 contents", async () => {
  const seen: { method: string; path: string; auth: string; body: string }[] = []
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const path = req.url ?? ""
    seen.push({
      method: req.method ?? "",
      path,
      auth: String(req.headers.authorization ?? ""),
      body: Buffer.concat(chunks).toString(),
    })
    if (path.startsWith("/app/installations/9/access_tokens")) {
      res.end(JSON.stringify({ token: "ghs_test", expires_at: "2099-01-01T00:00:00Z" }))
      return
    }
    if (path.includes("/pulls/7/files")) {
      res.end(JSON.stringify([{ filename: "user.go", status: "modified", patch: "@@ -1 +1,2 @@\n+email := in.Email" }]))
      return
    }
    if (req.method === "POST" && path.includes("/pulls/7/reviews")) {
      res.end(JSON.stringify({ id: 1 }))
      return
    }
    res.statusCode = 404
    res.end("{}")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const client = new GithubClient({
    appId: "123",
    privateKey: pem,
    installationId: "9",
    apiBase: `http://127.0.0.1:${address.port}`,
  })
  try {
    const diff = await client.getPullDiff("omiapp/omi-backend", 7)
    assert.match(diff.diff, /email := in.Email/)
    await client.createReviewComment("omiapp/omi-backend", 7, "abc", "报告")
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
  assert.ok(seen.some((call) => call.path.startsWith("/app/installations/9/access_tokens")))
  assert.ok(seen.some((call) => call.path.includes("/pulls/7/files") && call.auth === "Bearer ghs_test"))
  const review = seen.find((call) => call.method === "POST" && call.path.includes("/reviews"))
  assert.equal(JSON.parse(review?.body ?? "{}").event, "COMMENT")
  assert.ok(!seen.some((call) => call.path.includes("/contents/")))
})
