'use client'

import Link from 'next/link'
import { useState, useEffect, useCallback, useRef } from 'react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { AccountNumber } from '@/components/ui/account-number'
import { AlertCircle, ChevronDown, ChevronRight, Link2, Unlink, Play, Eye, EyeOff, PiggyBank, MoreHorizontal } from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { CashAccountSelector } from '@/components/common/CashAccountSelector'
import { MatchVerifikationPicker, type UnlinkedGLLine } from '@/components/reconciliation/MatchVerifikationPicker'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  DestructiveConfirmDialog,
  useDestructiveConfirm,
} from '@/components/ui/destructive-confirm-dialog'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import type { CashAccount } from '@/types'

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const METHOD_LABELS: Record<string, string> = {
  auto_exact: 'Exakt matchning',
  auto_date_range: 'Datumintervall',
  auto_reference: 'Referensmatchning',
  auto_fuzzy: 'Ungefärlig matchning',
  manual: 'Manuell',
}

// journal_entries.source_type values that can appear on a bank-account GL line,
// mapped to Swedish. Falls back to the raw value for anything unmapped so a new
// enum value degrades to today's behaviour instead of an empty cell.
const SOURCE_TYPE_LABELS: Record<string, string> = {
  manual: 'Manuell',
  import: 'Import',
  bank_transaction: 'Banktransaktion',
  invoice_paid: 'Kundfaktura betald',
  invoice_cash_payment: 'Kontantfaktura',
  supplier_invoice_paid: 'Leverantörsfaktura betald',
  supplier_invoice_cash_payment: 'Leverantörsfaktura (kontant)',
  salary_payment: 'Löneutbetalning',
  system: 'System',
  inbox_item: 'Inkorgsunderlag',
  currency_revaluation: 'Valutaomvärdering',
  year_end: 'Bokslut',
  reminder_fee: 'Påminnelseavgift',
}

// Same thresholds as MatchVerifikationPicker's confidenceBadge: the dry-run
// preview must read identically to the per-row picker.
function confidenceLabel(confidence: number): {
  label: string
  variant: 'success' | 'secondary' | 'outline'
} {
  if (confidence >= 0.85) return { label: 'Stark', variant: 'success' }
  if (confidence >= 0.6) return { label: 'Trolig', variant: 'secondary' }
  return { label: 'Svag', variant: 'outline' }
}

/** Pre-tick strong matches; fuzzy (0.75) stays unticked for explicit opt-in. */
const PRESELECT_CONFIDENCE = 0.85

const matchKey = (transactionId: string, journalEntryId: string) =>
  `${transactionId}:${journalEntryId}`

// One-click bookings for transactions with no upstream invoice/voucher to match
// against: the common "stuck on the unmatched list" cause (small ränteintäkter,
// bankavgifter, valutakursdifferenser). These reuse the existing bank_finance
// booking templates; the categorize endpoint rewrites the bank leg to the
// transaction's actual settlement account, so they book correctly on ANY cash
// account (1930, a savings account, a EUR account…), not just 1930.
// `account` is the non-bank leg (revenue/cost): the bank leg is the selected
// account. Income templates apply to positive amounts, expense to negative.
const QUICK_BOOK_TEMPLATES: {
  id: string
  label: string
  account: string
  direction: 'income' | 'expense'
}[] = [
  { id: 'bank_interest_income', label: 'ränteintäkt', account: '8310', direction: 'income' },
  { id: 'bank_currency_gain', label: 'valutakursvinst', account: '3960', direction: 'income' },
  { id: 'bank_fees', label: 'bankavgift', account: '6570', direction: 'expense' },
  { id: 'bank_interest_expense', label: 'räntekostnad', account: '8410', direction: 'expense' },
  { id: 'bank_currency_loss', label: 'valutakursförlust', account: '7960', direction: 'expense' },
]

// ============================================================
// Types
// ============================================================

interface ReconciliationStatus {
  bank_transaction_total: number
  /**
   * @deprecated Kept on the server response for back-compat. The UI no longer
   * reads it: `gl_1930_period_movement` is required.
   */
  gl_1930_balance: number
  gl_1930_period_movement: number
  gl_1930_opening_balance: number
  gl_1930_correction_adjustment: number
  difference: number
  is_reconciled: boolean
  matched_count: number
  unmatched_transaction_count: number
  unmatched_gl_line_count: number
}

interface UnmatchedTransaction {
  id: string
  date: string
  description: string
  amount: number
  reference: string | null
  currency: string
  is_ignored?: boolean
}

interface MatchedTransaction {
  id: string
  date: string
  description: string
  amount: number
  reconciliation_method: string | null
  journal_entry_id: string | null
}

interface DryRunMatch {
  transaction_id: string
  transaction_date: string
  transaction_description: string
  transaction_amount: number
  journal_entry_id: string
  voucher_number: number
  voucher_series: string
  entry_date: string
  entry_description: string
  method: string
  confidence: number
}

// ============================================================
// Component
// ============================================================

interface BankReconciliationViewProps {
  /**
   * The fiscal period to reconcile, from the page-level räkenskapsår selector in
   * the report header (FocusedReport). The view no longer owns a selector of its
   * own: that duplicate, hidden behind the loading skeleton, deadlocked the page
   * (#771).
   */
  periodId: string
  /** period_start / period_end of that period; seeds the date window (#751). */
  periodBounds: { start: string; end: string } | null
}

