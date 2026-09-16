import {
  MSATS_PER_BTC,
  RATES_ATTEMPTS,
  RATES_CACHE_MS,
  RATES_MAX_AGE_MS,
  RATES_RETRY_AFTER_MS,
  RATES_TIMEOUT_MS,
  RATES_URL,
} from "./constants"
import { ErrorCodes, invalidData, unavailable } from "./errors"

export interface RatesSnapshot {
  /** BTC price per uppercase ISO 4217 code. */
  rates: Record<string, number>
  fetchedAt: number
}

/** How a payment was priced in the store currency. */
export interface Quote {
  amountSats: number
  /** The price of 1 BTC in the currency used to compute `amountSats`. */
  rate: number
}

let ratesCache: RatesSnapshot | null = null
let ratesInFlight: Promise<RatesSnapshot> | null = null
let ratesFailedAt = 0

const ratesUnavailable = (message: string, cause?: unknown) =>
  unavailable(ErrorCodes.EXCHANGE_RATE_UNAVAILABLE, message, cause)

interface RatesBody {
  BTC?: Record<string, unknown>
  /** When Yadio computed the table, Unix milliseconds. */
  timestamp?: unknown
}

/** Transport failures (timeout, refused, unreachable) get a fresh attempt; HTTP answers do not. */
const fetchWithRetry = async (): Promise<Response> => {
  let lastCause: unknown
  for (let attempt = 1; attempt <= RATES_ATTEMPTS; attempt++) {
    try {
      return await fetch(RATES_URL, { signal: AbortSignal.timeout(RATES_TIMEOUT_MS) })
    } catch (cause) {
      lastCause = cause
    }
  }
  throw ratesUnavailable("Exchange rate service unreachable", lastCause)
}

const fetchRates = async (): Promise<RatesSnapshot> => {
  const resp = await fetchWithRetry()
  if (!resp.ok) {
    throw ratesUnavailable(`Exchange rate service error (HTTP ${resp.status})`)
  }
  let body: RatesBody
  try {
    body = (await resp.json()) as RatesBody
  } catch (cause) {
    throw ratesUnavailable("Invalid exchange rate response", cause)
  }
  const table = body?.BTC
  if (!table || typeof table !== "object") {
    throw ratesUnavailable("Invalid exchange rate response")
  }
  if (typeof body.timestamp !== "number" || Date.now() - body.timestamp > RATES_MAX_AGE_MS) {
    throw ratesUnavailable("Exchange rate table is stale")
  }
  const rates: Record<string, number> = {}
  for (const [code, price] of Object.entries(table)) {
    if (code === "BTC") continue
    if (typeof price === "number" && Number.isFinite(price) && price > 0) {
      rates[code.toUpperCase()] = price
    }
  }
  if (Object.keys(rates).length === 0) {
    throw ratesUnavailable("Invalid exchange rate response")
  }
  return { rates, fetchedAt: Date.now() }
}

/**
 * The current BTC price table, refreshed at most once a minute. Concurrent
 * callers share one upstream request. A stale table is never served past the
 * cache window: with the rate source down, pricing fails rather than quoting
 * an old price, and keeps failing fast for a few seconds so a degraded source
 * is not hammered once per checkout.
 */
export const getRates = async (): Promise<RatesSnapshot> => {
  const now = Date.now()
  if (ratesCache && now - ratesCache.fetchedAt < RATES_CACHE_MS) {
    return ratesCache
  }
  if (now - ratesFailedAt < RATES_RETRY_AFTER_MS) {
    throw ratesUnavailable("Exchange rate service unavailable")
  }
  if (!ratesInFlight) {
    ratesInFlight = fetchRates()
      .then((snapshot) => {
        ratesCache = snapshot
        return snapshot
      })
      .catch((err) => {
        ratesFailedAt = Date.now()
        throw err
      })
      .finally(() => {
        ratesInFlight = null
      })
  }
  return ratesInFlight
}

/** Test hook: forgets the cached price table and any recent failure. */
export const resetRatesCache = () => {
  ratesCache = null
  ratesInFlight = null
  ratesFailedAt = 0
}

/**
 * Converts a store-currency amount to satoshis at the current rate, rounded up
 * so the merchant never receives less than the price they set. Works in integer
 * millisatoshis, the Lightning quantum, so an exact price stays exact without a
 * float epsilon. Whether the result is payable is the address's call
 * (min/maxSendable), checked by the caller.
 */
export const quoteFiat = async (amount: number, currencyCode: string): Promise<Quote> => {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw invalidData(ErrorCodes.INVALID_AMOUNT, "amount must be a positive number")
  }
  const currency = currencyCode.toUpperCase()
  const { rates } = await getRates()
  const rate = rates[currency]
  if (rate === undefined) {
    throw invalidData(
      ErrorCodes.INVALID_CURRENCY,
      `currency ${currency} has no BTC exchange rate; price the store in a currency Yadio publishes`
    )
  }
  const msats = Math.round((amount * MSATS_PER_BTC) / rate)
  const amountSats = Math.ceil(msats / 1000)
  if (!Number.isSafeInteger(amountSats) || amountSats < 1) {
    throw invalidData(
      ErrorCodes.INVALID_AMOUNT,
      "amount converts to an unpayable number of satoshis"
    )
  }
  return { amountSats, rate }
}
