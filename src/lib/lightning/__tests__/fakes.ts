import { vi } from "vitest"

// Fake breez.tips: the plugin's only external boundary besides the rate
// source. Each known address maps to an LNURL-pay callback; invoices carry a
// verify URL unless the address is listed in `noVerify`, and `settled` decides
// what verify reports. Fake Yadio: the BTC price table payments are quoted from.
export const fake = {
  known: new Set<string>(["shop", "other"]),
  noVerify: new Set<string>(),
  settled: new Set<string>(),
  verifyDown: false,
  minSendable: 1000,
  maxSendable: 100_000_000_000,
  invoiceRequests: [] as URL[],
  verifyRequests: 0,
  counter: 0,
  rates: { USD: 100_000, EUR: 80_000, JPY: 15_000_000 } as Record<string, number>,
  ratesDown: false,
  /** How many upcoming rate fetches fail at the transport level (connection refused). */
  ratesConnectFailures: 0,
  /** How old the fake table claims to be. */
  ratesAgeMs: 0,
  ratesRequests: 0,
}

export const resetFake = () => {
  fake.known = new Set(["shop", "other"])
  fake.noVerify.clear()
  fake.settled.clear()
  fake.verifyDown = false
  fake.minSendable = 1000
  fake.maxSendable = 100_000_000_000
  fake.invoiceRequests = []
  fake.verifyRequests = 0
  fake.rates = { USD: 100_000, EUR: 80_000, JPY: 15_000_000 }
  fake.ratesDown = false
  fake.ratesConnectFailures = 0
  fake.ratesAgeMs = 0
  fake.ratesRequests = 0
}

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })

export const fakeFetch = async (input: unknown): Promise<Response> => {
  const url = new URL(String(input))
  if (url.hostname === "api.yadio.io") {
    fake.ratesRequests++
    if (fake.ratesConnectFailures > 0) {
      fake.ratesConnectFailures--
      throw new TypeError("fetch failed")
    }
    if (fake.ratesDown) return new Response("<html>503</html>", { status: 503 })
    return jsonResponse(200, {
      BTC: { BTC: 1, ...fake.rates },
      base: "BTC",
      timestamp: Date.now() - fake.ratesAgeMs,
    })
  }
  if (url.hostname !== "breez.tips") throw new Error(`unexpected host ${url.hostname}`)

  const wellKnown = url.pathname.match(/^\/\.well-known\/lnurlp\/([^/]+)$/)
  if (wellKnown) {
    const name = decodeURIComponent(wellKnown[1])
    if (!fake.known.has(name)) return jsonResponse(404, { status: "ERROR", reason: "not found" })
    return jsonResponse(200, {
      callback: `https://breez.tips/lnurlp/${name}/invoice`,
      minSendable: fake.minSendable,
      maxSendable: fake.maxSendable,
      commentAllowed: 255,
      tag: "payRequest",
    })
  }

  const invoice = url.pathname.match(/^\/lnurlp\/([^/]+)\/invoice$/)
  if (invoice) {
    fake.invoiceRequests.push(url)
    const hash = `hash${++fake.counter}`
    const body: Record<string, unknown> = { pr: `lnbc1fake${hash}`, routes: [] }
    if (!fake.noVerify.has(invoice[1])) body.verify = `https://breez.tips/verify/${hash}`
    return jsonResponse(200, body)
  }

  const verify = url.pathname.match(/^\/verify\/([^/]+)$/)
  if (verify) {
    fake.verifyRequests++
    if (fake.verifyDown) return new Response("<html>502</html>", { status: 502 })
    return jsonResponse(200, { status: "OK", settled: fake.settled.has(verify[1]) })
  }
  return jsonResponse(404, { status: "ERROR", reason: "unknown route" })
}

export const installFakeFetch = () => vi.stubGlobal("fetch", fakeFetch)

/** The verify hash of an invoice the fake issued. */
export const hashOf = (invoice: string) => invoice.replace("lnbc1fake", "")

export const fakeLogger = () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  log: vi.fn(),
  activity: vi.fn(),
  progress: vi.fn(),
  failure: vi.fn(),
  success: vi.fn(),
  panic: vi.fn(),
  shouldLog: vi.fn(),
  setLogLevel: vi.fn(),
  unsetLogLevel: vi.fn(),
})
