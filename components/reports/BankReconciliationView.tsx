'use client'

import Link from 'next/link'
import { Fragment, useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useTranslations } from 'next-intl'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Switch } from '@/components/ui/switch'
import { Skeleton } from '@/components/ui/skeleton'
import { Progress } from '@/components/ui/progress'
import { InfoTooltip } from '@/components/ui/info-tooltip'
import { EmptyState } from '@/components/ui/empty-state'
import { AttnLine } from '@/components/ui/attn-line'
import { TH_CLASS, TD_CLASS } from '@/components/ui/dry-table'
import { AccountNumber } from '@/components/ui/account-number'
import { AlertCircle, ArrowRightLeft, ChevronDown, ChevronRight, Landmark, Link2, Unlink, Play, EyeOff, PiggyBank, MoreHorizontal } from 'lucide-react'
import { formatCurrency, formatDate } from '@/lib/utils'
// Pure module, safe in the client bundle: lib/reconciliation/bank-reconciliation
// pulls in the event bus and the match log and must never be imported here.
import { hasVoucherCandidate } from '@/lib/reconciliation/voucher-candidate'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { CashAccountSelector } from '@/components/common/CashAccountSelector'
import type { DateRangeValue } from '@/components/common/ReportDateRange'
import { MatchVerifikationPicker, type UnlinkedGLLine } from '@/components/reconciliation/MatchVerifikationPicker'
import DuplicateBookingDialog from '@/components/transactions/DuplicateBookingDialog'
import type { BookedDuplicateCandidate } from '@/lib/transactions/booking-duplicate-detection'
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
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** A bridge step, always carrying its sign so the column reads as a running
 *  adjustment. Only the plus is added: Intl already renders negatives with a
 *  real minus sign (U+2212), and prefixing an ASCII hyphen to an absolute value
 *  would put a different glyph in this column than every other amount on the
 *  page. */
function formatSigned(amount: number, currency?: string): string {
  const rendered = formatCurrency(amount, currency)
  return amount > 0 ? `+${rendered}` : rendered
}

/** Anchors for the bridge rows: clicking a step scrolls to the list it names.
 *  The dashboard panel is the scroll container, so scrollIntoView (which walks
 *  up to the nearest scrollable ancestor) is correct here and window.scrollTo
 *  would not be. */
const UNMATCHED_TX_SECTION_ID = 'recon-unmatched-transactions'
const UNMATCHED_GL_SECTION_ID = 'recon-unmatched-gl-lines'

function scrollToSection(id: string) {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
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
  /** Bank-feed total EXCLUDING ignored rows: the reconciling bank side. */
  bank_transaction_total: number
  /** Sum of ignored rows in the window; informational, not in the difference. */
  ignored_transaction_total: number
  ignored_transaction_count: number
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
  /** Sum behind unmatched_transaction_count: one leg of the bridge. */
  unmatched_transaction_total: number
  unmatched_gl_line_count: number
  /** Sum behind unmatched_gl_line_count, signed like a bank movement. null on a
   *  foreign account whose candidate lines carry no amount in that currency. */
  unmatched_gl_line_total: number | null
  /** What is left of the difference once both lists are accounted for; null
   *  whenever unmatched_gl_line_total is. */
  unexplained_difference: number | null
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
  /**
   * Narrowing applied by the page-level ReportDateRange. Empty (`{}` or
   * undefined) means the whole räkenskapsår, which is what a reconciliation
   * normally runs over.
   */
  dateRange?: DateRangeValue
  /**
   * Deep-link bridge (?autorun=1, e.g. from the transactions inbox banner):
   * runs the dry-run preview automatically ONCE, only after the first load has
   * recorded appliedDates and while the typed dates still match it, so the
   * preview can never cover a different window than the on-screen lists.
   */
  autoRun?: boolean
}

