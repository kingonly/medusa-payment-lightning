import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import { listOpenLightningSessions } from "@breeztech/medusa-payment-lightning/lib/lightning"

/**
 * Lists the Lightning payment sessions the settlement job would verify.
 * Run with: npx medusa exec ./src/scripts/check-lightning.ts
 */
export default async function checkLightning({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const sessions = await listOpenLightningSessions(container)
  logger.info(`${sessions.length} open Lightning payment session(s)`)
  for (const s of sessions) {
    const d = s.data as Record<string, unknown>
    logger.info(`  ${s.id} medusa=${s.status} invoice=${d.status} ${d.amount_sats} sats expires ${d.expires_at}`)
  }
}
