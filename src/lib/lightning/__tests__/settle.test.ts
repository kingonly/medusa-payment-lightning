import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

const runMock = vi.fn(async (_opts?: unknown) => ({ result: undefined, errors: [] as { error: unknown }[] }))
vi.mock("@medusajs/medusa/core-flows", () => ({
  processPaymentWorkflow: () => ({ run: runMock }),
}))

import { LATE_SETTLEMENT_GRACE_SECONDS } from "../constants"
import type { LightningSessionData } from "../session-data"
import {
  isLightningProviderId,
  listOpenLightningSessions,
  refreshSessionData,
  settlePaidSession,
  type PaymentSessionRow,
} from "../settle"
import settleLightningPayments from "../../../jobs/settle-lightning-payments"
import { GET as getStatus } from "../../../api/store/lightning/payment-sessions/[id]/route"
import { GET as getAdminSettings } from "../../../api/admin/lightning/settings/route"
import { fake, fakeLogger, hashOf, installFakeFetch, resetFake } from "./fakes"

const sessionData = (overrides: Partial<LightningSessionData> = {}): LightningSessionData => {
  const n = ++fake.counter
  const now = Date.now()
  return {
    session_id: `payses_${n}`,
    invoice: `lnbc1fakehash${n}`,
    verify_url: `https://breez.tips/verify/hash${n}`,
    lightning_address: "shop@breez.tips",
    amount_sats: 1000,
    amount: 1,
    currency_code: "usd",
    rate: 100_000,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(now + 900_000).toISOString(),
    paid_at: null,
    status: "pending",
    ...overrides,
  }
}

const row = (data: LightningSessionData, status = "pending", provider_id = "pp_lightning_lightning"): PaymentSessionRow => ({
  id: data.session_id,
  provider_id,
  status,
  amount: { value: String(data.amount) },
  currency_code: data.currency_code,
  data,
})

const fakeContainer = (rows: PaymentSessionRow[]) => {
  const logger = fakeLogger()
  const graph = vi.fn(async ({ filters }: { filters: Record<string, unknown> }) => {
    if (typeof filters.id === "string") {
      return { data: rows.filter((r) => r.id === filters.id) }
    }
    const statuses = filters.status as string[]
    return { data: rows.filter((r) => statuses.includes(r.status)) }
  })
  const container = {
    resolve: (key: string) => {
      if (key === "logger") return logger
      if (key === "query") return { graph }
      if (key === "configModule") {
        return {
          modules: {
            payment: {
              options: {
                providers: [
                  { resolve: "medusa-payment-lightning/providers/lightning", id: "lightning", options: { lightningAddress: "shop@breez.tips" } },
                ],
              },
            },
          },
        }
      }
      throw new Error(`unexpected resolve ${key}`)
    },
  }
  return { container: container as never, logger, graph }
}

beforeAll(() => installFakeFetch())
afterAll(() => vi.unstubAllGlobals())
afterEach(() => {
  resetFake()
  runMock.mockClear()
})

describe("refreshSessionData", () => {
  it("marks a settled invoice paid and stamps paid_at", async () => {
    const data = sessionData()
    fake.settled.add(hashOf(data.invoice))
    const out = await refreshSessionData(data)
    expect(out.status).toBe("paid")
    expect(out.paid_at).toBeTruthy()
    expect(data.status).toBe("pending")
  })

  it("marks an unpaid invoice expired after expires_at but keeps checking inside the grace window", async () => {
    const data = sessionData({ expires_at: new Date(Date.now() - 1000).toISOString() })
    const out = await refreshSessionData(data)
    expect(out.status).toBe("expired")
    expect(fake.verifyRequests).toBe(1)
  })

  it("stops verifying past the grace window unless told otherwise, and leaves final states alone", async () => {
    const dead = sessionData({
      expires_at: new Date(Date.now() - (LATE_SETTLEMENT_GRACE_SECONDS + 1) * 1000).toISOString(),
    })
    expect((await refreshSessionData(dead)).status).toBe("expired")
    expect(fake.verifyRequests).toBe(0)
    fake.settled.add(hashOf(dead.invoice))
    expect((await refreshSessionData(dead, { alwaysVerify: true })).status).toBe("paid")
    expect(fake.verifyRequests).toBe(1)
    fake.verifyRequests = 0
    const paid = sessionData({ status: "paid" })
    const canceled = sessionData({ status: "canceled" })
    expect(await refreshSessionData(paid)).toBe(paid)
    expect(await refreshSessionData(canceled)).toBe(canceled)
    expect(fake.verifyRequests).toBe(0)
  })
})

