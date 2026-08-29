'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { CheckCircle, Loader2, Upload } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { notifyBankSyncUpdated } from '@/lib/transactions/bank-sync-signal'
import { useCompany, useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
  SettingsRowNote,
  SettingsSeg,
} from '@/components/settings/SettingsRows'
import { BankSelector, type Bank } from './BankSelector'
import { BankConnectionStatus } from './BankConnectionStatus'
import { AccountPickerDialog } from './AccountPickerDialog'
import {
  buildPageAttentionSentence,
  selectPageAttention,
  sortConnectionsByPrecedence,
} from '../lib/connection-state'
import { sameBankWarning } from '../lib/connection-warning'
import type { BankConnection } from '@/types'
import type { StoredAccount } from '../types'

/** One "reuse an existing connection" offer, as returned by /reusable-sessions. */
interface ReusableSessionOffer {
  connection_id: string
  company_id: string
  company_name: string | null
  bank_name: string | null
  consent_expires: string | null
  available_account_count: number
}

/**
 * Self-contained banking settings panel for the enable-banking extension.
 * Loaded dynamically by the settings panel registry.
 */
export default function BankingSettingsPanel() {
  const { toast } = useToast()
  // Stable across renders so effects can list it as a dependency without
  // re-firing on every parent render (same reason as AccountPickerDialog).
  const supabase = useMemo(() => createClient(), [])
  // The OAuth callback lands here with ?select_accounts=<id> once a bank is
  // successfully connected. Read via useSearchParams (SSR/hydration-safe) so
  // the first-load spinner can say "bank connected, fetching accounts"
  // instead of an anonymous spinner. The param itself is consumed and
  // stripped by the auto-open effect below.
  const searchParams = useSearchParams()
  const arrivedFromBankCallback = !!searchParams?.get('select_accounts')

  const { dialogProps, confirm } = useDestructiveConfirm()
  const { company, companies } = useCompany()
  const hasBankSync = useCapability(CAPABILITY.bank_sync)

  const [bankConnections, setBankConnections] = useState<BankConnection[]>([])
  const [syncingConnectionId, setSyncingConnectionId] = useState<string | null>(null)
  const [isConnecting, setIsConnecting] = useState(false)
  const [connectingBankName, setConnectingBankName] = useState<string | null>(null)
  const connectingRef = useRef(false)
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const [isLoading, setIsLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)
  const hasLoadedRef = useRef(false)
  const [showCsvFallback, setShowCsvFallback] = useState(false)
  const [psuType, setPsuType] = useState<'personal' | 'business'>('business')
  const [pickerConnectionId, setPickerConnectionId] = useState<string | null>(null)
  // Live connections the same user holds at the same banks in OTHER companies.
  // Several ASPSPs allow only one active AIS session per PSU, so authorizing
  // company B silently kills company A's connection. RLS scopes SELECT to
  // user_company_ids(), so this read stays within the user's own companies.
  // Live sessions in the user's OTHER companies that still have unclaimed
  // accounts. Reusing one connects this company without a second BankID and
  // without revoking the first, which is what kills feeds at one-session banks.
  const [reusableSessions, setReusableSessions] = useState<ReusableSessionOffer[]>([])
  const [attachingConnectionId, setAttachingConnectionId] = useState<string | null>(null)
  const [otherCompanyConnections, setOtherCompanyConnections] = useState<
    { bank_name: string; company_id: string; session_id: string | null }[]
  >([])
  // Set when the OAuth callback pointed at a connection that belongs to a
  // different company than the active one: without this the picker simply
  // never opens and the connection looks like it vanished.
  const [pickerCompanyMismatch, setPickerCompanyMismatch] = useState<string | null>(null)
  // "Anslut ny bank" is collapsed behind one button whenever the company
  // already has a connection: renewing the existing row is almost always the
  // right move, so the fresh-connect surface must not compete with it.
  const [connectNewOpen, setConnectNewOpen] = useState(false)
  // Same-bank intercept: a fresh connect to an already-connected bank pauses
  // here so the user can renew the existing row instead of creating a
  // duplicate.
  const [sameBankIntercept, setSameBankIntercept] = useState<{
    bank: Bank
    psuTypeOverride?: 'personal' | 'business'
    existing: BankConnection
  } | null>(null)

  // Must match STALE_THRESHOLD_MS in extensions/general/enable-banking/index.ts
  const PENDING_LOCK_MS = 30 * 1000

  useEffect(() => {
    fetchConnections()
    return () => {
      if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current)
    }
  }, [])

  // Latest-ref so the visibility listener below (subscribed once) always
  // calls the current render's fetchConnections, which closes over company
  // context that may resolve after mount.
  const fetchConnectionsRef = useRef(fetchConnections)
  useEffect(() => {
    fetchConnectionsRef.current = fetchConnections
  })

  // Safety net for completion signals that never reach this tab: a mobile
  // BankID app-switch can land the bank's redirect in a different browser
  // tab, the user can close the finalize page before its redirect, and a
  // bfcache-restored page shows a pre-connection snapshot. Refetch when the
  // tab regains visibility (background refresh, no spinner: fetchConnections
  // only blanks the panel on first load), throttled so rapid tab toggling
  // doesn't hammer the API.
  const lastVisibilityFetchRef = useRef(0)
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return
      const now = Date.now()
      if (now - lastVisibilityFetchRef.current < 5_000) return
      lastVisibilityFetchRef.current = now
      void fetchConnectionsRef.current()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  // Auto-open the picker when the user lands here from the OAuth callback
  // (URL: /settings/banking?select_accounts=<id>). The query param is stripped
  // afterwards so a refresh doesn't keep reopening it.
  useEffect(() => {
    if (isLoading) return
    if (typeof window === 'undefined') return

    const params = new URLSearchParams(window.location.search)
    const targetId = params.get('select_accounts')
    if (!targetId) return

    const match = bankConnections.find(c => c.id === targetId)
    if (match) {
      setPickerConnectionId(targetId)
      setPickerCompanyMismatch(null)
    } else {
      // The callback finished, but the connection belongs to a company that
      // isn't the active one (the user switched company during the bank
      // round-trip, or authorized while another company was active). Name the
      // owner instead of dropping the user on a panel that looks unchanged.
      void (async () => {
        const { data } = await supabase
          .from('bank_connections')
          .select('company_id')
          .eq('id', targetId)
          .maybeSingle()
        const ownerId = (data as { company_id?: string } | null)?.company_id
        if (!ownerId) return
        const owner = companies.find((c) => c.company.id === ownerId)
        setPickerCompanyMismatch(owner?.company.name ?? 'ett annat bolag')
      })()
    }

    params.delete('select_accounts')
    const newQuery = params.toString()
    const newUrl = `${window.location.pathname}${newQuery ? `?${newQuery}` : ''}`
    window.history.replaceState({}, '', newUrl)
  }, [isLoading, bankConnections, companies, supabase])

  function releaseConnectingLock() {
    connectingRef.current = false
    setIsConnecting(false)
    setConnectingBankName(null)
  }

  async function fetchConnections() {
    // Only the first load blanks the panel to a spinner. Later refetches (after
    // a sync, disconnect, or account save) refresh in the background so the
    // panel doesn't flash back to a full-height spinner and lose scroll
    // position on every action.
    if (!hasLoadedRef.current) setIsLoading(true)
    setLoadError(false)
    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user || !company) {
        setBankConnections([])
        return
      }

      const { data: connections, error } = await supabase
        .from('bank_connections')
        .select('*')
        .eq('company_id', company.id)
        .order('created_at', { ascending: false })

      if (error) {
        // Surface the failure instead of rendering an empty panel: an empty
        // panel reads as "your bank got disconnected" when it's really a
        // transient fetch/RLS error.
        setLoadError(true)
        return
      }

      setBankConnections(connections || [])

      // Same-bank connections in the user's other companies. Only sessions
      // that actually hold a consent count: a revoked or errored row is not
      // competing for the bank's one-session-per-login slot.
      const { data: allConnections } = await supabase
        .from('bank_connections')
        .select('bank_name, company_id, session_id, status')
        .in('status', ['active', 'pending_selection'])
      setOtherCompanyConnections(
        ((allConnections || []) as {
          bank_name: string
          company_id: string
          session_id: string | null
        }[]).filter((c) => c.company_id !== company.id)
      )

      // Reuse offers. Best-effort: a failure here costs the shortcut, never the
      // panel, so the normal connect flow stays available either way.
      try {
        const reuseResponse = await fetch('/api/extensions/ext/enable-banking/reusable-sessions')
        if (reuseResponse.ok) {
          const { sessions } = await reuseResponse.json()
          setReusableSessions((sessions || []) as ReusableSessionOffer[])
        } else {
          setReusableSessions([])
        }
      } catch {
        setReusableSessions([])
      }

      // If a pending connection exists from a recent attempt (e.g. user bounced back from
      // the bank's auth page), keep the connect button disabled until the server-side lock expires.
      const freshPending = (connections || []).find((c) => c.status === 'pending')
      if (freshPending) {
        const age = Date.now() - new Date(freshPending.created_at).getTime()
        const remaining = PENDING_LOCK_MS - age
        if (remaining > 0) {
          connectingRef.current = true
          setIsConnecting(true)
          setConnectingBankName(freshPending.bank_name)
          if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current)
          releaseTimerRef.current = setTimeout(releaseConnectingLock, remaining)
        }
      }
    } finally {
      // Always clear the spinner, even on the early `!user || !company` return,
      // so an expired session can't leave the panel spinning forever.
      hasLoadedRef.current = true
      setIsLoading(false)
    }
  }

  /**
   * Warn before authorizing a bank where the same user already holds live
   * connections in other companies. The decision table lives in
   * lib/connection-warning.ts: banks with observed one-session-per-PSU
   * behavior get the hard warning, everything else gets a calm confirmation
   * on fresh connects and no dialog at all on renewals. Advisory only:
   * legitimate multi-company setups must still be able to proceed, so the
   * dialog always offers a working confirm.
   */
  async function confirmSameBankConnections(
    bankName: string,
    isReconnect: boolean,
    currentSessionId?: string | null,
  ): Promise<boolean> {
    const clashes = otherCompanyConnections
      .filter((c) => c.bank_name === bankName)
      .map((c) => ({
        companyId: c.company_id,
        companyName:
          companies.find((entry) => entry.company.id === c.company_id)?.company.name ?? null,
        sessionId: c.session_id,
      }))

    const warning = sameBankWarning({
      bankName,
      clashes,
      isReconnect,
      currentSessionId,
    })
    if (!warning) return true
    return confirm(warning)
  }

  /**
   * Reuse a session authorized for another of the user's companies. No bank
   * round-trip: the server creates this company's connection against the same
   * consent and parks it in 'pending_selection', so the account picker opens
   * exactly as it does after a real authorization.
   */
  async function handleReuseConnection(offer: ReusableSessionOffer) {
    if (attachingConnectionId) return
    setAttachingConnectionId(offer.connection_id)
    try {
      const response = await fetch('/api/extensions/ext/enable-banking/attach', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: offer.connection_id }),
      })
      const result = await response.json()

      if (!response.ok) {
        toast({
          title: 'Kunde inte återanvända anslutningen',
          description: result?.error || 'Försök igen om en stund.',
          variant: 'destructive',
        })
        return
      }

      await fetchConnections()
      notifyBankSyncUpdated()
      // Straight into account selection: the connection exists but syncs
      // nothing until the user picks which accounts belong to this company.
      setPickerConnectionId(result.connection_id)
    } catch (error) {
      console.error('[enable-banking] Reuse failed', error)
      toast({
        title: 'Kunde inte återanvända anslutningen',
        description: 'Ett oväntat fel uppstod. Försök igen om en stund.',
        variant: 'destructive',
      })
    } finally {
      setAttachingConnectionId(null)
    }
  }

  async function handleConnectBank(bank: Bank, psuTypeOverride?: 'personal' | 'business') {
    if (connectingRef.current) return
    // Same-bank intercept: when this company already holds a non-revoked
    // connection to the bank, renewing that row is almost always what the
    // user means. A second fresh row leaves the old one stuck in "Åtgärd
    // krävs" and risks duplicate transactions on the re-import.
    const existing = bankConnections.find(
      (c) => c.status !== 'revoked' && c.status !== 'pending' && c.bank_name === bank.name,
    )
    if (existing) {
      setSameBankIntercept({ bank, psuTypeOverride, existing })
      return
    }
    await startFreshConnect(bank, psuTypeOverride)
  }

  async function startFreshConnect(
    bank: Bank,
    psuTypeOverride?: 'personal' | 'business',
    forceNew = false,
  ) {
    if (connectingRef.current) return
    // Claim the lock BEFORE the confirm await. The dialog can sit open
    // indefinitely, and a second click in that window would otherwise sail
    // past the guard above and start a concurrent connect flow.
    connectingRef.current = true
    if (!(await confirmSameBankConnections(bank.name, false))) {
      connectingRef.current = false
      return
    }
    setIsConnecting(true)
    setConnectingBankName(bank.name)

    try {
      console.log('[enable-banking] Initiating bank connection', {
        bankName: bank.name,
        bankCountry: bank.country,
        psuTypeOverride,
        forceNew,
      })

      const body: Record<string, string | boolean> = { aspsp_name: bank.name, aspsp_country: bank.country }
      if (psuTypeOverride) body.psu_type = psuTypeOverride
      // Deliberate second connection to a bank this company is already
      // connected to (past the intercept dialog). The server ignores the flag
      // today; a parallel change adds a 409 guard that force_new bypasses.
      if (forceNew) body.force_new = true

      const response = await fetch('/api/extensions/ext/enable-banking/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })

      const data = await response.json()

      if (!response.ok) {
        console.error('[enable-banking] Connect request failed', {
          status: response.status,
          statusText: response.statusText,
          error: data.error,
          bankName: bank.name,
        })
        throw new Error(data.error)
      }

      console.log('[enable-banking] Redirecting to bank authorization', {
        connectionId: data.connection_id,
        hasAuthUrl: !!data.authorization_url,
      })
      window.location.href = data.authorization_url
    } catch (error) {
      console.error('[enable-banking] Connect flow failed', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        bankName: bank.name,
      })
      toast({
        title: 'Fel',
        description: error instanceof Error ? error.message : 'Kunde inte ansluta bank',
        variant: 'destructive',
      })
      connectingRef.current = false
      setIsConnecting(false)
      setConnectingBankName(null)
      setShowCsvFallback(true)
    }
  }

  // Re-authorize an existing connection in place: no disconnect required.
  // Posts to /connect with the existing connection_id so the server reuses the
  // same row (revoking the dead session, issuing fresh authorization), then
  // hands off to the bank's consent screen. The OAuth callback drives the row
  // back through account selection to active.
  async function handleReconnect(connection: BankConnection, psuTypeOverride?: 'personal' | 'business') {
    if (connectingRef.current) return
    // Lock before the confirm await, same reason as handleConnectBank.
    connectingRef.current = true
    if (!(await confirmSameBankConnections(connection.bank_name, true, connection.session_id))) {
      connectingRef.current = false
      return
    }
    setIsConnecting(true)
    setConnectingBankName(connection.bank_name)

    try {
      const country = (connection.provider as string)?.split('-').pop()?.toUpperCase() || 'SE'
      const response = await fetch('/api/extensions/ext/enable-banking/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connection_id: connection.id,
          aspsp_name: connection.bank_name,
          aspsp_country: country,
          // Omitted → server reuses the connection's stored psu_type (falling
          // back to entity_type). Set → switch account type in place.
          ...(psuTypeOverride ? { psu_type: psuTypeOverride } : {}),
        }),
      })

      const data = await response.json()

      if (!response.ok) {
        throw new Error(data.error)
      }

      window.location.href = data.authorization_url
    } catch (error) {
      console.error('[enable-banking] Reconnect flow failed', {
        message: error instanceof Error ? error.message : String(error),
        connectionId: connection.id,
      })
      toast({
        title: 'Fel',
        description: error instanceof Error ? error.message : 'Kunde inte förnya anslutningen',
        variant: 'destructive',
      })
      connectingRef.current = false
      setIsConnecting(false)
      setConnectingBankName(null)
    }
  }

  async function handleSyncTransactions(connectionId: string) {
    setSyncingConnectionId(connectionId)

    // A slow bank can hold the request open up to the route's 300s budget.
    // Cap the client wait so the spinner can't hang indefinitely; the sync is
    // idempotent (imports dedup), so a background completion or manual retry is
    // safe.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 180_000)

    try {
      console.log('[enable-banking] Starting sync', { connectionId })

      const response = await fetch('/api/extensions/ext/enable-banking/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connectionId }),
        signal: controller.signal,
      })

      const data = await response.json()

      if (!response.ok) {
        console.error('[enable-banking] Sync request failed', {
          status: response.status,
          statusText: response.statusText,
          error: data.error,
          connectionId,
        })
        throw new Error(data.error)
      }

      console.log('[enable-banking] Sync completed', {
        connectionId,
        imported: data.imported,
        duplicates: data.duplicates,
      })

      toast({
        title: 'Synkronisering klar',
        description: `${data.imported} nya transaktioner importerade`,
      })

      setShowCsvFallback(false)
      notifyBankSyncUpdated()
      fetchConnections()
    } catch (error) {
      if (controller.signal.aborted) {
        toast({
          title: 'Synkronisering tar längre tid än vanligt',
          description: 'Transaktionerna hämtas i bakgrunden. Uppdatera sidan om en stund.',
        })
        fetchConnections()
      } else {
        console.error('[enable-banking] Sync flow failed', {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          connectionId,
        })
        toast({
          title: 'Fel',
          description: error instanceof Error ? error.message : 'Synkronisering misslyckades',
          variant: 'destructive',
        })
        setShowCsvFallback(true)
        // Refresh so a now-expired connection (e.g. closed PSD2 session) moves
        // into "Åtgärd krävs" and surfaces the "Förnya anslutning" button.
        fetchConnections()
      }
    } finally {
      clearTimeout(timeout)
      setSyncingConnectionId(null)
    }
  }

  async function handleDisconnectBank(connectionId: string) {
    const ok = await confirm({
      title: 'Koppla bort bank?',
      description: 'PSD2-samtycket kommer återkallas. Befintliga transaktioner påverkas inte.',
      confirmLabel: 'Koppla bort',
      variant: 'warning',
    })
    if (!ok) return

    try {
      console.log('[enable-banking] Disconnecting bank', { connectionId })

      const response = await fetch('/api/extensions/ext/enable-banking/disconnect', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ connection_id: connectionId }),
      })

      if (!response.ok) {
        const data = await response.json()
        console.error('[enable-banking] Disconnect request failed', {
          status: response.status,
          statusText: response.statusText,
          error: data.error,
          connectionId,
        })
        throw new Error(data.error || 'Disconnect failed')
      }

      console.log('[enable-banking] Bank disconnected', { connectionId })
      toast({
        title: 'Bank bortkopplad',
        description: 'Bankanslutningen och PSD2-samtycket har återkallats',
      })
      fetchConnections()
    } catch (error) {
      console.error('[enable-banking] Disconnect flow failed', {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        connectionId,
      })
      toast({
        title: 'Fel',
        description: error instanceof Error ? error.message : 'Kunde inte koppla bort bank',
        variant: 'destructive',
      })
    }
  }

  if (isLoading) {
    // Coming back from the bank's consent flow the connection already exists,
    // so tell the user that instead of showing an anonymous spinner: this is
    // the last silent gap between "approved at the bank" and the account
    // picker opening.
    if (arrivedFromBankCallback) {
      return (
        <div className="flex h-32 flex-col items-center justify-center gap-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <CheckCircle className="h-4 w-4 text-success" />
            <span>Banken är ansluten</span>
          </div>
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Hämtar dina konton…</span>
          </div>
        </div>
      )
    }
    return (
      <div className="flex items-center justify-center h-32">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // First-load failure: show a recoverable error instead of an empty panel (a
  // blank panel misreads as "no banks connected"). A background-refetch failure
  // keeps the already-loaded connections visible instead of wiping them.
  if (loadError && bankConnections.length === 0) {
    return (
      <div className="px-1 pt-8">
        <p className="text-sm font-medium">Kunde inte ladda bankanslutningar</p>
        <p className="mt-1 max-w-[56ch] text-xs leading-relaxed text-muted-foreground">
          Något gick fel när dina bankanslutningar skulle hämtas. Dina anslutningar
          och transaktioner är oförändrade.
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button variant="outline" size="sm" onClick={() => fetchConnections()}>
            Försök igen
          </Button>
          <Button variant="outline" size="sm" asChild>
            <Link href="/import?mode=bank">Importera bankfil istället</Link>
          </Button>
        </div>
      </div>
    )
  }

  // One group, sorted so the row that needs the user sits first
  // (pending_selection, pending, error, expired, expiring soon, active).
  // Revoked rows stay hidden, exactly as before.
  const stateNow = Date.now()
  const visibleConnections = sortConnectionsByPrecedence(
    bankConnections.filter((c) => c.status !== 'revoked'),
    stateNow,
  )
  const hasVisibleConnections = visibleConnections.length > 0
  // Exactly one page-level attention sentence for the worst state, or none
  // (design convention 6).
  const pageAttention = selectPageAttention(visibleConnections, stateNow)
  // With zero connections the bank list IS the page; with any connection it
  // collapses behind one button.
  const connectNewExpanded = connectNewOpen || !hasVisibleConnections

  const pickerConnection = pickerConnectionId
    ? bankConnections.find(c => c.id === pickerConnectionId)
    : null
  const pickerAccounts = pickerConnection
    ? ((pickerConnection.accounts_data as StoredAccount[] | null) || [])
    : []

  return (
    <div>
      <DestructiveConfirmDialog {...dialogProps} />

      {/* Same-bank intercept: renew the existing connection (primary) or
          deliberately connect a second one (e.g. another login at the same
          bank). */}
      <Dialog
        open={!!sameBankIntercept}
        onOpenChange={(open) => {
          if (!open) setSameBankIntercept(null)
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle data-ph-mask="">
              Du har redan en koppling till {sameBankIntercept?.bank.name}
            </DialogTitle>
            <DialogDescription data-ph-mask="">
              Förnya den i stället? Då behåller kontona sin historik och du undviker dubbletter
              av transaktioner. Anslut som ny bara om det gäller en annan inloggning på samma
              bank.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2 sm:gap-0">
            <Button
              variant="outline"
              className="min-h-11 w-full sm:w-auto"
              onClick={() => {
                const intercept = sameBankIntercept
                setSameBankIntercept(null)
                if (!intercept) return
                void startFreshConnect(intercept.bank, intercept.psuTypeOverride, true)
              }}
            >
              Anslut som ny
            </Button>
            <Button
              className="min-h-11 w-full sm:w-auto"
              onClick={() => {
                const intercept = sameBankIntercept
                setSameBankIntercept(null)
                if (!intercept) return
                // No psu override: the server reuses the stored psu_type.
                void handleReconnect(intercept.existing)
              }}
            >
              Förnya kopplingen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {pickerConnection && (
        <AccountPickerDialog
          open={!!pickerConnection}
          onOpenChange={(open) => {
            if (!open) setPickerConnectionId(null)
          }}
          connectionId={pickerConnection.id}
          bankName={pickerConnection.bank_name}
          accounts={pickerAccounts}
          isInitialSelection={pickerConnection.status === 'pending_selection'}
          onSaved={() => fetchConnections()}
        />
      )}

      {/* The callback landed on a connection owned by another of the user's
          companies: one ochre line naming where it went (convention 6). */}
      {pickerCompanyMismatch && (
        <p className="px-1 pt-6 text-[12.5px] leading-relaxed text-attn">
          Bankanslutningen slutfördes för {pickerCompanyMismatch}, inte för det bolag som är aktivt
          nu. Byt till {pickerCompanyMismatch} för att välja vilka konton som ska synka.
        </p>
      )}

      {/* Persistent CSV fallback after connection/sync failure: a live hint,
          kept visible as a compact line instead of a boxed strip. */}
      {showCsvFallback && (
        <div className="flex items-start gap-2 px-1 pt-6">
          <Upload className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Har du problem med bankanslutningen? Du kan{' '}
            <Link href="/import?mode=bank" className="underline underline-offset-2 hover:text-foreground">
              importera transaktioner manuellt via bankfil
            </Link>
            .
          </p>
        </div>
      )}

      {/* The page's one attention sentence: the worst connection state, or
          nothing (convention 6). The rows themselves stay quiet. */}
      {pageAttention && (
        <p className="px-1 pt-6 text-[12.5px] leading-relaxed text-attn">
          {buildPageAttentionSentence(pageAttention, stateNow)}
        </p>
      )}

      {/* All connections in one group, worst state first. Each row carries
          its own state badge and exactly one primary action. */}
      {hasVisibleConnections && (
        <SettingsGroup label="Dina bankkopplingar">
          {visibleConnections.map((connection) => (
            <BankConnectionStatus
              key={connection.id}
              connection={connection}
              onSync={handleSyncTransactions}
              onDisconnect={handleDisconnectBank}
              onReconnect={handleReconnect}
              onManageAccounts={(connectionId) => setPickerConnectionId(connectionId)}
              isSyncing={syncingConnectionId === connection.id}
            />
          ))}
        </SettingsGroup>
      )}

      {/* Reuse a session authorized for another of the user's companies. Sits
          ABOVE the bank list deliberately: at a one-session-per-login bank,
          choosing the bank below is the very action that kills the other
          company's feed, so the cheaper and safer path has to be seen first.
          Renders only when a live session actually has unclaimed accounts,
          and only while the connect-new surface is visible: it is an
          alternative to a fresh connect, not a state of this company's
          connections. */}
      {connectNewExpanded && hasBankSync && reusableSessions.length > 0 && (
        <SettingsGroup
          label="Återanvänd befintlig anslutning"
          help={
            <div className="space-y-2">
              <p>
                Du har redan en giltig bankanslutning i ett annat bolag, och den ser konton
                som inget bolag använder ännu.
              </p>
              <p>
                Vissa banker tillåter bara en aktiv anslutning per inloggning. Att återanvända
                anslutningen i stället för att logga in på nytt låter bolagen dela samma
                samtycke, så bolaget som redan är anslutet fortsätter att synka.
              </p>
              <p>
                Bolagen delar bara samtycket. Konton, transaktioner och bokföring hålls isär,
                och du väljer i nästa steg vilka konton som hör till det här bolaget.
              </p>
            </div>
          }
        >
          {reusableSessions.map((offer) => (
            <SettingsRow key={offer.connection_id} label={<span data-ph-mask="">{offer.bank_name ?? 'Bank'}</span>}>
              <SettingsRowNote>
                Ansluten för{' '}
                <span className="font-medium text-foreground">
                  {offer.company_name ?? 'ett annat bolag'}
                </span>
                . {offer.available_account_count}{' '}
                {offer.available_account_count === 1 ? 'ledigt konto' : 'lediga konton'} kan
                kopplas till{' '}
                <span className="font-medium text-foreground">
                  {company?.name ?? 'det här bolaget'}
                </span>{' '}
                utan nytt BankID.
              </SettingsRowNote>
              <SettingsRowEnd>
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => handleReuseConnection(offer)}
                  disabled={!!attachingConnectionId}
                >
                  {attachingConnectionId === offer.connection_id ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      Kopplar
                    </>
                  ) : (
                    'Återanvänd'
                  )}
                </Button>
              </SettingsRowEnd>
            </SettingsRow>
          ))}
        </SettingsGroup>
      )}

      {/* Connect new bank. Collapsed behind one outline button whenever the
          company already has a connection (renewing the existing row is the
          primary path); the full group is the page's main content only when
          nothing is connected yet. Non-payers keep seeing the group
          (conversion surface) but the bank list is replaced by an upgrade
          note: the server gate would 403 the connect anyway. The former "Om
          bankintegration (PSD2)" card lives on as group-level help. */}
      {!connectNewExpanded ? (
        <div className="px-1 pt-8">
          <Button variant="outline" size="sm" onClick={() => setConnectNewOpen(true)}>
            Anslut en bank till
          </Button>
        </div>
      ) : (
      <SettingsGroup
        label="Anslut ny bank"
        help={
          <div className="space-y-2">
            <p>Välj din bank nedan för att koppla ditt konto via PSD2.</p>
            <p>
              Anslutningen görs för det bolag som är aktivt just nu. Byt bolag först om du vill
              ansluta banken åt ett annat bolag.
            </p>
            <p className="font-medium">Om bankintegration (PSD2)</p>
            <p>
              Automatisk import av transaktioner via PSD2 open banking.
              Samtycket gäller i 90 dagar och behöver sedan förnyas.
            </p>
            <p>
              Vi använder säker bankintegration (PSD2). Vi kan endast läsa transaktioner,
              aldrig flytta pengar. Du kan också importera transaktioner manuellt via
              bankfiler på importsidan.
            </p>
          </div>
        }
      >
        {!hasBankSync ? (
          <div className="px-1 pt-3">
            <UpgradeNote>
              Automatisk banksynk kräver ett abonnemang. Du kan fortfarande importera
              transaktioner manuellt via bankfiler på importsidan.
            </UpgradeNote>
          </div>
        ) : (
          <>
            <SettingsRow
              label="Kontotyp"
              help="Välj Privatkonto om du använder ditt personliga bankkonto för din verksamhet (vanligt för enskild firma)."
            >
              <SettingsSeg
                value={psuType}
                onChange={setPsuType}
                aria-label="Kontotyp"
                options={[
                  { value: 'business', label: 'Företagskonto' },
                  { value: 'personal', label: 'Privatkonto' },
                ]}
              />
            </SettingsRow>
            <div className="px-1 pt-4">
              {/* Name the company on the surface itself, not only in the help
                  popover: the bank login that follows says nothing about which
                  set of books the accounts will land in. */}
              {company?.name && (
                <p className="mb-3 text-[12.5px] leading-relaxed text-muted-foreground">
                  Anslutningen görs för{' '}
                  <span className="font-medium text-foreground">{company.name}</span>.
                </p>
              )}
              <BankSelector
                onConnect={(bank) => handleConnectBank(bank, psuType)}
                onPsuTypeDetected={setPsuType}
                isConnecting={isConnecting}
                connectingBankName={connectingBankName}
              />
            </div>
          </>
        )}
      </SettingsGroup>
      )}
    </div>
  )
}
