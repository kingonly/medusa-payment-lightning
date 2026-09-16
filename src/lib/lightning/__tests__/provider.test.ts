import { PaymentSessionStatus } from "@medusajs/framework/utils"
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest"
import LightningProviderService from "../../../providers/lightning/service"
import {
  DEFAULT_EXPIRY_SECONDS,
  LATE_SETTLEMENT_GRACE_SECONDS,
  RATES_CACHE_MS,
  RATES_MAX_AGE_MS,
  RATES_RETRY_AFTER_MS,
} from "../constants"
import { resetRegisteredProviderOptions, getRegisteredProviderOptions } from "../options"
import { resetRatesCache } from "../rates"
import type { LightningSessionData } from "../session-data"
import { fake, fakeLogger, hashOf, installFakeFetch, resetFake } from "./fakes"

const makeProvider = (options: Record<string, unknown> = { lightningAddress: "shop@breez.tips" }) =>
  new LightningProviderService({ logger: fakeLogger() as never }, options as never)

const initiate = (provider: LightningProviderService, amount: number, currency = "usd") =>
  provider.initiatePayment({
    amount,
    currency_code: currency,
    data: { session_id: "payses_1" },
    context: { idempotency_key: "payses_1" },
  })

/** Rewrites the data so its expiry lies `secondsAgo` in the past. */
const aged = (data: LightningSessionData, secondsAgo: number): LightningSessionData => ({
  ...data,
  expires_at: new Date(Date.now() - secondsAgo * 1000).toISOString(),
})

beforeAll(() => installFakeFetch())
afterAll(() => vi.unstubAllGlobals())
afterEach(() => {
  resetFake()
  resetRatesCache()
  resetRegisteredProviderOptions()
  vi.useRealTimers()
})

describe("options", () => {
  it("requires a breez.tips lightning address", () => {
    expect(() => LightningProviderService.validateOptions({})).toThrow(/lightningAddress/)
    expect(() => LightningProviderService.validateOptions({ lightningAddress: "me@walletofsatoshi.com" })).toThrow(
      /breez\.tips/
    )
    expect(() => LightningProviderService.validateOptions({ lightningAddress: "Shop@Breez.tips" })).not.toThrow()
  })

  it("bounds the expiry and applies the 15 minute default", () => {
    expect(() => LightningProviderService.validateOptions({ lightningAddress: "shop@breez.tips", expirySeconds: 5 })).toThrow(
      /expirySeconds/
    )
    expect(makeProvider().options).toEqual({
      lightningAddress: "shop@breez.tips",
      expirySeconds: DEFAULT_EXPIRY_SECONDS,
    })
    expect(makeProvider({ lightningAddress: " SHOP@breez.tips ", expirySeconds: 600 }).options).toEqual({
      lightningAddress: "shop@breez.tips",
      expirySeconds: 600,
    })
  })

  it("registers its options for the admin settings route", () => {
    makeProvider()
    expect(getRegisteredProviderOptions()).toEqual([
      { lightningAddress: "shop@breez.tips", expirySeconds: DEFAULT_EXPIRY_SECONDS },
    ])
  })
})

