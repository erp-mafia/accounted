'use client'

/**
 * The settings panel of a cursor-based connector feed (Shopify, WooCommerce,
 * Zettle, Stripe): status, "Synka nu", disconnect, the nightly-sync toggle and
 * the backfill, against the shared routes in lib/feed-sync/connector-routes.
 *
 * Each connector carried its own ~500-line copy of this panel. A connector now
 * passes what is its own: the connect controls, how a connection is named,
 * its translation namespace for the sentences that name the provider, and
 * any extra lines or blocks. The sentences that are the same for every
 * connector live in the feed_connector namespace.
 */

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter, useSearchParams } from 'next/navigation'
import { ArrowPathIcon, ClockIcon, LinkSlashIcon, type Icon as AppIcon } from '@/components/icons'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { HelpPopover } from '@/components/ui/help-popover'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction, type ToastActionElement } from '@/components/ui/toast'
import { useFormat } from '@/lib/hooks/use-format'
import { failureDescription } from '@/lib/browser/action-failure'
import type { PanelRequestOptions, PanelRequestResult } from '@/lib/browser/panel-request'
import type { FeedSyncOutcome, FeedSyncPayload } from '@/lib/feed-sync/sync-outcome'
import type { ErrorLocale } from '@/lib/errors/get-error-message'

export interface FeedPanelConnection {
  id: string
  status: 'active' | 'pending' | 'revoked' | 'error'
  error_message: string | null
  connected_at: string | null
  transaction_sync_enabled: boolean
}

interface FeedStatusResponse<C> {
  configured: boolean
  connection?: C | null
  /** Connectors with several connections per company (WooCommerce stores). */
  connections?: C[]
}

/** What the connect controls need from the panel. */
export interface FeedConnectArgs {
  /** Re-read the status after a connect that completed in place. */
  reload: () => Promise<void>
  hasActive: boolean
  /** The connector's timeout and network sentences for failureDescription. */
  failureCopy: { timeout: string; network: string }
}

export interface FeedConnectorPanelProps<C extends FeedPanelConnection, P extends FeedSyncPayload> {
  /** URL segment of /api/extensions/ext/<id>/ and of the ?<id>_connected bounce. */
  extensionId: string
  /** The connector's own namespace: the sentences that name the provider. */
  namespace: string
  icon: AppIcon
  /** The connector's request helper, with its quick-call deadline. */
  request: <T>(options: PanelRequestOptions) => Promise<PanelRequestResult<T>>
  /** Deadline for "Synka nu" and the backfill: the route's ceiling plus margin. */
  syncTimeoutMs: number
  /** Bounds of the backfill date picker, mirroring parseBackfillFrom on the server. */
  maxBackfillYears: number
  summarize: (payload: P | null) => FeedSyncOutcome
  /** The connection's name and the muted line under it. */
  identity: (connection: C) => { name: string; detail: string | null }
  /** When the sync cursor last moved. */
  lastSyncedAt: (connection: C) => string | null
  /** The connect controls: a credentials form or an OAuth button. */
  renderConnect: (args: FeedConnectArgs) => ReactNode
  /** Several connections at once: the connect controls stay open. */
  multiple?: boolean
  /** Sentence for an error code the OAuth callback appended; raw text otherwise. */
  connectErrorMessage?: (code: string) => string
  /** Badges after the status (Stripe's test mode). */
  renderBadges?: (connection: C) => ReactNode
  /** Lines under the connection's name (a pending note, a permission notice). */
  renderNotes?: (connection: C) => ReactNode
  /** Blocks at the end of a connection's card. */
  renderExtras?: (connection: C) => ReactNode
  /** A sentence appended to the sync toast (WooCommerce's unusable-currency orders). */
  syncNote?: (outcome: FeedSyncOutcome) => string | null
  /** Sees every sync answer (Shopify learns whether the store withholds addresses). */
  onSyncPayload?: (payload: P | null) => void
}

const STATUS_VARIANT: Record<FeedPanelConnection['status'], 'secondary' | 'destructive' | 'warning' | null> = {
  // Active is the normal state: muted text, not a chip (chips mark exceptions).
  active: null,
  pending: 'secondary',
  revoked: 'warning',
  error: 'destructive',
}

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function earliestBackfillDay(maxYears: number): string {
  const floor = new Date()
  floor.setUTCFullYear(floor.getUTCFullYear() - maxYears)
  return isoDay(floor)
}

