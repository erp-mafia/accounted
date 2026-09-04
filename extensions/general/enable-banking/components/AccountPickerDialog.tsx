'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { useAccounts, useCompanySettings, useFiscalPeriods } from '@/lib/reference-data/hooks'
import Link from 'next/link'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { ChevronRight, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import {
  getPreviousFiscalYearStart,
  daysBetween,
} from '@/lib/company/fiscal-year'
import {
  resolveBookedCoverage,
  resolveFiscalYearStart,
  resolveGapFillStart,
} from '../lib/date-suggestions'
import { describeClaimedElsewhere, partitionByClaim } from '../lib/claimed-accounts'
import type { StoredAccount } from '../types'
import {
  BankSyncProgressDialog,
  type SyncProgressState,
} from './BankSyncProgressDialog'

interface AccountPickerDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  connectionId: string
  bankName: string
  accounts: StoredAccount[]
  // True when the connection is still in pending_selection: closing without
  // saving is allowed but the user is reminded that no sync runs until they
  // confirm.
  isInitialSelection: boolean
  onSaved: () => void
}

interface ChartAccount {
  account_number: string
  account_name: string
}

type LookbackMode = 'gap-fill' | 'fast' | 'fiscal-year' | 'custom'
type CustomSubMode = 'date' | 'previous-fiscal-year'

// Suggested BAS account per currency. The mapping engine falls back to 1930
// when ledger_account is unset, so the SEK case is just an explicit hint.
// Foreign-currency accounts default to the BAS-recommended numbers; if the
// company hasn't created them yet, the user must pick or seed them first.
const CURRENCY_DEFAULTS: Record<string, string> = {
  SEK: '1930',
  EUR: '1932',
  USD: '1933',
  GBP: '1934',
}

