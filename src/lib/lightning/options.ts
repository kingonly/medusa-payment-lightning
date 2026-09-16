import { normalizeLightningAddress } from "./address"
import {
  DEFAULT_EXPIRY_SECONDS,
  MAX_EXPIRY_SECONDS,
  MIN_EXPIRY_SECONDS,
} from "./constants"
import { ErrorCodes, invalidData } from "./errors"

/** Options passed to the provider in `medusa-config.ts`. */
export interface LightningProviderOptions {
  /** The merchant's Lightning address on breez.tips (from the Glow wallet). */
  lightningAddress: string
  /** How long each invoice stays payable, in seconds. Default 900 (15 minutes). */
  expirySeconds?: number
}

export interface ResolvedLightningOptions {
  lightningAddress: string
  expirySeconds: number
}

export const resolveOptions = (options: unknown): ResolvedLightningOptions => {
  if (!options || typeof options !== "object") {
    throw invalidData(
      ErrorCodes.INVALID_OPTIONS,
      "Lightning payment provider needs options: { lightningAddress: 'you@breez.tips' }"
    )
  }
  const raw = options as Record<string, unknown>
  if (raw.lightningAddress === undefined || raw.lightningAddress === null || raw.lightningAddress === "") {
    throw invalidData(
      ErrorCodes.INVALID_OPTIONS,
      "Required option `lightningAddress` is missing for the Lightning payment provider"
    )
  }
  const lightningAddress = normalizeLightningAddress(raw.lightningAddress)
  let expirySeconds = DEFAULT_EXPIRY_SECONDS
  if (raw.expirySeconds !== undefined) {
    const n = Number(raw.expirySeconds)
    if (!Number.isInteger(n) || n < MIN_EXPIRY_SECONDS || n > MAX_EXPIRY_SECONDS) {
      throw invalidData(
        ErrorCodes.INVALID_OPTIONS,
        `Option \`expirySeconds\` must be an integer between ${MIN_EXPIRY_SECONDS} and ${MAX_EXPIRY_SECONDS}`
      )
    }
    expirySeconds = n
  }
  return { lightningAddress, expirySeconds }
}

/** One Lightning provider entry from `medusa-config.ts`, as the admin route reports it. */
export type ConfiguredProvider =
  | { id: string; options: ResolvedLightningOptions; error?: undefined }
  | { id: string; options?: undefined; error: string }

/**
 * Reads this plugin's provider entries from the payment module config. The
 * payment module constructs providers lazily inside its own container, so the
 * config is the one place an API route can learn what the merchant set up,
 * whether or not a checkout has run yet.
 */
export const providersFromConfig = (configModule: unknown): ConfiguredProvider[] => {
  const modules = (configModule as { modules?: Record<string, unknown> } | undefined)?.modules
  const payment = modules?.payment as { options?: { providers?: unknown[] } } | undefined
  const entries = Array.isArray(payment?.options?.providers) ? payment!.options!.providers! : []
  const out: ConfiguredProvider[] = []
  for (const entry of entries) {
    const e = entry as { resolve?: unknown; id?: unknown; options?: unknown }
    if (typeof e.resolve !== "string" || !/\/providers\/lightning\/?$/.test(e.resolve)) continue
    const id = typeof e.id === "string" ? e.id : "lightning"
    try {
      out.push({ id, options: resolveOptions(e.options) })
    } catch (err) {
      out.push({ id, error: (err as Error).message })
    }
  }
  return out
}
