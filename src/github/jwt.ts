import { createSign } from "node:crypto"

function b64url(value: string): string {
  return Buffer.from(value).toString("base64url")
}

/** GitHub App JWT。exp 不超过 10 分钟，iat 提前 60 秒避开时钟偏差。 */
export function createAppJwt(appId: string, privateKeyPem: string, now = Date.now()): string {
  const iat = Math.floor(now / 1000) - 60
  const exp = Math.floor(now / 1000) + 9 * 60
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))
  const payload = b64url(JSON.stringify({ iat, exp, iss: appId }))
  const data = `${header}.${payload}`
  const sign = createSign("RSA-SHA256")
  sign.update(data)
  return `${data}.${sign.sign(privateKeyPem).toString("base64url")}`
}