export function AccountPickerDialog({
  open,
  onOpenChange,
  connectionId,
  bankName,
  accounts,
  isInitialSelection,
  onSaved,
}: AccountPickerDialogProps) {
  const { toast } = useToast()
  // Memoise so the client has a stable reference across re-renders. Without this,
  // listing `supabase` in the data-fetch effects' deps would re-fire those queries
  // on every checkbox tick or parent re-render.
  const supabase = useMemo(() => createClient(), [])
  const { company } = useCompany()

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [isSaving, setIsSaving] = useState(false)
  // Accounts the callback found booked by another of the user's companies
  // (one SEB consent covers every company the signer represents). They are
  // kept out of the main list so the picker shows THIS company's accounts,
  // and live behind a collapsed disclosure: still reachable, never pre-checked.
  const { own: ownAccounts, claimedElsewhere } = useMemo(
    () => partitionByClaim(accounts),
    [accounts],
  )
  const [claimedOpen, setClaimedOpen] = useState(false)
  // Server-side save rejection (validation / ledger conflict). Shown inline in
  // the dialog: a rejected save persisted nothing and started no sync, so the
  // user must see why and be able to correct the picks.
  const [saveError, setSaveError] = useState<string | null>(null)
  const [lastBookedDate, setLastBookedDate] = useState<string | null>(null)
  // Earliest completed SIE import coverage start: present = migrator flow.
  const [sieCoverageStart, setSieCoverageStart] = useState<string | null>(null)
  // Reference data from the session cache (lib/reference-data), seeded by
  // the dashboard layout: settings, the period containing today and the
  // chart are known when the dialog opens, no requests of its own. A failed
  // load keeps settingsLoaded false so the calendar-year fallback is never
  // presented as the authoritative fiscal-year start (issue #917).
  const {
    settings: companySettings,
    isLoading: settingsLoading,
    error: settingsError,
  } = useCompanySettings()
  const { periods, isLoading: periodsLoading, error: periodsError } = useFiscalPeriods()
  // Inactive accounts included: the old chart query did not filter on is_active.
  const { accounts: allAccounts, error: chartLoadError } = useAccounts(false)
  const settingsLoaded = !settingsLoading && !periodsLoading && !settingsError && !periodsError
  const currentPeriodStart = useMemo(() => {
    const today = new Date().toISOString().split('T')[0]
    const containing = periods
      .filter((p) => p.period_start <= today && today <= p.period_end)
      .sort((a, b) => b.period_start.localeCompare(a.period_start))
    return containing[0]?.period_start || null
  }, [periods])
  // 19xx accounts for the per-account ledger combobox. Class 19 = bank/cash
  // on the BAS chart.
  const chartAccounts = useMemo<ChartAccount[]>(
    () =>
      allAccounts
        .filter((a) => a.account_number.startsWith('19'))
        .sort((a, b) => a.account_number.localeCompare(b.account_number))
        .map((a) => ({ account_number: a.account_number, account_name: a.account_name })),
    [allAccounts],
  )
  // Surface the failure: without the 19xx chart the ledger picker is
  // silently empty, which reads as "no bank accounts exist".
  const chartError = Boolean(chartLoadError)
  const [ledgerByUid, setLedgerByUid] = useState<Record<string, string>>({})

  // Default 'fast' (90 days): the known-good PSD2 window. The fiscal-year
  // default used to send 365+-day requests that some banks (Swedbank) answer
  // by TERMINATING the session: zero transactions, connection expired, no
  // error surfaced (E2E 2026-08-26). Longer ranges stay available as explicit
  // choices with the risk spelled out.
  const [lookbackMode, setLookbackMode] = useState<LookbackMode>('fast')
  const [customSubMode, setCustomSubMode] = useState<CustomSubMode>('date')
  const [customDate, setCustomDate] = useState<string>('')
  // Newest transaction date this CONNECTION has already imported (date null on
  // a first connect). A date means this is a renewal, where the default must be
  // "fill the gap", not a fresh long lookback over bookkept periods. Keyed by
  // connectionId so a stale value can never render into another connection's
  // dialog between open and probe: the gapFill memo ignores mismatched keys.
  const [latestImported, setLatestImported] = useState<{ connectionId: string; date: string | null } | null>(null)
  // Ref, not state: only the async default below reads it, and putting it in
  // the effect's deps would re-fire the query on the first radio click.
  const lookbackTouched = useRef(false)

  const [progressOpen, setProgressOpen] = useState(false)
  const [progressState, setProgressState] = useState<SyncProgressState>({ kind: 'syncing' })
  // Bumped on each new backfill so the progress dialog is keyed per attempt and
  // remounts fresh: the dialog stays mounted across attempts, so without this a
  // second sync would inherit the previous run's elapsed timer for a frame and
  // briefly compute overGrace/blockClose from stale state.
  const [syncAttempt, setSyncAttempt] = useState(0)

  useEffect(() => {
    if (open) {
      const initial = new Set<string>(
        accounts.filter(a => a.enabled !== false).map(a => a.uid)
      )
      setSelected(initial)
      setSaveError(null)
      setClaimedOpen(false)
      setLookbackMode('fast')
      setCustomSubMode('date')
      setCustomDate('')
      lookbackTouched.current = false

      // Pre-populate ledger picks from existing StoredAccount values, falling
      // back to currency-based suggestions for accounts the user hasn't mapped
      // yet. The currency default is suggested at most once — two SEK accounts
      // both pre-filled with 1930 would collide on the UNIQUE
      // (company_id, ledger_account) constraint at save; the second account is
      // left blank so the user picks a distinct slot.
      const initialLedger: Record<string, string> = {}
      const suggested = new Set<string>()
      for (const a of accounts) {
        const fromStored = a.ledger_account
        const fromDefault = CURRENCY_DEFAULTS[a.currency] ?? ''
        const pick = fromStored ?? (suggested.has(fromDefault) ? '' : fromDefault)
        if (pick) suggested.add(pick)
        initialLedger[a.uid] = pick
      }
      setLedgerByUid(initialLedger)
    }
  }, [open, accounts])

  // fiscal_year_start_month + entity_type make "Sedan räkenskapsårets början"
  // resolve to the right date for non-calendar fiscal years, and the actual
  // fiscal_periods row containing today wins when it exists: the recurring
  // setting cannot represent an extended or shortened first year. Both are
  // derived above from the session cache.

  // Fetch the latest posted verifikat date so we can offer "day after the last
  // booked entry" as a one-click escape from the default fiscal-year start.
  // Deliberately NOT sie_imports.fiscal_year_end (issue #917): that is the
  // fiscal period's end, which can lie months past the last actually booked
  // transaction and would make the user skip everything unbooked in between.
  // Only matters on the initial activation flow: selection edits don't re-run sync.
  //
  // Alongside it: the earliest completed SIE import's coverage start. For a
  // migrator the right move is the OPPOSITE of skipping the booked overlap:
  // fetch the whole period and let the post-sync sweep match bank rows against
  // the imported verifikat. The nudge below flips accordingly.
  useEffect(() => {
    if (!open || !isInitialSelection || !company?.id) {
      setLastBookedDate(null)
      setSieCoverageStart(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const [entryRes, sieRes] = await Promise.all([
        supabase
          .from('journal_entries')
          .select('entry_date')
          .eq('company_id', company.id)
          .eq('status', 'posted')
          .order('entry_date', { ascending: false })
          .limit(1)
          .maybeSingle(),
        supabase
          .from('sie_imports')
          .select('fiscal_year_start')
          .eq('company_id', company.id)
          .eq('status', 'completed')
          .not('fiscal_year_start', 'is', null)
          .order('fiscal_year_start', { ascending: true })
          .limit(1)
          .maybeSingle(),
      ])
      if (cancelled) return
      setLastBookedDate((entryRes.data as { entry_date?: string } | null)?.entry_date || null)
      setSieCoverageStart(
        (sieRes.data as { fiscal_year_start?: string } | null)?.fiscal_year_start || null,
      )
    })()
    return () => { cancelled = true }
  }, [open, isInitialSelection, company?.id, supabase])

  // Fetch the newest transaction this connection has already imported. Any row
  // means this pending_selection is a RENEWAL: the flow re-runs the initial
  // backfill, and a fresh consent often makes the bank release history the
  // first connect never delivered. Defaulting to the fiscal-year lookback then
  // re-imports whole bookkept periods as "ohanterade" (the 2026-08 renewal
  // flood), so a renewal defaults to gap-fill instead, unless the user has
  // already picked a mode by the time the query lands.
  useEffect(() => {
    // `accounts` is deliberately a dep even though only its length is read: the
    // reset effect above re-runs on every accounts identity change (the panel's
    // visibility refetch produces a fresh array mid-open, e.g. returning from a
    // BankID app switch) and resets the lookback default. Re-probing on the
    // same trigger re-establishes the gap-fill default; without it the reset
    // would silently strand a renewal back on the fiscal-year default.
    if (!open || !isInitialSelection || !company?.id || accounts.length === 0) return
    let cancelled = false
    ;(async () => {
      // Include rows this connection superseded: a renewal that arrived via a
      // fresh connect owns no transactions until the callback's supersede has
      // re-pointed them, and the gap-fill default must not depend on winning
      // that race. A failed lookup (e.g. column not deployed yet) falls back
      // to probing this connection alone.
      let probeConnectionIds: string[] = [connectionId]
      const { data: supersededRows, error: supersededError } = await supabase
        .from('bank_connections')
        .select('id')
        .eq('company_id', company.id)
        .eq('superseded_by', connectionId)
      if (cancelled) return
      if (!supersededError && supersededRows) {
        probeConnectionIds = [
          connectionId,
          ...(supersededRows as Array<{ id: string }>).map((r) => r.id),
        ]
      }
      const { data, error } = await supabase
        .from('transactions')
        .select('date')
        .eq('company_id', company.id)
        .in('bank_connection_id', probeConnectionIds)
        .order('date', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (cancelled) return
      if (error) {
        // A failed probe must not read as "first connect": deriving the
        // fiscal-year default from an unknown state is the flood case itself.
        console.warn('[enable-banking] latest-import probe failed', error.message)
        return
      }
      const date = (data as { date?: string } | null)?.date || null
      setLatestImported({ connectionId, date })
      if (date && !lookbackTouched.current) setLookbackMode('gap-fill')
    })()
    return () => { cancelled = true }
  }, [open, isInitialSelection, company?.id, connectionId, supabase, accounts])

  // "Alla" means this company's accounts: a claimed account is only ever
  // selected by an explicit tick inside the disclosure. Vacuously true when
  // there are no own accounts, so "Markera alla" is disabled instead of
  // being a live button that does nothing.
  const allSelected = ownAccounts.every((a) => selected.has(a.uid))
  const noneSelected = selected.size === 0
  // Claimed accounts the user deliberately ticked inside the disclosure. They
  // count in "x av y valda" and are named on the disclosure line even while
  // it is collapsed, so the counter never exceeds what the user can see.
  const selectedClaimedCount = claimedElsewhere.filter((a) => selected.has(a.uid)).length
  const selectableCount = ownAccounts.length + selectedClaimedCount

  const byDisplayName = (a: StoredAccount, b: StoredAccount) =>
    (a.name || a.iban || '').localeCompare(b.name || b.iban || '')
  const sortedAccounts = useMemo(() => [...ownAccounts].sort(byDisplayName), [ownAccounts])
  const sortedClaimed = useMemo(() => [...claimedElsewhere].sort(byDisplayName), [claimedElsewhere])

  // Detect cases where the user routed two enabled accounts with different
  // currencies to the same BAS account, usually a mistake, but allowed.
  const currencyConflicts = useMemo(() => {
    const byLedger = new Map<string, Set<string>>()
    for (const a of accounts) {
      if (!selected.has(a.uid)) continue
      const ledger = ledgerByUid[a.uid]
      if (!ledger) continue
      if (!byLedger.has(ledger)) byLedger.set(ledger, new Set())
      byLedger.get(ledger)!.add(a.currency)
    }
    return Array.from(byLedger.entries())
      .filter(([, currencies]) => currencies.size > 1)
      .map(([ledger, currencies]) => ({ ledger, currencies: Array.from(currencies) }))
  }, [accounts, selected, ledgerByUid])

  function toggle(uid: string) {
    setSelected(prev => {
      const next = new Set(prev)
      if (next.has(uid)) next.delete(uid)
      else next.add(uid)
      return next
    })
  }

  function selectAll() {
    // Own accounts only; a claimed account already ticked stays ticked.
    setSelected(prev => {
      const next = new Set(prev)
      for (const a of ownAccounts) next.add(a.uid)
      return next
    })
  }

  function selectNone() {
    setSelected(new Set())
  }

  async function handleSave() {
    if (noneSelected) {
      toast({
        title: 'Välj minst ett konto',
        description: 'Avmarkera alla konton och koppla bort banken istället om inga konton ska synkas.',
        variant: 'destructive',
      })
      return
    }

    // Block save when any enabled account has no ledger picked. The currency
    // defaults cover SEK/EUR/USD/GBP; other currencies require an explicit pick.
    const missingLedger = accounts.filter(a => selected.has(a.uid) && !ledgerByUid[a.uid])
    if (missingLedger.length > 0) {
      toast({
        title: 'Välj bokföringskonto',
        description: `Saknar bokföringskonto för: ${missingLedger.map(a => a.name || a.iban || a.uid).join(', ')}`,
        variant: 'destructive',
      })
      return
    }

    // Block save when the chosen mode resolved to no request body: a blank
    // custom date, or gap-fill whose suggestion vanished. Without this guard,
    // lookback.body is null and the PATCH would silently fall back to the
    // backend's 120-day default, not what the user asked for.
    if (
      isInitialSelection &&
      ((lookbackMode === 'custom' && customSubMode === 'date') || lookbackMode === 'gap-fill') &&
      !lookback.body
    ) {
      toast({
        title: 'Ange startdatum',
        description: 'Välj ett datum för att hämta historik, eller välj ett annat alternativ.',
        variant: 'destructive',
      })
      return
    }

    setIsSaving(true)
    setSaveError(null)

    // Cap the client wait at the route's 300s budget so a hung backfill can't
    // leave the progress modal in 'syncing' forever. The save+backfill is one
    // request; on abort we don't know if it finished, so the message stays
    // neutral and the parent refetch reflects the true state.
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 300_000)

    // For the initial-selection path, open the progress modal up-front so the
    // user has visible feedback during the 30-60s backfill. Selection edits
    // (no backfill) keep the existing toast-only feedback. Do NOT signal the
    // parent to close here (issue #916): the parent unmounts this component on
    // close, which would tear down the progress modal too and swallow every
    // outcome, including a rejected save. The picker Dialog hides itself while
    // progressOpen is true and comes back if the save is rejected.
    if (isInitialSelection) {
      setSyncAttempt((n) => n + 1)
      setProgressState({ kind: 'syncing' })
      setProgressOpen(true)
    }

    try {
      // Send a mapping entry per selected account. Account_mappings doesn't
      // include disabled accounts: their existing ledger_account stays untouched.
      const account_mappings = Array.from(selected).map(uid => ({
        uid,
        ledger_account: ledgerByUid[uid] || null,
      }))

      const response = await fetch('/api/extensions/ext/enable-banking/accounts', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connection_id: connectionId,
          enabled_uids: Array.from(selected),
          account_mappings,
          ...(isInitialSelection && lookback.body ? lookback.body : {}),
        }),
        signal: controller.signal,
      })

      const data = await response.json()

      if (!response.ok) {
        // Rejected save (400 conflicting_accounts / duplicate_accounts / other
        // validation): nothing was persisted and no sync started. Surface the
        // server's message inside the still-open picker; the progress modal's
        // failed state would wrongly claim "we retry in the background".
        setSaveError(
          typeof data?.error === 'string' && data.error
            ? data.error
            : 'Kunde inte spara kontoval'
        )
        if (isInitialSelection) setProgressOpen(false)
        return
      }

      if (isInitialSelection && data.initial_sync) {
        setProgressState({ kind: 'done', summary: data.initial_sync })
      } else if (isInitialSelection && data.initial_sync_error) {
        setProgressState({
          kind: 'failed',
          error: { message: 'Vi sparade kontovalet men kunde inte hämta transaktioner just nu. Vi försöker igen vid nästa körning.' },
        })
      } else {
        toast({
          title: 'Kontoval sparat',
          description: `${data.enabled_count} av ${data.total_count} konton kommer synkas.`,
        })
        onOpenChange(false)
      }

      onSaved()
    } catch (error) {
      const aborted = controller.signal.aborted
      const message = aborted
        ? 'Det tar längre tid än vanligt. Vi slutför i bakgrunden: uppdatera sidan om en stund.'
        : (error instanceof Error ? error.message : 'Kunde inte spara kontoval')
      if (isInitialSelection) {
        setProgressState({ kind: 'failed', error: { message } })
      } else {
        toast({
          title: aborted ? 'Tar längre tid än vanligt' : 'Fel',
          description: message,
          variant: aborted ? undefined : 'destructive',
        })
      }
    } finally {
      clearTimeout(timeout)
      setIsSaving(false)
    }
  }

  const bookedCoverage = useMemo(
    () => resolveBookedCoverage(lastBookedDate),
    [lastBookedDate],
  )

  const gapFill = useMemo(
    () => (latestImported?.connectionId === connectionId
      ? resolveGapFillStart(latestImported.date)
      : null),
    [latestImported, connectionId],
  )

  const fiscalYearStart = useMemo(
    () => resolveFiscalYearStart(currentPeriodStart, companySettings),
    [currentPeriodStart, companySettings],
  )

  const previousFiscalYearStart = useMemo(
    () => getPreviousFiscalYearStart(companySettings),
    [companySettings],
  )

  // Resolve mode → concrete request payload and a "resolved from-date" for display.
  const lookback = useMemo(() => {
    if (lookbackMode === 'gap-fill') {
      // The gap-fill radio only renders when gapFill resolved, but guard the
      // body anyway: a null body falls into the same save-block as a blank
      // custom date instead of silently syncing the server's 120-day default.
      if (gapFill) {
        return {
          body: { initial_lookback_from_date: gapFill.suggestedStartDate },
          fromDate: gapFill.suggestedStartDate,
          days: daysBetween(gapFill.suggestedStartDate),
        }
      }
      return { body: null as Record<string, string | number> | null, fromDate: null as string | null, days: 0 }
    }
    if (lookbackMode === 'fast') {
      return { body: { initial_lookback_days: 90 }, fromDate: null as string | null, days: 90 }
    }
    if (lookbackMode === 'fiscal-year') {
      return { body: { initial_lookback_from_date: fiscalYearStart }, fromDate: fiscalYearStart, days: daysBetween(fiscalYearStart) }
    }
    // custom
    const date = customSubMode === 'previous-fiscal-year' ? previousFiscalYearStart : customDate
    if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return { body: { initial_lookback_from_date: date }, fromDate: date, days: daysBetween(date) }
    }
    return { body: null as Record<string, string | number> | null, fromDate: null as string | null, days: 0 }
  }, [lookbackMode, customSubMode, customDate, fiscalYearStart, previousFiscalYearStart, gapFill])

  const showLongRangeHelper = lookback.days > 90

  // On a renewal, a lookback reaching past what the connection already
  // delivered re-imports periods that may already be bookkept: with a fresh
  // consent the bank often releases history the first connect never returned.
  const reimportsFetchedPeriod = Boolean(
    gapFill &&
    lookbackMode !== 'gap-fill' &&
    (lookback.fromDate
      ? lookback.fromDate < gapFill.latestImportedDate
      : lookback.days > daysBetween(gapFill.latestImportedDate)),
  )

  // One account row; shared by the main list and the claimed-elsewhere
  // disclosure so the two can never drift apart.
  function renderAccountRow(account: StoredAccount) {
    const isChecked = selected.has(account.uid)
    const ledger = ledgerByUid[account.uid] || ''
    const ledgerExistsInChart = chartAccounts.some(c => c.account_number === ledger)
    return (
      <div
        key={account.uid}
        className="flex items-center gap-3 p-3 hover:bg-muted/50"
      >
        {/* Toggle area: label + Checkbox (a Radix Checkbox renders as
            its own <button role="checkbox">, so wrapping it in another
            <button> would be nested interactive elements: invalid HTML
            that browsers silently flatten and breaks event routing). */}
        <label className="flex flex-1 min-w-0 cursor-pointer items-center gap-3">
          <Checkbox
            checked={isChecked}
            onCheckedChange={() => toggle(account.uid)}
            disabled={isSaving}
          />
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium truncate">
              {account.name || account.iban || 'Okänt konto'}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                {account.currency}
              </span>
            </p>
            {account.iban && (
              <p className="text-xs text-muted-foreground tabular-nums">
                {account.iban.replace(/(.{4})/g, '$1 ').trim()}
              </p>
            )}
            {/* The callback found this IBAN already booked by another
                of the user's companies (one consent can cover several
                companies' accounts at e.g. SEB). Unchecked by default;
                naming the claimant is what stops a reflexive
                select-all from booking it here too. */}
            {account.claimed_by_company_id && (
              <p className="text-xs text-muted-foreground">
                Synkas redan i{' '}
                <span data-ph-mask="">
                  {account.claimed_by_company_name || 'ett annat bolag'}
                </span>
              </p>
            )}
            {/* Carried deselection: the user said "Synkas ej" to this
                IBAN on another connection. An unexplained unchecked
                box reads as a glitch; a silent one hides a sync gap. */}
            {!account.claimed_by_company_id && account.deselected_elsewhere && (
              <p className="text-xs text-muted-foreground">
                Tidigare bortvald: markera för att synka i detta bolag
              </p>
            )}
          </div>
          {account.balance !== undefined && (
            <p className="text-sm font-medium tabular-nums shrink-0">
              {new Intl.NumberFormat('sv-SE', {
                style: 'currency',
                currency: account.currency,
              }).format(account.balance)}
            </p>
          )}
        </label>
        {/* Ledger picker is a sibling of the label, not inside it:
            otherwise clicking the Select would also toggle the checkbox. */}
        <div className="w-44 shrink-0">
          {isChecked && (
            <Select
              value={ledger}
              onValueChange={(v) => setLedgerByUid(prev => ({ ...prev, [account.uid]: v }))}
              disabled={isSaving}
            >
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Välj konto…" />
              </SelectTrigger>
              <SelectContent>
                {/* Surface a non-existent default so the user can see/correct it. */}
                {ledger && !ledgerExistsInChart && (
                  <SelectItem value={ledger} disabled>
                    {ledger}: finns ej i kontoplan
                  </SelectItem>
                )}
                {chartAccounts.map(acc => (
                  <SelectItem key={acc.account_number} value={acc.account_number}>
                    <span className="tabular-nums">{acc.account_number}</span> {acc.account_name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
    )
  }

  return (
    <>
    <BankSyncProgressDialog
      key={syncAttempt}
      open={progressOpen}
      onOpenChange={(next) => {
        setProgressOpen(next)
        // When the user dismisses the progress modal the initial-selection
        // flow is over: propagate the saved/refresh signal and close the
        // picker. The parent unmounts this whole component on close, which is
        // exactly why the picker must stay open until this point: closing it
        // earlier would unmount the progress modal mid-flight and swallow the
        // sync summary or error. (onSaved was already emitted on success;
        // repeating it just guards the failure case where we still refresh.)
        if (!next) {
          onSaved()
          onOpenChange(false)
        }
      }}
      bankName={bankName}
      accounts={accounts.filter((a) => selected.has(a.uid))}
      state={progressState}
    />
    {/* Visually yield to the progress modal while it is up, but WITHOUT
        signaling the parent (open stays true): the parent unmounts the
        component on close, and a rejected save must return to a live picker
        with the user's picks intact. */}
    <Dialog open={open && !progressOpen} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Välj konton att synka: <span data-ph-mask="">{bankName}</span></DialogTitle>
          <DialogDescription>
            {isInitialSelection
              ? 'Banken har gett åtkomst till följande konton. Avmarkera de konton du inte vill synka transaktioner från, och välj vilket bokföringskonto varje konto ska bokföras mot. Inga transaktioner hämtas innan du sparar.'
              : 'Justera vilka konton som ska synkas och vilka bokföringskonton de bokförs mot. Konton du avmarkerar slutar synkas från nästa körning; redan importerade transaktioner ligger kvar.'}
          </DialogDescription>
        </DialogHeader>

        {/* Which company's books this lands in. The connection is bound to the
            company that was active when it was authorized, and the account
            list below is that company's chart: without naming it here, a bank
            authorized while the wrong company was active looks identical to
            the right one. */}
        {company?.name && (
          <p className="text-[12.5px] leading-relaxed text-muted-foreground">
            Kontona bokförs i <span className="font-medium text-foreground">{company.name}</span>
            {' '}och bokföringskontona nedan kommer ur det bolagets kontoplan.
          </p>
        )}

        {isInitialSelection && (
          <div className="space-y-3 rounded-lg border border-border bg-muted/30 p-4 text-sm">
            <div>
              <label className="block text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Hämta historik från
              </label>
              <p className="mt-1 text-xs text-muted-foreground">
                Vi börjar hämta transaktioner från det datum du väljer. Du behöver inte tänka i dagar.
              </p>
            </div>

            {sieCoverageStart ? (
              <div className="space-y-2 rounded-md border border-border bg-background/60 p-3">
                {/* Migrator flow: a completed SIE import exists, so the booked
                    overlap is exactly what the post-sync sweep matches bank
                    rows against. Pulling from the SIE year's start is the
                    recommended move; skipping the overlap (the non-migrator
                    nudge) would leave the imported verifikat unreconciled. */}
                <div className="flex items-start justify-between gap-3">
                  <p className="text-xs text-muted-foreground">
                    Du har importerat bokföring. Hämta bankhistorik från{' '}
                    <span className="font-medium tabular-nums text-foreground">{sieCoverageStart}</span>{' '}
                    (importens början) så matchar vi transaktionerna automatiskt mot din importerade
                    bokföring i stället för att bokföra dem igen.
                  </p>
                  <button
                    type="button"
                    className="shrink-0 text-xs text-foreground underline underline-offset-2"
                    onClick={() => {
                      // Explicit choice: the async gap-fill probe must not
                      // override it if it resolves after this click.
                      lookbackTouched.current = true
                      setLookbackMode('custom')
                      setCustomSubMode('date')
                      setCustomDate(sieCoverageStart)
                    }}
                    disabled={isSaving}
                  >
                    Hämta från detta datum
                  </button>
                </div>
                {daysBetween(sieCoverageStart) > 90 && (
                  <p className="text-xs text-muted-foreground">
                    De flesta banker lämnar bara ut ca 90 dagars historik via bankkopplingen. Når
                    hämtningen inte hela vägen tillbaka kan du ladda upp kontoutdrag (CSV) under{' '}
                    <span className="font-medium">Importera</span> för den äldre perioden, matchningen
                    fungerar likadant.
                  </p>
                )}
                {bookedCoverage && (
                  <p className="text-xs text-muted-foreground">
                    Vill du ändå hoppa över det som redan är bokfört kan du{' '}
                    <button
                      type="button"
                      className="text-foreground underline underline-offset-2"
                      onClick={() => {
                        lookbackTouched.current = true
                        setLookbackMode('custom')
                        setCustomSubMode('date')
                        setCustomDate(bookedCoverage.suggestedStartDate)
                      }}
                      disabled={isSaving}
                    >
                      börja från {bookedCoverage.suggestedStartDate}
                    </button>{' '}
                    i stället.
                  </p>
                )}
              </div>
            ) : bookedCoverage && (
              <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-background/60 p-3">
                {/* Stated as a fact with an opt-in shortcut, not as "vi
                    föreslår": the selected default below is the fiscal-year
                    start, and a recommendation that contradicts the selected
                    option reads as a broken prefill. Mid-year is the normal
                    place for the last verifikat to sit, so this line must not
                    push the user off a full-year backfill. */}
                <p className="text-xs text-muted-foreground">
                  Din bokföring är bokförd till och med{' '}
                  <span className="font-medium tabular-nums text-foreground">{bookedCoverage.lastBookedDate}</span>.
                  Vill du hoppa över det som redan är bokfört kan du börja från{' '}
                  <span className="font-medium tabular-nums text-foreground">{bookedCoverage.suggestedStartDate}</span>{' '}
                  i stället.
                </p>
                <button
                  type="button"
                  className="shrink-0 text-xs text-foreground underline underline-offset-2"
                  onClick={() => {
                    lookbackTouched.current = true
                    setLookbackMode('custom')
                    setCustomSubMode('date')
                    setCustomDate(bookedCoverage.suggestedStartDate)
                  }}
                  disabled={isSaving}
                >
                  Använd detta datum
                </button>
              </div>
            )}

            <div className="space-y-2">
              {gapFill && (
                <label className="flex cursor-pointer items-start gap-2">
                  <input
                    type="radio"
                    name="lookback-mode"
                    value="gap-fill"
                    checked={lookbackMode === 'gap-fill'}
                    onChange={() => { lookbackTouched.current = true; setLookbackMode('gap-fill') }}
                    disabled={isSaving}
                    className="mt-1"
                  />
                  <span>
                    <span className="block">Fortsätt där förra hämtningen slutade <span className="text-muted-foreground">(rekommenderas)</span></span>
                    <span className="text-xs text-muted-foreground tabular-nums">
                      från {gapFill.suggestedStartDate}; redan hämtade transaktioner hoppas över automatiskt
                    </span>
                  </span>
                </label>
              )}

              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="lookback-mode"
                  value="fast"
                  checked={lookbackMode === 'fast'}
                  onChange={() => { lookbackTouched.current = true; setLookbackMode('fast') }}
                  disabled={isSaving}
                  className="mt-1"
                />
                <span>
                  <span className="block">Senaste 90 dagar{!gapFill && <span className="text-muted-foreground"> (rekommenderas)</span>}</span>
                  <span className="text-xs text-muted-foreground">
                    det längsta de flesta banker lämnar ut utan extra godkännande
                  </span>
                </span>
              </label>

              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="lookback-mode"
                  value="fiscal-year"
                  checked={lookbackMode === 'fiscal-year'}
                  onChange={() => { lookbackTouched.current = true; setLookbackMode('fiscal-year') }}
                  disabled={isSaving}
                  className="mt-1"
                />
                <span>
                  <span className="block">Sedan räkenskapsårets början</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    från {settingsLoaded ? fiscalYearStart : '…'}
                    {settingsLoaded && daysBetween(fiscalYearStart) > 90 && ': vissa banker avbryter kopplingen vid så långa förfrågningar'}
                  </span>
                </span>
              </label>

              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="lookback-mode"
                  value="custom"
                  checked={lookbackMode === 'custom'}
                  onChange={() => { lookbackTouched.current = true; setLookbackMode('custom') }}
                  disabled={isSaving}
                  className="mt-1"
                />
                <span className="flex-1">
                  <span className="block">Anpassat datum</span>
                  {lookbackMode === 'custom' && (
                    <div className="mt-2 space-y-2">
                      <Select
                        value={customSubMode}
                        onValueChange={(v) => setCustomSubMode(v as CustomSubMode)}
                        disabled={isSaving}
                      >
                        <SelectTrigger className="w-full">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="date">Specifikt datum</SelectItem>
                          <SelectItem value="previous-fiscal-year">
                            Föregående räkenskapsårets start ({settingsLoaded ? previousFiscalYearStart : '…'})
                          </SelectItem>
                        </SelectContent>
                      </Select>
                      {customSubMode === 'date' && (
                        <Input
                          type="date"
                          value={customDate}
                          onChange={(e) => setCustomDate(e.target.value)}
                          max={new Date().toISOString().split('T')[0]}
                          min={new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]}
                          disabled={isSaving}
                          className="tabular-nums"
                        />
                      )}
                    </div>
                  )}
                </span>
              </label>
            </div>

            {reimportsFetchedPeriod && gapFill && (
              <p className="attn text-[12.5px]">
                Du har redan hämtat transaktioner till och med {gapFill.latestImportedDate}. Ett
                tidigare startdatum kan hämta mer historik från banken, och dagar som redan är
                bokförda kan då dyka upp som ohanterade.
              </p>
            )}

            {showLongRangeHelper && (
              <p className="attn text-[12.5px]">
                De flesta banker lämnar bara ut cirka 90 dagar utan extra godkännande, och vissa
                (till exempel Swedbank) avbryter hela kopplingen vid längre förfrågningar: då hämtas
                inget alls och banken måste kopplas om. Säkrast är 90 dagar här och äldre historik
                via{' '}
                <Link
                  href="/import?mode=sie"
                  className="text-foreground underline underline-offset-2"
                >
                  SIE eller kontoutdrag (CSV)
                </Link>
                . Vi visar exakt vad banken returnerade efter sparat val.
              </p>
            )}
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {selected.size} av {selectableCount} valda
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={selectAll}
              disabled={allSelected || isSaving}
              className="underline-offset-2 hover:underline disabled:opacity-50 disabled:no-underline"
            >
              Markera alla
            </button>
            <span aria-hidden>·</span>
            <button
              type="button"
              onClick={selectNone}
              disabled={noneSelected || isSaving}
              className="underline-offset-2 hover:underline disabled:opacity-50 disabled:no-underline"
            >
              Avmarkera alla
            </button>
          </div>
        </div>

        {currencyConflicts.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/30 p-3 text-xs text-muted-foreground">
            Varning: samma bokföringskonto används för flera valutor:
            {currencyConflicts.map(c => ` ${c.ledger} (${c.currencies.join(', ')})`).join(';')}.
            Det fungerar tekniskt men gör årsskifte med valutaomvärdering svårare.
          </div>
        )}

        {chartError && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
            Kunde inte ladda bokföringskonton (19xx). Ladda om sidan och försök igen innan du sparar kontoval.
          </div>
        )}

        {saveError && (
          <div
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive"
          >
            Kontovalet sparades inte: {saveError}
          </div>
        )}

        <div className="max-h-[50vh] overflow-y-auto rounded-lg border border-border divide-y divide-border">
          {sortedAccounts.map(renderAccountRow)}
          {/* Two distinct empty states: every account in the consent belongs
              to another company (the text below says so and points at the
              disclosure), or the consent simply carries no accounts (a failed
              connect, or nothing ticked at the bank), where a claim would be
              a false statement. */}
          {sortedAccounts.length === 0 && (
            <p className="p-3 text-xs text-muted-foreground">
              {claimedElsewhere.length > 0
                ? 'Inga konton att välja: alla konton i den här bankkopplingen synkas redan i andra bolag.'
                : 'Bankkopplingen innehåller inga konton. Förnya anslutningen och välj konton hos banken.'}
            </p>
          )}
        </div>

        {/* Accounts another of the user's companies already books (one SEB
            consent covers every company the signer represents). Collapsed by
            default so this company's picker shows this company's accounts;
            expandable because a claim is a strong hint, not proof, and an
            account that belongs here must stay reachable. */}
        {claimedElsewhere.length > 0 && (
          <div>
            <button
              type="button"
              onClick={() => setClaimedOpen((v) => !v)}
              aria-expanded={claimedOpen}
              className="flex min-h-9 items-center gap-1 text-xs text-muted-foreground transition-colors duration-150 hover:text-foreground"
            >
              <ChevronRight
                className={cn('h-3.5 w-3.5 transition-transform duration-150', claimedOpen && 'rotate-90')}
              />
              <span className="tabular-nums" data-ph-mask="">
                {describeClaimedElsewhere(claimedElsewhere)}
                {selectedClaimedCount > 0 && ` (${selectedClaimedCount} valt här)`}
              </span>
            </button>
            {claimedOpen && (
              <div className="max-h-[30vh] overflow-y-auto rounded-lg border border-border divide-y divide-border">
                {sortedClaimed.map(renderAccountRow)}
              </div>
            )}
          </div>
        )}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            Avbryt
          </Button>
          <Button type="button" onClick={handleSave} disabled={isSaving || noneSelected}>
            {isSaving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {isInitialSelection ? 'Sparar och hämtar transaktioner…' : 'Sparar…'}
              </>
            ) : (
              'Spara val'
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    </>
  )
}
