import type { ExecArgs } from "@medusajs/framework/types"
import { ContainerRegistrationKeys, Modules, PaymentActions } from "@medusajs/framework/utils"
import {
  addToCartWorkflow,
  completeCartWorkflow,
  createCartWorkflow,
  createPaymentCollectionForCartWorkflow,
  createPaymentSessionsWorkflow,
  processPaymentWorkflow,
} from "@medusajs/medusa/core-flows"

// Exercises the order-first, pay-later path without spending sats: breez.tips
// and Yadio are stubbed in-process, and the invoice reports settled once the
// order exists, so the plugin's settlement job can be run against it.
// Run: npx medusa exec ./src/scripts/repro-deferred.ts
export default async function repro({ container }: ExecArgs) {
  const logger = container.resolve(ContainerRegistrationKeys.LOGGER)
  const query = container.resolve(ContainerRegistrationKeys.QUERY)

  let settled = false
  const realFetch = globalThis.fetch
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input))
    if (url.hostname === "api.yadio.io") return json({ BTC: { EUR: 65000, USD: 70000 }, timestamp: Date.now() })
    if (url.hostname === "breez.tips") {
      if (url.pathname.startsWith("/.well-known/lnurlp/"))
        return json({ callback: "https://breez.tips/lnurlp/x/invoice", minSendable: 1000, maxSendable: 1e11, tag: "payRequest" })
      if (url.pathname.endsWith("/invoice")) return json({ pr: "lnbc1repro", verify: "https://breez.tips/verify/repro" })
      if (url.pathname.startsWith("/verify/")) return json({ status: "OK", settled })
    }
    return realFetch(input)
  }) as typeof fetch

  const { data: regions } = await query.graph({ entity: "region", fields: ["id"] })
  const { data: variants } = await query.graph({ entity: "product_variant", fields: ["id"], filters: { title: "M / Black" } })
  const { data: channels } = await query.graph({ entity: "sales_channel", fields: ["id"] })

  const { result: cart } = await createCartWorkflow(container).run({
    input: {
      region_id: regions[0].id,
      sales_channel_id: channels[0].id,
      email: "repro@example.com",
      shipping_address: { first_name: "Re", last_name: "Pro", address_1: "1 St", city: "London", country_code: "gb", postal_code: "E1" },
      billing_address: { first_name: "Re", last_name: "Pro", address_1: "1 St", city: "London", country_code: "gb", postal_code: "E1" },
    },
  })
  await addToCartWorkflow(container).run({ input: { cart_id: cart.id, items: [{ variant_id: variants[0].id, quantity: 1 }] } })
  const { data: options } = await query.graph({ entity: "shipping_option", fields: ["id"] })
  const { addShippingMethodToCartWorkflow } = await import("@medusajs/medusa/core-flows")
  await addShippingMethodToCartWorkflow(container).run({ input: { cart_id: cart.id, options: [{ id: options[0].id }] } })

  await createPaymentCollectionForCartWorkflow(container).run({ input: { cart_id: cart.id } })
  const { data: [c] } = await query.graph({ entity: "cart", fields: ["payment_collection.id"], filters: { id: cart.id } })
  const { result: session } = await createPaymentSessionsWorkflow(container).run({
    input: { payment_collection_id: c.payment_collection.id, provider_id: "pp_lightning_lightning" },
  })
  logger.info(`session ${session.id} created`)

  const { result: completed } = await completeCartWorkflow(container).run({ input: { id: cart.id } })
  logger.info(`order ${completed.id} placed with the invoice unpaid`)

  settled = true
  // Run the plugin's real job handler inside a job-style workflow step, the
  // way Medusa's job loader wraps scheduled jobs.
  const jobModule: any = await import("@breeztech/medusa-payment-lightning/jobs/settle-lightning-payments")
  const settleLightningPayments = jobModule.default?.default ?? jobModule.default
  const { createStep, createWorkflow, StepResponse, WorkflowResponse } = await import("@medusajs/framework/workflows-sdk")
  const suffix = Date.now().toString(36)
  const jobStep = createStep(`repro-settle-as-step-${suffix}`, async (_input: unknown, { container: c }) => {
    const res = await settleLightningPayments(c as any)
    return new StepResponse(res, res)
  })
  const jobWorkflow = createWorkflow(`repro-job-${suffix}`, (input: unknown) => new WorkflowResponse(jobStep(input)))
  try {
    await jobWorkflow(container).run({ input: {} })
    logger.info("job workflow completed without error")
  } catch (e) {
    logger.error(`job workflow threw: ${(e as Error).message}`)
  }
  const { data: [ps] } = await query.graph({
    entity: "payment_session",
    fields: ["id", "status", "payment.id", "payment.captured_at", "payment.captures.id"],
    filters: { id: session.id },
  })
  logger.info(`end state: ${JSON.stringify(ps)}`)
  globalThis.fetch = realFetch
}
