import { GLOW_SETUP_URL, LNURL_DOMAIN } from "./constants"
import { ErrorCodes, invalidData } from "./errors"

const ADDRESS_RE = /^[a-z0-9][a-z0-9._-]{0,63}@breez\.tips$/

/** Lowercases and validates; only `breez.tips` addresses are accepted. */
export const normalizeLightningAddress = (value: unknown): string => {
  if (typeof value !== "string") {
    throw invalidData(
      ErrorCodes.INVALID_LIGHTNING_ADDRESS,
      "lightningAddress must be a string"
    )
  }
  const address = value.trim().toLowerCase()
  if (!ADDRESS_RE.test(address)) {
    throw invalidData(
      ErrorCodes.INVALID_LIGHTNING_ADDRESS,
      `lightningAddress must be a ${LNURL_DOMAIN} address (name@${LNURL_DOMAIN}). Get one by installing Glow: ${GLOW_SETUP_URL}`
    )
  }
  return address
}