export function BankReconciliationView({
  periodId,
  periodBounds,
  dateRange,
  autoRun,
}: BankReconciliationViewProps) {
  const t = useTranslations('reports')
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
  // on a permanent skeleton (#771).
  //
  // Narrowing inside the year is owned by the page too (ReportDateRange), so
  // this view no longer holds date state at all. It used to render its own
  // "Datum från / Datum till" inputs behind a "Filtrera" button: a second
  // period control competing with the header's picker (convention 8), and the
  // source of the "typed but not applied" state that had to be explained in an
  // attention line. The window now changes only through a control that applies
  // immediately, so there is nothing to be dirty.
  const [accountNumber, setAccountNumber] = useState('1930')
  const [cashAccounts, setCashAccounts] = useState<CashAccount[]>([])
  // The window the whole surface runs on: the räkenskapsår, narrowed by the
  // page's range control when it is set. `toDate` is clamped to today for a
  // still-open year so the view never claims to reconcile into the future
  // (the ledger can hold future-dated vouchers; the bank feed cannot).
  const { windowFrom, windowTo } = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10)
    const from = dateRange?.fromDate ?? periodBounds?.start ?? ''
    const periodEnd = periodBounds?.end
    const to =
      dateRange?.toDate ?? (periodEnd && periodEnd < today ? periodEnd : today)
    return { windowFrom: from, windowTo: to }
  }, [dateRange?.fromDate, dateRange?.toDate, periodBounds?.start, periodBounds?.end])

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
  // Booking-time duplicate guard (TRANSACTION_BOOK_POSSIBLE_DUPLICATE) fired
  // for a quick-book: opened as the shared match/ignore/book-anyway dialog
  // instead of a dead-end toast; this page's whole purpose is matching.
  const [duplicateWarning, setDuplicateWarning] = useState<{
    transactionId: string
    retry: () => Promise<void>
    candidate: BookedDuplicateCandidate
  } | null>(null)
  const [duplicateProcessing, setDuplicateProcessing] = useState(false)

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
  /** The one unmatched row whose match picker is open. Single-open by design:
   *  the picker is a heavy control (it fetches ranked candidates per row), and
   *  rendering one per row is exactly what made this list unusable. */
  const [expandedTxId, setExpandedTxId] = useState<string | null>(null)
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



  // Every ticked preview pair is a strong match (>= the Stark badge floor):
  // the apply button relabels to "Matcha X starka träffar" and the apply
  // request carries confidence_threshold so the server re-run enforces the
  // same floor. Manually ticked weaker pairs drop back to the plain label and
  // an unthresholded apply.
  const allSelectedStrong =
    dryRunResults !== null &&
    selectedPairs.size > 0 &&
    dryRunResults
      .filter((m) => selectedPairs.has(matchKey(m.transaction_id, m.journal_entry_id)))
      .every((m) => m.confidence >= PRESELECT_CONFIDENCE)

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
      const fromValue = windowFrom
      const toValue = windowTo
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
    // The window is now a prop-derived value that only changes when the user
    // picks a different year or range, so it belongs in the dependency list:
    // there is no keystroke-level churn to protect against any more, and the
    // lists must never lag behind the control that sets them.
    //
    // periodId is in here as belt-and-braces: the window is derived from
    // periodBounds, so a year switch normally changes it, but a period with no
    // bounds would derive the SAME window for every year and silently skip the
    // refetch. Keying on the id too makes a year switch always reload. The lint
    // rule cannot see that because the id is not read inside the callback.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountNumber, accountCurrency, includeMatched, windowFrom, windowTo, periodId])

  // Load on mount and whenever fetchAll's identity changes: bank account,
  // currency, the matched-toggle, or the window itself. The old off-by-one trap
  // here (a year switch fetching the PREVIOUS year's window because the date
  // refs updated a commit late) is gone with the refs: windowFrom/windowTo are
  // derived during render, so the fetch below always sees the current window.
  useEffect(() => {
    fetchAll()
  }, [fetchAll])

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

  // Run the matcher automatically once per window, instead of waiting for a
  // button many users never found: the old flow left people matching a whole
  // migration row by row next to a control that said only "Förhandsgranska".
  // It is a dry run, so nothing is written and nothing is applied without the
  // explicit Tillämpa below. Gated on the first load having recorded
  // appliedDates, so the preview can never cover a different window than the
  // on-screen lists.
  const autoRunConsumedRef = useRef<string | null>(null)
  useEffect(() => {
    if (loading || !appliedDates) return
    // Once per window+account, so a silent refetch or a matched-toggle flip on
    // the same window does not re-fire it, while switching year or account does.
    const runKey = `${accountNumber}:${appliedDates.from}:${appliedDates.to}`
    if (autoRunConsumedRef.current === runKey) return
    // Nothing to match: don't spend a server-side matching pass on a clean
    // window. ?autorun=1 (the transactions-inbox deep link) is an explicit
    // "run it" and overrides that, so the user who clicked it still gets a
    // result rather than silence.
    if (!autoRun && unmatchedTx.length === 0) return
    autoRunConsumedRef.current = runKey
    void handleDryRun()
    // handleDryRun is recreated every render; the consumed-ref guarantees the
    // single run, so depending on it would only add noise.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRun, loading, appliedDates, accountNumber, unmatchedTx.length])

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
            // Strong-only apply: when every ticked pair is >= the Stark floor,
            // ask the server to enforce that floor on its fresh re-run too. A
            // mixed selection omits it so manually ticked weaker pairs still
            // apply (the intersection guard still protects them).
            ...(allSelectedStrong ? { confidence_threshold: PRESELECT_CONFIDENCE } : {}),
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
        // The APPLIED window: the same one the lists and preview run against,
        // so a row can never be offered a candidate set the tables on screen
        // were not built from. The derived window is the pre-first-load
        // fallback (they agree except while a fresh load is in flight).
        const from = appliedDates?.from ?? windowFrom
        const to = appliedDates?.to ?? windowTo
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
    [accountNumber, includeMatched, rankedCandidates, appliedDates, windowFrom, windowTo],
  )

  /** Open one row's match picker (closing any other) and fetch its ranked
   *  candidates. The fetch used to hang off onFocusCapture on an always-rendered
   *  picker; it now runs on expand, which is the same moment the user asks for
   *  candidates but only for rows they actually open. */
  const toggleExpandedTx = useCallback(
    (transactionId: string) => {
      setExpandedTxId((current) => (current === transactionId ? null : transactionId))
      void ensureRankedCandidates(transactionId)
    },
    [ensureRankedCandidates],
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
        setExpandedTxId((current) => (current === transactionId ? null : current))
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
  const handleQuickBook = async (
    transactionId: string,
    templateId: string,
    // Set after the user confirmed the duplicate warning: force is bound to
    // the reviewed candidate's voucher and re-detected server-side.
    forceOpts?: { expectedDuplicateJournalEntryId: string },
  ) => {
    setActionLoading(transactionId)
    try {
      const res = await fetch(`/api/transactions/${transactionId}/categorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_business: true,
          template_id: templateId,
          confirm_no_match: true,
          ...(forceOpts
            ? { force: true, expected_duplicate_journal_entry_id: forceOpts.expectedDuplicateJournalEntryId }
            : {}),
        }),
      })
      const result = await res.json()
      if (!res.ok || result.error) {
        const candidate = result?.error?.details?.candidate as BookedDuplicateCandidate | undefined
        if (result?.error?.code === 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE' && candidate) {
          // The affärshändelse already looks booked. On the reconciliation
          // page the right resolutions (match the voucher, ignore a duplicate
          // import, or book anyway) all live in the shared dialog: never
          // dead-end in a toast with no way forward.
          setDuplicateWarning({
            transactionId,
            retry: () =>
              handleQuickBook(transactionId, templateId, {
                expectedDuplicateJournalEntryId: candidate.journal_entry_id,
              }),
            candidate,
          })
          return
        }
        toast({
          variant: 'destructive',
          title: 'Kunde inte bokföra transaktionen',
          description: getUserErrorMessage(result.error) || (typeof result.error === 'string' ? result.error : undefined),
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

  /**
   * Move a transaction to another of the company's cash accounts (PATCH
   * /api/transactions/[id]/cash-account). The row then leaves THIS account's
   * unmatched list and surfaces on the target account's reconciliation, which
   * is the fix for rows stuck under the wrong (or the primary) account:
   * cross-account matching is deliberately blocked, so the row must move to
   * where its verifikat lives. Server-side gating rejects booked/matched rows.
   */
  const handleMoveToAccount = async (tx: UnmatchedTransaction, target: CashAccount) => {
    setActionLoading(tx.id)
    try {
      const res = await fetch(`/api/transactions/${tx.id}/cash-account`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_number: target.ledger_account }),
      })
      const result = await res.json()
      if (!res.ok || result.error) {
        toast({
          variant: 'destructive',
          title: 'Kunde inte flytta transaktionen',
          description:
            getUserErrorMessage(result.error) ||
            (typeof result.error === 'string' ? result.error : undefined),
        })
        return
      }
      toast({
        variant: 'success',
        title: `Transaktionen flyttades till ${target.name || `Bankkonto ${target.currency}`} (${target.ledger_account})`,
      })
      // Both accounts' totals change (the row leaves this report and joins the
      // target's), so refresh the whole view, status card included.
      await fetchAll({ silent: true })
    } catch {
      toast({ variant: 'destructive', title: 'Kunde inte flytta transaktionen' })
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

  // Bridge derivations. `unexplained_difference` is null exactly when the GL
  // side cannot be expressed in the account's currency (a foreign account: the
  // candidate RPCs project no FX columns), and the card falls back to the flat
  // figures rather than showing a bridge whose middle row has no honest amount.
  const bridgeDerivable = status?.unexplained_difference != null
  const reconcilableCount = status
    ? status.matched_count + status.unmatched_transaction_count
    : 0
  const matchedPercent =
    reconcilableCount > 0 ? Math.round((status!.matched_count / reconcilableCount) * 100) : 0

  // What the reconciliation leaves out, as one line instead of three stacked
  // paragraphs. Amounts stay on screen (BFL: the user must be able to see what
  // was excluded); the legal reasoning moved into the tooltip beside them.
  // Unmatched rows that no voucher on this account could settle: bookkeeping,
  // not reconciliation. Counted once here rather than per row.
  const bookOnlyCount = unmatchedTx.filter(
    (tx) => !hasVoucherCandidate(tx.amount, unmatchedGlLines, accountCurrency),
  ).length
  // Land on the account being reconciled, not on every bank source: an
  // `acct:<id>` filter is exactly the scope this page is showing. Falls back to
  // all bank rows when the cash account has not loaded yet, which is a wider
  // list but never a wrong one.
  const reconciledCashAccountId = cashAccounts.find(
    (a) => a.ledger_account === accountNumber,
  )?.id
  const bookOnlySource = reconciledCashAccountId ? `acct:${reconciledCashAccountId}` : 'bank'

  const excludedItems: string[] = []
  if (status) {
    if (status.gl_1930_opening_balance !== 0) {
      excludedItems.push(
        t('recon_excl_ib', { amount: formatCurrency(status.gl_1930_opening_balance) })
      )
    }
    if (status.ignored_transaction_count > 0) {
      excludedItems.push(
        t('recon_excl_ignored', {
          count: status.ignored_transaction_count,
          amount: formatCurrency(status.ignored_transaction_total, accountCurrency),
        })
      )
    }
  }
  const exclusionNotes: string[] = []
  if (excludedItems.length > 0) {
    exclusionNotes.push(t('recon_excl_prefix', { items: excludedItems.join(', ') }))
  }
  // Corrections are the opposite case: INCLUDED, exactly as on the balance
  // sheet. Stated here because a large correction figure is the single most
  // common "why is the booked amount so big" question on this card.
  if (status && status.gl_1930_correction_adjustment !== 0) {
    exclusionNotes.push(
      t('recon_excl_corrections', {
        amount: formatCurrency(status.gl_1930_correction_adjustment),
      })
    )
  }

  return (
    <div className="space-y-8">
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
              {/* Convention 5: chips mark exceptions. Being mid-year and not yet
                  reconciled is the NORMAL state, so a permanent destructive
                  "Ej avstämd" badge marked nothing and just manufactured alarm.
                  Fully reconciled is the state worth marking. */}
              {status.is_reconciled ? (
                <Badge variant="success">Avstämd</Badge>
              ) : (
                <span className="text-sm text-muted-foreground">
                  {t('recon_open_items', {
                    count:
                      status.unmatched_transaction_count + status.unmatched_gl_line_count,
                  })}
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <div className="space-y-5 text-sm">
              {/* Reconciliation is a count-down-to-zero task; the only progress
                  signal used to be three comma-separated numbers in 12px grey. */}
              {reconcilableCount > 0 && (
                <div className="space-y-1.5">
                  <Progress value={matchedPercent} className="h-1" />
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>
                      {t('recon_progress', {
                        matched: status.matched_count,
                        total: reconcilableCount,
                      })}
                    </span>
                    <span className="tabular-nums">{matchedPercent} %</span>
                  </div>
                </div>
              )}

              {/* THE BRIDGE. The old card printed the bank total, the ledger
                  total and a red difference, leaving the user to work out what
                  the difference consisted of: the page already knew, exactly.
                  Every krona of it is (unmatched bank rows) - (unmatched
                  vouchers), so the two middle rows both explain the number AND
                  navigate to the list that resolves them. Only the residual
                  after those two can mean something is actually wrong.
                  Falls back to the flat figures when the residual is not
                  derivable (a foreign account: see unmatched_gl_line_total). */}
              <div className="space-y-2">
                <div className="flex justify-between">
                  <span>Banktransaktioner i perioden</span>
                  <span className="tabular-nums">
                    {formatCurrency(status.bank_transaction_total, accountCurrency)}
                  </span>
                </div>

                {bridgeDerivable && (
                  <>
                    {status.unmatched_transaction_count > 0 && (
                      <button
                        type="button"
                        onClick={() => scrollToSection(UNMATCHED_TX_SECTION_ID)}
                        className="-mx-2 flex w-[calc(100%+1rem)] items-baseline justify-between gap-4 rounded-sm px-2 py-1 text-left text-muted-foreground transition-colors duration-150 hover:bg-secondary/60 hover:text-foreground"
                      >
                        <span>
                          {t('recon_bridge_unmatched_tx', {
                            count: status.unmatched_transaction_count,
                          })}
                        </span>
                        <span className="tabular-nums">
                          {formatSigned(-status.unmatched_transaction_total, accountCurrency)}
                        </span>
                      </button>
                    )}
                    {status.unmatched_gl_line_count > 0 && (
                      <button
                        type="button"
                        onClick={() => scrollToSection(UNMATCHED_GL_SECTION_ID)}
                        className="-mx-2 flex w-[calc(100%+1rem)] items-baseline justify-between gap-4 rounded-sm px-2 py-1 text-left text-muted-foreground transition-colors duration-150 hover:bg-secondary/60 hover:text-foreground"
                      >
                        <span>
                          {t('recon_bridge_unmatched_gl', {
                            count: status.unmatched_gl_line_count,
                          })}
                        </span>
                        <span className="tabular-nums">
                          {formatSigned(status.unmatched_gl_line_total ?? 0, accountCurrency)}
                        </span>
                      </button>
                    )}
                  </>
                )}

                {/* GL-side figures (bokfört, IB, rättelser, differens) stay in
                    SEK: journal entries are booked in SEK regardless of the
                    cash account's currency. Only the bank-feed total above is in
                    the account's own currency. */}
                <div className="flex justify-between border-t pt-2">
                  <span>
                    Bokfört på <AccountNumber number={accountNumber} /> i perioden
                  </span>
                  <span className="tabular-nums">
                    {formatCurrency(status.gl_1930_period_movement)}
                  </span>
                </div>

                {bridgeDerivable ? (
                  <div className="flex items-baseline justify-between gap-4 pt-1 font-semibold">
                    <span className="flex items-center gap-1.5">
                      {t('recon_unexplained_label')}
                      <InfoTooltip content={t('recon_unexplained_help')} />
                    </span>
                    <span
                      className={`tabular-nums ${
                        Math.abs(status.unexplained_difference ?? 0) < 0.01 ? 'text-success' : ''
                      }`}
                    >
                      {formatCurrency(status.unexplained_difference ?? 0, accountCurrency)}
                    </span>
                  </div>
                ) : (
                  <div className="flex justify-between pt-1 font-semibold">
                    <span>Differens</span>
                    <span
                      className={`tabular-nums ${
                        status.is_reconciled ? 'text-success' : 'text-destructive'
                      }`}
                    >
                      {formatCurrency(status.difference)}
                    </span>
                  </div>
                )}

                {bridgeDerivable && Math.abs(status.unexplained_difference ?? 0) >= 0.01 && (
                  <p className="text-xs text-muted-foreground">
                    {t('recon_unexplained_note')}
                  </p>
                )}
              </div>

              {/* What the reconciliation deliberately leaves out. Three stacked
                  paragraphs of legal prose used to sit in the card; the amounts
                  stay visible (they are compliance-relevant) but the reasoning
                  moved behind the tooltip. */}
              {exclusionNotes.length > 0 && (
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <span>{exclusionNotes.join(' ')}</span>
                  <InfoTooltip content={t('recon_exclusions_help')} className="mt-0.5 shrink-0" />
                </p>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Toolbar: flat on the panel, no box (UI-migration language) */}
      <div className="space-y-3">
        {/* The page's one ochre sentence (convention 6) now reports a run in
            progress. The old line counted unmatched rows and pointed at the
            button to press; with the matcher running by itself that promotion
            is obsolete by construction, and the count it carried is already on
            the card ("N poster kvar att förklara") and the section header. */}
        {runLoading && <AttnLine>{t('recon_matching_attn')}</AttnLine>}
        <div className="flex flex-wrap items-center gap-3">
          <CashAccountSelector
            value={accountNumber}
            onChange={setAccountNumber}
          />
          <div className="flex-1" />
          <Button
            onClick={handleDryRun}
            disabled={runLoading}
            variant="outline"
          >
            <Link2 className="h-4 w-4 mr-2" />
            {runLoading ? t('recon_matching') : t('recon_match_automatically')}
          </Button>
          {dryRunResults && dryRunResults.length > 0 && (
            <Button onClick={handleApply} disabled={applyLoading || selectedPairs.size === 0}>
              <Play className="h-4 w-4 mr-2" />
              {applyLoading
                ? 'Tillämpar...'
                : allSelectedStrong
                  ? t('recon_apply_strong', { count: selectedPairs.size })
                  : `Tillämpa ${selectedPairs.size} ${selectedPairs.size === 1 ? 'matchning' : 'matchningar'}`}
            </Button>
          )}
        </div>
      </div>

      {/* Dry Run Preview */}
      {dryRunResults && dryRunResults.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-sm uppercase tracking-wider text-muted-foreground">
            Förhandsgranskning ({dryRunResults.length})
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={`${TH_CLASS} w-8`}></th>
                  <th className={TH_CLASS}>Transaktion</th>
                  <th className={`${TH_CLASS} w-24`}>Datum</th>
                  <th className={`${TH_CLASS} w-28 text-right`}>Belopp</th>
                  <th className={`${TH_CLASS} w-8 text-center`}>&harr;</th>
                  <th className={TH_CLASS}>Verifikation</th>
                  <th className={`${TH_CLASS} w-24`}>Datum</th>
                  <th className={`${TH_CLASS} w-28`}>Metod</th>
                  <th className={`${TH_CLASS} w-20`}>Träff</th>
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {dryRunResults.map((m) => {
                  const key = matchKey(m.transaction_id, m.journal_entry_id)
                  const badge = confidenceLabel(m.confidence)
                  return (
                    <tr key={key} className="transition-colors duration-150 hover:bg-secondary/35">
                      <td className={TD_CLASS}>
                        <Checkbox
                          checked={selectedPairs.has(key)}
                          onCheckedChange={() => toggleMatchSelection(key)}
                          aria-label={`Tillämpa matchning för ${m.transaction_description}`}
                        />
                      </td>
                      <td className={`${TD_CLASS} truncate max-w-[180px]`}>{m.transaction_description}</td>
                      <td className={`${TD_CLASS} tabular-nums`}>{formatDate(m.transaction_date)}</td>
                      <td className={`${TD_CLASS} text-right tabular-nums`}>{formatAmount(m.transaction_amount)}</td>
                      <td className={`${TD_CLASS} text-center text-muted-foreground`}>&harr;</td>
                      <td className={TD_CLASS}>
                        <Link
                          href={`/bookkeeping/${m.journal_entry_id}`}
                          className="font-mono text-xs underline-offset-2 hover:underline"
                          target="_blank"
                        >
                          {formatVoucher(m)}
                        </Link>
                        <span className="ml-2 text-muted-foreground truncate">{m.entry_description}</span>
                      </td>
                      <td className={`${TD_CLASS} tabular-nums`}>{formatDate(m.entry_date)}</td>
                      <td className={`${TD_CLASS} text-xs text-muted-foreground`}>
                        {METHOD_LABELS[m.method] || m.method}
                      </td>
                      <td className={TD_CLASS}>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {dryRunResults && dryRunResults.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Inga automatiska matchningar hittades.
        </p>
      )}

      {/* Unmatched Transactions */}
      {unmatchedTx.length > 0 && (
        <section id={UNMATCHED_TX_SECTION_ID} className="scroll-mt-4 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm uppercase tracking-wider text-muted-foreground">
              Omatchade transaktioner ({unmatchedTx.length})
            </h2>
            <div className="flex items-center gap-3">
              {/* The split that matters on this page: rows a voucher could
                  settle are reconciliation work and stay here; the rest are
                  unbooked affärshändelser and belong in Transaktioner, which
                  already does that job well. */}
              {bookOnlyCount > 0 && (
                <Button asChild size="sm" variant="ghost" className="h-8 text-xs">
                  <Link href={`/transactions?source=${bookOnlySource}`}>
                    {t('recon_book_rest', { count: bookOnlyCount })}
                  </Link>
                </Button>
              )}
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
          {/* One line per transaction (locked convention 4). This list used to
              render a ~230px card per row, each carrying an always-open, always
              empty "Matcha mot verifikation" search field: for a company with a
              real backlog that is thousands of pixels of empty search boxes, and
              it gave the RAREST action (pairing with an existing voucher) the
              only visible affordance while the common ones (bokför, ignorera)
              stayed hidden behind the row menu. The picker now renders for the
              one row the user opens, and its ranked candidates are fetched then. */}
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={`${TH_CLASS} w-24`}>Datum</th>
                  <th className={TH_CLASS}>Beskrivning</th>
                  <th className={`${TH_CLASS} w-32 text-right`}>Belopp</th>
                  <th className={`${TH_CLASS} w-32`}></th>
                  <th className={`${TH_CLASS} w-10`}></th>
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {unmatchedTx.map((tx) => {
                  const isPositive = tx.amount > 0
                  const isOpen = expandedTxId === tx.id
                  const hasCandidate = hasVoucherCandidate(tx.amount, unmatchedGlLines, accountCurrency)
                  // Quick-book options matching the transaction's direction. The
                  // bank leg books to the SELECTED account (the categorize endpoint
                  // rewrites it from the cash_account_id), so these are correct on
                  // any account, not just 1930.
                  const quickBooks = QUICK_BOOK_TEMPLATES.filter((t) =>
                    isPositive ? t.direction === 'income' : t.direction === 'expense',
                  )
                  // Other enabled cash accounts this row could move to. Same
                  // currency only: the server hard-rejects a cross-currency move
                  // (the row would vanish from every report's currency scope).
                  const moveTargets = cashAccounts.filter(
                    (a) =>
                      a.enabled &&
                      a.ledger_account !== accountNumber &&
                      a.currency.toUpperCase() === tx.currency.toUpperCase(),
                  )
                  return (
                    <Fragment key={tx.id}>
                      <tr
                        className={`transition-colors duration-150 hover:bg-secondary/35 ${
                          isOpen ? 'bg-secondary/35' : ''
                        }`}
                      >
                        <td className={`${TD_CLASS} tabular-nums text-muted-foreground`}>
                          {formatDate(tx.date)}
                        </td>
                        <td className={TD_CLASS}>
                          {/* Only a row that HAS something to expand into is a
                              toggle. On a row no voucher can settle, a chevron
                              and a click target that opens nothing is a dead
                              affordance: it renders as plain text and the action
                              cell offers Bokför instead.
                              The reference sits inline rather than on a second
                              line: convention 4 keeps list rows one line high. */}
                          {hasCandidate ? (
                            <button
                              type="button"
                              onClick={() => toggleExpandedTx(tx.id)}
                              aria-expanded={isOpen}
                              className="flex max-w-full items-center gap-1.5 text-left transition-colors duration-150 hover:text-foreground"
                            >
                              {isOpen ? (
                                <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              ) : (
                                <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              )}
                              <span className="truncate">{tx.description}</span>
                              {tx.reference && (
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  · {tx.reference}
                                </span>
                              )}
                            </button>
                          ) : (
                            <span className="flex max-w-full items-center gap-1.5 pl-5">
                              <span className="truncate">{tx.description}</span>
                              {tx.reference && (
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  · {tx.reference}
                                </span>
                              )}
                            </span>
                          )}
                        </td>
                        <td
                          className={`${TD_CLASS} text-right tabular-nums ${
                            isPositive ? 'text-success' : ''
                          }`}
                        >
                          {isPositive ? '+' : ''}
                          {formatCurrency(tx.amount, tx.currency)}
                        </td>
                        <td className={`${TD_CLASS} text-right`}>
                          {/* A row with no voucher that could possibly settle it
                              is not reconciliation work at all, it is bookkeeping:
                              send it to the surface that does that instead of
                              offering a picker that holds nothing for it.
                              ?highlight= opens the row's categorize panel. */}
                          {hasCandidate ? (
                            // Opens the picker; the button INSIDE it performs the
                            // match. Two controls labelled "Matcha" in one row
                            // would read as the same action twice.
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-8 text-xs"
                              onClick={() => toggleExpandedTx(tx.id)}
                            >
                              {isOpen ? 'Stäng' : 'Välj verifikat'}
                            </Button>
                          ) : (
                            <Button asChild size="sm" variant="ghost" className="h-8 text-xs">
                              <Link href={`/transactions?highlight=${tx.id}`}>
                                {t('recon_book_row')}
                              </Link>
                            </Button>
                          )}
                        </td>
                        <td className={`${TD_CLASS} text-right`}>
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
                    {moveTargets.length > 0 && (
                      <>
                        <DropdownMenuLabel className="text-[11px] font-normal uppercase tracking-wider text-muted-foreground">
                          Flytta till annat konto
                        </DropdownMenuLabel>
                        {moveTargets.map((account) => (
                          <DropdownMenuItem
                            key={account.id}
                            onClick={() => handleMoveToAccount(tx, account)}
                            disabled={actionLoading === tx.id}
                          >
                            <ArrowRightLeft className="h-4 w-4" />
                            <div className="flex flex-col">
                              <span>
                                Flytta till {account.name || `Bankkonto ${account.currency}`}
                              </span>
                              <span className="text-xs text-muted-foreground tabular-nums">
                                {account.ledger_account}
                              </span>
                            </div>
                          </DropdownMenuItem>
                        ))}
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
                        </td>
                      </tr>
                      {isOpen && hasCandidate && (
                        <tr className="bg-secondary/20">
                          <td colSpan={5} className="px-3 pb-4 pt-1 align-top">
                            <div className="space-y-2">
                              <div className="flex items-center justify-between gap-2">
                                <Label className="text-[11px] uppercase tracking-wider text-muted-foreground">
                                  Matcha mot verifikation
                                </Label>
                                {glLines.length === 0 && (
                                  <span className="text-[11px] text-muted-foreground">
                                    Inga omatchade verifikationer på{' '}
                                    <AccountNumber number={accountNumber} />
                                  </span>
                                )}
                              </div>
                              <div className="flex items-start gap-2">
                                <div className="min-w-0 flex-1">
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
                                  className="h-10 shrink-0"
                                >
                                  <Link2 className="mr-1.5 h-3.5 w-3.5" />
                                  {linkLoading === tx.id ? 'Matchar…' : 'Matcha'}
                                </Button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Unmatched GL Lines */}
      {unmatchedGlLines.length > 0 && (
        <section id={UNMATCHED_GL_SECTION_ID} className="scroll-mt-4 space-y-3">
          <h2 className="text-sm uppercase tracking-wider text-muted-foreground">
            Omatchade verifikationer på <AccountNumber number={accountNumber} /> ({unmatchedGlLines.length})
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr>
                  <th className={`${TH_CLASS} w-16`}>Ver.nr</th>
                  <th className={`${TH_CLASS} w-24`}>Datum</th>
                  <th className={TH_CLASS}>Beskrivning</th>
                  <th className={`${TH_CLASS} w-28 text-right`}>Belopp</th>
                  <th className={`${TH_CLASS} w-24`}>Typ</th>
                  <th className={`${TH_CLASS} w-36`}></th>
                </tr>
              </thead>
              <tbody className="stagger-enter">
                {unmatchedGlLines.map((line) => {
                  const amount = line.debit_amount > 0 ? line.debit_amount : -line.credit_amount
                  const isRetaggable = line.source_type === 'manual' || line.source_type === 'import'
                  return (
                    <tr key={line.line_id} className="group transition-colors duration-150 hover:bg-secondary/35">
                      <td className={TD_CLASS}>
                        <Link
                          href={`/bookkeeping/${line.journal_entry_id}`}
                          className="font-mono text-xs underline-offset-2 hover:underline"
                          target="_blank"
                        >
                          {formatVoucher(line)}
                        </Link>
                      </td>
                      <td className={`${TD_CLASS} tabular-nums`}>{formatDate(line.entry_date)}</td>
                      <td className={`${TD_CLASS} truncate max-w-[300px]`}>
                        {line.line_description || line.entry_description}
                      </td>
                      <td className={`${TD_CLASS} text-right tabular-nums`}>
                        {formatCurrency(amount)}
                      </td>
                      <td className={`${TD_CLASS} text-xs text-muted-foreground`}>
                        {SOURCE_TYPE_LABELS[line.source_type] ?? line.source_type}
                      </td>
                      <td className={`${TD_CLASS} text-right`}>
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
        </section>
      )}

      {/* Ignored transactions (undo) */}
      {ignoredTx.length > 0 && (
        <section className="space-y-3">
          <button
            type="button"
            aria-expanded={showIgnored}
            onClick={() => setShowIgnored(!showIgnored)}
            className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            {showIgnored ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            Ignorerade transaktioner ({ignoredTx.length})
          </button>
          {showIgnored && (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={`${TH_CLASS} w-24`}>Datum</th>
                    <th className={TH_CLASS}>Beskrivning</th>
                    <th className={`${TH_CLASS} w-20`}>Valuta</th>
                    <th className={`${TH_CLASS} w-28 text-right`}>Belopp</th>
                    <th className={`${TH_CLASS} w-32`}></th>
                  </tr>
                </thead>
                <tbody className="stagger-enter">
                  {ignoredTx.map((tx) => (
                    <tr key={tx.id} className="text-muted-foreground transition-colors duration-150 hover:bg-secondary/35">
                      <td className={`${TD_CLASS} tabular-nums`}>{formatDate(tx.date)}</td>
                      <td className={`${TD_CLASS} truncate max-w-[300px]`}>{tx.description}</td>
                      <td className={`${TD_CLASS} text-xs tabular-nums`}>{tx.currency}</td>
                      <td className={`${TD_CLASS} text-right tabular-nums`}>
                        {formatCurrency(tx.amount, tx.currency)}
                      </td>
                      <td className={TD_CLASS}>
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
          )}
        </section>
      )}

      {/* Recently Matched */}
      {matchedTx.length > 0 && (
        <section className="space-y-3">
          <button
            type="button"
            aria-expanded={showMatched}
            onClick={() => setShowMatched(!showMatched)}
            className="flex items-center gap-2 text-sm font-medium uppercase tracking-wider text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            {showMatched ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
            Matchade transaktioner ({matchedTx.length})
          </button>
          {showMatched && (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={`${TH_CLASS} w-24`}>Datum</th>
                    <th className={TH_CLASS}>Beskrivning</th>
                    <th className={`${TH_CLASS} w-28 text-right`}>Belopp</th>
                    <th className={`${TH_CLASS} w-32`}>Metod</th>
                    <th className={`${TH_CLASS} w-28`}>Verifikation</th>
                    <th className={`${TH_CLASS} w-24`}></th>
                  </tr>
                </thead>
                <tbody className="stagger-enter">
                  {matchedTx.map((tx) => (
                    <tr key={tx.id} className="transition-colors duration-150 hover:bg-secondary/35">
                      <td className={`${TD_CLASS} tabular-nums`}>{formatDate(tx.date)}</td>
                      <td className={`${TD_CLASS} truncate max-w-[300px]`}>{tx.description}</td>
                      <td className={`${TD_CLASS} text-right tabular-nums`}>
                        {formatCurrency(tx.amount, accountCurrency)}
                      </td>
                      <td className={`${TD_CLASS} text-xs text-muted-foreground`}>
                        {tx.reconciliation_method
                          ? METHOD_LABELS[tx.reconciliation_method] || tx.reconciliation_method
                          : null}
                      </td>
                      <td className={TD_CLASS}>
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
                      <td className={TD_CLASS}>
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
          )}
        </section>
      )}

      {/* Empty state */}
      {unmatchedTx.length === 0 && glLines.length === 0 && matchedTx.length === 0 && ignoredTx.length === 0 && !loading && (
        <EmptyState
          icon={Landmark}
          title="Inget att stämma av"
          description="Det finns inga banktransaktioner eller verifikationer i den valda perioden. Importera eller synka banktransaktioner så visas de här."
        />
      )}

      {duplicateWarning && (
        <DuplicateBookingDialog
          candidate={duplicateWarning.candidate}
          processing={duplicateProcessing}
          onCancel={() => setDuplicateWarning(null)}
          matchTransaction={{
            id: duplicateWarning.transactionId,
            // The view is scoped to one ledger account; resolve its cash
            // account so the match links on the account being reconciled.
            cash_account_id: cashAccounts.find((a) => a.ledger_account === accountNumber)?.id ?? null,
            currency:
              unmatchedTx.find((t) => t.id === duplicateWarning.transactionId)?.currency ??
              accountCurrency,
          }}
          onMatched={async () => {
            setDuplicateWarning(null)
            toast({ variant: 'success', title: 'Transaktionen matchades mot verifikatet' })
            await fetchAll({ silent: true })
          }}
          onIgnored={async () => {
            setDuplicateWarning(null)
            toast({ variant: 'success', title: 'Transaktionen ignorerad' })
            await fetchAll({ silent: true })
          }}
          onBookAnyway={async () => {
            const retry = duplicateWarning?.retry
            setDuplicateProcessing(true)
            try {
              setDuplicateWarning(null)
              if (retry) await retry()
            } finally {
              setDuplicateProcessing(false)
            }
          }}
        />
      )}

      <DestructiveConfirmDialog {...confirmDialogProps} />
    </div>
  )
}
