'use client'

import { useCallback, useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { useFormat } from '@/lib/hooks/use-format'
import { failureDescription } from '@/lib/browser/action-failure'
import type { ErrorLocale } from '@/lib/errors/get-error-message'
import { CreditCard, History, Link2, RefreshCw, Unlink } from 'lucide-react'
import {
  stripeRequest,
  syncSummary,
  STRIPE_SYNC_TIMEOUT_MS,
  type StripeSyncPayload,
} from '../lib/settings-actions'
import { MAX_BACKFILL_YEARS } from '../types'
import type { StripeStatusResponse } from '../types'

type ConnectionInfo = NonNullable<StripeStatusResponse['connection']>

/** Bounds of the backfill date picker, mirroring parseBackfillFrom on the server. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function earliestBackfillDay(): string {
  const floor = new Date()
  floor.setUTCFullYear(floor.getUTCFullYear() - MAX_BACKFILL_YEARS)
  return isoDay(floor)
}

const STATUS_VARIANT: Record<ConnectionInfo['status'], 'secondary' | 'destructive' | 'warning' | null> = {
  // Active is the normal state: muted text, not a chip (chips mark exceptions).
  active: null,
  pending: 'secondary',
  revoked: 'warning',
  error: 'destructive',
}

export default function StripeSettingsPanel() {
  const t = useTranslations('settings_payments')
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
  const [backfillFrom, setBackfillFrom] = useState('')
  const [backfilling, setBackfilling] = useState(false)
  const [togglingTransactionSync, setTogglingTransactionSync] = useState(false)

  // The failure copy is the same sentence for every action here: all four calls
  // are quick writes whose outcome the panel itself reveals once reloaded, so a
  // timeout says "reload and check" and a dead connection says "check the
  // connection", regardless of which button was pressed.
  const failureCopy = { timeout: t('action_timeout'), network: t('action_network') }

  const loadStatus = useCallback(async () => {
    // A failed status read must never render as "not configured": that message
    // tells the user to contact an administrator about an installation that is
    // in fact configured, and it is what a swallowed error produced here.
    const result = await stripeRequest<StripeStatusResponse>({
      url: '/api/extensions/ext/stripe/status',
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
    if (connecting) return
    setConnecting(true)
    try {
      // The route ignores the request body, so none is sent.
      const result = await stripeRequest<{ url?: string }>({
        url: '/api/extensions/ext/stripe/connect',
        locale,
      })
      if (!result.ok || !result.data?.url) {
        toast({
          title: t('connect_failed_title'),
          description: result.ok
            // A 2xx with no url is a route bug: nothing more specific is known.
            ? t('error_generic')
            : failureDescription(result, failureCopy),
          variant: 'destructive',
        })
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
      const result = await stripeRequest<StripeSyncPayload>({
        url: '/api/extensions/ext/stripe/sync',
        locale,
        timeoutMs: STRIPE_SYNC_TIMEOUT_MS,
      })
      // Exactly one toast per outcome: TOAST_LIMIT is 1, so a second toast in
      // the same tick evicts the first and only the last one renders.
      if (!result.ok) {
        toast({
          title: t('sync_failed_title'),
          description: failureDescription(result, failureCopy),
          variant: 'destructive',
        })
        return
      }
      showSyncOutcome(result.data, t('sync_done_title'), t('sync_failed_title'))
      await loadStatus()
    } finally {
      setSyncing(false)
    }
  }

  /**
   * Same counts, two entry points: "Synka nu" and the explicit backfill.
   * Honest summary: report what Stripe actually returned. An all-zero run is
   * a real answer ("the account had nothing in the window"), a revoked
   * connection is not, and a body that never parsed is neither.
   */
  function showSyncOutcome(
    payload: StripeSyncPayload | null | undefined,
    doneTitle: string,
    failedTitle: string,
  ) {
    const summary = syncSummary(payload ?? null)
    if (summary.reason === 'revoked') {
      toast({ title: failedTitle, description: t('sync_revoked'), variant: 'destructive' })
    } else if (summary.reason === 'empty') {
      toast({ title: doneTitle, description: t('sync_done_empty') })
    } else if (summary.reason === 'errors') {
      toast({ title: doneTitle, description: t('sync_done_feed_errors', summary.values) })
    } else if (summary.reason === 'feed') {
      toast({ title: doneTitle, description: t('sync_done_feed', summary.values) })
    } else {
      // The sync ran, but the response never said what it did. Claim only that.
      toast({ title: doneTitle })
    }
  }

  async function handleBackfill() {
    if (backfilling) return
    if (!backfillFrom) {
      toast({
        title: t('backfill_failed_title'),
        description: t('backfill_missing_date'),
        variant: 'destructive',
      })
      return
    }
    setBackfilling(true)
    try {
      const result = await stripeRequest<StripeSyncPayload>({
        url: '/api/extensions/ext/stripe/backfill',
        body: { from: backfillFrom },
        locale,
        timeoutMs: STRIPE_SYNC_TIMEOUT_MS,
      })
      if (!result.ok) {
        toast({
          title: t('backfill_failed_title'),
          description: failureDescription(result, failureCopy),
          variant: 'destructive',
        })
        return
      }
      showSyncOutcome(result.data, t('backfill_done_title'), t('backfill_failed_title'))
      await loadStatus()
    } finally {
      setBackfilling(false)
    }
  }

  async function handleToggleTransactionSync(enabled: boolean) {
    if (togglingTransactionSync) return
    setTogglingTransactionSync(true)
    try {
      const result = await stripeRequest({
        url: '/api/extensions/ext/stripe/transaction-sync',
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
      const result = await stripeRequest({
        url: '/api/extensions/ext/stripe/disconnect',
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

  if (loadFailed) {
    // Kept strictly apart from `!configured` below: a status read that never
    // answered says nothing about whether Stripe is configured, and the user can
    // fix a dropped connection themselves. Recoverable, so it offers the retry.
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
                  {STATUS_VARIANT[connection.status] ? (
                    <Badge variant={STATUS_VARIANT[connection.status] ?? undefined}>
                      {t(`status_${connection.status}`)}
                    </Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">{t(`status_${connection.status}`)}</span>
                  )}
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
                  <Button variant="outline" size="sm" onClick={handleSyncNow} loading={syncing}>
                    {!syncing && <RefreshCw className="mr-2 h-4 w-4" />}
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

        {isActive && connection && (
          <div className="space-y-4 rounded-lg border border-border p-4">
            <div className="min-w-0 max-w-prose space-y-1">
              <p className="text-sm font-medium">{t('backfill_title')}</p>
              <p className="text-sm text-muted-foreground">{t('backfill_description')}</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Input
                type="date"
                className="w-48"
                value={backfillFrom}
                min={earliestBackfillDay()}
                max={isoDay(new Date())}
                onChange={(event) => setBackfillFrom(event.target.value)}
                aria-label={t('backfill_from_label')}
                disabled={backfilling}
              />
              <Button
                variant="outline"
                size="sm"
                onClick={handleBackfill}
                loading={backfilling}
              >
                {!backfilling && <History className="mr-2 h-4 w-4" />}
                {backfilling ? t('backfill_running') : t('backfill_submit')}
              </Button>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