describe("initiatePayment", () => {
  it("quotes the cart total in sats, rounds up, and requests an invoice with the configured expiry", async () => {
    const provider = makeProvider({ lightningAddress: "shop@breez.tips", expirySeconds: 600 })
    const out = await initiate(provider, 4.99, "usd")
    expect(out.status).toBe(PaymentSessionStatus.PENDING)
    expect(out.id).toBe("payses_1")
    expect(out.data).toMatchObject({
      session_id: "payses_1",
      status: "pending",
      amount: 4.99,
      currency_code: "usd",
      amount_sats: 4990,
      rate: 100_000,
      lightning_address: "shop@breez.tips",
      paid_at: null,
    })
    const data = out.data as LightningSessionData
    expect(data.invoice.startsWith("lnbc1fake")).toBe(true)
    expect(data.verify_url).toBe(`https://breez.tips/verify/${hashOf(data.invoice)}`)
    expect(new Date(data.expires_at).getTime() - new Date(data.created_at).getTime()).toBe(600_000)
    const request = fake.invoiceRequests[0]
    expect(request.searchParams.get("amount")).toBe("4990000")
    expect(request.searchParams.get("expiry")).toBe("600")
  })

  it("rounds a fraction of a satoshi up so the merchant never receives less than the price", async () => {
    fake.rates.USD = 97_531
    const out = await initiate(makeProvider(), 10, "usd")
    // 10 / 97531 BTC = 10253.15 sats
    expect(out.data).toMatchObject({ amount_sats: 10254 })
  })

  it("handles zero-decimal currencies and BigNumber amounts", async () => {
    const out = await initiate(makeProvider(), 1500, "jpy")
    expect(out.data).toMatchObject({ amount_sats: 10_000, currency_code: "jpy" })
  })

  it("rejects a currency Yadio does not publish", async () => {
    await expect(initiate(makeProvider(), 5, "xyz")).rejects.toMatchObject({ code: "invalid_currency" })
  })

  it("rejects amounts the address cannot receive", async () => {
    fake.minSendable = 10_000_000
    await expect(initiate(makeProvider(), 5, "usd")).rejects.toMatchObject({ code: "amount_out_of_range" })
  })

  it("fails when the configured address does not exist", async () => {
    await expect(initiate(makeProvider({ lightningAddress: "nobody@breez.tips" }), 5)).rejects.toMatchObject({
      code: "lightning_address_not_found",
    })
  })

  it("refuses an address whose invoices cannot be verified", async () => {
    fake.noVerify.add("shop")
    await expect(initiate(makeProvider(), 5)).rejects.toMatchObject({ code: "lightning_verify_unsupported" })
  })
})

describe("exchange rates", () => {
  it("caches the table for a minute and shares one request between concurrent checkouts", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const provider = makeProvider()
    await Promise.all([initiate(provider, 1), initiate(provider, 2), initiate(provider, 3)])
    expect(fake.ratesRequests).toBe(1)
    vi.advanceTimersByTime(RATES_CACHE_MS + 1)
    await initiate(provider, 4)
    expect(fake.ratesRequests).toBe(2)
  })

  it("fails rather than quoting when the rate source is down, then fails fast", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    fake.ratesDown = true
    const provider = makeProvider()
    await expect(initiate(provider, 1)).rejects.toMatchObject({ code: "exchange_rate_unavailable" })
    await expect(initiate(provider, 1)).rejects.toMatchObject({ code: "exchange_rate_unavailable" })
    expect(fake.ratesRequests).toBe(1)
    vi.advanceTimersByTime(RATES_RETRY_AFTER_MS + 1)
    fake.ratesDown = false
    await expect(initiate(provider, 1)).resolves.toBeTruthy()
    expect(fake.ratesRequests).toBe(2)
  })

  it("retries a dropped connection once, but not an HTTP error", async () => {
    fake.ratesConnectFailures = 1
    await expect(initiate(makeProvider(), 1)).resolves.toBeTruthy()
    expect(fake.ratesRequests).toBe(2)

    resetRatesCache()
    fake.ratesRequests = 0
    fake.ratesConnectFailures = 2
    await expect(initiate(makeProvider(), 1)).rejects.toMatchObject({ code: "exchange_rate_unavailable" })
    expect(fake.ratesRequests).toBe(2)

    resetRatesCache()
    fake.ratesRequests = 0
    fake.ratesDown = true
    await expect(initiate(makeProvider(), 1)).rejects.toMatchObject({ code: "exchange_rate_unavailable" })
    expect(fake.ratesRequests).toBe(1)
  })

  it("treats a frozen upstream table as unavailable", async () => {
    fake.ratesAgeMs = RATES_MAX_AGE_MS + 1000
    await expect(initiate(makeProvider(), 1)).rejects.toMatchObject({ code: "exchange_rate_unavailable" })
  })

  it("never serves a stale table after the cache window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    const provider = makeProvider()
    await initiate(provider, 1)
    vi.advanceTimersByTime(RATES_CACHE_MS + 1)
    fake.ratesDown = true
    await expect(initiate(provider, 1)).rejects.toMatchObject({ code: "exchange_rate_unavailable" })
  })
})

