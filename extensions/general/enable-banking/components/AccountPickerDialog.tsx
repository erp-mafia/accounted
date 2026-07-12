'use client'

import { useEffect, useMemo, useState } from 'react'
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
import { Loader2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import {
  getPreviousFiscalYearStart,
  daysBetween,
} from '@/lib/company/fiscal-year'
import {
  resolveBookedCoverage,
  resolveFiscalYearStart,
} from '../lib/date-suggestions'
import type { CompanySettings } from '@/types'
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

type LookbackMode = 'fast' | 'fiscal-year' | 'custom'
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
  // Server-side save rejection (validation / ledger conflict). Shown inline in
  // the dialog: a rejected save persisted nothing and started no sync, so the
  // user must see why and be able to correct the picks.
  const [saveError, setSaveError] = useState<string | null>(null)
  const [lastBookedDate, setLastBookedDate] = useState<string | null>(null)
  const [chartAccounts, setChartAccounts] = useState<ChartAccount[]>([])
  const [chartError, setChartError] = useState(false)
  const [ledgerByUid, setLedgerByUid] = useState<Record<string, string>>({})
  const [companySettings, setCompanySettings] = useState<Pick<CompanySettings, 'fiscal_year_start_month' | 'entity_type'> | null>(null)
  const [currentPeriodStart, setCurrentPeriodStart] = useState<string | null>(null)
  const [settingsLoaded, setSettingsLoaded] = useState(false)

  const [lookbackMode, setLookbackMode] = useState<LookbackMode>('fiscal-year')
  const [customSubMode, setCustomSubMode] = useState<CustomSubMode>('date')
  const [customDate, setCustomDate] = useState<string>('')

  const [progressOpen, setProgressOpen] = useState(false)
  const [progressState, setProgressState] = useState<SyncProgressState>({ kind: 'syncing' })
  // Bumped on each new backfill so the progress dialog is keyed per attempt and
  // remounts fresh: the dialog stays mounted across attempts, so without this a
  // second sync would inherit the previous run's elapsed timer for a frame and
  // briefly compute overGrace/blockClose from stale state.
  const [syncAttempt, setSyncAttempt] = useState(0)

  useEffect(() => {
    if (open) {
      // Re-arm the "settings loaded" gate each open so the fiscal-year label
      // doesn't flash last-open's resolved date before this open's fetch lands.
      setSettingsLoaded(false)
      const initial = new Set<string>(
        accounts.filter(a => a.enabled !== false).map(a => a.uid)
      )
      setSelected(initial)
      setSaveError(null)
      setLookbackMode('fiscal-year')
      setCustomSubMode('date')
      setCustomDate('')

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

  // Load fiscal_year_start_month + entity_type so "Sedan räkenskapsårets början"
  // resolves to the right date for non-calendar fiscal years, plus the actual
  // fiscal_periods row containing today: the recurring setting cannot represent
  // an extended or shortened first year, so the period row wins when it exists.
  useEffect(() => {
    if (!open || !company?.id) return
    let cancelled = false
    ;(async () => {
      const today = new Date().toISOString().split('T')[0]
      const [settingsRes, periodRes] = await Promise.all([
        supabase
          .from('company_settings')
          .select('fiscal_year_start_month, entity_type')
          .eq('company_id', company.id)
          .maybeSingle(),
        supabase
          .from('fiscal_periods')
          .select('period_start')
          .eq('company_id', company.id)
          .lte('period_start', today)
          .gte('period_end', today)
          .order('period_start', { ascending: false })
          .limit(1)
          .maybeSingle(),
      ])
      if (cancelled) return
      if (settingsRes.error || periodRes.error) {
        // A failed fetch must not present the calendar-year fallback as the
        // authoritative fiscal-year start (issue #917). Leave settingsLoaded
        // false so the date stays masked; if the user proceeds anyway the
        // request falls back to the recurring-setting derivation.
        return
      }
      setCompanySettings((settingsRes.data as { fiscal_year_start_month?: number; entity_type?: CompanySettings['entity_type'] } | null) as Pick<CompanySettings, 'fiscal_year_start_month' | 'entity_type'> | null)
      setCurrentPeriodStart((periodRes.data as { period_start?: string } | null)?.period_start || null)
      setSettingsLoaded(true)
    })()
    return () => { cancelled = true }
  }, [open, company?.id, supabase])

  // Fetch the latest posted verifikat date so we can offer "day after the last
  // booked entry" as a one-click escape from the default fiscal-year start.
  // Deliberately NOT sie_imports.fiscal_year_end (issue #917): that is the
  // fiscal period's end, which can lie months past the last actually booked
  // transaction and would make the user skip everything unbooked in between.
  // Only matters on the initial activation flow: selection edits don't re-run sync.
  useEffect(() => {
    if (!open || !isInitialSelection || !company?.id) {
      setLastBookedDate(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('journal_entries')
        .select('entry_date')
        .eq('company_id', company.id)
        .eq('status', 'posted')
        .order('entry_date', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (cancelled) return
      setLastBookedDate((data as { entry_date?: string } | null)?.entry_date || null)
    })()
    return () => { cancelled = true }
  }, [open, isInitialSelection, company?.id, supabase])

  // Load 19xx accounts from the chart for the per-account ledger combobox.
  // Class 19 = bank/cash on the BAS chart.
  useEffect(() => {
    if (!open || !company?.id) return
    let cancelled = false
    ;(async () => {
      const { data, error } = await supabase
        .from('chart_of_accounts')
        .select('account_number, account_name')
        .eq('company_id', company.id)
        .like('account_number', '19%')
        .order('account_number', { ascending: true })
      if (cancelled) return
      if (error) {
        // Surface the failure: without the 19xx chart the ledger picker is
        // silently empty, which reads as "no bank accounts exist".
        setChartError(true)
        return
      }
      setChartError(false)
      setChartAccounts((data as ChartAccount[] | null) || [])
    })()
    return () => { cancelled = true }
  }, [open, company?.id, supabase])

  const allSelected = accounts.length > 0 && selected.size === accounts.length
  const noneSelected = selected.size === 0

  const sortedAccounts = useMemo(
    () => [...accounts].sort((a, b) => (a.name || a.iban || '').localeCompare(b.name || b.iban || '')),
    [accounts]
  )

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
    setSelected(new Set(accounts.map(a => a.uid)))
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

    // Block save when the user picked "Anpassat datum" but left the date blank.
    // Without this guard, lookback.body is null and the PATCH would silently
    // fall back to the backend's 120-day default, not what the user asked for.
    if (
      isInitialSelection &&
      lookbackMode === 'custom' &&
      customSubMode === 'date' &&
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
  }, [lookbackMode, customSubMode, customDate, fiscalYearStart, previousFiscalYearStart])

  const showLongRangeHelper = lookback.days > 90

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
          <DialogTitle>Välj konton att synka: {bankName}</DialogTitle>
          <DialogDescription>
            {isInitialSelection
              ? 'Banken har gett åtkomst till följande konton. Avmarkera de konton du inte vill synka transaktioner från, och välj vilket bokföringskonto varje konto ska bokföras mot. Inga transaktioner hämtas innan du sparar.'
              : 'Justera vilka konton som ska synkas och vilka bokföringskonton de bokförs mot. Konton du avmarkerar slutar synkas från nästa körning; redan importerade transaktioner ligger kvar.'}
          </DialogDescription>
        </DialogHeader>

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

            {bookedCoverage && (
              <div className="flex items-start justify-between gap-3 rounded-md border border-border bg-background/60 p-3">
                <p className="text-xs text-muted-foreground">
                  Ditt senaste bokförda verifikat är daterat{' '}
                  <span className="font-medium tabular-nums text-foreground">{bookedCoverage.lastBookedDate}</span>.
                  Vi föreslår{' '}
                  <span className="font-medium tabular-nums text-foreground">{bookedCoverage.suggestedStartDate}</span>{' '}
                  som startdatum så inget överlappar din bokföring.
                </p>
                <button
                  type="button"
                  className="shrink-0 text-xs text-foreground underline underline-offset-2"
                  onClick={() => {
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
              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="lookback-mode"
                  value="fast"
                  checked={lookbackMode === 'fast'}
                  onChange={() => setLookbackMode('fast')}
                  disabled={isSaving}
                  className="mt-1"
                />
                <span>
                  <span className="block">Senaste 90 dagar <span className="text-muted-foreground">(snabbt)</span></span>
                </span>
              </label>

              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="lookback-mode"
                  value="fiscal-year"
                  checked={lookbackMode === 'fiscal-year'}
                  onChange={() => setLookbackMode('fiscal-year')}
                  disabled={isSaving}
                  className="mt-1"
                />
                <span>
                  <span className="block">Sedan räkenskapsårets början</span>
                  <span className="text-xs text-muted-foreground tabular-nums">
                    från {settingsLoaded ? fiscalYearStart : '…'}
                  </span>
                </span>
              </label>

              <label className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="lookback-mode"
                  value="custom"
                  checked={lookbackMode === 'custom'}
                  onChange={() => setLookbackMode('custom')}
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

            {showLongRangeHelper && (
              <p className="text-xs text-muted-foreground">
                Din bank returnerar oftast max 90 dagar. Behöver du äldre transaktioner kan du{' '}
                <Link
                  href="/import?mode=sie"
                  className="text-foreground underline underline-offset-2"
                >
                  importera via SIE eller bankfil
                </Link>
                . Vi visar exakt vad banken returnerade efter sparat val.
              </p>
            )}
          </div>
        )}

        <div className="flex items-center justify-between text-xs text-muted-foreground">
          <span>
            {selected.size} av {accounts.length} valda
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
          {sortedAccounts.map(account => {
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
          })}
        </div>

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
