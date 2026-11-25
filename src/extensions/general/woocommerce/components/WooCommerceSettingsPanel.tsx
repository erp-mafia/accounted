'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { KeyIcon, LinkIcon, ShoppingCartIcon } from '@/components/icons'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { failureDescription } from '@/lib/browser/action-failure'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { PaymentMethodMappingForm } from '@/components/orders/PaymentMethodMappingForm'
import { FeedConnectorPanel } from '@/components/extensions/shared/FeedConnectorPanel'
import {
  wooRequest,
  syncSummary,
  WOO_CONNECT_TIMEOUT_MS,
  WOO_SYNC_TIMEOUT_MS,
  type WooSyncPayload,
} from '../lib/settings-actions'
import { KEY_SUFFIX_LENGTH, MAX_BACKFILL_YEARS } from '../types'
import type { WooCommerceConnectionStatusView } from '../types'

/** "#1042 (2026-08-01)": the order number the store shows, plus its date. */
function skippedOrderLabel(order: { order_number: string; order_date: string | null }): string {
  return order.order_date ? `#${order.order_number} (${order.order_date})` : `#${order.order_number}`
}

/** Client twin of wooStoreScope(): store identity used by the mapping table. */
function storeScopeOf(storeUrl: string): string {
  return storeUrl.replace(/^https:\/\//, '')
}

/**
 * The last step of the store's authorization handshake: the store goes live
 * once the user types the last characters of the new key, which only the
 * store's own admin shows (POST /verify-store).
 */
function StoreProofForm({ connectionId, reload }: { connectionId: string; reload: () => Promise<void> }) {
  const t = useTranslations('woocommerce')
  const tf = useTranslations('feed_connector')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [suffix, setSuffix] = useState('')
  const [verifying, setVerifying] = useState(false)
  const inputId = `woocommerce-key-suffix-${connectionId}`

  async function handleVerify() {
    if (verifying) return
    setVerifying(true)
    try {
      const result = await wooRequest({
        url: '/api/extensions/ext/woocommerce/verify-store',
        body: { connection_id: connectionId, key_suffix: suffix },
        locale,
      })
      if (!result.ok) {
        toast({
          title: tf('connect_failed_title'),
          description: failureDescription(result, { timeout: t('action_timeout'), network: t('action_network') }),
          variant: 'destructive',
        })
        // A refusal may have closed the attempt (expired, store taken): show it.
        await reload()
        return
      }
      toast({ title: t('connected_toast_title'), description: t('connected_toast_description') })
      await reload()
    } finally {
      setVerifying(false)
    }
  }

  return (
    <div className="max-w-prose space-y-2 border-t-hairline pt-4">
      <p className="text-sm font-medium">{t('proof_title')}</p>
      <p className="text-sm text-muted-foreground">{t('proof_hint', { count: KEY_SUFFIX_LENGTH })}</p>
      <Label htmlFor={inputId}>{t('proof_label', { count: KEY_SUFFIX_LENGTH })}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          id={inputId}
          className="w-40 font-mono"
          autoComplete="off"
          spellCheck={false}
          value={suffix}
          onChange={(e) => setSuffix(e.target.value)}
          disabled={verifying}
        />
        <Button onClick={handleVerify} disabled={!suffix.trim()} loading={verifying}>
          {verifying ? t('proof_verifying') : t('proof_submit')}
        </Button>
      </div>
    </div>
  )
}

/**
 * WooCommerce on the shared feed panel. A company may connect several stores,
 * so the connect controls stay open; connecting is the store's own
 * authorization handshake, or pasted REST keys when that cannot run.
 */
export default function WooCommerceSettingsPanel() {
  const t = useTranslations('woocommerce')
  const tf = useTranslations('feed_connector')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [storeUrl, setStoreUrl] = useState('')
  const [manualMode, setManualMode] = useState(false)
  const [consumerKey, setConsumerKey] = useState('')
  const [consumerSecret, setConsumerSecret] = useState('')
  const [connecting, setConnecting] = useState(false)

  return (
    <FeedConnectorPanel<WooCommerceConnectionStatusView, WooSyncPayload>
      extensionId="woocommerce"
      namespace="woocommerce"
      icon={ShoppingCartIcon}
      request={wooRequest}
      syncTimeoutMs={WOO_SYNC_TIMEOUT_MS}
      maxBackfillYears={MAX_BACKFILL_YEARS}
      summarize={syncSummary}
      multiple
      identity={(c) => ({
        name: c.store_name || c.store_url || t('unnamed_store'),
        detail: c.store_name ? c.store_url : null,
      })}
      lastSyncedAt={(c) => c.last_order_synced_at}
      connectErrorMessage={(code) =>
        code === 'denied'
          ? t('error_denied')
          : code === 'wrong_user'
            ? t('error_wrong_user')
            : code === 'expired'
              ? t('error_expired')
              : code === 'conflict'
                ? t('error_conflict')
                : t('error_generic')
      }
      // Orders skipped for an unusable currency get their own sentence on any
      // counted outcome: syncing again does not bring them in.
      syncNote={(outcome) =>
        'values' in outcome && outcome.values.unknownCurrency > 0
          ? t('sync_unknown_currency', { count: outcome.values.unknownCurrency })
          : null
      }
      renderExtras={(c, { reload }) => {
        const skipped = c.skipped_currency_orders
        const skippedMore = skipped ? skipped.count - skipped.orders.length : 0
        return (
          <>
            {c.status === 'pending' && <StoreProofForm connectionId={c.id} reload={reload} />}
            {skipped && skipped.count > 0 && (
              // Orders the sync skipped for an unusable currency stay listed
              // until a sync imports them: the cursor has moved past them, so
              // this is the only lasting trace (lib/skipped-orders).
              <div className="max-w-prose space-y-1 border-t-hairline pt-4">
                <p className="attn text-xs">{t('skipped_orders_attn', { count: skipped.count })}</p>
                <p className="text-sm text-muted-foreground">{t('skipped_orders_help')}</p>
                <p className="text-sm text-muted-foreground">
                  {t('skipped_orders_list', { orders: skipped.orders.map(skippedOrderLabel).join(', ') })}
                  {skippedMore > 0 ? ` ${t('skipped_orders_more', { count: skippedMore })}` : ''}
                </p>
              </div>
            )}
            {c.status === 'active' && c.store_url && (
              <PaymentMethodMappingForm platform="woocommerce" storeScope={storeScopeOf(c.store_url)} />
            )}
          </>
        )
      }}
      renderConnect={({ reload, hasActive, failureCopy }) => {
        async function handleConnect() {
          if (connecting) return
          setConnecting(true)
          try {
            const result = await wooRequest<{ url?: string }>({
              url: '/api/extensions/ext/woocommerce/connect',
              body: { store_url: storeUrl },
              locale,
              timeoutMs: WOO_CONNECT_TIMEOUT_MS,
            })
            if (!result.ok || !result.data?.url) {
              toast({
                title: tf('connect_failed_title'),
                description: result.ok ? t('error_generic') : failureDescription(result, failureCopy),
                variant: 'destructive',
              })
              return
            }
            window.location.href = result.data.url
          } finally {
            setConnecting(false)
          }
        }

        async function handleManualConnect() {
          if (connecting) return
          setConnecting(true)
          try {
            const result = await wooRequest({
              url: '/api/extensions/ext/woocommerce/manual-connect',
              body: { store_url: storeUrl, consumer_key: consumerKey, consumer_secret: consumerSecret },
              locale,
              timeoutMs: WOO_CONNECT_TIMEOUT_MS,
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
            setConsumerKey('')
            setConsumerSecret('')
            setStoreUrl('')
            setManualMode(false)
            await reload()
          } finally {
            setConnecting(false)
          }
        }

        return (
          <div className="space-y-4">
            {hasActive && <p className="text-sm font-medium">{t('add_store')}</p>}
            <div className="space-y-2">
              <Label htmlFor="woocommerce-store-url">{t('store_url_label')}</Label>
              <Input
                id="woocommerce-store-url"
                type="url"
                inputMode="url"
                placeholder="https://minbutik.se"
                value={storeUrl}
                onChange={(e) => setStoreUrl(e.target.value)}
                disabled={connecting}
              />
            </div>

            {manualMode ? (
              <div className="space-y-4 rounded-lg p-4 bg-control shadow-raised">
                <p className="text-sm text-muted-foreground">{t('manual_hint')}</p>
                <div className="space-y-2">
                  <Label htmlFor="woocommerce-consumer-key">{t('consumer_key_label')}</Label>
                  <Input
                    id="woocommerce-consumer-key"
                    autoComplete="off"
                    placeholder="ck_..."
                    value={consumerKey}
                    onChange={(e) => setConsumerKey(e.target.value)}
                    disabled={connecting}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="woocommerce-consumer-secret">{t('consumer_secret_label')}</Label>
                  <Input
                    id="woocommerce-consumer-secret"
                    type="password"
                    autoComplete="off"
                    placeholder="cs_..."
                    value={consumerSecret}
                    onChange={(e) => setConsumerSecret(e.target.value)}
                    disabled={connecting}
                  />
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    onClick={handleManualConnect}
                    disabled={!storeUrl || !consumerKey || !consumerSecret}
                    loading={connecting}
                  >
                    {!connecting && <KeyIcon className="h-4 w-4" />}
                    {connecting ? tf('connecting') : t('manual_connect')}
                  </Button>
                  <Button variant="ghost" onClick={() => setManualMode(false)} disabled={connecting}>
                    {tf('cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={handleConnect} disabled={!storeUrl} loading={connecting}>
                    {!connecting && <LinkIcon className="h-4 w-4" />}
                    {connecting ? tf('connecting') : t('connect')}
                  </Button>
                  <Button variant="ghost" onClick={() => setManualMode(true)} disabled={connecting}>
                    {t('manual_toggle')}
                  </Button>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">{t('connect_hint')}</p>
              </div>
            )}
          </div>
        )
      }}
    />
  )
}
