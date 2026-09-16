import type {
  AuthorizePaymentInput,
  AuthorizePaymentOutput,
  CancelPaymentInput,
  CancelPaymentOutput,
  CapturePaymentInput,
  CapturePaymentOutput,
  DeletePaymentInput,
  DeletePaymentOutput,
  GetPaymentStatusInput,
  GetPaymentStatusOutput,
  InitiatePaymentInput,
  InitiatePaymentOutput,
  Logger,
  ProviderWebhookPayload,
  RefundPaymentInput,
  RefundPaymentOutput,
  RetrievePaymentInput,
  RetrievePaymentOutput,
  UpdatePaymentInput,
  UpdatePaymentOutput,
  WebhookActionResult,
} from "@medusajs/framework/types"
import {
  AbstractPaymentProvider,
  MathBN,
  PaymentActions,
  PaymentSessionStatus,
} from "@medusajs/framework/utils"
import type { BigNumberInput } from "@medusajs/framework/types"
import {
  ErrorCodes,
  fetchLnurlPayInfo,
  invalidData,
  isLightningSessionData,
  type LightningProviderOptions,
  type LightningSessionData,
  notAllowed,
  PROVIDER_IDENTIFIER,
  quoteFiat,
  refreshSessionData,
  registerProviderOptions,
  requestInvoice,
  resolveOptions,
  type ResolvedLightningOptions,
  unavailable,
  withinGrace,
} from "../../lib/lightning"

type InjectedDependencies = {
  logger: Logger
}

/**
 * Bitcoin (Lightning) payments through the merchant's own Glow wallet.
 *
 * A payment session is one bolt11 invoice requested over LNURL-pay from the
 * merchant's breez.tips address for the cart total converted to satoshis.
 * Settlement is observed over LNURL-verify. Lightning payments are final, so
 * authorizing a paid session reports it captured; there is no separate capture
 * step and refunds are the merchant's to send from their wallet.
 */
export default class LightningProviderService extends AbstractPaymentProvider<LightningProviderOptions> {
  static identifier = PROVIDER_IDENTIFIER

  protected readonly logger_: Logger
  protected readonly options_: ResolvedLightningOptions

  static validateOptions(options: Record<string, unknown>): void {
    resolveOptions(options)
  }

  constructor(cradle: InjectedDependencies, options: LightningProviderOptions) {
    super(cradle as unknown as Record<string, unknown>, options)
    this.logger_ = cradle.logger
    this.options_ = resolveOptions(options)
    registerProviderOptions(this.options_)
  }

  get options(): ResolvedLightningOptions {
    return this.options_
  }

  /** Quotes the store-currency amount in sats and requests a fresh invoice. */
  protected async issueInvoice(
    amount: BigNumberInput,
    currencyCode: string,
    sessionId: string
  ): Promise<LightningSessionData> {
    const amountNumber = MathBN.convert(amount).toNumber()
    const currency = currencyCode.toLowerCase()
    const { lightningAddress, expirySeconds } = this.options_
    // The quote and the address lookup are independent; only the invoice
    // request needs both.
    const [quote, info] = await Promise.all([
      quoteFiat(amountNumber, currency),
      fetchLnurlPayInfo(lightningAddress),
    ])
    const amountMsats = quote.amountSats * 1000
    if (amountMsats < info.minSendable || amountMsats > info.maxSendable) {
      throw invalidData(
        ErrorCodes.AMOUNT_OUT_OF_RANGE,
        `${amountNumber} ${currency.toUpperCase()} converts to ${quote.amountSats} sats; ${lightningAddress} accepts between ${Math.ceil(info.minSendable / 1000)} and ${Math.floor(info.maxSendable / 1000)} sats`
      )
    }
    const invoice = await requestInvoice(info, amountMsats, expirySeconds)
    const now = Date.now()
    return {
      session_id: sessionId,
      invoice: invoice.pr,
      verify_url: invoice.verify,
      lightning_address: lightningAddress,
      amount_sats: quote.amountSats,
      amount: amountNumber,
      currency_code: currency,
      rate: quote.rate,
      created_at: new Date(now).toISOString(),
      expires_at: new Date(now + expirySeconds * 1000).toISOString(),
      paid_at: null,
      status: "pending",
    }
  }

  protected requireData(data: Record<string, unknown> | undefined, method: string): LightningSessionData {
    if (!isLightningSessionData(data)) {
      throw unavailable(
        ErrorCodes.PAYMENT_SESSION_NOT_FOUND,
        `${method}: payment session has no Lightning invoice data`
      )
    }
    return data
  }

  async initiatePayment(input: InitiatePaymentInput): Promise<InitiatePaymentOutput> {
    const sessionId = String(input.data?.session_id ?? input.context?.idempotency_key ?? "")
    const data = await this.issueInvoice(input.amount, input.currency_code, sessionId)
    return { id: sessionId || data.invoice, status: PaymentSessionStatus.PENDING, data }
  }

