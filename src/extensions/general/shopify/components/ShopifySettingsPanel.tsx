'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { KeyIcon, ShoppingBagIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { AttnLine } from '@/components/ui/attn-line'
import { useToast } from '@/components/ui/use-toast'
import { failureDescription } from '@/lib/browser/action-failure'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { FeedConnectorPanel } from '@/components/extensions/shared/FeedConnectorPanel'
import { CountryAccountRulesForm } from '@/components/orders/CountryAccountRulesForm'
import { PaymentMethodMappingForm } from '@/components/orders/PaymentMethodMappingForm'
import {
  shippingCountryWithheld as shippingCountryWithheldIn,
  shopifyRequest,
  syncSummary,
  SHOPIFY_CONNECT_TIMEOUT_MS,
  SHOPIFY_SYNC_TIMEOUT_MS,
  type ShopifySyncPayload,
} from '../lib/settings-actions'
import { MAX_BACKFILL_YEARS } from '../types'
import type { ShopifyStatusResponse } from '../types'

type ConnectionInfo = NonNullable<ShopifyStatusResponse['connection']>

/**
 * Shopify on the shared feed panel. Connecting takes the merchant's own
 * custom-app credentials (Dev Dashboard), verified against the store before
 * anything is stored.
 */
export default function ShopifySettingsPanel() {
  const t = useTranslations('shopify')
  const tf = useTranslations('feed_connector')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [shopDomain, setShopDomain] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [connecting, setConnecting] = useState(false)
  // Learned from the last sync or backfill in this session: the store
  // withholds shipping addresses, so orders carry no destination country.
  const [shippingCountryWithheld, setShippingCountryWithheld] = useState(false)

  return (
    <FeedConnectorPanel<ConnectionInfo, ShopifySyncPayload>
      extensionId="shopify"
      namespace="shopify"
      icon={ShoppingBagIcon}
      request={shopifyRequest}
      syncTimeoutMs={SHOPIFY_SYNC_TIMEOUT_MS}
      maxBackfillYears={MAX_BACKFILL_YEARS}
      summarize={syncSummary}
      identity={(c) => ({
        name: c.shop_name || c.shop_domain || t('unnamed_store'),
        detail: c.shop_name ? c.shop_domain : null,
      })}
      lastSyncedAt={(c) => c.last_order_synced_at}
      onSyncPayload={(payload) => {
        const withheld = shippingCountryWithheldIn(payload)
        if (withheld !== null) setShippingCountryWithheld(withheld)
      }}
      renderNotes={(c) =>
        c.status === 'active' && shippingCountryWithheld ? (
          <AttnLine className="mt-1">{t('shipping_country_withheld')}</AttnLine>
        ) : null
      }
      // The store scope is the shop domain as stored (client twin of
      // shopifyShopScope(), which is the identity).
      renderExtras={(c) =>
        c.status === 'active' && c.shop_domain ? (
          <>
            <PaymentMethodMappingForm platform="shopify" storeScope={c.shop_domain} />
            <CountryAccountRulesForm platform="shopify" storeScope={c.shop_domain} />
          </>
        ) : null
      }
      renderConnect={({ reload, failureCopy }) => {
        async function handleConnect() {
          if (connecting) return
          setConnecting(true)
          try {
            const result = await shopifyRequest({
              url: '/api/extensions/ext/shopify/connect',
              body: { shop_domain: shopDomain, client_id: clientId, client_secret: clientSecret },
              locale,
              timeoutMs: SHOPIFY_CONNECT_TIMEOUT_MS,
            })
            if (!result.ok) {
              toast({
                title: tf('connect_failed_title'),
                description: failureDescription(result, failureCopy),
                variant: 'destructive',
              })
              return
            }
            toast({ title: t('connected_toast_title'), description: t('connected_toast_description') })
            setClientId('')
            setClientSecret('')
            await reload()
          } finally {
            setConnecting(false)
          }
        }
        return (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('connect_hint')}</p>
            <div className="space-y-2">
              <Label htmlFor="shopify-shop-domain">{t('shop_domain_label')}</Label>
              <Input
                id="shopify-shop-domain"
                inputMode="url"
                placeholder="minbutik.myshopify.com"
                value={shopDomain}
                onChange={(e) => setShopDomain(e.target.value)}
                disabled={connecting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="shopify-client-id">{t('client_id_label')}</Label>
              <Input
                id="shopify-client-id"
                autoComplete="off"
                value={clientId}
                onChange={(e) => setClientId(e.target.value)}
                disabled={connecting}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="shopify-client-secret">{t('client_secret_label')}</Label>
              <Input
                id="shopify-client-secret"
                type="password"
                autoComplete="off"
                value={clientSecret}
                onChange={(e) => setClientSecret(e.target.value)}
                disabled={connecting}
              />
            </div>
            <Button
              onClick={handleConnect}
              disabled={!shopDomain || !clientId || !clientSecret}
              loading={connecting}
            >
              {!connecting && <KeyIcon className="h-4 w-4" />}
              {connecting ? tf('connecting') : t('connect')}
            </Button>
          </div>
        )
      }}
    />
  )
}
