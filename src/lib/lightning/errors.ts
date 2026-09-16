import { MedusaError } from "@medusajs/framework/utils"

/**
 * Machine-readable codes carried on `MedusaError.code`. HTTP status comes from
 * the Medusa error type: INVALID_DATA is a 400, NOT_FOUND a 404, and
 * UNEXPECTED_STATE a 500 (used for upstream outages: retrying is the right
 * response, not fixing the request).
 */
export const ErrorCodes = {
  INVALID_LIGHTNING_ADDRESS: "invalid_lightning_address",
  LIGHTNING_ADDRESS_NOT_FOUND: "lightning_address_not_found",
  LIGHTNING_SERVICE_UNAVAILABLE: "lightning_service_unavailable",
  LIGHTNING_VERIFY_UNSUPPORTED: "lightning_verify_unsupported",
  EXCHANGE_RATE_UNAVAILABLE: "exchange_rate_unavailable",
  INVALID_CURRENCY: "invalid_currency",
  INVALID_AMOUNT: "invalid_amount",
  AMOUNT_OUT_OF_RANGE: "amount_out_of_range",
  INVALID_OPTIONS: "invalid_options",
  PAYMENT_SESSION_NOT_FOUND: "payment_session_not_found",
  REFUND_NOT_SUPPORTED: "refund_not_supported",
  CANCEL_NOT_SUPPORTED: "cancel_not_supported",
} as const

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

export const invalidData = (code: ErrorCode, message: string) =>
  new MedusaError(MedusaError.Types.INVALID_DATA, message, code)

export const notFound = (code: ErrorCode, message: string) =>
  new MedusaError(MedusaError.Types.NOT_FOUND, message, code)

export const notAllowed = (code: ErrorCode, message: string) =>
  new MedusaError(MedusaError.Types.NOT_ALLOWED, message, code)

export const unavailable = (code: ErrorCode, message: string, cause?: unknown) => {
  const err = new MedusaError(MedusaError.Types.UNEXPECTED_STATE, message, code)
  if (cause !== undefined) {
    ;(err as Error & { cause?: unknown }).cause = cause
  }
  return err
}
