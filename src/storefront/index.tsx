"use client"

import { QRCodeSVG } from "qrcode.react"
import { useCallback, useEffect, useRef, useState } from "react"
import type { CSSProperties, ReactNode } from "react"

/** Provider ids for this plugin look like `pp_lightning_<id>`. */
export const isLightningProvider = (providerId?: string | null) =>
  typeof providerId === "string" && providerId.startsWith("pp_lightning_")

export type LightningPaymentStatus = "pending" | "paid" | "expired" | "canceled"

/** What `GET /store/lightning/payment-sessions/:id` returns. */
export interface LightningPayment {
  id: string
  status: LightningPaymentStatus
  invoice: string
  lightning_uri: string
  cash_app_url: string
  amount_sats: number
  amount: number
  currency_code: string
  rate: number
  lightning_address: string
  created_at: string
  expires_at: string
  paid_at: string | null
}

export interface FetchStatusOptions {
  backendUrl: string
  publishableKey: string
  sessionId: string
  signal?: AbortSignal
}

export const fetchLightningPayment = async ({
  backendUrl,
  publishableKey,
  sessionId,
  signal,
}: FetchStatusOptions): Promise<LightningPayment> => {
  const resp = await fetch(
    `${backendUrl.replace(/\/$/, "")}/store/lightning/payment-sessions/${encodeURIComponent(sessionId)}`,
    { headers: { "x-publishable-api-key": publishableKey }, signal, cache: "no-store" }
  )
  if (!resp.ok) {
    let message = `HTTP ${resp.status}`
    try {
      const body = (await resp.json()) as { message?: string }
      if (body?.message) message = body.message
    } catch {
      // keep the status line
    }
    throw new Error(message)
  }
  const body = (await resp.json()) as { payment_session: LightningPayment }
  return body.payment_session
}

/**
 * Reads what `initiatePaymentSession` already put on the cart, so the invoice
 * renders before the first poll returns.
 */
export const paymentFromSessionData = (
  sessionId: string,
  data: Record<string, unknown> | null | undefined
): LightningPayment | null => {
  if (!data || typeof data.invoice !== "string") return null
  const invoice = data.invoice
  return {
    id: sessionId,
    status: (data.status as LightningPaymentStatus) ?? "pending",
    invoice,
    lightning_uri: `lightning:${invoice}`,
    cash_app_url: `https://cash.app/launch/lightning/${invoice}`,
    amount_sats: Number(data.amount_sats),
    amount: Number(data.amount),
    currency_code: String(data.currency_code ?? ""),
    rate: Number(data.rate),
    lightning_address: String(data.lightning_address ?? ""),
    created_at: String(data.created_at ?? ""),
    expires_at: String(data.expires_at ?? ""),
    paid_at: (data.paid_at as string | null) ?? null,
  }
}

export const formatSats = (sats: number) => `${sats.toLocaleString()} sats`

export const formatFiat = (amount: number, currencyCode: string, locale?: string) => {
  try {
    return new Intl.NumberFormat(locale, {
      style: "currency",
      currency: currencyCode.toUpperCase(),
    }).format(amount)
  } catch {
    return `${amount} ${currencyCode.toUpperCase()}`
  }
}

const formatCountdown = (ms: number) => {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, "0")}`
}

const copyText = async (text: string): Promise<boolean> => {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // fall through to the legacy path
  }
  try {
    const el = document.createElement("textarea")
    el.value = text
    el.setAttribute("readonly", "")
    el.style.position = "fixed"
    el.style.opacity = "0"
    document.body.appendChild(el)
    el.select()
    const ok = document.execCommand("copy")
    document.body.removeChild(el)
    return ok
  } catch {
    return false
  }
}

export interface LightningPaymentLabels {
  scan: string
  openWallet: string
  cashApp: string
  copy: string
  copied: string
  expiresIn: string
  waiting: string
  paid: string
  expired: string
  canceled: string
  error: string
}

const defaultLabels: LightningPaymentLabels = {
  scan: "Scan with any Lightning wallet",
  openWallet: "Open in wallet",
  cashApp: "Pay with Cash App",
  copy: "Copy invoice",
  copied: "Copied",
  expiresIn: "Expires in",
  waiting: "Waiting for payment",
  paid: "Payment received",
  expired: "This invoice expired",
  canceled: "This payment was canceled",
  error: "Could not check the payment",
}

export interface LightningPaymentProps {
  /** The Medusa payment session id (`payses_...`). */
  sessionId: string
  /** Medusa backend URL, for example `http://localhost:9000`. */
  backendUrl?: string
  /** The store's publishable API key. */
  publishableKey?: string
  /** Replaces the built-in transport, for storefronts that proxy the backend. */
  fetchPayment?: (sessionId: string, signal: AbortSignal) => Promise<LightningPayment>
  /** Session `data` from the cart, so the invoice renders before the first poll. */
  initialData?: Record<string, unknown> | null
  /** Called once when the invoice is paid. Complete the cart here. */
  onPaid?: (payment: LightningPayment) => void
  /** Called once when the invoice expires unpaid. Offer a new one here. */
  onExpired?: (payment: LightningPayment) => void
  onError?: (error: Error) => void
  /** Milliseconds between status checks. Default 2000. */
  pollIntervalMs?: number
  /** Whether to show the Cash App deep link. Default true. */
  showCashApp?: boolean
  /** QR code edge length in CSS pixels. Default 220. */
  qrSize?: number
  /** BCP 47 locale for the fiat amount. Defaults to the browser's. */
  locale?: string
  labels?: Partial<LightningPaymentLabels>
  className?: string
  style?: CSSProperties
  /** Rendered under the status line, for example a "New invoice" button once expired. */
  children?: ReactNode
}

