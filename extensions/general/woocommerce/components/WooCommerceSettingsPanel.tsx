'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter, useSearchParams } from 'next/navigation'
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
import { KeyRound, Link2, Loader2, RefreshCw, ShoppingCart, Unlink } from 'lucide-react'
import {
  wooRequest,
  syncSummary,
  WOO_CONNECT_TIMEOUT_MS,
  WOO_SYNC_TIMEOUT_MS,
  type WooSyncPayload,
} from '../lib/settings-actions'
import type { WooCommerceStatusResponse } from '../types'

type ConnectionInfo = NonNullable<WooCommerceStatusResponse['connection']>

const STATUS_VARIANT: Record<ConnectionInfo['status'], 'success' | 'secondary' | 'destructive' | 'warning'> = {
  active: 'success',
  pending: 'secondary',
  revoked: 'warning',
  error: 'destructive',
}

export default function WooCommerceSettingsPanel() {
  const t = useTranslations('woocommerce')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { formatDateLong } = useFormat()

  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [connection, setConnection] = useState<ConnectionInfo | null>(null)
  const [storeUrl, setStoreUrl] = useState('')
  const [manualMode, setManualMode] = useState(false)
  const [consumerKey, setConsumerKey] = useState('')
  const [consumerSecret, setConsumerSecret] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [togglingTransactionSync, setTogglingTransactionSync] = useState(false)

  const failureCopy = { timeout: t('action_timeout'), network: t('action_network') }

  const loadStatus = useCallback(async () => {
    // A failed status read must never render as "not configured" (see the
    // Stripe panel: that copy sends the user to an administrator for nothing).
    const result = await wooRequest<WooCommerceStatusResponse>({
      url: '/api/extensions/ext/woocommerce/status',
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

  // Consume the one-shot handshake bounce-back params off the render path,
  // mirroring the Stripe/banking sections.
  useEffect(() => {
    const connected = searchParams.get('woocommerce_connected')
    const error = searchParams.get('woocommerce_error')
    if (!connected && !error) return

    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      if (connected) {
        toast({ title: t('connected_toast_title'), description: t('connected_toast_description') })
      } else if (error) {
        const message = error === 'denied' ? t('error_denied') : t('error_generic')
        toast({ title: t('connect_failed_title'), description: message, variant: 'destructive' })
      }
      router.replace('/import?mode=woocommerce')
    })
    return () => { cancelled = true }
  }, [searchParams, router, toast, t])

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
          title: t('connect_failed_title'),
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
        body: {
          store_url: storeUrl,
          consumer_key: consumerKey,
          consumer_secret: consumerSecret,
        },
        locale,
        timeoutMs: WOO_CONNECT_TIMEOUT_MS,
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
      setConsumerKey('')
      setConsumerSecret('')
      setManualMode(false)
      await loadStatus()
    } finally {
      setConnecting(false)
    }
  }

  async function handleSyncNow() {
    if (syncing) return
    setSyncing(true)
    try {
      const result = await wooRequest<WooSyncPayload>({
        url: '/api/extensions/ext/woocommerce/sync',
        locale,
        timeoutMs: WOO_SYNC_TIMEOUT_MS,
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
      const result = await wooRequest({
        url: '/api/extensions/ext/woocommerce/transaction-sync',
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
      const result = await wooRequest({
        url: '/api/extensions/ext/woocommerce/disconnect',
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
      // The key still exists in the store's wp-admin; only the merchant can
      // delete it there, so the toast says so.
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
              <ShoppingCart className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {connection.store_name || connection.store_url || t('unnamed_store')}
                  </span>
                  <Badge variant={STATUS_VARIANT[connection.status]}>
                    {t(`status_${connection.status}`)}
                  </Badge>
                </div>
                {connection.store_name && (
                  <p className="mt-1 text-sm text-muted-foreground">{connection.store_url}</p>
                )}
                {isActive && connection.connected_at && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('connected_since', { date: formatDateLong(connection.connected_at) })}
                  </p>
                )}
                {connection.status === 'pending' && (
                  <p className="mt-1 text-sm text-muted-foreground">{t('pending_note')}</p>
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
              <div className="space-y-4 rounded-lg border border-border p-4">
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
                <div className="flex items-center gap-2">
                  <Button
                    onClick={handleManualConnect}
                    disabled={connecting || !storeUrl || !consumerKey || !consumerSecret}
                  >
                    {connecting ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <KeyRound className="mr-2 h-4 w-4" />
                    )}
                    {connecting ? t('connecting') : t('manual_connect')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setManualMode(false)}
                    disabled={connecting}
                  >
                    {t('cancel')}
                  </Button>
                </div>
              </div>
            ) : (
              <div>
                <div className="flex items-center gap-2">
                  <Button onClick={handleConnect} disabled={connecting || !storeUrl}>
                    {connecting ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : (
                      <Link2 className="mr-2 h-4 w-4" />
                    )}
                    {connecting ? t('connecting') : t('connect')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setManualMode(true)}
                    disabled={connecting}
                  >
                    {t('manual_toggle')}
                  </Button>
                </div>
                <p className="mt-3 text-sm text-muted-foreground">{t('connect_hint')}</p>
              </div>
            )}
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
