import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http"
import {
  fetchLnurlPayInfo,
  getRegisteredProviderOptions,
  GLOW_SETUP_URL,
  LNURL_DOMAIN,
} from "../../../../lib/lightning"

export interface AdminLightningProvider {
  lightning_address: string
  expiry_seconds: number
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
 * What the admin widget shows: the address the provider pays into (set in
 * medusa-config.ts) and whether breez.tips currently resolves it.
 */
export const GET = async (_req: MedusaRequest, res: MedusaResponse<AdminLightningSettingsResponse>) => {
  const options = getRegisteredProviderOptions()
  const providers = await Promise.all(
    options.map(async (o): Promise<AdminLightningProvider> => {
      try {
        const info = await fetchLnurlPayInfo(o.lightningAddress)
        return {
          lightning_address: o.lightningAddress,
          expiry_seconds: o.expirySeconds,
          check: {
            ok: true,
            min_sendable_sats: Math.ceil(info.minSendable / 1000),
            max_sendable_sats: Math.floor(info.maxSendable / 1000),
          },
        }
      } catch (e) {
        return {
          lightning_address: o.lightningAddress,
          expiry_seconds: o.expirySeconds,
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