describe("updatePayment", () => {
  it("keeps the invoice when the total is unchanged", async () => {
    const provider = makeProvider()
    const { data } = await initiate(provider, 4.99)
    const out = await provider.updatePayment({ amount: 4.99, currency_code: "USD", data })
    expect(out.status).toBe(PaymentSessionStatus.PENDING)
    expect(out.data).toBe(data)
    expect(fake.invoiceRequests).toHaveLength(1)
  })

  it("issues a new invoice when the total changes", async () => {
    const provider = makeProvider()
    const { data } = await initiate(provider, 4.99)
    const out = await provider.updatePayment({ amount: 7.5, currency_code: "usd", data })
    expect(out.data).toMatchObject({ amount: 7.5, amount_sats: 7500, session_id: "payses_1", status: "pending" })
    expect((out.data as LightningSessionData).invoice).not.toBe((data as LightningSessionData).invoice)
    expect(fake.invoiceRequests).toHaveLength(2)
  })

  it("never replaces a paid invoice", async () => {
    const provider = makeProvider()
    const { data } = await initiate(provider, 4.99)
    const paid = { ...(data as LightningSessionData), status: "paid" as const, paid_at: new Date().toISOString() }
    const out = await provider.updatePayment({ amount: 9.99, currency_code: "usd", data: paid })
    expect(out.status).toBe(PaymentSessionStatus.CAPTURED)
    expect(out.data).toBe(paid)
    expect(fake.invoiceRequests).toHaveLength(1)
  })

  it("issues an invoice when the session has none yet", async () => {
    const out = await makeProvider().updatePayment({
      amount: 1,
      currency_code: "usd",
      data: { session_id: "payses_2" },
    })
    expect(out.data).toMatchObject({ session_id: "payses_2", amount_sats: 1000 })
  })
})

describe("authorizePayment", () => {
  it("reports a paid invoice as captured", async () => {
    const provider = makeProvider()
    const { data } = await initiate(provider, 4.99)
    fake.settled.add(hashOf((data as LightningSessionData).invoice))
    const out = await provider.authorizePayment({ data })
    expect(out.status).toBe(PaymentSessionStatus.CAPTURED)
    expect(out.data).toMatchObject({ status: "paid" })
    expect((out.data as LightningSessionData).paid_at).toBeTruthy()
  })

  it("defers an unpaid invoice that can still be paid", async () => {
    const provider = makeProvider()
    const { data } = await initiate(provider, 4.99)
    const out = await provider.authorizePayment({ data })
    expect(out.status).toBe(PaymentSessionStatus.PENDING_AUTHORIZATION)
    expect(out.data).toMatchObject({ status: "pending" })
  })

  it("keeps verifying through the grace window after expiry", async () => {
    const provider = makeProvider()
    const { data } = await initiate(provider, 4.99)
    const expired = aged(data as LightningSessionData, 60)
    const pending = await provider.authorizePayment({ data: expired })
    expect(pending.status).toBe(PaymentSessionStatus.PENDING_AUTHORIZATION)
    expect(pending.data).toMatchObject({ status: "expired" })

    fake.settled.add(hashOf(expired.invoice))
    const paid = await provider.authorizePayment({ data: expired })
    expect(paid.status).toBe(PaymentSessionStatus.CAPTURED)
  })

  it("still verifies past the grace window: paid is captured, unpaid is an error", async () => {
    const provider = makeProvider()
    const { data } = await initiate(provider, 4.99)
    const dead = aged(data as LightningSessionData, LATE_SETTLEMENT_GRACE_SECONDS + 1)
    const before = fake.verifyRequests
    expect((await provider.authorizePayment({ data: dead })).status).toBe(PaymentSessionStatus.ERROR)
    expect(fake.verifyRequests).toBe(before + 1)
    fake.settled.add(hashOf(dead.invoice))
    expect((await provider.authorizePayment({ data: dead })).status).toBe(PaymentSessionStatus.CAPTURED)
  })

  it("surfaces a verify outage instead of guessing", async () => {
    const provider = makeProvider()
    const { data } = await initiate(provider, 4.99)
    fake.verifyDown = true
    await expect(provider.authorizePayment({ data })).rejects.toMatchObject({
      code: "lightning_service_unavailable",
    })
  })

  it("rejects a session without invoice data", async () => {
    await expect(makeProvider().authorizePayment({ data: {} })).rejects.toMatchObject({
      code: "payment_session_not_found",
    })
  })
})

