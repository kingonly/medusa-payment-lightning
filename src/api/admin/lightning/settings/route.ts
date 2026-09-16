import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import { ContainerRegistrationKeys } from "@medusajs/framework/utils"
import {
  fetchLnurlPayInfo,
  GLOW_SETUP_URL,
  LNURL_DOMAIN,
  PROVIDER_ID_PREFIX,
  providersFromConfig,
} from "../../../../lib/lightning"

export interface AdminLightningProvider {
  /** The Medusa provider id, `pp_lightning_<id>`. */
  provider_id: string
  lightning_address: string | null
  expiry_seconds: number | null
  /** Live LNURL-pay lookup of the configured address. */
  check: {
    ok: boolean
    min_sendable_sats?: number
    max_sendable_sats?: number
    error?: string
  }
}

export interface AdminLightningSettingsResponse {
  configured: boolean
  providers: AdminLightningProvider[]
  glow_setup_url: string
  lnurl_domain: string
}

/**
 * GET /admin/lightning/settings
 *
 * What the admin widget shows: the address the provider pays into (read from
 * the payment module config in medusa-config.ts) and whether breez.tips
 * currently resolves it.
 */
export const GET = async (req: MedusaRequest, res: MedusaResponse<AdminLightningSettingsResponse>) => {
  const configured = providersFromConfig(req.scope.resolve(ContainerRegistrationKeys.CONFIG_MODULE))
  const providers = await Promise.all(
    configured.map(async (p): Promise<AdminLightningProvider> => {
      const provider_id = `${PROVIDER_ID_PREFIX}${p.id}`
      if (p.error !== undefined) {
        return { provider_id, lightning_address: null, expiry_seconds: null, check: { ok: false, error: p.error } }
      }
      try {
        const info = await fetchLnurlPayInfo(p.options.lightningAddress)
        return {
          provider_id,
          lightning_address: p.options.lightningAddress,
          expiry_seconds: p.options.expirySeconds,
          check: {
            ok: true,
            min_sendable_sats: Math.ceil(info.minSendable / 1000),
            max_sendable_sats: Math.floor(info.maxSendable / 1000),
          },
        }
      } catch (e) {
        return {
          provider_id,
          lightning_address: p.options.lightningAddress,
          expiry_seconds: p.options.expirySeconds,
          check: { ok: false, error: (e as Error).message },
        }
      }
    })
  )
  res.json({
    configured: providers.length > 0,
    providers,
    glow_setup_url: GLOW_SETUP_URL,
    lnurl_domain: LNURL_DOMAIN,
  })
}
