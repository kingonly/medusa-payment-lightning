import { CASHAPP_LIGHTNING_URL, LATE_SETTLEMENT_GRACE_SECONDS } from "./constants"

export type LightningPaymentStatus = "pending" | "paid" | "expired" | "canceled"

/**
 * What the provider stores on `payment_session.data`. Medusa exposes it to the
 * storefront through the cart, so it is also the contract a custom checkout
 * builds on. Snake case like the rest of the Medusa API.
 */
export interface LightningSessionData {
  session_id: string
  /** The bolt11 invoice to pay. */
  invoice: string
  /** LNURL-verify URL; the provider polls it for settlement. */
  verify_url: string
  /** The merchant address that receives the funds. */
  lightning_address: string
  /** What the payer sends. */
  amount_sats: number
  /** The store-currency amount this invoice was issued for. */
  amount: number
  /** Lowercase ISO 4217 code, as Medusa reports it. */
  currency_code: string
  /** The price of 1 BTC in `currency_code` used for the conversion. */
  rate: number
  created_at: string
  expires_at: string
  paid_at: string | null
  status: LightningPaymentStatus
  [key: string]: unknown
}

export const isLightningSessionData = (data: unknown): data is LightningSessionData => {
  if (!data || typeof data !== "object") return false
  const d = data as Record<string, unknown>
  return (
    typeof d.invoice === "string" &&
    typeof d.verify_url === "string" &&
    typeof d.expires_at === "string" &&
    typeof d.amount_sats === "number"
  )
}

export const expiresAtMs = (data: LightningSessionData) => new Date(data.expires_at).getTime()

export const isExpired = (data: LightningSessionData, now = Date.now()) => now >= expiresAtMs(data)

/** A payment in flight at expiry can still land; keep verifying for a while. */
export const withinGrace = (data: LightningSessionData, now = Date.now()) =>
  now < expiresAtMs(data) + LATE_SETTLEMENT_GRACE_SECONDS * 1000

/** Whether verifying can still change anything. */
export const isVerifiable = (data: LightningSessionData, now = Date.now()) =>
  data.status !== "paid" && data.status !== "canceled" && withinGrace(data, now)

/** The shape the store status route returns; the verify URL stays internal. */
export interface PublicLightningPayment {
  id: string
  status: LightningPaymentStatus
  invoice: string
  lightning_uri: string
  cash_app_url: string
  amount_sats: number
  amount: number
  currency_code: string
  rate: number
  lightning_address: string
  created_at: string
  expires_at: string
  paid_at: string | null
}

export const toPublic = (id: string, data: LightningSessionData): PublicLightningPayment => ({
  id,
  status: data.status,
  invoice: data.invoice,
  lightning_uri: `lightning:${data.invoice}`,
  cash_app_url: `${CASHAPP_LIGHTNING_URL}${data.invoice}`,
  amount_sats: data.amount_sats,
  amount: data.amount,
  currency_code: data.currency_code,
  rate: data.rate,
  lightning_address: data.lightning_address,
  created_at: data.created_at,
  expires_at: data.expires_at,
  paid_at: data.paid_at,
})
