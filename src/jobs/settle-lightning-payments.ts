import type { Logger, MedusaContainer } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  listOpenLightningSessions,
  refreshSessionData,
  settlePaidSession,
} from "../lib/lightning"

const CONCURRENCY = 5

/**
 * Catches payments the checkout did not report: the customer paid and closed
 * the tab before the order was placed, or placed the order first and paid
 * later. Every open Lightning session still inside its expiry plus grace is
 * verified; paid ones go through Medusa's process-payment workflow.
 */
export default async function settleLightningPayments(container: MedusaContainer) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER) as Logger
  const sessions = await listOpenLightningSessions(container)
  if (sessions.length === 0) return

  let next = 0
  let settled = 0
  const worker = async () => {
    while (next < sessions.length) {
      const session = sessions[next++]
      try {
        const data = await refreshSessionData(session.data as never)
        if (data.status !== "paid") continue
        await settlePaidSession(container, session)
        settled++
      } catch (e) {
        logger.warn(`[lightning] settlement check failed for ${session.id}: ${(e as Error).message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, sessions.length) }, worker))
  if (settled > 0) {
    logger.info(`[lightning] settled ${settled} of ${sessions.length} open payment sessions`)
  }
}

export const config = {
  name: "settle-lightning-payments",
  schedule: "* * * * *",
}