  /**
   * Medusa calls this when the cart changes. A new total means a new invoice;
   * the old one is simply left to expire. A paid session never changes: the
   * funds are already in the merchant's wallet.
   */
  async updatePayment(input: UpdatePaymentInput): Promise<UpdatePaymentOutput> {
    const current = input.data
    if (!isLightningSessionData(current)) {
      const sessionId = String(current?.session_id ?? input.context?.idempotency_key ?? "")
      const data = await this.issueInvoice(input.amount, input.currency_code, sessionId)
      return { status: PaymentSessionStatus.PENDING, data }
    }
    if (current.status === "paid") {
      return { status: PaymentSessionStatus.CAPTURED, data: current }
    }
    const sameAmount =
      MathBN.eq(input.amount, current.amount) &&
      input.currency_code.toLowerCase() === current.currency_code
    if (sameAmount) {
      return { status: PaymentSessionStatus.PENDING, data: current }
    }
    const data = await this.issueInvoice(input.amount, input.currency_code, current.session_id)
    return { status: PaymentSessionStatus.PENDING, data }
  }

  /**
   * Verifies the invoice. Paid means captured (Lightning is final). Unpaid but
   * still within expiry plus grace means the order may be placed as awaiting
   * payment; the settlement job authorizes it once the payment lands. Unpaid
   * past grace is an error: the customer needs a new invoice.
   */
  async authorizePayment(input: AuthorizePaymentInput): Promise<AuthorizePaymentOutput> {
    const current = this.requireData(input.data, "authorizePayment")
    const data = await refreshSessionData(current)
    if (data.status === "paid") {
      return { status: PaymentSessionStatus.CAPTURED, data }
    }
    if (data.status === "canceled") {
      return { status: PaymentSessionStatus.CANCELED, data }
    }
    if (withinGrace(data)) {
      return { status: PaymentSessionStatus.PENDING_AUTHORIZATION, data }
    }
    return { status: PaymentSessionStatus.ERROR, data }
  }

  async getPaymentStatus(input: GetPaymentStatusInput): Promise<GetPaymentStatusOutput> {
    const current = this.requireData(input.data, "getPaymentStatus")
    const data = await refreshSessionData(current)
    switch (data.status) {
      case "paid":
        return { status: PaymentSessionStatus.CAPTURED, data }
      case "canceled":
        return { status: PaymentSessionStatus.CANCELED, data }
      case "expired":
        return {
          status: withinGrace(data) ? PaymentSessionStatus.PENDING : PaymentSessionStatus.ERROR,
          data,
        }
      default:
        return { status: PaymentSessionStatus.PENDING, data }
    }
  }

  /** Nothing to do: a Lightning payment settles the moment it is paid. */
  async capturePayment(input: CapturePaymentInput): Promise<CapturePaymentOutput> {
    return { data: input.data }
  }

  /**
   * An unpaid invoice cannot be revoked, it just expires; the session is marked
   * canceled so it is no longer verified. A paid one cannot be canceled at all.
   */
  async cancelPayment(input: CancelPaymentInput): Promise<CancelPaymentOutput> {
    const current = input.data
    if (!isLightningSessionData(current)) {
      return { data: current }
    }
    if (current.status === "paid") {
      throw notAllowed(
        ErrorCodes.CANCEL_NOT_SUPPORTED,
        `Lightning payment ${current.session_id} is already paid (${current.amount_sats} sats to ${current.lightning_address}); refund it from your wallet`
      )
    }
    return { data: { ...current, status: "canceled" } }
  }

  async deletePayment(input: DeletePaymentInput): Promise<DeletePaymentOutput> {
    return this.cancelPayment(input)
  }

  /** Lightning has no refund primitive; the merchant sends one from their wallet. */
  async refundPayment(input: RefundPaymentInput): Promise<RefundPaymentOutput> {
    const current = isLightningSessionData(input.data) ? input.data : null
    throw notAllowed(
      ErrorCodes.REFUND_NOT_SUPPORTED,
      current
        ? `Lightning payments cannot be refunded automatically. Send ${MathBN.convert(input.amount).toString()} ${current.currency_code.toUpperCase()} back to the customer from your Glow wallet, then record the refund manually.`
        : "Lightning payments cannot be refunded automatically; refund from your Glow wallet."
    )
  }

  async retrievePayment(input: RetrievePaymentInput): Promise<RetrievePaymentOutput> {
    const current = this.requireData(input.data, "retrievePayment")
    try {
      return { data: await refreshSessionData(current) }
    } catch (e) {
      // A verify outage must not break reading the payment; the data is as
      // fresh as the last successful check.
      this.logger_.warn(`[lightning] could not verify ${current.session_id}: ${(e as Error).message}`)
      return { data: current }
    }
  }

  /**
   * breez.tips sends no webhooks. Settlement is observed by the store status
   * route and the settlement job, which run Medusa's process-payment workflow
   * directly, so nothing arrives here.
   */
  async getWebhookActionAndData(_payload: ProviderWebhookPayload["payload"]): Promise<WebhookActionResult> {
    return { action: PaymentActions.NOT_SUPPORTED }
  }
}
