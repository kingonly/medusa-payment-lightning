import type { Logger, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, PaymentActions } from "@medusajs/framework/utils"
import { processPaymentWorkflow } from "@medusajs/medusa/core-flows"
import { PROVIDER_ID_PREFIX } from "./constants"
import { checkSettled } from "./lnurl"
import {
  isExpired,
  isLightningSessionData,
  isVerifiable,
  type LightningSessionData,
} from "./session-data"

// Settlement is observed, never pushed: breez.tips has no webhook, so the
// store status route (while the checkout is open) and the settlement job
// (afterwards) both verify invoices and hand paid sessions to Medusa's own
// process-payment workflow, the same path a Stripe webhook takes.

export interface PaymentSessionRow {
  id: string
  provider_id: string
  status: string
  amount: number | string | { value?: string } | null
  currency_code: string
  data: Record<string, unknown> | null
}

export const isLightningProviderId = (providerId: string | null | undefined) =>
  typeof providerId === "string" && providerId.startsWith(PROVIDER_ID_PREFIX)

const SESSION_FIELDS = ["id", "provider_id", "status", "amount", "currency_code", "data"]

export const loadPaymentSession = async (
  container: MedusaContainer,
  id: string
): Promise<PaymentSessionRow | null> => {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "payment_session",
    fields: SESSION_FIELDS,
    filters: { id },
  })
  return (data[0] as PaymentSessionRow | undefined) ?? null
}

/** Lightning sessions that a payment could still settle. */
export const listOpenLightningSessions = async (
  container: MedusaContainer,
  now = Date.now()
): Promise<PaymentSessionRow[]> => {
  const query = container.resolve(ContainerRegistrationKeys.QUERY)
  const { data } = await query.graph({
    entity: "payment_session",
    fields: SESSION_FIELDS,
    filters: {
      provider_id: { $like: `${PROVIDER_ID_PREFIX}%` },
      status: ["pending", "pending_authorization"],
    },
  })
  return (data as PaymentSessionRow[]).filter(
    (row) =>
      isLightningProviderId(row.provider_id) &&
      isLightningSessionData(row.data) &&
      isVerifiable(row.data, now)
  )
}

/**
 * Brings session data up to date against LNURL-verify. Paid and canceled are
 * final; an unpaid invoice past its expiry is reported expired but stays
 * verifiable through the grace window. Throws when the verify service is down,
 * so callers decide whether that is fatal (authorize) or a retry (status poll).
 */
export const refreshSessionData = async (
  data: LightningSessionData,
  now = Date.now()
): Promise<LightningSessionData> => {
  if (data.status === "paid" || data.status === "canceled") return data
  const next: LightningSessionData = { ...data }
  if (isVerifiable(data, now) && (await checkSettled(data.verify_url))) {
    next.status = "paid"
    next.paid_at = new Date(now).toISOString()
    return next
  }
  if (isExpired(data, now)) {
    next.status = "expired"
  }
  return next
}

/**
 * Tells Medusa a Lightning session is paid. For a cart still open this
 * completes the cart (order created, payment authorized and captured); for an
 * order placed before the payment landed it authorizes the deferred session.
 * Idempotent: the workflow locks the cart and re-reads state.
 */
export const settlePaidSession = async (
  container: MedusaContainer,
  session: PaymentSessionRow
): Promise<void> => {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as Logger
  const amount =
    session.amount && typeof session.amount === "object"
      ? Number(session.amount.value)
      : Number(session.amount)
  logger.info(`[lightning] payment session ${session.id} is paid; settling`)
  await processPaymentWorkflow(container).run({
    input: {
      action: PaymentActions.AUTHORIZED,
      data: { session_id: session.id, amount },
    },
  })
}
