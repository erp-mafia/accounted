'use client'

import { useCallback, useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useRouter, useSearchParams } from 'next/navigation'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { useFormat } from '@/lib/hooks/use-format'
import { formatCurrency, formatDate } from '@/lib/utils'
import { CreditCard, Link2, RefreshCw, Unlink } from 'lucide-react'
import type { StripeReviewEvent, StripeStatusResponse } from '../types'

type ConnectionInfo = NonNullable<StripeStatusResponse['connection']>

const KNOWN_REVIEW_REASONS = new Set([
  'invoice_not_found',
  'invoice_already_paid',
  'amount_mismatch',
  'currency_mismatch',
  'non_sek_invoice',
])

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
  const [needsReviewCount, setNeedsReviewCount] = useState(0)
  const [needsReview, setNeedsReview] = useState<StripeReviewEvent[]>([])

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/extensions/ext/stripe/status')
      if (!res.ok) return
      const data = (await res.json()) as StripeStatusResponse
      setConfigured(data.configured)
      setConnection(data.connection)
      setNeedsReviewCount(data.needs_review_count ?? 0)
      setNeedsReview(data.needs_review ?? [])
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
      router.replace('/settings/payments')
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
        settled?: number
        needsReview?: number
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
      toast({
        title: t('sync_done_title'),
        description: t('sync_done_description', {
          settled: data.settled ?? 0,
          review: data.needsReview ?? 0,
        }),
      })
      await loadStatus()
    } finally {
      setSyncing(false)
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
    // Hosted: the Connect platform isn't live yet, so the whole integration
    // presents as "coming soon" (every server path is already a no-op without
    // STRIPE_CONNECT_CLIENT_ID). Self-hosted admins get the honest
    // configuration message instead: for them it's a setup task, not a launch.
    const isSelfHosted = process.env.NEXT_PUBLIC_SELF_HOSTED === 'true'
    if (isSelfHosted) {
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
    return (
      <Card>
        <CardContent className="p-0">
          <EmptyState
            icon={CreditCard}
            title={t('coming_soon_title')}
            description={t('coming_soon_description')}
          />
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
                    <RefreshCw className="mr-2 h-4 w-4" />
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

        {isActive && needsReviewCount > 0 && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
                {t('needs_review_title')}
              </h2>
              <Badge variant="warning">{needsReviewCount}</Badge>
            </div>
            <p className="text-sm text-muted-foreground">{t('needs_review_hint')}</p>
            <ul className="divide-y divide-border rounded-lg border border-border">
              {needsReview.map((event) => (
                <li key={event.id} className="flex items-center justify-between gap-4 px-4 py-3">
                  <div className="min-w-0">
                    <p className="text-sm">
                      {event.reason && KNOWN_REVIEW_REASONS.has(event.reason)
                        ? t(`reason_${event.reason}`)
                        : event.reason || t('reason_unknown')}
                    </p>
                    {event.event_created_at && (
                      <p className="text-xs text-muted-foreground tabular-nums">
                        {formatDate(event.event_created_at)}
                      </p>
                    )}
                  </div>
                  {event.amount != null && (
                    <span className="shrink-0 text-sm tabular-nums">
                      {formatCurrency(event.amount, event.currency ?? 'SEK')}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
