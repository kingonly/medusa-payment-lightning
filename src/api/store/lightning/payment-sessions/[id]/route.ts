import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import type { Logger } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils"
import {
  ErrorCodes,
  isLightningProviderId,
  isLightningSessionData,
  loadPaymentSession,
  refreshSessionData,
  settlePaidSession,
  toPublic,
} from "../../../../../lib/lightning"

/**
 * GET /store/lightning/payment-sessions/:id
 *
 * The checkout polls this while the invoice is on screen. Each call runs
 * LNURL-verify, so the answer is live, not a cached flag. Requires the store's
 * publishable API key like every store route.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse) => {
  const id = req.params.id
  const session = await loadPaymentSession(req.scope, id)
  if (!session || !isLightningProviderId(session.provider_id) || !isLightningSessionData(session.data)) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `Lightning payment session ${id} not found`,
      ErrorCodes.PAYMENT_SESSION_NOT_FOUND
    )
  }

  const logger = req.scope.resolve(ContainerRegistrationKeys.LOGGER) as Logger
  let data = session.data
  try {
    data = await refreshSessionData(session.data)
  } catch (e) {
    // A verify outage is not the payer's problem: report the last known state
    // and let the next poll try again.
    logger.warn(`[lightning] verify failed for ${id}: ${(e as Error).message}`)
  }

  // An order placed before the payment landed waits in pending_authorization;
  // seeing the payment here is sooner than the settlement job would.
  if (data.status === "paid" && session.status === "pending_authorization") {
    try {
      await settlePaidSession(req.scope, session)
    } catch (e) {
      logger.error(`[lightning] settling ${id} failed, the settlement job will retry: ${(e as Error).message}`)
    }
  }

  res.json({ payment_session: toPublic(session.id, data) })
}