describe("settlePaidSession", () => {
  it("hands the session to the process-payment workflow as authorized", async () => {
    const data = sessionData()
    const { container } = fakeContainer([])
    await expect(settlePaidSession(container, row(data))).resolves.toBe(true)
    expect(runMock).toHaveBeenCalledWith({
      input: { action: "authorized", data: { session_id: data.session_id, amount: 1 } },
      throwOnError: false,
    })
  })

  it("logs an error and reports not settled when the workflow finished with errors", async () => {
    const data = sessionData()
    const { container, logger } = fakeContainer([row(data)])
    runMock.mockResolvedValueOnce({ result: undefined, errors: [{ error: new Error("inventory: out of stock") }] })
    await expect(settlePaidSession(container, row(data))).resolves.toBe(false)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining("out of stock"))
  })
})

describe("settlePaidSession under a concurrent settlement", () => {
  it("stays quiet when another instance settled the session first", async () => {
    const data = sessionData()
    const rows = [row(data, "pending_authorization")]
    const { container, logger } = fakeContainer(rows)
    runMock.mockImplementationOnce(async () => {
      // The other instance won: by the time our workflow fails, the session is authorized.
      rows[0] = { ...rows[0], status: "authorized" }
      // The message Medusa's db error mapper produces for the unique payment index.
      throw new Error(`Payment with payment_session_id: ${data.session_id}, already exists.`)
    })
    await expect(settlePaidSession(container, row(data, "pending_authorization"))).resolves.toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("already exists"))
  })

  it("rethrows the workflow error when the re-read itself fails", async () => {
    const data = sessionData()
    const { container, graph } = fakeContainer([row(data, "pending_authorization")])
    runMock.mockImplementationOnce(async () => {
      throw new Error("lock timeout")
    })
    graph.mockRejectedValueOnce(new Error("connection refused"))
    await expect(settlePaidSession(container, row(data, "pending_authorization"))).rejects.toThrow("lock timeout")
  })

  it("rethrows when the session is still unsettled", async () => {
    const data = sessionData()
    const { container } = fakeContainer([row(data, "pending_authorization")])
    runMock.mockImplementationOnce(async () => {
      throw new Error("database down")
    })
    await expect(settlePaidSession(container, row(data, "pending_authorization"))).rejects.toThrow("database down")
  })
})

describe("listOpenLightningSessions", () => {
  it("returns only verifiable Lightning sessions", async () => {
    const open = sessionData()
    const awaiting = sessionData()
    const dead = sessionData({
      expires_at: new Date(Date.now() - (LATE_SETTLEMENT_GRACE_SECONDS + 1) * 1000).toISOString(),
    })
    const stripe = sessionData()
    const { container } = fakeContainer([
      row(open),
      row(awaiting, "pending_authorization"),
      row(dead),
      row(stripe, "pending", "pp_stripe_stripe"),
      row(sessionData(), "authorized"),
    ])
    const out = await listOpenLightningSessions(container)
    expect(out.map((r) => r.id).sort()).toEqual([open.session_id, awaiting.session_id].sort())
    expect(isLightningProviderId("pp_lightning_lightning")).toBe(true)
    expect(isLightningProviderId("pp_stripe_stripe")).toBe(false)
  })
})