export function BankReconciliationView({ periodId, periodBounds }: BankReconciliationViewProps) {
  const [status, setStatus] = useState<ReconciliationStatus | null>(null)
  const [unmatchedTx, setUnmatchedTx] = useState<UnmatchedTransaction[]>([])
  const [glLines, setGlLines] = useState<UnlinkedGLLine[]>([])
  const [matchedTx, setMatchedTx] = useState<MatchedTransaction[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // The window is scoped to a fiscal period (issue #751/#771): a bank
  // reconciliation is inherently per-period, and a "full history" window spans
  // the fiscal-year boundary: mixing a prior period's movements with the current
  // year's IB and manufacturing a phantom difference equal to the IB. The period
  // is owned by the page-level FiscalYearSelector in the report header and passed
  // in as props, so the view always mounts with a known window. It used to host
  // its OWN selector inside the action bar and gate the first fetch on a
  // `periodReady` flag, but that selector lived below the loading-skeleton
  // early-return, so it never mounted, the flag never flipped, and the page hung
  // on a permanent skeleton (#771). dateFrom/dateTo are seeded from periodBounds
  // here and stay editable as a manual override (applied via "Filtrera").
  const [dateFrom, setDateFrom] = useState(periodBounds?.start ?? '')
  const [dateTo, setDateTo] = useState(() => {
    const today = new Date().toISOString().slice(0, 10)
    if (periodBounds && periodBounds.end < today) return periodBounds.end
    return today
  })
  const [accountNumber, setAccountNumber] = useState('1930')
  const [cashAccounts, setCashAccounts] = useState<CashAccount[]>([])
  // Date filters apply on demand (the "Filtrera" button or an account switch),
  // never on every keystroke. Editing a date used to re-create fetchAll and
  // re-trigger its effect: the "switching months reloads automatically"
  // annoyance. fetchAll reads the live dates from refs so an explicit run always
  // uses the latest typed values without putting them in its dependency array.
  const dateFromRef = useRef(dateFrom)
  const dateToRef = useRef(dateTo)
  useEffect(() => {
    dateFromRef.current = dateFrom
  }, [dateFrom])
  useEffect(() => {
    dateToRef.current = dateTo
  }, [dateTo])

  const [dryRunResults, setDryRunResults] = useState<DryRunMatch[] | null>(null)
  // Which preview rows apply on "Tillämpa". Strong matches (≥0.85) are
  // pre-ticked; fuzzy ones require an explicit opt-in tick.
  const [selectedPairs, setSelectedPairs] = useState<Set<string>>(new Set())
  // The date window the on-screen lists were last fetched with. Preview/apply
  // read THIS window (not the live inputs) so they can never run against a
  // different window than the lists the user is looking at; a mismatch between
  // typed and applied dates renders a "klicka Filtrera" hint instead.
  const [appliedDates, setAppliedDates] = useState<{ from: string; to: string } | null>(null)
  const [runLoading, setRunLoading] = useState(false)
  const [applyLoading, setApplyLoading] = useState(false)
  const [linkLoading, setLinkLoading] = useState<string | null>(null)
  const [unlinkLoading, setUnlinkLoading] = useState<string | null>(null)
  // Per-verifikat loading for the "Märk som ingående balans" re-tag action.
  const [markLoading, setMarkLoading] = useState<string | null>(null)
  const [actionLoading, setActionLoading] = useState<string | null>(null)

  // Opt-in: also surface vouchers already matched to a bank transaction as
  // candidates, so a second/third transaction can be attached to the same
  // verifikat (N:1, e.g. a salary run paid out in several transfers). Only
  // affects the per-row picker candidates; the "Omatchade verifikationer" table
  // below stays unmatched-only (it lists vouchers that still need a transaction).
  const [includeMatched, setIncludeMatched] = useState(false)

  const [showMatched, setShowMatched] = useState(false)
  // Default expanded so users discover the undo path. The card itself only
  // renders when ignoredTx.length > 0: collapsing it by default hid the
  // recovery affordance from anyone who didn't already know it was there.
  const [showIgnored, setShowIgnored] = useState(true)
  const [ignoredTx, setIgnoredTx] = useState<UnmatchedTransaction[]>([])
  const [selectedMatch, setSelectedMatch] = useState<Record<string, string>>({})
  // True when the unmatched list hit the API's 500-row cap: surfaced so a long
  // date range doesn't silently hide rows and let the user think they're done.
  const [unmatchedTruncated, setUnmatchedTruncated] = useState(false)
  // Per-transaction ranked match candidates, lazily fetched when the row's
  // picker is first focused. Passing transaction_id to /unmatched-entries makes
  // the server rank candidates and attach confidence: the same intelligence
  // MatchVoucherDialog gets on the Transactions page. Keyed by transaction id;
  // cleared whenever the lists refetch (the candidate set may have changed).
  const [rankedCandidates, setRankedCandidates] = useState<Record<string, UnlinkedGLLine[]>>({})
  const rankedFetchInFlight = useRef<Set<string>>(new Set())
  // Bumped whenever fetchAll clears the ranked cache: an in-flight ranked
  // response from before the clear must not repopulate the fresh cache, or
  // that row's picker would show pre-refetch candidates until the next reload.
  const rankedGenerationRef = useRef(0)
  // Aborts the previous in-flight load when the account/date filters change, so
  // a slow stale response can't overwrite the freshly-selected account's data
  // (the intermittent "flips between accounts" bug).
  const fetchAbortRef = useRef<AbortController | null>(null)

  const { dialogProps: confirmDialogProps, confirm } = useDestructiveConfirm()
  const { toast } = useToast()

  // Derive the currency for the selected ledger account from cash_accounts.
  // Without this the lists below would hardcode SEK and silently return zero
  // rows for users on 1932 EUR (or any other non-SEK cash account).
  const accountCurrency =
    cashAccounts.find((a) => a.ledger_account === accountNumber)?.currency ?? 'SEK'

  // glLines feeds the per-row picker (which may include already-matched vouchers
  // when includeMatched is on). The "Omatchade verifikationer" table below must
  // stay unmatched-only: a voucher with a linked transaction isn't something
  // that still needs one.
  const unmatchedGlLines = glLines.filter((l) => !(l.linked_transaction_count ?? 0))

  // The typed dates differ from what the lists (and preview/apply) run against.
  // Surfaced as a hint so a user can't edit a date, skip Filtrera, and believe
  // the preview covered the window they typed.
  const datesDirty =
    appliedDates !== null && (appliedDates.from !== dateFrom || appliedDates.to !== dateTo)

  useEffect(() => {
    let cancelled = false
    fetch('/api/cash-accounts')
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled && Array.isArray(j.data)) setCashAccounts(j.data as CashAccount[])
      })
      .catch(() => {
        // Non-critical: falls back to 'SEK' currency, matches old behaviour.
      })
    return () => {
      cancelled = true
    }
  }, [])

  const fetchAll = useCallback(async (opts?: { silent?: boolean }) => {
    // Cancel any in-flight load: it may be for a different account. Without
    // this, switching accounts quickly lets an older response land last and
    // overwrite the current account's data.
    fetchAbortRef.current?.abort()
    const controller = new AbortController()
    fetchAbortRef.current = controller
    const { signal } = controller

    // Only wholesale reloads (mount, account/period switch, Filtrera) show the
    // skeleton. Row mutations refresh silently and update in place: the old
    // behaviour unmounted the entire page on EVERY link/unlink/quick-book,
    // losing scroll position and flashing 30 skeletons for 30 matches.
    if (!opts?.silent) {
      setLoading(true)
      // A wholesale reload means the window/account/candidate set may have
      // changed: a preview computed for the previous window must not leave an
      // enabled "Tillämpa" button behind. Silent row-mutation refetches keep
      // the preview (same window; the intersection guard on apply covers rows
      // that got linked meanwhile).
      setDryRunResults(null)
      setSelectedPairs(new Set())
    }
    setError(null)
    // The candidate pool changes with the data: drop stale per-row rankings
    // and invalidate any ranked fetch already in flight.
    setRankedCandidates({})
    rankedFetchInFlight.current.clear()
    rankedGenerationRef.current++
    try {
      const fromValue = dateFromRef.current
      const toValue = dateToRef.current
      const params = new URLSearchParams()
      if (fromValue) params.set('date_from', fromValue)
      if (toValue) params.set('date_to', toValue)
      params.set('account_number', accountNumber)
      const qs = `?${params}`

      // The candidate-lines fetch optionally includes already-matched vouchers
      // (for N:1); the status endpoint must NOT (its movement/diff is computed
      // independently) so it keeps the plain qs.
      const glParams = new URLSearchParams(params)
      if (includeMatched) glParams.set('include_matched', 'true')
      const glQs = `?${glParams}`

      const txParams = new URLSearchParams()
      txParams.set('currency', accountCurrency)
      txParams.set('account_number', accountNumber)
      if (fromValue) txParams.set('date_from', fromValue)
      if (toValue) txParams.set('date_to', toValue)
      const unmatchedQs = `?unmatched=true&${txParams}`
      const reconciledQs = `?reconciled=true&${txParams}`

      const [statusRes, glRes, unmatchedRes, matchedRes] = await Promise.all([
        fetch(`/api/reconciliation/bank/status${qs}`, { signal }),
        fetch(`/api/reconciliation/bank/unmatched-entries${glQs}`, { signal }),
        fetch(`/api/transactions${unmatchedQs}`, { signal }),
        fetch(`/api/transactions${reconciledQs}`, { signal }),
      ])

      const [statusData, glData, unmatchedData, matchedData] = await Promise.all([
        statusRes.json(),
        glRes.json(),
        unmatchedRes.json(),
        matchedRes.json(),
      ])

      // A newer load superseded this one while we awaited: discard these
      // stale results rather than clobber the current account's data.
      if (signal.aborted) return

      if (statusData.data) setStatus(statusData.data)
      setGlLines(glData.data || [])
      setUnmatchedTx(unmatchedData.data || [])
      setMatchedTx(matchedData.data || [])
      setUnmatchedTruncated(Boolean(unmatchedData.has_more))
      // Record the window these lists represent: preview/apply run against it.
      setAppliedDates({ from: fromValue, to: toValue })

      // Refresh the ignored list whenever the main lists refresh.
      // Deliberately NOT filtered by account or currency: if a user ignored
      // a row on 1932 EUR and then switched to 1930 SEK, the recovery card
      // would disappear and the row would feel "stuck". Company-wide scope
      // keeps the Återställ path reachable from any account selection. The
      // date filter is also dropped so old ignores stay visible.
      try {
        const ignoredRes = await fetch(`/api/transactions?unmatched=true&only_ignored=true`, { signal })
        const ignoredData = await ignoredRes.json()
        if (!signal.aborted) setIgnoredTx(ignoredData.data || [])
      } catch {
        if (!signal.aborted) setIgnoredTx([])
      }
    } catch (e) {
      // Aborts are expected when the user switches account/date quickly.
      if (signal.aborted || (e instanceof DOMException && e.name === 'AbortError')) return
      console.error('[reconciliation] fetchAll failed', e)
      setError('Kunde inte hämta avstämningsdata')
    } finally {
      // Only the latest load owns the spinner; a superseded load must not flip
      // it off while the fresh one is still running.
      if (!signal.aborted) setLoading(false)
    }
    // Deliberately excludes dateFrom/dateTo: editing a date must NOT auto-fetch
    // (it read from refs above). Re-runs on account / currency change, on the
    // matched-toggle flip (which changes the candidate set), and on mount; the
    // "Filtrera" button calls fetchAll() explicitly for date changes.
  }, [accountNumber, accountCurrency, includeMatched])

  // Re-seed the date window whenever the selected räkenskapsår changes (driven
  // by the page-level FiscalYearSelector in the report header). dateTo is clamped
  // to today for the current (open) year so we don't claim to reconcile into the
  // future; a past year ends at its period_end.
  //
  // We write dateFromRef/dateToRef SYNCHRONOUSLY here, not just the state: fetchAll
  // reads the window from the refs, and the [dateFrom]/[dateTo] sync effects above
  // only refresh them on the NEXT commit: too late for the fetch effect below,
  // which runs on this same period-switch commit. Without the synchronous ref
  // write the first load after a year switch would use the PREVIOUS period's
  // window (off-by-one). This effect MUST stay declared ABOVE the fetch effect so
  // React runs it first.
  //
  // Keyed on periodId ONLY: switching the bank account must re-fetch (via the
  // fetch effect, whose fetchAll identity changes) but must NOT re-seed the dates
  // and discard a manual "Datum från/till" edit.
  useEffect(() => {
    if (!periodBounds) return
    const today = new Date().toISOString().slice(0, 10)
    const from = periodBounds.start
    const to = periodBounds.end < today ? periodBounds.end : today
    setDateFrom(from)
    setDateTo(to)
    dateFromRef.current = from
    dateToRef.current = to
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId])

  // Load on mount, when the bank account / currency / matched-toggle change
  // (fetchAll identity), and when the räkenskapsår switches (periodId). fetchAll
  // reads the window from the refs, which the effect above has already refreshed
  // for a period switch. Manual date edits intentionally do NOT auto-fetch: that
  // stays on the explicit "Filtrera" button (which calls fetchAll() directly).
  useEffect(() => {
    fetchAll()
  }, [fetchAll, periodId])

  // Reset transient per-account UI state when the selected account changes. A
  // verifikation pick or a dry-run preview computed for the previous account is
  // meaningless against the new one, and applying it would cross-link.
  useEffect(() => {
    setSelectedMatch({})
    setDryRunResults(null)
    setSelectedPairs(new Set())
  }, [accountNumber])

  const handleDryRun = async () => {
    setRunLoading(true)
    setDryRunResults(null)
    setSelectedPairs(new Set())
    try {
      const res = await fetch('/api/reconciliation/bank/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          // The APPLIED window: never the live inputs, which may not match the
          // lists on screen until the user clicks Filtrera.
          date_from: appliedDates?.from || undefined,
          date_to: appliedDates?.to || undefined,
          account_number: accountNumber,
          dry_run: true,
        }),
      })
      const result = await res.json()
      if (!res.ok || result.error) {
        // An error envelope parses as JSON, so the catch below never fires for
        // it: without this check the button just stopped spinning and NOTHING
        // rendered, leaving the user staring at an unchanged page.
        setError(
          typeof result.error === 'string' ? result.error : 'Kunde inte köra förhandsgranskning',
        )
        return
      }
      if (result.data?.matches) {
        const matches = result.data.matches as DryRunMatch[]
        setDryRunResults(matches)
        setSelectedPairs(
          new Set(
            matches
              .filter((m) => m.confidence >= PRESELECT_CONFIDENCE)
              .map((m) => matchKey(m.transaction_id, m.journal_entry_id)),
          ),
        )
      }
    } catch {
      setError('Kunde inte köra förhandsgranskning')
    } finally {
      setRunLoading(false)
    }
  }

  const toggleMatchSelection = (key: string) => {
    setSelectedPairs((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  // Matches RunReconciliationSchema's selected_matches .max(500). A first
  // reconciliation after a year of imports can preview (and pre-tick) far more
  // than 500 matches: applied in sequential chunks so the flow never dead-ends
  // on the payload cap. Chunking is safe: the server intersects each chunk with
  // a fresh match run, so pairs applied by an earlier chunk simply drop out of
  // later ones and unselected pairs are never applied.
  const APPLY_CHUNK_SIZE = 500

  const handleApply = async () => {
    if (!dryRunResults || selectedPairs.size === 0) return
    const selected = dryRunResults.filter((m) =>
      selectedPairs.has(matchKey(m.transaction_id, m.journal_entry_id)),
    )
    const requested = selected.length
    setApplyLoading(true)
    let applied = 0
    let failed = false
    let failMessage: string | undefined
    try {
      for (let i = 0; i < selected.length; i += APPLY_CHUNK_SIZE) {
        const chunk = selected.slice(i, i + APPLY_CHUNK_SIZE)
        const res = await fetch('/api/reconciliation/bank/run', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            date_from: appliedDates?.from || undefined,
            date_to: appliedDates?.to || undefined,
            account_number: accountNumber,
            dry_run: false,
            selected_matches: chunk.map((m) => ({
              transaction_id: m.transaction_id,
              journal_entry_id: m.journal_entry_id,
            })),
          }),
        })
        const result = await res.json()
        if (!res.ok || result.error) {
          failed = true
          failMessage = typeof result.error === 'string' ? result.error : undefined
          break
        }
        applied += result.data?.applied ?? 0
      }
    } catch {
      failed = true
    }

    // Report what actually happened: the old flow cleared the preview and
    // said nothing, even when the API had failed outright.
    if (failed) {
      toast({
        variant: 'destructive',
        title:
          applied > 0
            ? `${applied} av ${requested} matchningar tillämpade; resten misslyckades`
            : 'Kunde inte tillämpa matchningarna',
        description: failMessage,
      })
    } else if (applied === requested) {
      toast({
        variant: 'success',
        title: `${applied} ${applied === 1 ? 'matchning tillämpad' : 'matchningar tillämpade'}`,
      })
    } else {
      toast({
        variant: 'destructive',
        title: `${applied} av ${requested} matchningar tillämpade`,
        description:
          'Resten kunde inte tillämpas: underlaget kan ha ändrats sedan förhandsgranskningen. Kör en ny förhandsgranskning.',
      })
    }
    // Refetch whenever anything may have been written; on a clean failure with
    // zero applied the preview survives so the user can retry.
    try {
      if (!failed || applied > 0) {
        setDryRunResults(null)
        setSelectedPairs(new Set())
        await fetchAll({ silent: true })
      }
    } finally {
      setApplyLoading(false)
    }
  }

  /**
   * Lazily fetch ranked, confidence-scored candidates for one transaction the
   * first time its picker is focused. The endpoint ranks and attaches
   * confidence when transaction_id is passed: without it every row shows the
   * same unranked list and no Stark/Trolig/Svag badges (the intelligence the
   * Transactions page's MatchVoucherDialog has had all along).
   */
  const ensureRankedCandidates = useCallback(
    async (transactionId: string) => {
      if (rankedCandidates[transactionId] || rankedFetchInFlight.current.has(transactionId)) {
        return
      }
      rankedFetchInFlight.current.add(transactionId)
      const generation = rankedGenerationRef.current
      try {
        const params = new URLSearchParams()
        // The APPLIED window: the same one the lists and preview run against.
        // Reading the live refs here would let a typed-but-not-filtered date
        // silently give this row a different candidate set than the tables on
        // screen. Refs are only the pre-first-load fallback.
        const from = appliedDates?.from ?? dateFromRef.current
        const to = appliedDates?.to ?? dateToRef.current
        if (from) params.set('date_from', from)
        if (to) params.set('date_to', to)
        params.set('account_number', accountNumber)
        params.set('transaction_id', transactionId)
        if (includeMatched) params.set('include_matched', 'true')
        const res = await fetch(`/api/reconciliation/bank/unmatched-entries?${params}`)
        const json = await res.json()
        // Discard if fetchAll cleared the cache while we were in flight:
        // committing would pin pre-refetch candidates on this row.
        if (res.ok && Array.isArray(json.data) && rankedGenerationRef.current === generation) {
          setRankedCandidates((prev) => ({ ...prev, [transactionId]: json.data }))
        }
      } catch {
        // Non-critical: the picker falls back to the unranked shared list.
      } finally {
        rankedFetchInFlight.current.delete(transactionId)
      }
    },
    [accountNumber, includeMatched, rankedCandidates, appliedDates],
  )

  const handleManualLink = async (transactionId: string) => {
    const journalEntryId = selectedMatch[transactionId]
    if (!journalEntryId) return

    setLinkLoading(transactionId)
    try {
      const res = await fetch('/api/reconciliation/bank/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          transaction_id: transactionId,
          journal_entry_id: journalEntryId,
          account_number: accountNumber,
        }),
      })
      const result = await res.json()
      if (!res.ok || result.error) {
        // Row-level failures surface next to where the user is working: the
        // old top-of-page banner was off-screen when acting on row 40.
        toast({
          variant: 'destructive',
          title: 'Kunde inte matcha transaktionen',
          description: typeof result.error === 'string' ? result.error : undefined,
        })
      } else {
        setSelectedMatch((prev) => {
          const next = { ...prev }
          delete next[transactionId]
          return next
        })
        toast({ variant: 'success', title: 'Transaktionen matchades mot verifikationen' })
        await fetchAll({ silent: true })
      }
    } catch {
      toast({ variant: 'destructive', title: 'Kunde inte matcha transaktionen' })
    } finally {
      setLinkLoading(null)
    }
  }

  const handleUnlink = async (transactionId: string) => {
    setUnlinkLoading(transactionId)
    try {
      const res = await fetch('/api/reconciliation/bank/unlink', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_id: transactionId }),
      })
      const result = await res.json()
      if (!res.ok || result.error) {
        toast({
          variant: 'destructive',
          title: 'Kunde inte avmatcha transaktionen',
          description: typeof result.error === 'string' ? result.error : undefined,
        })
      } else {
        toast({ variant: 'success', title: 'Matchningen togs bort' })
        await fetchAll({ silent: true })
      }
    } catch {
      toast({ variant: 'destructive', title: 'Kunde inte avmatcha transaktionen' })
    } finally {
      setUnlinkLoading(null)
    }
  }

  /**
   * Re-tag a manual/import voucher that is really an ingående balans as
   * source_type='opening_balance'. Such a voucher (common after a migration
   * where the IB was booked as an ordinary verifikat) otherwise stays in the
   * period movement and shows up as a phantom difference equal to the IB. After
   * re-tagging it drops out of the diff and is surfaced as "IB: räknas inte".
   */
  const handleMarkOpeningBalance = async (journalEntryId: string) => {
    setMarkLoading(journalEntryId)
    try {
      const res = await fetch('/api/reconciliation/bank/mark-opening-balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journal_entry_id: journalEntryId }),
      })
      const result = await res.json()
      if (!res.ok || result.error) {
        toast({
          variant: 'destructive',
          title: 'Kunde inte markera verifikationen som ingående balans',
          description: typeof result.error === 'string' ? result.error : undefined,
        })
      } else {
        toast({ variant: 'success', title: 'Verifikationen markerades som ingående balans' })
        await fetchAll({ silent: true })
      }
    } catch {
      toast({
        variant: 'destructive',
        title: 'Kunde inte markera verifikationen som ingående balans',
      })
    } finally {
      setMarkLoading(null)
    }
  }

  /**
   * Inline one-click booking for an unmatched transaction with no upstream
   * voucher to match against (ränteintäkter, bankavgifter, valutakurs-
   * differenser). Calls the standard categorize endpoint with a bank_finance
   * template so the resulting verifikation is identical to the /transactions
   * flow: no parallel booking path. The categorize endpoint rewrites the bank
   * leg to the transaction's actual settlement account, so this is correct on
   * any cash account.
   */
  const handleQuickBook = async (transactionId: string, templateId: string) => {
    setActionLoading(transactionId)
    try {
      const res = await fetch(`/api/transactions/${transactionId}/categorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_business: true,
          template_id: templateId,
          confirm_no_match: true,
        }),
      })
      const result = await res.json()
      if (!res.ok || result.error) {
        toast({
          variant: 'destructive',
          title: 'Kunde inte bokföra transaktionen',
          description: result.error?.message || (typeof result.error === 'string' ? result.error : undefined),
        })
        return
      }
      if (result.journal_entry_error) {
        toast({
          variant: 'destructive',
          title: 'Kunde inte bokföra transaktionen',
          description: result.journal_entry_error,
        })
        return
      }
      toast({ variant: 'success', title: 'Transaktionen bokfördes' })
      await fetchAll({ silent: true })
    } catch {
      toast({ variant: 'destructive', title: 'Kunde inte bokföra transaktionen' })
    } finally {
      setActionLoading(null)
    }
  }

  const handleIgnore = async (tx: UnmatchedTransaction) => {
    // Even though Ignorera is fully reversible, it's still a state change the
    // user could miss after a misclick: the row vanishes from the unmatched
    // list immediately. Confirmation before the write + an explicit Ångra
    // toast on success gives two recovery affordances. The persistent
    // "Ignorerade transaktioner" card is the third.
    const ok = await confirm({
      title: 'Ignorera transaktionen?',
      description: `${tx.description}: ${formatCurrency(tx.amount, tx.currency)} (${formatDate(tx.date)}) försvinner från avstämningen utan att bokföras. Du kan återställa den från "Ignorerade transaktioner" nedan när som helst.`,
      confirmLabel: 'Ignorera',
      cancelLabel: 'Avbryt',
      variant: 'warning',
    })
    if (!ok) return

    setActionLoading(tx.id)
    try {
      const res = await fetch(`/api/transactions/${tx.id}/ignore`, {
        method: 'POST',
      })
      const result = await res.json()
      if (!res.ok || result.error) {
        toast({
          variant: 'destructive',
          title: 'Kunde inte ignorera transaktionen',
          description: typeof result.error === 'string' ? result.error : undefined,
        })
        return
      }
      await fetchAll({ silent: true })
      toast({
        title: 'Transaktionen ignorerad',
        description: `${tx.description}: ${formatCurrency(tx.amount, tx.currency)}`,
        action: (
          <ToastAction
            altText="Ångra ignorera"
            onClick={() => handleUnignore(tx.id)}
          >
            Ångra
          </ToastAction>
        ),
      })
    } catch {
      toast({ variant: 'destructive', title: 'Kunde inte ignorera transaktionen' })
    } finally {
      setActionLoading(null)
    }
  }

  const handleUnignore = async (transactionId: string) => {
    setActionLoading(transactionId)
    try {
      const res = await fetch(`/api/transactions/${transactionId}/ignore`, {
        method: 'DELETE',
      })
      const result = await res.json()
      if (!res.ok || result.error) {
        toast({
          variant: 'destructive',
          title: 'Kunde inte återställa transaktionen',
          description: typeof result.error === 'string' ? result.error : undefined,
        })
        return
      }
      await fetchAll({ silent: true })
    } catch {
      toast({ variant: 'destructive', title: 'Kunde inte återställa transaktionen' })
    } finally {
      setActionLoading(null)
    }
  }

  if (loading) {
    return (
      <Card>
        <CardContent className="p-6 space-y-3">
          <Skeleton className="h-5 w-48" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    )
  }

  if (error && !status) {
    return (
      <Card>
        <CardContent className="p-8 text-center text-destructive">
          <AlertCircle className="h-6 w-6 mx-auto mb-2" />
          {error}
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {error && (
        <Card>
          <CardContent className="py-3 text-center text-destructive text-sm">
            <AlertCircle className="h-4 w-4 inline mr-1" />
            {error}
            <Button variant="ghost" size="sm" className="ml-2" onClick={() => setError(null)}>
              Stäng
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Status Card */}
      {status && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>Avstämning mot <AccountNumber number={accountNumber} /></CardTitle>
              {status.is_reconciled ? (
                <Badge variant="success">Avstämd</Badge>
              ) : (
                <Badge variant="destructive">Ej avstämd</Badge>
              )}
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              Avstämningen körs mot <AccountNumber number={accountNumber} /> ({accountCurrency}). Övriga bankkonton (t.ex. Plusgiro <AccountNumber number="1920" />, kreditkort <AccountNumber number="1940" /> eller valutakonton) stäms av separat. Välj kontot i listan nedan.
            </p>
          </CardHeader>
          <CardContent>
            <div className="space-y-2 text-sm">
              <div className="flex justify-between">
                <span>Banktransaktioner i perioden</span>
                <span className="tabular-nums">
                  {formatCurrency(status.bank_transaction_total, accountCurrency)}
                </span>
              </div>
              {/* GL-side figures (bokfört, IB, rättelser, differens) stay in
                  SEK: journal entries are booked in SEK regardless of the
                  cash account's currency. Only the bank-feed total above is in
                  the account's own currency. */}
              <div className="flex justify-between">
                <span>Bokfört på <AccountNumber number={accountNumber} /> i perioden</span>
                <span className="tabular-nums">
                  {formatCurrency(status.gl_1930_period_movement)}
                </span>
              </div>
              <div className="flex justify-between pt-2 border-t font-semibold">
                <span>Differens</span>
                <span
                  className={`tabular-nums ${
                    status.is_reconciled ? 'text-success' : 'text-destructive'
                  }`}
                >
                  {formatCurrency(status.difference)}
                </span>
              </div>
              {status.gl_1930_opening_balance !== 0 && (
                <p className="pt-2 text-xs text-muted-foreground">
                  Ingående balans (IB) på <AccountNumber number={accountNumber} />:{' '}
                  <span className="tabular-nums">
                    {formatCurrency(status.gl_1930_opening_balance)}
                  </span>
                  , räknas inte i avstämningen.
                </p>
              )}
              {status.gl_1930_correction_adjustment !== 0 && (
                <p className="pt-2 text-xs text-muted-foreground">
                  Varav rättelser och stornon på <AccountNumber number={accountNumber} /> i perioden:{' '}
                  <span className="tabular-nums">
                    {formatCurrency(status.gl_1930_correction_adjustment)}
                  </span>
                  , ingår i det bokförda beloppet och i avstämningen, precis som i balansräkningen.
                </p>
              )}
              <div className="flex gap-4 pt-2 text-xs text-muted-foreground">
                <span>Matchade: {status.matched_count}</span>
                <span>Omatchade transaktioner: {status.unmatched_transaction_count}</span>
                <span>Omatchade verifikationer: {status.unmatched_gl_line_count}</span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Action Bar */}
      <Card>
        <CardContent className="pt-6">
          <div className="flex flex-wrap items-end gap-4">
            <CashAccountSelector
              value={accountNumber}
              onChange={setAccountNumber}
            />
            <div>
              <Label>Datum från</Label>
              <Input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="mt-1"
              />
            </div>
            <div>
              <Label>Datum till</Label>
              <Input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="mt-1"
              />
            </div>
            <Button onClick={() => fetchAll()} variant={datesDirty ? 'default' : 'outline'}>
              Filtrera
            </Button>
            <div className="flex-1" />
            <Button onClick={handleDryRun} disabled={runLoading || datesDirty} variant="outline">
              <Eye className="h-4 w-4 mr-2" />
              {runLoading ? 'Analyserar...' : 'Förhandsgranska'}
            </Button>
            {dryRunResults && dryRunResults.length > 0 && (
              <Button onClick={handleApply} disabled={applyLoading || selectedPairs.size === 0}>
                <Play className="h-4 w-4 mr-2" />
                {applyLoading
                  ? 'Tillämpar...'
                  : `Tillämpa ${selectedPairs.size} ${selectedPairs.size === 1 ? 'matchning' : 'matchningar'}`}
              </Button>
            )}
          </div>
          {datesDirty && (
            <p className="mt-3 text-xs text-muted-foreground">
              Datumfiltret är ändrat men inte tillämpat: klicka Filtrera för att uppdatera
              listorna innan du förhandsgranskar.
            </p>
          )}
        </CardContent>
      </Card>

      {/* Dry Run Preview */}
      {dryRunResults && dryRunResults.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Förhandsgranskning: {dryRunResults.length}{' '}
              {dryRunResults.length === 1 ? 'matchning hittad' : 'matchningar hittade'}
            </CardTitle>
            <p className="mt-1 text-xs text-muted-foreground">
              Starka träffar är förvalda. Ungefärliga träffar kräver att du bockar i dem själv:
              granska verifikationen först.
            </p>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <tr className="border-b text-left">
                    <th className="py-2 w-8"></th>
                    <th className="py-2">Transaktion</th>
                    <th className="py-2 w-24">Datum</th>
                    <th className="py-2 w-28 text-right">Belopp</th>
                    <th className="py-2 w-8 text-center">&harr;</th>
                    <th className="py-2">Verifikation</th>
                    <th className="py-2 w-24">Datum</th>
                    <th className="py-2 w-28">Metod</th>
                    <th className="py-2 w-20">Träff</th>
                  </tr>
                </thead>
                <tbody>
                  {dryRunResults.map((m) => {
                    const key = matchKey(m.transaction_id, m.journal_entry_id)
                    const badge = confidenceLabel(m.confidence)
                    return (
                      <tr key={key} className="border-b last:border-0">
                        <td className="py-2">
                          <Checkbox
                            checked={selectedPairs.has(key)}
                            onCheckedChange={() => toggleMatchSelection(key)}
                            aria-label={`Tillämpa matchning för ${m.transaction_description}`}
                          />
                        </td>
                        <td className="py-2 truncate max-w-[180px]">{m.transaction_description}</td>
                        <td className="py-2 tabular-nums">{formatDate(m.transaction_date)}</td>
                        <td className="py-2 text-right tabular-nums">{formatAmount(m.transaction_amount)}</td>
                        <td className="py-2 text-center text-muted-foreground">&harr;</td>
                        <td className="py-2">
                          <Link
                            href={`/bookkeeping/${m.journal_entry_id}`}
                            className="font-mono text-xs underline-offset-2 hover:underline"
                            target="_blank"
                          >
                            {formatVoucher(m)}
                          </Link>
                          <span className="ml-2 text-muted-foreground truncate">{m.entry_description}</span>
                        </td>
                        <td className="py-2 tabular-nums">{formatDate(m.entry_date)}</td>
                        <td className="py-2">
                          <span className="text-xs text-muted-foreground">
                            {METHOD_LABELS[m.method] || m.method}
                          </span>
                        </td>
                        <td className="py-2">
                          <Badge variant={badge.variant}>{badge.label}</Badge>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {dryRunResults && dryRunResults.length === 0 && (
        <Card>
          <CardContent className="p-6 text-center text-muted-foreground">
            Inga automatiska matchningar hittades.
          </CardContent>
        </Card>
      )}

      {/* Unmatched Transactions */}
      {unmatchedTx.length > 0 && (
        <section className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium uppercase tracking-wider text-muted-foreground">
              Omatchade transaktioner ({unmatchedTx.length})
            </h2>
            <div className="flex items-center gap-3">
              {unmatchedGlLines.length > 0 && (
                <p className="text-xs text-muted-foreground">
                  {unmatchedGlLines.length} verifikation{unmatchedGlLines.length === 1 ? '' : 'er'} att matcha mot
                </p>
              )}
              <label className="flex cursor-pointer items-center gap-2 whitespace-nowrap text-xs text-muted-foreground">
                <Switch
                  checked={includeMatched}
                  onCheckedChange={setIncludeMatched}
                  aria-label="Visa även matchade verifikationer"
                />
                Visa matchade
              </label>
            </div>
          </div>
          {unmatchedTruncated && (
            <p className="text-xs text-muted-foreground">
              Visar de senaste 500 transaktionerna: begränsa datumintervallet för att se fler.
            </p>
          )}
          <div className="space-y-3">
            {unmatchedTx.map((tx) => {
              const isPositive = tx.amount > 0
              // Quick-book options matching the transaction's direction. The
              // bank leg books to the SELECTED account (the categorize endpoint
              // rewrites it from the cash_account_id), so these are correct on
              // any account, not just 1930.
              const quickBooks = QUICK_BOOK_TEMPLATES.filter((t) =>
                isPositive ? t.direction === 'income' : t.direction === 'expense',
              )
              return (
                <div
                  key={tx.id}
                  className="rounded-lg border border-border bg-card p-4 space-y-4"
                >
                  {/* Header row: meta + description + amount + menu */}
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground tabular-nums">
                        <span>{formatDate(tx.date)}</span>
                        <span aria-hidden>·</span>
                        <span>{tx.currency}</span>
                        {tx.reference && (
                          <>
                            <span aria-hidden>·</span>
                            <span>Ref: {tx.reference}</span>
                          </>
                        )}
                      </div>
                      <div className="mt-1.5 text-sm font-medium truncate">{tx.description}</div>
                    </div>
                    <div className="flex items-start gap-2 shrink-0">
                      <div
                        className={`font-display text-xl tabular-nums ${
                          isPositive ? 'text-success' : ''
                        }`}
                      >
                        {isPositive ? '+' : ''}
                        {formatCurrency(tx.amount, tx.currency)}
                      </div>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            size="icon"
                            variant="ghost"
                            className="h-8 w-8"
                            aria-label="Fler åtgärder"
                            disabled={actionLoading === tx.id}
                          >
                            <MoreHorizontal className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-72">
                          {quickBooks.length > 0 && (
                            <>
                              <DropdownMenuLabel className="text-[11px] font-normal uppercase tracking-wider text-muted-foreground">
                                Bokför direkt
                              </DropdownMenuLabel>
                              {quickBooks.map((t) => {
                                // Read as "debit mot credit": income debits the
                                // bank (selected account), credits revenue;
                                // expense debits the cost account, credits bank.
                                const legs = isPositive
                                  ? `${accountNumber} mot ${t.account}`
                                  : `${t.account} mot ${accountNumber}`
                                return (
                                  <DropdownMenuItem
                                    key={t.id}
                                    onClick={() => handleQuickBook(tx.id, t.id)}
                                    disabled={actionLoading === tx.id}
                                  >
                                    <PiggyBank className="h-4 w-4" />
                                    <div className="flex flex-col">
                                      <span>Bokför som {t.label}</span>
                                      <span className="text-xs text-muted-foreground tabular-nums">
                                        {legs}
                                      </span>
                                    </div>
                                  </DropdownMenuItem>
                                )
                              })}
                              <DropdownMenuSeparator />
                            </>
                          )}
                          <DropdownMenuItem
                            onClick={() => handleIgnore(tx)}
                            disabled={actionLoading === tx.id}
                          >
                            <EyeOff className="h-4 w-4" />
                            <div className="flex flex-col">
                              <span>Ignorera transaktion…</span>
                              <span className="text-xs text-muted-foreground">
                                Dölj utan att bokföra. Går att återställa.
                              </span>
                            </div>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </div>

                  {/* Match action row */}
                  <div className="pt-3 border-t border-border space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
                        Matcha mot verifikation
                      </Label>
                      {glLines.length === 0 && (
                        <span className="text-[11px] text-muted-foreground">
                          Inga omatchade verifikationer på <AccountNumber number={accountNumber} />
                        </span>
                      )}
                    </div>
                    <div className="flex items-start gap-2">
                      <div
                        className="flex-1 min-w-0"
                        // First focus fetches ranked, confidence-scored candidates
                        // for THIS transaction (server-side ranking via
                        // transaction_id). Until they land the picker shows the
                        // shared unranked pool, so nothing blocks.
                        onFocusCapture={() => ensureRankedCandidates(tx.id)}
                      >
                        <MatchVerifikationPicker
                          glLines={rankedCandidates[tx.id] ?? glLines}
                          value={selectedMatch[tx.id] || ''}
                          onChange={(v) =>
                            setSelectedMatch((prev) => ({ ...prev, [tx.id]: v }))
                          }
                          disabled={linkLoading === tx.id || glLines.length === 0}
                        />
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!selectedMatch[tx.id] || linkLoading === tx.id}
                        onClick={() => handleManualLink(tx.id)}
                        className="shrink-0 h-10"
                      >
                        <Link2 className="h-3.5 w-3.5 mr-1.5" />
                        {linkLoading === tx.id ? 'Matchar…' : 'Matcha'}
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </section>
      )}

      {/* Unmatched GL Lines */}
      {unmatchedGlLines.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg">
              Omatchade verifikationer på <AccountNumber number={accountNumber} /> ({unmatchedGlLines.length})
            </CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-3 text-xs text-muted-foreground">
              Är en manuellt eller importerat bokförd verifikation egentligen en ingående balans? Markera den som IB: då räknas den inte med i avstämningen utan visas separat som ingående balans.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                  <tr className="border-b text-left">
                    <th className="py-2 w-16">Ver.nr</th>
                    <th className="py-2 w-24">Datum</th>
                    <th className="py-2">Beskrivning</th>
                    <th className="py-2 w-28 text-right">Belopp</th>
                    <th className="py-2 w-24">Typ</th>
                    <th className="py-2 w-36"></th>
                  </tr>
                </thead>
                <tbody>
                  {unmatchedGlLines.map((line) => {
                    const amount = line.debit_amount > 0 ? line.debit_amount : -line.credit_amount
                    const isRetaggable = line.source_type === 'manual' || line.source_type === 'import'
                    return (
                      <tr key={line.line_id} className="border-b last:border-0">
                        <td className="py-2">
                          <Link
                            href={`/bookkeeping/${line.journal_entry_id}`}
                            className="font-mono text-xs underline-offset-2 hover:underline"
                            target="_blank"
                          >
                            {formatVoucher(line)}
                          </Link>
                        </td>
                        <td className="py-2 tabular-nums">{formatDate(line.entry_date)}</td>
                        <td className="py-2 truncate max-w-[300px]">
                          {line.line_description || line.entry_description}
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {formatCurrency(amount)}
                        </td>
                        <td className="py-2 text-xs text-muted-foreground">
                          {SOURCE_TYPE_LABELS[line.source_type] ?? line.source_type}
                        </td>
                        <td className="py-2 text-right">
                          {isRetaggable && (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 text-xs"
                              disabled={markLoading === line.journal_entry_id}
                              onClick={() => handleMarkOpeningBalance(line.journal_entry_id)}
                              title="Markera verifikationen som ingående balans: den utesluts då från avstämningen"
                            >
                              {markLoading === line.journal_entry_id ? 'Markerar…' : 'Märk som IB'}
                            </Button>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Ignored transactions (undo) */}
      {ignoredTx.length > 0 && (
        <Card>
          <CardHeader
            className="cursor-pointer"
            onClick={() => setShowIgnored(!showIgnored)}
          >
            <div className="flex items-center gap-2">
              {showIgnored ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              <CardTitle className="text-lg">
                Ignorerade transaktioner ({ignoredTx.length})
              </CardTitle>
            </div>
          </CardHeader>
          {showIgnored && (
            <CardContent>
              <p className="text-xs text-muted-foreground mb-3">
                Rader du valt att dölja från avstämningen. De påverkar inte saldot på <AccountNumber number={accountNumber} />: de är bara gömda från listan.
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                    <tr className="border-b text-left">
                      <th className="py-2 w-24">Datum</th>
                      <th className="py-2">Beskrivning</th>
                      <th className="py-2 w-20">Valuta</th>
                      <th className="py-2 w-28 text-right">Belopp</th>
                      <th className="py-2 w-28"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {ignoredTx.map((tx) => (
                      <tr key={tx.id} className="border-b last:border-0 text-muted-foreground">
                        <td className="py-2 tabular-nums">{formatDate(tx.date)}</td>
                        <td className="py-2 truncate max-w-[300px]">{tx.description}</td>
                        <td className="py-2 text-xs">
                          <span className="tabular-nums">{tx.currency}</span>
                        </td>
                        <td className="py-2 text-right tabular-nums">
                          {formatCurrency(tx.amount, tx.currency)}
                        </td>
                        <td className="py-2">
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={actionLoading === tx.id}
                            onClick={() => handleUnignore(tx.id)}
                          >
                            {actionLoading === tx.id ? '...' : 'Återställ'}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          )}
        </Card>
      )}

      {/* Recently Matched */}
      {matchedTx.length > 0 && (
        <Card>
          <CardHeader
            className="cursor-pointer"
            onClick={() => setShowMatched(!showMatched)}
          >
            <div className="flex items-center gap-2">
              {showMatched ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              <CardTitle className="text-lg">
                Matchade transaktioner ({matchedTx.length})
              </CardTitle>
            </div>
          </CardHeader>
          {showMatched && (
            <CardContent>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
                    <tr className="border-b text-left">
                      <th className="py-2 w-24">Datum</th>
                      <th className="py-2">Beskrivning</th>
                      <th className="py-2 w-28 text-right">Belopp</th>
                      <th className="py-2 w-32">Metod</th>
                      <th className="py-2 w-28">Verifikation</th>
                      <th className="py-2 w-24"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {matchedTx.map((tx) => (
                      <tr key={tx.id} className="border-b last:border-0">
                        <td className="py-2 tabular-nums">{formatDate(tx.date)}</td>
                        <td className="py-2 truncate max-w-[300px]">{tx.description}</td>
                        <td className="py-2 text-right tabular-nums">
                          {formatCurrency(tx.amount, accountCurrency)}
                        </td>
                        <td className="py-2">
                          {tx.reconciliation_method && (
                            <span className="text-xs text-muted-foreground">
                              {METHOD_LABELS[tx.reconciliation_method] || tx.reconciliation_method}
                            </span>
                          )}
                        </td>
                        <td className="py-2">
                          {tx.journal_entry_id && (
                            <Link
                              href={`/bookkeeping/${tx.journal_entry_id}`}
                              className="text-xs underline-offset-2 hover:underline"
                              target="_blank"
                            >
                              Öppna verifikat
                            </Link>
                          )}
                        </td>
                        <td className="py-2">
                          {tx.reconciliation_method && (
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={unlinkLoading === tx.id}
                              onClick={() => handleUnlink(tx.id)}
                            >
                              <Unlink className="h-3 w-3 mr-1" />
                              {unlinkLoading === tx.id ? '...' : 'Avmatcha'}
                            </Button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </CardContent>
          )}
        </Card>
      )}

      {/* Empty state */}
      {unmatchedTx.length === 0 && glLines.length === 0 && matchedTx.length === 0 && ignoredTx.length === 0 && !loading && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            Inga transaktioner eller verifikationer att stämma av.
          </CardContent>
        </Card>
      )}

      <DestructiveConfirmDialog {...confirmDialogProps} />
    </div>
  )
}
