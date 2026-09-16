/** The only Lightning address domain accepted; it is what Glow issues. */
export const LNURL_DOMAIN = "breez.tips"
/** Where a merchant gets a Lightning address: install Glow, copy the address. */
export const GLOW_SETUP_URL = "https://breez.technology/glow/"
/** Cash App opens any bolt11 through this deep link. */
export const CASHAPP_LIGHTNING_URL = "https://cash.app/launch/lightning/"

/**
 * Where store-currency amounts are converted to satoshis. Yadio publishes the
 * BTC price in every ISO 4217 currency; the same source Glow Pay prices in.
 */
export const RATES_URL = "https://api.yadio.io/exrates/BTC"
/** A fiat-priced invoice is quoted at a rate at most this old. */
export const RATES_CACHE_MS = 60_000
/**
 * Yadio stamps each table with when it was computed; one older than this is a
 * frozen upstream, not a price.
 */
export const RATES_MAX_AGE_MS = 15 * 60_000
/** After a failed fetch, fiat pricing fails fast for this long before retrying. */
export const RATES_RETRY_AFTER_MS = 5_000
/**
 * Yadio answers in well under a second, but its hostname resolves to several
 * addresses and a dead one costs a full connect timeout; do not hold a
 * checkout for longer than this per attempt.
 */
export const RATES_TIMEOUT_MS = 5_000
/** One immediate retry covers a bad address pick or a dropped connection. */
export const RATES_ATTEMPTS = 2
export const MSATS_PER_BTC = 100_000_000_000

/** How long an invoice stays payable, unless the provider is configured otherwise. */
export const DEFAULT_EXPIRY_SECONDS = 15 * 60
export const MIN_EXPIRY_SECONDS = 60
export const MAX_EXPIRY_SECONDS = 24 * 3600
/**
 * A payment in flight at expiry can still settle a little later, so an expired
 * invoice keeps being verified for this long after `expires_at`.
 */
export const LATE_SETTLEMENT_GRACE_SECONDS = 10 * 60
export const UPSTREAM_TIMEOUT_MS = 10_000

/** The value of `AbstractPaymentProvider.identifier`; provider ids are `pp_lightning_<id>`. */
export const PROVIDER_IDENTIFIER = "lightning"
export const PROVIDER_ID_PREFIX = `pp_${PROVIDER_IDENTIFIER}_`