export function FeedConnectorPanel<C extends FeedPanelConnection, P extends FeedSyncPayload>(
  props: FeedConnectorPanelProps<C, P>,
) {
  const { extensionId, request, summarize, onSyncPayload, syncNote, connectErrorMessage } = props
  const t = useTranslations(props.namespace)
  const tf = useTranslations('feed_connector')
  const tCommon = useTranslations('common')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const { formatDateLong } = useFormat()
  const base = `/api/extensions/ext/${extensionId}`

  const [loading, setLoading] = useState(true)
  const [loadFailed, setLoadFailed] = useState(false)
  const [configured, setConfigured] = useState(false)
  const [connections, setConnections] = useState<C[]>([])
  // One request at a time across every card: busyId names the card whose
  // spinner shows, and every control disables meanwhile.
  const [busyId, setBusyId] = useState<string | null>(null)
  const [backfillingId, setBackfillingId] = useState<string | null>(null)
  const [confirmDisconnectId, setConfirmDisconnectId] = useState<string | null>(null)
  const [backfillFrom, setBackfillFrom] = useState<Record<string, string>>({})

  const failureCopy = { timeout: t('action_timeout'), network: t('action_network') }

  const loadStatus = useCallback(async () => {
    // A failed status read must never render as "not configured": that copy
    // sends the user to an administrator about an installation that is fine.
    const result = await request<FeedStatusResponse<C>>({ url: `${base}/status`, method: 'GET', locale })
    setLoading(false)
    if (!result.ok || !result.data) {
      setLoadFailed(true)
      return
    }
    setLoadFailed(false)
    setConfigured(result.data.configured)
    setConnections(result.data.connections ?? (result.data.connection ? [result.data.connection] : []))
  }, [request, base, locale])

  useEffect(() => {
    void loadStatus()
  }, [loadStatus])

  // Consume the one-shot OAuth bounce-back params (?<id>_connected=true /
  // ?<id>_error=...) off the render path.
  useEffect(() => {
    const connected = searchParams.get(`${extensionId}_connected`)
    const error = searchParams.get(`${extensionId}_error`)
    if (!connected && !error) return
    let cancelled = false
    queueMicrotask(() => {
      if (cancelled) return
      if (connected) {
        toast({ title: t('connected_toast_title'), description: t('connected_toast_description') })
      } else if (error) {
        // searchParams.get already returns the decoded value; decoding again
        // throws URIError when the message contains a literal % character.
        toast({
          title: tf('connect_failed_title'),
          description: connectErrorMessage ? connectErrorMessage(error) : error,
          variant: 'destructive',
        })
      }
      router.replace(`/import?mode=${extensionId}`)
    })
    return () => {
      cancelled = true
    }
  }, [searchParams, router, toast, t, tf, extensionId, connectErrorMessage])

  function retryLoadStatus() {
    setLoading(true)
    void loadStatus()
  }

  /**
   * Same counts, two entry points: "Synka nu" and the backfill. Exactly one
   * toast per outcome: TOAST_LIMIT is 1, so a second toast in the same tick
   * would evict the first. `booked` is the backfill's sentence about the days
   * the books already held, with the action that fetches them anyway.
   */
  function showSyncOutcome(
    payload: P | null | undefined,
    doneTitle: string,
    failedTitle: string,
    booked?: { note: string; action: ToastActionElement },
  ) {
    onSyncPayload?.(payload ?? null)
    const outcome = summarize(payload ?? null)
    const note = syncNote?.(outcome)
    const withNote = (text: string) => (note ? `${text} ${note}` : text)
    const withBooked = (text?: string) => (booked ? (text ? `${text} ${booked.note}` : booked.note) : text)
    const action = booked?.action
    if (outcome.reason === 'revoked') {
      toast({ title: failedTitle, description: t('sync_revoked'), variant: 'destructive' })
    } else if (outcome.reason === 'partial') {
      toast({ title: t('sync_partial_title'), description: withBooked(withNote(t('sync_partial', outcome.values))), action })
    } else if (outcome.reason === 'empty') {
      toast({ title: doneTitle, description: withBooked(t('sync_done_empty')), action })
    } else if (outcome.reason === 'errors') {
      toast({ title: doneTitle, description: withBooked(withNote(t('sync_done_feed_errors', outcome.values))), action })
    } else if (outcome.reason === 'feed') {
      toast({ title: doneTitle, description: withBooked(withNote(t('sync_done_feed', outcome.values))), action })
    } else {
      // The sync ran, but the answer never said what it did. Claim only that.
      toast({ title: doneTitle, description: withBooked(), action })
    }
  }

  async function handleSyncNow(connectionId: string) {
    if (busyId) return
    setBusyId(connectionId)
    try {
      const result = await request<P>({
        url: `${base}/sync`,
        body: { connection_id: connectionId },
        locale,
        timeoutMs: props.syncTimeoutMs,
      })
      if (!result.ok) {
        toast({
          title: tf('sync_failed_title'),
          description: failureDescription(result, failureCopy),
          variant: 'destructive',
        })
        return
      }
      showSyncOutcome(result.data, tf('sync_done_title'), tf('sync_failed_title'))
      await loadStatus()
    } finally {
      setBusyId(null)
    }
  }

  /**
   * includeBooked fetches the days the books already hold too (crm#1386):
   * only from the toast that named them, never by default.
   */
  async function handleBackfill(connectionId: string, includeBooked = false) {
    if (busyId) return
    const from = backfillFrom[connectionId] ?? ''
    if (!from) {
      toast({
        title: tf('backfill_failed_title'),
        description: tf('backfill_missing_date'),
        variant: 'destructive',
      })
      return
    }
    setBusyId(connectionId)
    setBackfillingId(connectionId)
    try {
      const result = await request<P & { booked_through?: string | null }>({
        url: `${base}/backfill`,
        body: { from, connection_id: connectionId, ...(includeBooked ? { include_booked: true } : {}) },
        locale,
        timeoutMs: props.syncTimeoutMs,
      })
      if (!result.ok) {
        toast({
          title: tf('backfill_failed_title'),
          description: failureDescription(result, failureCopy),
          variant: 'destructive',
        })
        return
      }
      const bookedThrough = result.data?.booked_through
      showSyncOutcome(
        result.data,
        t('backfill_done_title'),
        tf('backfill_failed_title'),
        bookedThrough
          ? {
              note: tf('backfill_booked_through', { date: formatDateLong(bookedThrough) }),
              action: (
                <ToastAction
                  altText={tf('backfill_include_booked')}
                  onClick={() => void handleBackfill(connectionId, true)}
                >
                  {tf('backfill_include_booked')}
                </ToastAction>
              ),
            }
          : undefined,
      )
      await loadStatus()
    } finally {
      setBackfillingId(null)
      setBusyId(null)
    }
  }

  async function handleToggleTransactionSync(connectionId: string, enabled: boolean) {
    if (busyId) return
    setBusyId(connectionId)
    try {
      const result = await request({
        url: `${base}/transaction-sync`,
        body: { enabled, connection_id: connectionId },
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
      toast({ title: enabled ? t('transaction_sync_enabled_toast') : t('transaction_sync_disabled_toast') })
      await loadStatus()
    } finally {
      setBusyId(null)
    }
  }

  async function handleDisconnect(connectionId: string) {
    if (busyId) return
    setBusyId(connectionId)
    try {
      const result = await request({
        url: `${base}/disconnect`,
        method: 'DELETE',
        body: { connection_id: connectionId },
        locale,
      })
      if (!result.ok) {
        toast({
          title: tf('disconnect_failed_title'),
          description: failureDescription(result, failureCopy),
          variant: 'destructive',
        })
        return
      }
      // A connector whose app or key lives on in the merchant's own admin
      // says so in the description (only they can delete it there).
      toast({
        title: t('disconnected_toast_title'),
        description: t.has('disconnected_toast_description') ? t('disconnected_toast_description') : undefined,
      })
      setConfirmDisconnectId(null)
      await loadStatus()
    } finally {
      setBusyId(null)
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
            <ArrowPathIcon className="mr-2 h-4 w-4" />
            {tCommon('retry')}
          </Button>
        </CardContent>
      </Card>
    )
  }

  if (!configured) {
    // Self-hosted without the provider's credentials: a setup task for the
    // administrator, not a launch.
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

  const hasActive = connections.some((c) => c.status === 'active')
  const Icon = props.icon

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          {t('title')}
          {/* Connected, the description only restates the import row that
              opened this panel: it moves behind the "?". */}
          {hasActive && <HelpPopover className="shrink-0">{t('description')}</HelpPopover>}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-6 pt-0">
        {!hasActive && <p className="text-sm text-muted-foreground">{t('description')}</p>}

        {connections.map((connection) => {
          const isActive = connection.status === 'active'
          const blocked = busyId !== null
          const backfilling = backfillingId === connection.id
          const syncing = busyId === connection.id && !backfilling
          const { name, detail } = props.identity(connection)
          const lastSynced = props.lastSyncedAt(connection)
          // The switch row's one note: when the feed last ran.
          const syncedNote = lastSynced
            ? tf('transaction_sync_last_synced', { date: formatDateLong(lastSynced) })
            : connection.transaction_sync_enabled
              ? tf('transaction_sync_never_synced')
              : null
          return (
            <div key={connection.id} className="space-y-4 rounded-lg border border-border p-4">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div className="flex items-center gap-3">
                  <Icon className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">{name}</span>
                      {STATUS_VARIANT[connection.status] ? (
                        <Badge variant={STATUS_VARIANT[connection.status] ?? undefined}>
                          {tf(`status_${connection.status}`)}
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">{tf(`status_${connection.status}`)}</span>
                      )}
                      {props.renderBadges?.(connection)}
                    </div>
                    {detail && <p className="mt-1 break-all text-sm text-muted-foreground">{detail}</p>}
                    {isActive && connection.connected_at && (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {tf('connected_since', { date: formatDateLong(connection.connected_at) })}
                      </p>
                    )}
                    {connection.error_message && (
                      // Shown for active connections too: a sync that cannot
                      // run must not hide behind a healthy "Ansluten" status.
                      <p className="mt-1 text-sm text-destructive">{connection.error_message}</p>
                    )}
                    {props.renderNotes?.(connection)}
                  </div>
                </div>
                {isActive &&
                  (confirmDisconnectId === connection.id ? (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="destructive"
                        size="sm"
                        onClick={() => handleDisconnect(connection.id)}
                        disabled={blocked}
                      >
                        {tf('disconnect_confirm')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setConfirmDisconnectId(null)}
                        disabled={blocked}
                      >
                        {tf('cancel')}
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleSyncNow(connection.id)}
                        disabled={blocked}
                        loading={syncing}
                      >
                        {!syncing && <ArrowPathIcon className="mr-2 h-4 w-4" />}
                        {syncing ? tf('syncing') : tf('sync_now')}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setConfirmDisconnectId(connection.id)}
                        disabled={blocked}
                      >
                        <LinkSlashIcon className="mr-2 h-4 w-4" />
                        {tf('disconnect')}
                      </Button>
                    </div>
                  ))}
              </div>

              {/* Flat rows: the switch with its "?" and when it last ran, then
                  the backfill date and button with theirs. */}
              {isActive && (
                <div className="flex items-center justify-between gap-4 border-t border-border pt-4">
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      {t('transaction_sync_title')}
                      <HelpPopover className="shrink-0">
                        <p>{t('transaction_sync_description')}</p>
                        <p className="mt-2">{t('transaction_sync_backfill_note')}</p>
                      </HelpPopover>
                    </p>
                    {syncedNote && <p className="mt-0.5 text-xs text-muted-foreground">{syncedNote}</p>}
                  </div>
                  <Switch
                    checked={connection.transaction_sync_enabled}
                    onCheckedChange={(enabled) => handleToggleTransactionSync(connection.id, enabled)}
                    disabled={blocked}
                    aria-label={t('transaction_sync_title')}
                  />
                </div>
              )}

              {isActive && (
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border pt-4">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    {t('backfill_title')}
                    <HelpPopover className="shrink-0">
                      <p>{t('backfill_description')}</p>
                      <p className="mt-2">{tf('backfill_booked_note')}</p>
                    </HelpPopover>
                  </p>
                  <div className="flex flex-wrap items-center gap-3">
                    <Input
                      type="date"
                      className="w-48"
                      value={backfillFrom[connection.id] ?? ''}
                      min={earliestBackfillDay(props.maxBackfillYears)}
                      max={isoDay(new Date())}
                      onChange={(event) =>
                        setBackfillFrom((prev) => ({ ...prev, [connection.id]: event.target.value }))
                      }
                      aria-label={tf('backfill_from_label')}
                      disabled={blocked}
                    />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleBackfill(connection.id)}
                      disabled={blocked}
                      loading={backfilling}
                    >
                      {!backfilling && <ClockIcon className="mr-2 h-4 w-4" />}
                      {backfilling ? tf('backfill_running') : tf('backfill_submit')}
                    </Button>
                  </div>
                </div>
              )}

              {props.renderExtras?.(connection)}
            </div>
          )
        })}

        {(props.multiple || !hasActive) &&
          props.renderConnect({ reload: loadStatus, hasActive, failureCopy })}
      </CardContent>
    </Card>
  )
}
