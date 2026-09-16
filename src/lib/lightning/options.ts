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

// The payment module builds providers inside its own container, so API routes
// cannot resolve the provider instance. Each constructed provider records its
// resolved options here for the admin settings route; the module is loaded once
// per process, so both sides see the same map.
const registered: ResolvedLightningOptions[] = []

export const registerProviderOptions = (options: ResolvedLightningOptions) => {
  const i = registered.findIndex((o) => o.lightningAddress === options.lightningAddress)
  if (i >= 0) {
    registered[i] = options
  } else {
    registered.push(options)
  }
}

export const getRegisteredProviderOptions = (): ResolvedLightningOptions[] => [...registered]

/** Test hook. */
export const resetRegisteredProviderOptions = () => {
  registered.length = 0
}
