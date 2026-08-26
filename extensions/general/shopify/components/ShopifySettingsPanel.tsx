'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { useFormat } from '@/lib/hooks/use-format'
import { failureDescription } from '@/lib/browser/action-failure'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { KeyRound, Loader2, RefreshCw, ShoppingBag, Unlink } from 'lucide-react'
import {
  shopifyRequest,
  syncSummary,
  SHOPIFY_CONNECT_TIMEOUT_MS,
  SHOPIFY_SYNC_TIMEOUT_MS,
  type ShopifySyncPayload,
} from '../lib/settings-actions'
import type { ShopifyStatusResponse } from '../types'

type ConnectionInfo = NonNullable<ShopifyStatusResponse['connection']>

const STATUS_VARIANT: Record<ConnectionInfo['status'], 'success' | 'secondary' | 'destructive' | 'warning'> = {
  active: 'success',
  pending: 'secondary',
  revoked: 'warning',
  error: 'destructive',
}

export default function ShopifySettingsPanel() {
  const t = useTranslations('shopify')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const { formatDateLong } = useFormat()

  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [connection, setConnection] = useState<ConnectionInfo | null>(null)
  const [shopDomain, setShopDomain] = useState('')
  const [clientId, setClientId] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [togglingTransactionSync, setTogglingTransactionSync] = useState(false)

  const failureCopy = { timeout: t('action_timeout'), network: t('action_network') }

  const loadStatus = useCallback(async () => {
    // A failed status read must never render as "not configured" (see the
    // Stripe panel: that copy sends the user to an administrator for nothing).
    const result = await shopifyRequest<ShopifyStatusResponse>({
      url: '/api/extensions/ext/shopify/status',
      method: 'GET',
      locale,
    })
    setLoading(false)
    if (!result.ok || !result.data) {
      setLoadFailed(true)
      return
    }
    setLoadFailed(false)
    setConfigured(result.data.configured)
    setConnection(result.data.connection)
  }, [locale])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  function retryLoadStatus() {
    setLoading(true)
    void loadStatus()
  }

  async function handleConnect() {
    if (connecting) return
    setConnecting(true)
    try {
      const result = await shopifyRequest({
        url: '/api/extensions/ext/shopify/connect',
        body: {
          shop_domain: shopDomain,
          client_id: clientId,
          client_secret: clientSecret,
        },
        locale,
        timeoutMs: SHOPIFY_CONNECT_TIMEOUT_MS,
      })
      if (!result.ok) {
        toast({
          title: t('connect_failed_title'),
          description: failureDescription(result, failureCopy),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('connected_toast_title'), description: t('connected_toast_description') })
      setClientId('')
      setClientSecret('')
      await loadStatus()
    } finally {
      setConnecting(false)
    }
  }

  async function handleSyncNow() {
    if (syncing) return
    setSyncing(true)
    try {
      const result = await shopifyRequest<ShopifySyncPayload>({
        url: '/api/extensions/ext/shopify/sync',
        locale,
        timeoutMs: SHOPIFY_SYNC_TIMEOUT_MS,
      })
      if (!result.ok) {
        toast({
          title: t('sync_failed_title'),
          description: failureDescription(result, failureCopy),
          variant: 'destructive',
        })
        return
      }
      const summary = syncSummary(result.data)
      if (summary.reason === 'revoked') {
        toast({
          title: t('sync_failed_title'),
          description: t('sync_revoked'),
          variant: 'destructive',
        })
      } else if (summary.reason === 'partial') {
        toast({ title: t('sync_partial_title'), description: t('sync_partial', summary.values) })
      } else if (summary.reason === 'empty') {
        toast({ title: t('sync_done_title'), description: t('sync_done_empty') })
      } else if (summary.reason === 'errors') {
        toast({ title: t('sync_done_title'), description: t('sync_done_feed_errors', summary.values) })
      } else if (summary.reason === 'feed') {
        toast({ title: t('sync_done_title'), description: t('sync_done_feed', summary.values) })
      } else {
        toast({ title: t('sync_done_title') })
      }
      await loadStatus()
    } finally {
      setSyncing(false)
    }
  }

  async function handleToggleTransactionSync(enabled: boolean) {
    if (togglingTransactionSync) return
    setTogglingTransactionSync(true)
    try {
      const result = await shopifyRequest({
        url: '/api/extensions/ext/shopify/transaction-sync',
        body: { enabled },
        locale,
      })
      if (!result.ok) {
        toast({
          title: t('transaction_sync_toggle_failed'),
          description: failureDescription(result, failureCopy),
          variant: 'destructive',
        })
        return
      }
      toast({
        title: enabled
          ? t('transaction_sync_enabled_toast')
          : t('transaction_sync_disabled_toast'),
      })
      await loadStatus()
    } finally {
      setTogglingTransactionSync(false)
    }
  }

  async function handleDisconnect() {
    if (!connection || disconnecting) return
    setDisconnecting(true)
    try {
      const result = await shopifyRequest({
        url: '/api/extensions/ext/shopify/disconnect',
        method: 'DELETE',
        body: { connection_id: connection.id },
        locale,
      })
      if (!result.ok) {
        toast({
          title: t('disconnect_failed_title'),
          description: failureDescription(result, failureCopy),
          variant: 'destructive',
        })
        return
      }
      // The app still exists in the merchant's Shopify Dev Dashboard; only
      // they can delete it there, so the toast says so.
      toast({ title: t('disconnected_toast_title'), description: t('disconnected_toast_description') })
      setConfirmDisconnect(false)
      await loadStatus()
    } finally {
      setDisconnecting(false)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="space-y-3 p-6">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-4 w-72" />
          <Skeleton className="h-10 w-40" />
        </CardContent>
      </Card>
    )
  }

  if (loadFailed) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-0">
          <p className="text-sm text-destructive">{t('load_failed')}</p>
          <Button variant="outline" size="sm" onClick={retryLoadStatus}>
            <RefreshCw className="mr-2 h-4 w-4" />
            {tCommon('retry')}
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (!configured) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('title')}</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          <p className="text-sm text-muted-foreground">{t('not_configured')}</p>
        </CardContent>
      </Card>
    )
  }

  const isActive = connection?.status === 'active'
  const showConnectForm = !connection || !isActive

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6 pt-0">
        <p className="text-sm text-muted-foreground">{t('description')}</p>

        {connection && (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border p-4">
            <div className="flex items-center gap-3">
              <ShoppingBag className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {connection.shop_name || connection.shop_domain || t('unnamed_store')}
                  </span>
                  <Badge variant={STATUS_VARIANT[connection.status]}>
                    {t(`status_${connection.status}`)}
                  </Badge>
                </div>
                {connection.shop_name && (
                  <p className="mt-1 text-sm text-muted-foreground">{connection.shop_domain}</p>
                )}
                {isActive && connection.connected_at && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('connected_since', { date: formatDateLong(connection.connected_at) })}
                  </p>
                )}
                {connection.error_message && (
                  // Shown for active connections too: a sync that cannot run
                  // (e.g. cash-account currency conflict) must not hide
                  // behind a healthy-looking "Ansluten" badge.
                  <p className="mt-1 text-sm text-destructive">{connection.error_message}</p>
                )}
              </div>
            </div>
            {isActive && (
              confirmDisconnect ? (
                <div className="flex items-center gap-2">
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={handleDisconnect}
                    disabled={disconnecting}
                  >
                    {t('disconnect_confirm')}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setConfirmDisconnect(false)}
                    disabled={disconnecting}
                  >
                    {t('cancel')}
                  </Button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <Button variant="outline" size="sm" onClick={handleSyncNow} disabled={syncing}>
                    {syncing ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <RefreshCw className="mr-2 h-4 w-4" />
                    )}
                    {syncing ? t('syncing') : t('sync_now')}
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setConfirmDisconnect(true)}>
                    <Unlink className="mr-2 h-4 w-4" />
                    {t('disconnect')}
                  </Button>
                </div>
              )
            )}
          </div>
        )}

        {showConnectForm && (
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
              disabled={connecting || !shopDomain || !clientId || !clientSecret}
            >
              {connecting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <KeyRound className="mr-2 h-4 w-4" />
              )}
              {connecting ? t('connecting') : t('connect')}
            </Button>
          </div>
        )}

        {isActive && connection && (
          <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border p-4">
            <div className="min-w-0 max-w-prose space-y-1">
              <p className="text-sm font-medium">{t('transaction_sync_title')}</p>
              <p className="text-sm text-muted-foreground">{t('transaction_sync_description')}</p>
              {connection.transaction_sync_enabled ? (
                <p className="text-xs text-muted-foreground">
                  {connection.last_order_synced_at
                    ? t('transaction_sync_last_synced', {
                        date: formatDateLong(connection.last_order_synced_at),
                      })
                    : t('transaction_sync_never_synced')}
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t('transaction_sync_backfill_note')}
                </p>
              )}
            </div>
            <Switch
              checked={connection.transaction_sync_enabled}
              onCheckedChange={handleToggleTransactionSync}
              disabled={togglingTransactionSync}
              aria-label={t('transaction_sync_title')}
            />
          </div>
        )}
      </CardContent>
    </Card>
  )
}
