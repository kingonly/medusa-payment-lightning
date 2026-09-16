"use client"

import { initiatePaymentSession, placeOrder } from "@lib/data/cart"
import { getLightningPayment } from "@lib/data/lightning"
import { LightningPayment } from "medusa-payment-lightning/storefront"
import { HttpTypes } from "@medusajs/types"
import { Button } from "@medusajs/ui"
import { useRouter } from "next/navigation"
import { useCallback, useState } from "react"
import ErrorMessage from "../error-message"
import "../../../../styles/lightning-payment.css"

/**
 * The Lightning invoice screen for the review step. The order is placed the
 * moment the payment lands; an expired invoice can be replaced with a fresh one.
 */
const LightningPaymentStep = ({
  cart,
  session,
  notReady,
  "data-testid": dataTestId,
}: {
  cart: HttpTypes.StoreCart
  session: HttpTypes.StorePaymentSession
  notReady: boolean
  "data-testid"?: string
}) => {
  const router = useRouter()
  const [placing, setPlacing] = useState(false)
  const [expired, setExpired] = useState(false)
  const [renewing, setRenewing] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const onPaid = useCallback(async () => {
    setPlacing(true)
    try {
      await placeOrder(cart.id)
    } catch (e: any) {
      setError(e.message)
      setPlacing(false)
    }
  }, [cart.id])

  const renew = async () => {
    setRenewing(true)
    setError(null)
    try {
      await initiatePaymentSession(cart, { provider_id: session.provider_id })
      setExpired(false)
      router.refresh()
    } catch (e: any) {
      setError(e.message)
    } finally {
      setRenewing(false)
    }
  }

  if (notReady) {
    return <Button disabled>Complete the steps above to pay</Button>
  }

  return (
    <div data-testid={dataTestId}>
      <LightningPayment
        key={session.id}
        sessionId={session.id}
        initialData={session.data}
        fetchPayment={(id) => getLightningPayment(id)}
        onPaid={onPaid}
        onExpired={() => setExpired(true)}
        className="rounded-rounded border p-6"
      >
        {placing && <p className="text-ui-fg-subtle text-small-regular mt-2">Placing your order…</p>}
        {expired && (
          <Button className="mt-4" onClick={renew} isLoading={renewing} data-testid="lightning-new-invoice">
            Get a new invoice
          </Button>
        )}
      </LightningPayment>
      <ErrorMessage error={error} data-testid="lightning-payment-error-message" />
    </div>
  )
}

export default LightningPaymentStep
