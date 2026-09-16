import { defineWidgetConfig } from "@medusajs/admin-sdk"
import { Badge, Container, Heading, Text } from "@medusajs/ui"
import { useEffect, useState } from "react"
import { sdk } from "../lib/sdk"

type ProviderCheck = {
  ok: boolean
  min_sendable_sats?: number
  max_sendable_sats?: number
  error?: string
}

type Settings = {
  configured: boolean
  providers: {
    lightning_address: string
    expiry_seconds: number
    check: ProviderCheck
  }[]
  glow_setup_url: string
  lnurl_domain: string
}

const formatExpiry = (seconds: number) =>
  seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`

const LightningSettingsWidget = () => {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    sdk.client
      .fetch<Settings>("/admin/lightning/settings")
      .then((data) => active && setSettings(data))
      .catch((e: Error) => active && setError(e.message))
    return () => {
      active = false
    }
  }, [])

  return (
    <Container className="divide-y p-0">
      <div className="flex items-center justify-between px-6 py-4">
        <div>
          <Heading level="h2">Bitcoin (Lightning)</Heading>
          <Text className="text-ui-fg-subtle" size="small">
            Payments go straight to your Glow wallet. Nothing is held by this store.
          </Text>
        </div>
        {settings?.configured ? (
          settings.providers.every((p) => p.check.ok) ? (
            <Badge color="green">Ready</Badge>
          ) : (
            <Badge color="red">Check failed</Badge>
          )
        ) : settings ? (
          <Badge color="orange">Not configured</Badge>
        ) : null}
      </div>

      {error && (
        <div className="px-6 py-4">
          <Text className="text-ui-fg-error" size="small">
            Could not load Lightning settings: {error}
          </Text>
        </div>
      )}

      {settings && !settings.configured && (
        <div className="px-6 py-4 flex flex-col gap-y-2">
          <Text size="small">
            1. Install Glow and copy your Lightning address (ends with @{settings.lnurl_domain}):{" "}
            <a
              className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover"
              href={settings.glow_setup_url}
              target="_blank"
              rel="noreferrer"
            >
              {settings.glow_setup_url}
            </a>
          </Text>
          <Text size="small">
            2. Add the provider to <code>medusa-config.ts</code> with{" "}
            <code>lightningAddress: "you@{settings.lnurl_domain}"</code> and restart.
          </Text>
          <Text size="small">3. Enable it for your regions under Settings, Regions.</Text>
        </div>
      )}

      {settings?.providers.map((p) => (
        <div key={p.lightning_address} className="px-6 py-4 grid grid-cols-2 gap-y-3 small:grid-cols-3">
          <Text size="small" className="text-ui-fg-subtle">
            Lightning address
          </Text>
          <Text size="small" className="small:col-span-2 font-mono">
            {p.lightning_address}
          </Text>

          <Text size="small" className="text-ui-fg-subtle">
            Address check
          </Text>
          <Text size="small" className="small:col-span-2">
            {p.check.ok
              ? `Resolves. Accepts ${p.check.min_sendable_sats?.toLocaleString()} to ${p.check.max_sendable_sats?.toLocaleString()} sats per payment.`
              : `Failed: ${p.check.error}`}
          </Text>

          <Text size="small" className="text-ui-fg-subtle">
            Invoice expiry
          </Text>
          <Text size="small" className="small:col-span-2">
            {formatExpiry(p.expiry_seconds)}
          </Text>

          <Text size="small" className="text-ui-fg-subtle">
            Wallet
          </Text>
          <Text size="small" className="small:col-span-2">
            <a
              className="text-ui-fg-interactive hover:text-ui-fg-interactive-hover"
              href={settings.glow_setup_url}
              target="_blank"
              rel="noreferrer"
            >
              Glow
            </a>
            . Refunds are sent from the wallet and recorded manually.
          </Text>
        </div>
      ))}
    </Container>
  )
}

export const config = defineWidgetConfig({
  zone: "store.details.after",
  id: "medusa-payment-lightning-settings",
})

export default LightningSettingsWidget
