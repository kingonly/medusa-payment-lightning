import { LNURL_DOMAIN, UPSTREAM_TIMEOUT_MS } from "./constants"
import { ErrorCodes, notFound, unavailable } from "./errors"

// LNURL-pay issues the invoice and LNURL-verify reports settlement, both plain
// HTTPS against the address's domain. No wallet software runs here and no key
// is ever held: the merchant's own wallet receives the funds.

export interface LnurlPayInfo {
  callback: string
  minSendable: number
  maxSendable: number
  commentAllowed: number
}

export interface LnurlInvoice {
  /** The bolt11 invoice. */
  pr: string
  /** LNURL-verify URL for this invoice. */
  verify: string
}

const upstreamUnavailable = (message: string, cause?: unknown) =>
  unavailable(ErrorCodes.LIGHTNING_SERVICE_UNAVAILABLE, message, cause)

const upstreamJson = async (url: string): Promise<Record<string, unknown>> => {
  // Callback and verify URLs come from the upstream response; never follow
  // them anywhere but back to the same host over TLS.
  let target: URL | null = null
  try {
    target = new URL(url)
  } catch {
    target = null
  }
  if (!target || target.protocol !== "https:" || target.hostname !== LNURL_DOMAIN) {
    throw upstreamUnavailable("Invalid Lightning service URL")
  }
  let resp: Response
  try {
    resp = await fetch(url, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) })
  } catch (cause) {
    throw upstreamUnavailable("Lightning service unreachable", cause)
  }
  if (resp.status === 404) {
    throw notFound(ErrorCodes.LIGHTNING_ADDRESS_NOT_FOUND, "Lightning address not found")
  }
  if (!resp.ok) {
    throw upstreamUnavailable(`Lightning service error (HTTP ${resp.status})`)
  }
  let body: Record<string, unknown>
  try {
    body = (await resp.json()) as Record<string, unknown>
  } catch (cause) {
    throw upstreamUnavailable("Invalid Lightning service response", cause)
  }
  if (!body || typeof body !== "object") {
    throw upstreamUnavailable("Invalid Lightning service response")
  }
  if (body.status === "ERROR") {
    throw upstreamUnavailable(String(body.reason || "Lightning service error"))
  }
  return body
}

export const fetchLnurlPayInfo = async (lightningAddress: string): Promise<LnurlPayInfo> => {
  const [username, domain] = lightningAddress.split("@")
  const info = await upstreamJson(
    `https://${domain}/.well-known/lnurlp/${encodeURIComponent(username)}`
  )
  if (
    typeof info.callback !== "string" ||
    typeof info.minSendable !== "number" ||
    typeof info.maxSendable !== "number"
  ) {
    throw upstreamUnavailable("Invalid LNURL-pay response")
  }
  return {
    callback: info.callback,
    minSendable: info.minSendable,
    maxSendable: info.maxSendable,
    commentAllowed: typeof info.commentAllowed === "number" ? info.commentAllowed : 0,
  }
}

export const requestInvoice = async (
  info: LnurlPayInfo,
  amountMsats: number,
  expirySeconds: number,
  comment: string | null = null
): Promise<LnurlInvoice> => {
  const url = new URL(info.callback)
  url.searchParams.set("amount", String(amountMsats))
  url.searchParams.set("expiry", String(expirySeconds))
  // The comment is a courtesy for the payer's wallet; keep whatever the LNURL
  // server accepts.
  if (comment && info.commentAllowed > 0) {
    url.searchParams.set("comment", comment.slice(0, info.commentAllowed))
  }
  const body = await upstreamJson(url.toString())
  if (typeof body.pr !== "string") {
    throw upstreamUnavailable("Invalid invoice response")
  }
  // Without LNURL-verify there is no way to observe settlement, so a payment
  // could never be authorized. Refuse rather than create a dead session.
  if (typeof body.verify !== "string") {
    throw unavailable(
      ErrorCodes.LIGHTNING_VERIFY_UNSUPPORTED,
      "Lightning address does not support payment verification"
    )
  }
  return { pr: body.pr, verify: body.verify }
}

/** True once the invoice has been paid. Throws when the verify service is unreachable. */
export const checkSettled = async (verifyUrl: string): Promise<boolean> => {
  const body = await upstreamJson(verifyUrl)
  return body.settled === true
}