describe("getPaymentStatus and retrievePayment", () => {
  it("maps invoice states to Medusa statuses", async () => {
    const provider = makeProvider()
    const { data } = await initiate(provider, 4.99)
    const d = data as LightningSessionData
    expect((await provider.getPaymentStatus({ data: d })).status).toBe(PaymentSessionStatus.PENDING)
    expect((await provider.getPaymentStatus({ data: aged(d, 60) })).status).toBe(PaymentSessionStatus.PENDING)
    expect((await provider.getPaymentStatus({ data: aged(d, LATE_SETTLEMENT_GRACE_SECONDS + 1) })).status).toBe(
      PaymentSessionStatus.ERROR
    )
    fake.settled.add(hashOf(d.invoice))
    expect((await provider.getPaymentStatus({ data: d })).status).toBe(PaymentSessionStatus.CAPTURED)
    expect((await provider.getPaymentStatus({ data: { ...d, status: "canceled" } })).status).toBe(
      PaymentSessionStatus.CANCELED
    )
  })

  it("retrievePayment returns the last known state when verify is down", async () => {
    const provider = makeProvider()
    const { data } = await initiate(provider, 4.99)
    fake.verifyDown = true
    const out = await provider.retrievePayment({ data })
    expect(out.data).toBe(data)
  })
})

describe("capture, cancel, delete, refund", () => {
  it("capture is a no-op because Lightning settles on payment", async () => {
    const provider = makeProvider()
    const { data } = await initiate(provider, 4.99)
    expect(await provider.capturePayment({ data })).toEqual({ data })
  })

  it("cancel marks an unpaid session canceled and refuses a paid one", async () => {
    const provider = makeProvider()
    const { data } = await initiate(provider, 4.99)
    const out = await provider.cancelPayment({ data })
    expect(out.data).toMatchObject({ status: "canceled" })
    const paid = { ...(data as LightningSessionData), status: "paid" as const }
    const asAdmin = { data: paid, context: { idempotency_key: "pay_123" } }
    await expect(provider.cancelPayment(asAdmin)).rejects.toMatchObject({ code: "cancel_not_supported" })
    await expect(provider.deletePayment(asAdmin)).rejects.toMatchObject({ code: "cancel_not_supported" })
  })

  it("cancel without a payment id (Medusa compensating a failed authorization) logs and leaves paid data alone", async () => {
    const logger = fakeLogger()
    const provider = new LightningProviderService({ logger: logger as never }, { lightningAddress: "shop@breez.tips" } as never)
    const { data } = await initiate(provider, 4.99)
    const paid = { ...(data as LightningSessionData), status: "paid" as const }
    expect(await provider.cancelPayment({ data: paid, context: {} })).toEqual({ data: paid })
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("nothing to revoke"))
  })

  it("cancel tolerates a session that never got invoice data", async () => {
    expect(await makeProvider().cancelPayment({ data: { session_id: "x" } })).toEqual({ data: { session_id: "x" } })
  })

  it("refund always fails loudly with wallet instructions", async () => {
    const provider = makeProvider()
    const { data } = await initiate(provider, 4.99)
    await expect(provider.refundPayment({ amount: 4.99, data })).rejects.toMatchObject({
      code: "refund_not_supported",
      message: expect.stringContaining("Glow wallet"),
    })
  })

  it("has no webhook actions", async () => {
    expect(await makeProvider().getWebhookActionAndData({ data: {}, rawData: "", headers: {} })).toEqual({
      action: "not_supported",
    })
  })
})
