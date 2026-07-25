'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { useFormat } from '@/lib/hooks/use-format'
import { CreditCard, Link2, Loader2, RefreshCw, Unlink } from 'lucide-react'
import type { StripeStatusResponse } from '../types'

type ConnectionInfo = NonNullable<StripeStatusResponse['connection']>

const STATUS_VARIANT: Record<ConnectionInfo['status'], 'success' | 'secondary' | 'destructive' | 'warning'> = {
  active: 'success',
  pending: 'secondary',
  revoked: 'warning',
  error: 'destructive',
}

export default function StripeSettingsPanel() {
  const t = useTranslations('settings_payments')
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { formatDateLong } = useFormat()

  const [loading, setLoading] = useState(true)
  const [configured, setConfigured] = useState(false)
  const [connection, setConnection] = useState<ConnectionInfo | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [togglingTransactionSync, setTogglingTransactionSync] = useState(false)

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/extensions/ext/stripe/status')
      if (!res.ok) return
      const data = (await res.json()) as StripeStatusResponse
      setConfigured(data.configured)
      setConnection(data.connection)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  // Consume the one-shot OAuth bounce-back params (?stripe_connected=true /
  // ?stripe_error=...) off the render path, mirroring the banking section.
  useEffect(() => {
    const connected = searchParams.get('stripe_connected')
    const error = searchParams.get('stripe_error')
    if (!connected && !error) return

    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      if (connected) {
        toast({ title: t('connected_toast_title'), description: t('connected_toast_description') })
      } else if (error) {
        // useSearchParams().get() already returns the decoded value; do not decode again.
        let message = error
        if (message === 'account_already_connected') message = t('error_account_already_connected')
        else if (message === 'access_denied') message = t('error_access_denied')
        else if (['invalid_state', 'missing_parameters', 'connection_failed', 'activation_failed'].includes(message)) {
          message = t('error_generic')
        }
        toast({ title: t('connect_failed_title'), description: message, variant: 'destructive' })
      }
      router.replace('/import?mode=stripe')
    })
    return () => { cancelled = true }
  }, [searchParams, router, toast, t])

  async function handleConnect() {
    setConnecting(true)
    try {
      const res = await fetch('/api/extensions/ext/stripe/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = (await res.json()) as { url?: string; error?: string }
      if (!res.ok || !data.url) {
        toast({
          title: t('connect_failed_title'),
          description: data.error || t('error_generic'),
          variant: 'destructive',
        })
        return
      }
      window.location.href = data.url
    } catch {
      toast({ title: t('connect_failed_title'), description: t('error_generic'), variant: 'destructive' })
    } finally {
      setConnecting(false)
    }
  }

  async function handleSyncNow() {
    setSyncing(true)
    try {
      const res = await fetch('/api/extensions/ext/stripe/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      const data = (await res.json().catch(() => ({}))) as {
        transactions?: { fetched?: number; imported?: number; linked?: number }
        error?: string
      }
      if (!res.ok) {
        toast({
          title: t('sync_failed_title'),
          description: data.error || t('error_generic'),
          variant: 'destructive',
        })
        return
      }
      // Honest summary: report what Stripe actually returned. An all-zero
      // run is a real answer ("the account had nothing in the window"), not
      // a silent success.
      const fetched = data.transactions?.fetched ?? 0
      toast({
        title: t('sync_done_title'),
        description:
          fetched === 0
            ? t('sync_done_empty')
            : t('sync_done_feed', {
                fetched,
                imported: data.transactions?.imported ?? 0,
                linked: data.transactions?.linked ?? 0,
              }),
      })
      await loadStatus()
    } finally {
      setSyncing(false)
    }
  }

  async function handleToggleTransactionSync(enabled: boolean) {
    setTogglingTransactionSync(true)
    try {
      const res = await fetch('/api/extensions/ext/stripe/transaction-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        toast({
          title: t('transaction_sync_toggle_failed'),
          description: data.error,
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
    } catch {
      toast({ title: t('transaction_sync_toggle_failed'), variant: 'destructive' })
    } finally {
      setTogglingTransactionSync(false)
    }
  }

  async function handleDisconnect() {
    if (!connection) return
    setDisconnecting(true)
    try {
      const res = await fetch('/api/extensions/ext/stripe/disconnect', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connection.id }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        toast({
          title: t('disconnect_failed_title'),
          description: data.error || t('error_generic'),
          variant: 'destructive',
        })
        return
      }
      toast({ title: t('disconnected_toast_title') })
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

  if (!configured) {
    // Self-hosted without STRIPE_CONNECT_CLIENT_ID: honest configuration
    // message, for these admins it's a setup task, not a launch.
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

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6 pt-0">
        <p className="text-sm text-muted-foreground">{t('description')}</p>

        {connection ? (
          <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border p-4">
            <div className="flex items-center gap-3">
              <CreditCard className="h-5 w-5 text-muted-foreground" />
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">
                    {connection.display_name || connection.stripe_account_id || t('unnamed_account')}
                  </span>
                  <Badge variant={STATUS_VARIANT[connection.status]}>
                    {t(`status_${connection.status}`)}
                  </Badge>
                  {!connection.livemode && isActive && (
                    <Badge variant="warning">{t('test_mode')}</Badge>
                  )}
                </div>
                {isActive && connection.connected_at && (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {t('connected_since', { date: formatDateLong(connection.connected_at) })}
                  </p>
                )}
                {connection.error_message && connection.status !== 'active' && (
                  <p className="mt-1 text-sm text-destructive">{connection.error_message}</p>
                )}
              </div>
            </div>
            {isActive ? (
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
            ) : (
              <Button onClick={handleConnect} disabled={connecting}>
                <Link2 className="mr-2 h-4 w-4" />
                {connecting ? t('connecting') : t('connect')}
              </Button>
            )}
          </div>
        ) : (
          <div>
            <Button onClick={handleConnect} disabled={connecting}>
              <Link2 className="mr-2 h-4 w-4" />
              {connecting ? t('connecting') : t('connect')}
            </Button>
            <p className="mt-3 text-sm text-muted-foreground">{t('connect_hint')}</p>
          </div>
        )}

        {isActive && connection && (
          <div className="flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border p-4">
            <div className="min-w-0 max-w-prose space-y-1">
              <p className="text-sm font-medium">{t('transaction_sync_title')}</p>
              <p className="text-sm text-muted-foreground">
                {t('transaction_sync_description')}
              </p>
              {connection.transaction_sync_enabled ? (
                <p className="text-xs text-muted-foreground">
                  {connection.last_balance_txn_synced_at
                    ? t('transaction_sync_last_synced', {
                        date: formatDateLong(connection.last_balance_txn_synced_at),
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
