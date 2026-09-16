import type { Logger, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, PaymentActions, PaymentSessionStatus } from "@medusajs/framework/utils"
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
/** Medusa statuses a payment can still land on. */
const OPEN_STATUSES = [PaymentSessionStatus.PENDING, PaymentSessionStatus.PENDING_AUTHORIZATION]
/** Medusa statuses that mean the payment record exists. */
const SETTLED_STATUSES = new Set<string>([PaymentSessionStatus.AUTHORIZED, PaymentSessionStatus.CAPTURED])

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
      status: OPEN_STATUSES,
    },
  })
  return (data as PaymentSessionRow[]).filter(
    (row) =>
      isLightningProviderId(row.provider_id) &&
      isLightningSessionData(row.data) &&
      isVerifiable(row.data, now)
  )
}

export interface RefreshOptions {
  now?: number
  /**
   * Verify even past the grace window. The job and the status route stop
   * polling after grace; a decision that settles or fails an order must not,
   * since a payment observed by one check can otherwise be missed by the next.
   */
  alwaysVerify?: boolean
}

/**
 * Brings session data up to date against LNURL-verify. Paid and canceled are
 * final; an unpaid invoice past its expiry is reported expired but stays
 * verifiable through the grace window. Throws when the verify service is down,
 * so callers decide whether that is fatal (authorize) or a retry (status poll).
 */
export const refreshSessionData = async (
  data: LightningSessionData,
  { now = Date.now(), alwaysVerify = false }: RefreshOptions = {}
): Promise<LightningSessionData> => {
  if (data.status === "paid" || data.status === "canceled") return data
  const next: LightningSessionData = { ...data }
  if ((alwaysVerify || isVerifiable(data, now)) && (await checkSettled(data.verify_url))) {
    next.status = "paid"
    next.paid_at = new Date(now).toISOString()
    return next
  }
  if (isExpired(data, now)) {
    next.status = "expired"
  }
  return next
}

const errorMessage = (e: unknown) => (e instanceof Error ? e.message : String(e))

/**
 * Tells Medusa a Lightning session is paid. For a cart still open this
 * completes the cart (order created, payment authorized and captured); for an
 * order placed before the payment landed it authorizes the deferred session.
 *
 * Returns true when this call settled the session. False means the session
 * turned out to be settled already (another instance won the race) or the
 * workflow reported a failure that left the payment recorded, which is logged
 * at error level because the merchant has the funds and may lack an order.
 * Throws when the workflow failed and the session is still open.
 */
export const settlePaidSession = async (
  container: MedusaContainer,
  session: PaymentSessionRow
): Promise<boolean> => {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as Logger
  const amount =
    session.amount && typeof session.amount === "object"
      ? Number(session.amount.value)
      : Number(session.amount)
  logger.info(`[lightning] payment session ${session.id} is paid; settling`)
  try {
    // With a cart still open the workflow completes the cart with
    // continueOnPermanentFailure, so a failed order creation comes back in
    // `errors` rather than as a rejection.
    const { errors } = await processPaymentWorkflow(container).run({
      input: {
        action: PaymentActions.AUTHORIZED,
        data: { session_id: session.id, amount },
      },
      throwOnError: false,
    })
    if (errors?.length) {
      const messages = errors.map((e) => errorMessage(e.error)).join("; ")
      logger.error(
        `[lightning] payment session ${session.id} is paid but Medusa could not finish settling it: ${messages}. Check the order in the admin and complete it manually.`
      )
      return false
    }
    return true
  } catch (error) {
    // Several instances run the job and the route, so two can settle the same
    // session at once; Medusa keeps one payment per session and the loser
    // fails inside the payment module. A failure after the payment committed
    // looks the same from here. Either way the session is authorized and the
    // funds are recorded; log what happened and do not count it as ours.
    let current: PaymentSessionRow | null = null
    try {
      current = await loadPaymentSession(container, session.id)
    } catch (lookupError) {
      logger.warn(`[lightning] could not re-read ${session.id} after a failed settlement: ${errorMessage(lookupError)}`)
      throw error
    }
    if (current && SETTLED_STATUSES.has(current.status)) {
      logger.warn(
        `[lightning] payment session ${session.id} is authorized with its payment recorded; this settlement attempt failed with: ${errorMessage(error)}`
      )
      return false
    }
    throw error
  }
}
