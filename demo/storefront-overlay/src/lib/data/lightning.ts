"use server"

import { sdk } from "@lib/config"
import { getAuthHeaders } from "@lib/data/cookies"
import type { LightningPayment } from "medusa-payment-lightning/storefront"

/**
 * Live status of a Lightning payment session. Runs on the server so the
 * browser never needs the backend URL or the publishable key; the invoice
 * screen calls it every couple of seconds.
 */
export async function getLightningPayment(sessionId: string): Promise<LightningPayment> {
  const headers = { ...(await getAuthHeaders()) }
  const { payment_session } = await sdk.client.fetch<{ payment_session: LightningPayment }>(
    `/store/lightning/payment-sessions/${encodeURIComponent(sessionId)}`,
    { method: "GET", headers, cache: "no-store" }
  )
  return payment_session
}
