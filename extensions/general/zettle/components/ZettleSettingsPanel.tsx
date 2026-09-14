'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { useFormat } from '@/lib/hooks/use-format'
import { failureDescription } from '@/lib/browser/action-failure'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { CreditCard, Link2, Loader2, RefreshCw, Unlink } from 'lucide-react'
import {
  zettleRequest,
  syncSummary,
  ZETTLE_CONNECT_TIMEOUT_MS,
  ZETTLE_SYNC_TIMEOUT_MS,
  type ZettleSyncPayload,
} from '../lib/settings-actions'
import {
  ZETTLE_ORGANIZATION_NAME_MAX_LEN,
  zettleStoreDisplayName,
} from '../lib/organization-name'
import type { ZettleStatusResponse } from '../types'

type ConnectionInfo = NonNullable<ZettleStatusResponse['connection']>

const STATUS_VARIANT: Record<ConnectionInfo['status'], 'success' | 'secondary' | 'destructive' | 'warning'> = {
  active: 'success',
  pending: 'secondary',
  revoked: 'warning',
  error: 'destructive',
}

export default function ZettleSettingsPanel() {
  const t = useTranslations('zettle')
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
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [togglingTransactionSync, setTogglingTransactionSync] = useState(false)
  const [storeNameDraft, setStoreNameDraft] = useState('')
  const [savingStoreName, setSavingStoreName] = useState(false)

  const failureCopy = { timeout: t('action_timeout'), network: t('action_network') }

  const loadStatus = useCallback(async () => {
    const result = await zettleRequest<ZettleStatusResponse>({
      url: '/api/extensions/ext/zettle/status',
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
    // Never seed the editable field with the org UUID: that is an opaque id,
    // and saving it would lock the UUID in as the merchant-facing store name.
    setStoreNameDraft(
      result.data.connection
        ? zettleStoreDisplayName(result.data.connection.organization_name)
        : '',
    )
  }, [locale])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  useEffect(() => {
    const connected = searchParams.get('zettle_connected')
    const error = searchParams.get('zettle_error')
    if (!connected && !error) return
    if (connected === 'true') {
      toast({ title: t('connected_toast_title'), description: t('connected_toast_description') })
    } else if (error) {
      // searchParams.get already returns the decoded value; decoding again
      // throws URIError when the message contains a literal % character.
      toast({
        title: t('connect_failed_title'),
        description: error,
        variant: 'destructive',
      })
    }
    router.replace('/import?mode=zettle')
  }, [searchParams, toast, t, router])

  function retryLoadStatus() {
    setLoading(true)
    void loadStatus()
  }

  async function handleConnect() {
    if (connecting) return
    setConnecting(true)
    try {
      const result = await zettleRequest<{ url?: string }>({
        url: '/api/extensions/ext/zettle/connect',
        locale,
        timeoutMs: ZETTLE_CONNECT_TIMEOUT_MS,
      })
      if (!result.ok) {
        toast({
          title: t('connect_failed_title'),
          description: failureDescription(result, failureCopy),
          variant: 'destructive',
        })
        return
      }
      if (!result.data?.url) {
        toast({ title: t('connect_failed_title'), variant: 'destructive' })
        return
      }
      window.location.href = result.data.url
    } finally {
      setConnecting(false)
    }
  }

  async function handleSyncNow() {
    if (syncing) return
    setSyncing(true)
    try {
      const result = await zettleRequest<ZettleSyncPayload>({
        url: '/api/extensions/ext/zettle/sync',
        locale,
        timeoutMs: ZETTLE_SYNC_TIMEOUT_MS,
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
      const result = await zettleRequest({
        url: '/api/extensions/ext/zettle/transaction-sync',
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

  async function handleSaveStoreName() {
    if (!connection || connection.status !== 'active' || savingStoreName) return
    const next = storeNameDraft.trim().replace(/\s+/g, ' ')
    const stored = (connection.organization_name ?? '').trim().replace(/\s+/g, ' ')
    // Compare to the stored value (not the display fallback) so a null DB
    // name can still be persisted as the default and backfill existing orders.
    if (!next || next === stored) return
    setSavingStoreName(true)
    try {
      const result = await zettleRequest<{ organization_name?: string; warning?: string }>({
        url: '/api/extensions/ext/zettle/organization-name',
        body: { organization_name: next },
        locale,
      })
      if (!result.ok) {
        toast({
          title: t('store_name_save_failed'),
          description: failureDescription(result, failureCopy),
          variant: 'destructive',
        })
        return
      }
      const saved = result.data?.organization_name ?? next
      // Functional update: sync/toggle can refresh connection while rename awaits.
      setConnection((current) =>
        current ? { ...current, organization_name: saved } : current,
      )
      setStoreNameDraft(saved)
      toast({
        title: t('store_name_saved_toast'),
        description: result.data?.warning ? t('store_name_saved_orders_warning') : undefined,
      })
    } finally {
      setSavingStoreName(false)
    }
  }

  async function handleDisconnect() {
    if (!connection || disconnecting) return
    setDisconnecting(true)
    try {
      const result = await zettleRequest({
        url: '/api/extensions/ext/zettle/disconnect',
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
  const showConnect = !connection || !isActive

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6 pt-0">
        <p className="text-sm text-muted-foreground">{t('description')}</p>

        {connection && (
          <div className="space-y-4 rounded-lg border border-border p-4">
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex items-center gap-3">
                <CreditCard className="h-5 w-5 text-muted-foreground" />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium">
                      {zettleStoreDisplayName(connection.organization_name)}
                    </span>
                    <Badge variant={STATUS_VARIANT[connection.status]}>
                      {t(`status_${connection.status}`)}
                    </Badge>
                  </div>
                  {connection.organization_uuid && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {connection.organization_uuid}
                    </p>
                  )}
                  {isActive && connection.connected_at && (
                    <p className="mt-1 text-sm text-muted-foreground">
                      {t('connected_since', { date: formatDateLong(connection.connected_at) })}
                    </p>
                  )}
                  {connection.error_message && (
                    <p className="mt-1 text-sm text-destructive">{connection.error_message}</p>
                  )}
                </div>
              </div>
              {isActive &&
                (confirmDisconnect ? (
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
                ))}
            </div>

            {isActive && (
              <div className="space-y-2 border-t border-border pt-4">
                <Label htmlFor="zettle-store-name">{t('store_name_label')}</Label>
                <p className="text-sm text-muted-foreground">{t('store_name_help')}</p>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    id="zettle-store-name"
                    value={storeNameDraft}
                    onChange={(e) => setStoreNameDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        void handleSaveStoreName()
                      }
                    }}
                    maxLength={ZETTLE_ORGANIZATION_NAME_MAX_LEN}
                    disabled={savingStoreName}
                    className="max-w-sm"
                    aria-label={t('store_name_label')}
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void handleSaveStoreName()}
                    disabled={
                      savingStoreName ||
                      !storeNameDraft.trim() ||
                      storeNameDraft.trim().replace(/\s+/g, ' ') ===
                        (connection.organization_name ?? '').trim().replace(/\s+/g, ' ')
                    }
                  >
                    {savingStoreName ? (
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    ) : null}
                    {savingStoreName ? t('store_name_saving') : t('store_name_save')}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        {showConnect && (
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">{t('connect_hint')}</p>
            <Button onClick={handleConnect} disabled={connecting}>
              {connecting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Link2 className="mr-2 h-4 w-4" />
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
