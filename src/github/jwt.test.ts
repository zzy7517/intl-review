import assert from "node:assert/strict"
import { generateKeyPairSync, createVerify } from "node:crypto"
import { test } from "node:test"

import { createAppJwt } from "./jwt.js"

test("App JWT 的 iss 和 exp 落在 GitHub 允许的窗口", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  const now = Date.parse("2026-11-02T00:00:00Z")
  const token = createAppJwt("12345", pem, now)
  const [header, payload, signature] = token.split(".")
  assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "RS256")
  const body = JSON.parse(Buffer.from(payload, "base64url").toString())
  assert.equal(body.iss, "12345")
  assert.equal(body.exp - body.iat, 10 * 60)
  assert.ok(body.exp <= now / 1000 + 10 * 60)
  const verify = createVerify("RSA-SHA256")
  verify.update(`${header}.${payload}`)
  assert.equal(verify.verify(publicKey, Buffer.from(signature, "base64url")), true)
})