describe("settlement job", () => {
  it("settles paid sessions, skips unpaid ones, and survives a verify outage", async () => {
    const paid = sessionData()
    const unpaid = sessionData()
    const paidLater = sessionData()
    fake.settled.add(hashOf(paid.invoice))
    fake.settled.add(hashOf(paidLater.invoice))
    const { container, logger } = fakeContainer([
      row(paid),
      row(unpaid),
      row(paidLater, "pending_authorization"),
    ])
    await settleLightningPayments(container)
    expect(runMock).toHaveBeenCalledTimes(2)
    const settledIds = runMock.mock.calls.map((c) => (c as unknown as [{ input: { data: { session_id: string } } }])[0].input.data.session_id).sort()
    expect(settledIds).toEqual([paid.session_id, paidLater.session_id].sort())

    runMock.mockClear()
    fake.verifyDown = true
    await settleLightningPayments(container)
    expect(runMock).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalled()
  })

  it("does nothing when there are no open sessions", async () => {
    const { container, graph } = fakeContainer([])
    await settleLightningPayments(container)
    expect(graph).toHaveBeenCalledTimes(1)
    expect(runMock).not.toHaveBeenCalled()
  })
})

describe("store status route", () => {
  const call = async (rows: PaymentSessionRow[], id: string) => {
    const { container, logger } = fakeContainer(rows)
    const json = vi.fn()
    const req = { params: { id }, scope: container } as never
    const res = { json } as never
    await getStatus(req, res)
    return { body: json.mock.calls[0]?.[0] as { payment_session: Record<string, unknown> }, logger }
  }

  it("returns the live public state without the verify URL", async () => {
    const data = sessionData()
    const { body } = await call([row(data)], data.session_id)
    expect(body.payment_session).toMatchObject({
      id: data.session_id,
      status: "pending",
      invoice: data.invoice,
      lightning_uri: `lightning:${data.invoice}`,
      cash_app_url: `https://cash.app/launch/lightning/${data.invoice}`,
      amount_sats: 1000,
      amount: 1,
      currency_code: "usd",
    })
    expect(body.payment_session.verify_url).toBeUndefined()
    expect(runMock).not.toHaveBeenCalled()
  })

  it("reports paid and settles an order that was awaiting payment after responding", async () => {
    const data = sessionData()
    fake.settled.add(hashOf(data.invoice))
    const { body } = await call([row(data, "pending_authorization")], data.session_id)
    expect(body.payment_session.status).toBe("paid")
    await vi.waitFor(() => expect(runMock).toHaveBeenCalledTimes(1))
  })

  it("leaves cart completion to the storefront while the cart is open", async () => {
    const data = sessionData()
    fake.settled.add(hashOf(data.invoice))
    const { body } = await call([row(data, "pending")], data.session_id)
    expect(body.payment_session.status).toBe("paid")
    expect(runMock).not.toHaveBeenCalled()
  })

  it("returns the last known state when verify is down", async () => {
    const data = sessionData()
    fake.verifyDown = true
    const { body, logger } = await call([row(data)], data.session_id)
    expect(body.payment_session.status).toBe("pending")
    expect(logger.warn).toHaveBeenCalled()
  })

  it("404s for unknown ids and other providers' sessions", async () => {
    const data = sessionData()
    await expect(call([row(data, "pending", "pp_stripe_stripe")], data.session_id)).rejects.toMatchObject({
      code: "payment_session_not_found",
    })
    await expect(call([], "payses_none")).rejects.toMatchObject({ code: "payment_session_not_found" })
  })
})

describe("admin settings route", () => {
  it("reports the configured address with a live check, before any checkout ran", async () => {
    const { container } = fakeContainer([])
    const json = vi.fn()
    await getAdminSettings({ scope: container } as never, { json } as never)
    expect(json).toHaveBeenCalledWith({
      configured: true,
      providers: [
        {
          provider_id: "pp_lightning_lightning",
          lightning_address: "shop@breez.tips",
          expiry_seconds: 900,
          check: { ok: true, min_sendable_sats: 1, max_sendable_sats: 100_000_000 },
        },
      ],
      glow_setup_url: "https://breez.technology/glow/",
      lnurl_domain: "breez.tips",
    })
  })
})