/**
 * Invoice screen for a Lightning payment session: amount, QR code, wallet
 * links, countdown, and polling until the payment lands. Unstyled; every
 * element carries a `lightning-payment__*` class and the root a `data-status`
 * attribute, so a storefront styles it with its own CSS or Tailwind.
 */
export function LightningPayment({
  sessionId,
  backendUrl,
  publishableKey,
  fetchPayment,
  initialData,
  onPaid,
  onExpired,
  onError,
  pollIntervalMs = 2000,
  showCashApp = true,
  qrSize = 220,
  locale,
  labels: labelOverrides,
  className,
  style,
  children,
}: LightningPaymentProps) {
  const labels = { ...defaultLabels, ...labelOverrides }
  const [payment, setPayment] = useState<LightningPayment | null>(() =>
    paymentFromSessionData(sessionId, initialData)
  )
  const [now, setNow] = useState(() => Date.now())
  const [copied, setCopied] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const notified = useRef<LightningPaymentStatus | null>(null)

  const load = useCallback(
    (signal: AbortSignal) => {
      if (fetchPayment) return fetchPayment(sessionId, signal)
      if (!backendUrl || !publishableKey) {
        throw new Error("LightningPayment needs backendUrl and publishableKey, or a fetchPayment function")
      }
      return fetchLightningPayment({ backendUrl, publishableKey, sessionId, signal })
    },
    [backendUrl, fetchPayment, publishableKey, sessionId]
  )

  // Poll until the payment reaches a final state.
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | null = null
    let stopped = false

    const tick = async () => {
      try {
        const next = await load(controller.signal)
        if (stopped) return
        setPayment(next)
        setError(null)
        if (next.status === "paid" || next.status === "expired" || next.status === "canceled") {
          return
        }
      } catch (e) {
        if (stopped || controller.signal.aborted) return
        const err = e as Error
        setError(err.message)
        onError?.(err)
      }
      timer = setTimeout(tick, pollIntervalMs)
    }
    tick()

    return () => {
      stopped = true
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [load, pollIntervalMs, onError])

  // Countdown clock.
  useEffect(() => {
    if (!payment || payment.status !== "pending") return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [payment])

  // Fire onPaid / onExpired exactly once each.
  useEffect(() => {
    if (!payment) return
    if (payment.status === "paid" && notified.current !== "paid") {
      notified.current = "paid"
      onPaid?.(payment)
    } else if (payment.status === "expired" && notified.current !== "expired") {
      notified.current = "expired"
      onExpired?.(payment)
    }
  }, [payment, onPaid, onExpired])

  const handleCopy = async () => {
    if (!payment) return
    const ok = await copyText(payment.invoice)
    setCopied(ok)
    if (ok) setTimeout(() => setCopied(false), 2000)
  }

  const rootClass = ["lightning-payment", className].filter(Boolean).join(" ")

  if (!payment) {
    return (
      <div className={rootClass} style={style} data-status={error ? "error" : "loading"}>
        <p className="lightning-payment__status">{error ? `${labels.error}: ${error}` : "…"}</p>
        {children}
      </div>
    )
  }

  const remainingMs = new Date(payment.expires_at).getTime() - now
  const isPending = payment.status === "pending"
  const statusText =
    payment.status === "paid"
      ? labels.paid
      : payment.status === "expired"
        ? labels.expired
        : payment.status === "canceled"
          ? labels.canceled
          : error
            ? `${labels.error}: ${error}`
            : labels.waiting

  return (
    <div className={rootClass} style={style} data-status={payment.status}>
      <div className="lightning-payment__amount">
        <span className="lightning-payment__fiat">
          {formatFiat(payment.amount, payment.currency_code, locale)}
        </span>
        <span className="lightning-payment__sats">{formatSats(payment.amount_sats)}</span>
      </div>

      {isPending && (
        <>
          <a
            className="lightning-payment__qr"
            href={payment.lightning_uri}
            aria-label={labels.openWallet}
          >
            <QRCodeSVG
              value={`lightning:${payment.invoice.toUpperCase()}`}
              size={qrSize}
              level="M"
              marginSize={1}
            />
          </a>
          <p className="lightning-payment__hint">{labels.scan}</p>

          <div className="lightning-payment__actions">
            <a
              className="lightning-payment__button lightning-payment__button--wallet"
              href={payment.lightning_uri}
            >
              {labels.openWallet}
            </a>
            {showCashApp && (
              <a
                className="lightning-payment__button lightning-payment__button--cashapp"
                href={payment.cash_app_url}
                target="_blank"
                rel="noreferrer"
              >
                {labels.cashApp}
              </a>
            )}
            <button
              type="button"
              className="lightning-payment__button lightning-payment__button--copy"
              onClick={handleCopy}
            >
              {copied ? labels.copied : labels.copy}
            </button>
          </div>

          <p className="lightning-payment__countdown">
            {labels.expiresIn} <time dateTime={payment.expires_at}>{formatCountdown(remainingMs)}</time>
          </p>
        </>
      )}

      <p className="lightning-payment__status" role="status">
        {statusText}
      </p>
      {children}
    </div>
  )
}

export default LightningPayment
