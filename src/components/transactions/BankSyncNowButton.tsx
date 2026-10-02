'use client'

import { useEffect, useSyncExternalStore } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { createClient } from '@/lib/supabase/client'
import { notifyBankSyncUpdated } from '@/lib/transactions/bank-sync-signal'
import { invalidateReferenceData } from '@/lib/reference-data/invalidate'
import {
  claimConnectionsLoad,
  clearBusyConnection,
  getBankSyncSnapshot,
  markConnectionStatus,
  publishConnections,
  releaseConnectionsLoad,
  setBusyConnection,
  setSyncingAll,
  subscribeBankSync,
  type BankConn,
} from '@/lib/transactions/bank-sync-store'
import { useCompany, useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { isSelfHosted } from '@/lib/env/public-flags'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

export type { BankConn }

/**
 * Shared on-demand bank sync state + actions. Powers the footer "Synka nu"
 * button below and the "Synka bank nu" row in the Importera split-button menu
 * (TransactionStatusBar). Reuses the per-connection sync endpoint that
 * BankingSettingsPanel already calls.
 *
 * Also handles dead PSD2 sessions: a connection whose consent has closed or
 * expired re-authorizes in place via `reconnect` (no disconnect needed), and a
 * sync that fails with a session expiry surfaces the same reconnect action
 * right in the error toast.
 */
export function useBankSync() {
  const t = useTranslations('transactions')
  const { toast } = useToast()
  const router = useRouter()
  const { company } = useCompany()
  const hasBankSync = useCapability(CAPABILITY.bank_sync)
  // Busy state and the connection list live in a module-level store so every
  // useBankSync() instance (header split button, footer button) sees the same
  // sync in flight and cannot start a concurrent one (#1162).
  const store = useSyncExternalStore(subscribeBankSync, getBankSyncSnapshot, getBankSyncSnapshot)
  // Never present another company's cached list while a switch is loading.
  const connections = store.companyId === company?.id ? store.connections : null

  useEffect(() => {
    if (!company?.id) return
    // First instance to mount claims the fetch; the rest read the store. The
    // store outlives components, so the result publishes even if this
    // instance unmounts mid-flight.
    if (!claimConnectionsLoad(company.id)) return
    const companyId = company.id
    const supabase = createClient()
    supabase
      .from('bank_connections')
      .select('id, bank_name, status, provider, last_synced_at')
      // Include expired/error so the reconnect entry point survives a reload:
      // not just active connections that can sync. Include pending_selection
      // too: a bank that is authorized but whose accounts were never chosen
      // used to be invisible here, so the page offered no way to sync and no
      // hint why nothing arrived. Its action is "choose accounts", never a
      // sync or a new BankID round trip (see chooseAccounts below).
      .in('status', ['active', 'expired', 'error', 'pending_selection'])
      .eq('company_id', companyId)
      .then(({ data, error }) => {
        if (error) {
          releaseConnectionsLoad(companyId)
          return
        }
        publishConnections(companyId, (data as BankConn[]) ?? [])
      })
  }, [company?.id])

  // Re-authorize an existing connection in place: posts the connection_id so
  // the server reuses the same row, then hands off to the bank's consent screen.
  async function reconnect(conn: BankConn) {
    setBusyConnection(conn.id)
    try {
      const country = conn.provider?.split('-').pop()?.toUpperCase() || 'SE'
      const res = await fetch('/api/extensions/ext/enable-banking/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connection_id: conn.id,
          aspsp_name: conn.bank_name,
          aspsp_country: country,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Reconnect failed')
      window.location.href = data.authorization_url
    } catch (error) {
      toast({
        title: t('bank_reconnect'),
        description: error instanceof Error ? getUserErrorMessage(error) : 'Reconnect failed',
        variant: 'destructive',
      })
      setBusyConnection(null)
    }
  }

  async function syncConnection(conn: BankConn) {
    setBusyConnection(conn.id)
    try {
      const res = await fetch('/api/extensions/ext/enable-banking/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: conn.id }),
      })
      const data = await res.json()
      if (!res.ok) {
        // A dead PSD2 session can't be fixed by retrying: surface a one-click
        // reconnect in the toast instead of a dead-end error.
        if (data?.reauth_required) {
          toast({
            title: t('bank_sync_session_expired'),
            description: t('bank_sync_session_expired_desc'),
            variant: 'destructive',
            action: (
              <ToastAction altText={t('bank_reconnect')} onClick={() => reconnect(conn)}>
                {t('bank_reconnect')}
              </ToastAction>
            ),
          })
          // Reflect the now-expired status so the button flips to reconnect
          // on every surface at once.
          markConnectionStatus(conn.id, 'expired')
          return
        }
        throw new Error(data.error || 'Sync failed')
      }
      toast({
        title: t('bank_sync_button_now'),
        // Surface skipped duplicates too: a renewal that dedupes correctly
        // imports 0 rows, which without this line reads as a broken sync.
        // Joined with '. ' so the two sentences do not run together (the
        // imported-count strings are shared with the BankSyncSinceLastVisit
        // chip and deliberately carry no trailing period).
        description: [
          data.imported === 1
            ? t('bank_sync_new_since_last_visit_one')
            : t('bank_sync_new_since_last_visit_many', { count: data.imported ?? 0 }),
          typeof data.duplicates === 'number' && data.duplicates > 0
            ? data.duplicates === 1
              ? t('bank_sync_duplicates_skipped_one')
              : t('bank_sync_duplicates_skipped_many', { count: data.duplicates })
            : null,
        ]
          .filter(Boolean)
          .join('. '),
      })
      // Tell the neighbouring status chip to refetch so it doesn't keep showing
      // the pre-sync "synced Nd ago" until a hard reload.
      notifyBankSyncUpdated()
      // The account chooser reads cash accounts from the session cache
      // (lib/reference-data); a sync can change balances, so refetch them.
      void invalidateReferenceData('ref:cash-accounts')
      router.refresh()
    } catch (error) {
      toast({
        title: t('bank_sync_button_now'),
        description: error instanceof Error ? getUserErrorMessage(error) : 'Sync failed',
        variant: 'destructive',
      })
    } finally {
      clearBusyConnection(conn.id)
    }
  }

  // A connection waiting for account selection already holds a live consent:
  // finish it in the account picker instead of re-authorizing. The settings
  // panel opens the picker from ?select_accounts=, the same parameter the
  // bank callback lands on. Reconnecting here would cost a BankID round trip
  // and park the row in 'expired' for its duration.
  function chooseAccounts(conn: BankConn) {
    router.push(`/settings/banking?select_accounts=${encodeURIComponent(conn.id)}`)
  }

  // Active connections sync; a connection waiting for account selection opens
  // the picker; expired/error connections reconnect. Reads the live snapshot,
  // not the render closure, so a click racing a sync started from the other
  // surface is a no-op instead of a concurrent PSD2 call.
  function runFor(conn: BankConn) {
    const { busyId, syncingAll } = getBankSyncSnapshot()
    if (busyId !== null || syncingAll) return
    if (conn.status === 'active') return syncConnection(conn)
    if (conn.status === 'pending_selection') return chooseAccounts(conn)
    return reconnect(conn)
  }

  // One-shot "sync everything" for the split-button menu row: syncs every
  // active connection in turn; with only dead connections it jumps straight
  // to re-authorizing the first one (a retry can't revive a closed session).
  async function syncAll() {
    const { busyId, syncingAll } = getBankSyncSnapshot()
    if (busyId !== null || syncingAll) return
    setSyncingAll(true)
    try {
      const conns = connections ?? []
      const active = conns.filter((c) => c.status === 'active')
      if (active.length === 0) {
        // Nothing can sync. Finishing a connection that only lacks its
        // account choice beats re-authorizing a dead one: it needs no BankID.
        const waiting = conns.find((c) => c.status === 'pending_selection')
        if (waiting) {
          chooseAccounts(waiting)
          return
        }
        if (conns[0]) await reconnect(conns[0])
        return
      }
      for (const conn of active) {
        await syncConnection(conn)
      }
    } finally {
      setSyncingAll(false)
    }
  }

  const lastSyncedAt =
    (connections ?? [])
      .map((c) => c.last_synced_at)
      .filter((s): s is string => Boolean(s))
      .sort()
      .pop() ?? null

  return {
    connections,
    busyId: store.busyId,
    isBusy: store.busyId !== null || store.syncingAll,
    hasBankSync,
    reconnect,
    syncConnection,
    runFor,
    syncAll,
    lastSyncedAt,
  }
}

/**
 * On-demand "Sync now" button beside BankSyncStatusChip. If the user has
 * multiple connections, a dropdown lets them pick which one to sync/reconnect.
 */
export default function BankSyncNowButton() {
  const t = useTranslations('transactions')
  const { connections, isBusy, hasBankSync, runFor } = useBankSync()

  if (!connections || connections.length === 0) return null

  const syncLabel = isBusy ? t('bank_sync_button_syncing') : t('bank_sync_button_now')

  // Bank sync (and reconnect) is a paid external PSD2 call. Without the
  // capability we keep the button VISIBLE as the conversion surface but inert,
  // and surface an Uppgradera link. CSV/SIE import stays free (separate UI).
  // Self-host: the remedy is a connector key (or own EB credentials), never
  // the hosted Stripe billing page; same branch as UpgradeNote.
  const selfHosted = isSelfHosted()
  const gateTitle = !hasBankSync
    ? selfHosted
      ? t('bank_sync_requires_connector_key')
      : t('bank_sync_requires_subscription')
    : undefined
  const upsellNote = !hasBankSync ? (
    selfHosted ? (
      <span className="text-xs text-muted-foreground">{t('bank_sync_upsell_connector_key')}</span>
    ) : (
      <span className="text-xs text-muted-foreground">
        {t('bank_sync_upsell_subscription')}{' '}
        <a href="/settings/billing" className="underline underline-offset-2">
          {t('bank_sync_upsell_upgrade')}
        </a>
      </span>
    )
  ) : null

  if (connections.length === 1) {
    const conn = connections[0]
    const singleLabel =
      conn.status === 'active'
        ? syncLabel
        : conn.status === 'pending_selection'
          ? t('bank_choose_accounts')
          : t('bank_reconnect')
    return (
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={!hasBankSync}
          loading={isBusy}
          title={gateTitle}
          onClick={() => runFor(conn)}
        >
          {!isBusy && <RefreshCw className="mr-2 h-3.5 w-3.5" />}
          <span>{singleLabel}</span>
        </Button>
        {upsellNote}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2">
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={!hasBankSync}
          loading={isBusy}
          title={gateTitle}
        >
          {!isBusy && <RefreshCw className="mr-2 h-3.5 w-3.5" />}
          <span>{syncLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        {connections.map((conn) => (
          <DropdownMenuItem
            key={conn.id}
            disabled={isBusy}
            onSelect={() => runFor(conn)}
          >
            {conn.status === 'active'
              ? conn.bank_name
              : conn.status === 'pending_selection'
                ? `${conn.bank_name} · ${t('bank_choose_accounts')}`
                : `${conn.bank_name} · ${t('bank_reconnect')}`}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
    {upsellNote}
    </div>
  )
}
