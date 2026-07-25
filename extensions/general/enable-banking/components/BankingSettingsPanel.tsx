'use client'

import { useState, useEffect, useRef } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/use-toast'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { CheckCircle, Loader2, Upload } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { notifyBankSyncUpdated } from '@/lib/transactions/bank-sync-signal'
import { useCompany, useCapability } from '@/contexts/CompanyContext'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { UpgradeNote } from '@/components/billing/UpgradeNote'
import { SettingsGroup, SettingsRow, SettingsSeg } from '@/components/settings/SettingsRows'
import { BankSelector, type Bank } from './BankSelector'
import { BankConnectionStatus } from './BankConnectionStatus'
import { AccountPickerDialog } from './AccountPickerDialog'
import type { BankConnection } from '@/types'
import type { StoredAccount } from '../types'

/**
 * Self-contained banking settings panel for the enable-banking extension.
 * Loaded dynamically by the settings panel registry.
 */
export default function BankingSettingsPanel() {
  const { toast } = useToast()
  const supabase = createClient()
  // The OAuth callback lands here with ?select_accounts=<id> once a bank is
  // successfully connected. Read via useSearchParams (SSR/hydration-safe) so
  // the first-load spinner can say "bank connected, fetching accounts"
  // instead of an anonymous spinner. The param itself is consumed and
  // stripped by the auto-open effect below.
  const searchParams = useSearchParams()
  const arrivedFromBankCallback = !!searchParams?.get('select_accounts')

  const { dialogProps, confirm } = useDestructiveConfirm()
  const { company } = useCompany()
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
    }

    params.delete('select_accounts')
    const newQuery = params.toString()
    const newUrl = `${window.location.pathname}${newQuery ? `?${newQuery}` : ''}`
    window.history.replaceState({}, '', newUrl)
  }, [isLoading, bankConnections])

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

  async function handleConnectBank(bank: Bank, psuTypeOverride?: 'personal' | 'business') {
    if (connectingRef.current) return
    connectingRef.current = true
    setIsConnecting(true)
    setConnectingBankName(bank.name)

    try {
      console.log('[enable-banking] Initiating bank connection', {
        bankName: bank.name,
        bankCountry: bank.country,
        psuTypeOverride,
      })

      const body: Record<string, string> = { aspsp_name: bank.name, aspsp_country: bank.country }
      if (psuTypeOverride) body.psu_type = psuTypeOverride

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
    connectingRef.current = true
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

  const activeConnections = bankConnections.filter((c) => c.status === 'active')
  const pendingSelectionConnections = bankConnections.filter((c) => c.status === 'pending_selection')
  const actionRequiredConnections = bankConnections.filter((c) => ['expired', 'error'].includes(c.status))

  const pickerConnection = pickerConnectionId
    ? bankConnections.find(c => c.id === pickerConnectionId)
    : null
  const pickerAccounts = pickerConnection
    ? ((pickerConnection.accounts_data as StoredAccount[] | null) || [])
    : []

  return (
    <div>
      <DestructiveConfirmDialog {...dialogProps} />

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

      {/* Pending account selection: new connections waiting for the user to pick accounts */}
      {pendingSelectionConnections.length > 0 && (
        <SettingsGroup
          label="Välj konton att synka"
          help="Banken har gett åtkomst till flera konton. Välj vilka du vill synka innan några transaktioner hämtas."
        >
          {pendingSelectionConnections.map((connection) => {
            const accountsList = (connection.accounts_data as StoredAccount[] | null) || []
            return (
              <div
                key={connection.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-1 py-3"
              >
                <span className="text-sm font-medium">{connection.bank_name}</span>
                <span className="text-xs text-muted-foreground">
                  {accountsList.length} konton tillgängliga: inga transaktioner synkas ännu
                </span>
                <span className="ml-auto flex shrink-0 items-center gap-2">
                  <Button size="sm" onClick={() => setPickerConnectionId(connection.id)}>
                    Välj konton
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="text-muted-foreground hover:text-foreground"
                    onClick={() => handleDisconnectBank(connection.id)}
                  >
                    Avbryt
                  </Button>
                </span>
              </div>
            )
          })}
        </SettingsGroup>
      )}

      {/* Action required: expired/error connections */}
      {actionRequiredConnections.length > 0 && (
        <SettingsGroup label="Åtgärd krävs" help="Dessa anslutningar behöver uppmärksamhet.">
          {actionRequiredConnections.map((connection) => (
            <BankConnectionStatus
              key={connection.id}
              connection={connection}
              onSync={handleSyncTransactions}
              onDisconnect={handleDisconnectBank}
              onReconnect={handleReconnect}
              onManageAccounts={() => setPickerConnectionId(connection.id)}
              isSyncing={syncingConnectionId === connection.id}
            />
          ))}
        </SettingsGroup>
      )}

      {/* Connected banks */}
      {activeConnections.length > 0 && (
        <SettingsGroup label="Anslutna banker">
          {activeConnections.map((connection) => (
            <BankConnectionStatus
              key={connection.id}
              connection={connection}
              onSync={handleSyncTransactions}
              onDisconnect={handleDisconnectBank}
              onManageAccounts={() => setPickerConnectionId(connection.id)}
              isSyncing={syncingConnectionId === connection.id}
            />
          ))}
        </SettingsGroup>
      )}

      {/* Connect new bank. Non-payers keep seeing the group (conversion
          surface) but the bank list is replaced by an upgrade note: the
          server gate would 403 the connect anyway. The former "Om
          bankintegration (PSD2)" card lives on as group-level help. */}
      <SettingsGroup
        label="Anslut ny bank"
        help={
          <div className="space-y-2">
            <p>Välj din bank nedan för att koppla ditt konto via PSD2.</p>
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
    </div>
  )
}
