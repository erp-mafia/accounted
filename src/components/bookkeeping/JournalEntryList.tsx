'use client'

import { Fragment, useState, useEffect, useCallback, useMemo, useRef, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  DataList,
  DataListEmpty,
  DataListLoading,
} from '@/components/ui/data-list'
import { Badge } from '@/components/ui/badge'
import { useCommitDraft } from '@/components/bookkeeping/use-commit-draft'
import { Button } from '@/components/ui/button'
import { BulkSelectionBar } from '@/components/ui/bulk-selection-bar'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { ToolbarSearch, TOOLBAR_SEARCH_END_CLASS } from '@/components/ui/toolbar-search'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog'
import { useFiscalScope } from '@/components/providers/FiscalScopeProvider'
import { effectiveFiscalScope } from '@/lib/reference-data/fiscal-scope'
import { AttnLine } from '@/components/ui/attn-line'
import { LoadError } from '@/components/ui/empty-state'
import { LateReveal } from '@/components/ui/skeleton'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { OpenInNewTab } from '@/components/ui/open-in-new-tab'
import { IntentLink } from '@/components/ui/intent-link'
import {
  TH_CLASS,
  TD_CLASS,
  QUIET_LINK_CLASS,
  RowSelectCheckbox,
  HOVER_REVEAL_CLASS,
  RowFoldout,
  SortableTh,
} from '@/components/ui/dry-table'
import {
  AdjustmentsHorizontalIcon,
  BookOpenIcon,
  ChatBubbleLeftIcon,
  CheckIcon,
  ChevronDoubleLeftIcon,
  ChevronDoubleRightIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  LockClosedIcon,
  NoSymbolIcon,
  PaperClipIcon,
  QueueListIcon,
  SpinnerIcon,
  Square2StackIcon,
  XMarkIcon,
} from '@/components/icons'
import { cn, formatAmount, formatDate, formatCurrency } from '@/lib/utils'
import { formatVoucher, voucherSeriesLabel } from '@/lib/bookkeeping/voucher-series-resolver'
import { resolveCurrentPeriodId } from '@/lib/bookkeeping/suggest-fiscal-period'
import { planLedgerProbe } from '@/lib/bookkeeping/ledger-probe'
import { isBoundedVerifikatScope } from '@/lib/bookkeeping/verifikat-search'
import { useSeriesFilterLetters } from '@/components/bookkeeping/use-series-filter-letters'
import { useCashAccounts, useCompanySettings } from '@/lib/reference-data/hooks'
import { readVerifikatListQuery, writeVerifikatListQuery, type VerifikatListQuery } from '@/lib/bookkeeping/verifikat-list-query'
import { voucherDisplayAmount } from '@/lib/bookkeeping/voucher-display-amount'
import { Input } from '@/components/ui/input'
import { VoucherLinesTable } from '@/components/bookkeeping/VoucherLinesTable'
import { voucherLineViews } from '@/lib/bookkeeping/voucher-line-view'
import { useBasReference } from '@/lib/bookkeeping/use-bas-reference'
import JournalEntryAttachments from '@/components/bookkeeping/JournalEntryAttachments'
import JournalEntryTransactionLinks from '@/components/bookkeeping/JournalEntryTransactionLinks'
import NoDocRequiredToggle from '@/components/bookkeeping/NoDocRequiredToggle'
import CorrectionEntryDialog from '@/components/bookkeeping/CorrectionEntryDialog'
import VoucherGapNotice from '@/components/bookkeeping/VoucherGapNotice'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { OwnedVoucherActionDialog } from '@/components/bookkeeping/OwnedVoucherActionDialog'
import { useReverseJournalEntry } from '@/components/bookkeeping/use-reverse-journal-entry'
import { mayHaveVoucherOwner, type VoucherOwner } from '@/lib/core/bookkeeping/voucher-owner'
import JournalEntryStatusBadge from '@/components/bookkeeping/JournalEntryStatusBadge'
import AttachmentPreviewSheet from '@/components/bookkeeping/AttachmentPreviewSheet'
import { useToast } from '@/components/ui/use-toast'
import { fetchRattelseFlags } from '@/lib/bookkeeping/rattelse-flags'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useBulkSelection } from '@/lib/hooks/use-bulk-selection'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { listContextKey, writeListContext } from '@/lib/navigation/list-context'
import { NEEDS_DOC_SOURCE_TYPES } from '@/lib/worklist/types'
import { collectPages } from '@/lib/lists/collect-pages'
import type { JournalEntry, JournalEntryLine } from '@/types'
import { todayIsoStockholm } from '@/lib/dates/iso'

// Shared source of truth (lib/worklist/types.ts) so the per-row chip and
// waiver UI can never drift from the worklist count and the SQL predicate
// (skeptic finding on #1881: a hardcoded copy here missed webshop_order,
// leaving flagged rows without chip or waiver toggle).
const NEEDS_ATTACHMENT = new Set<string>(NEEDS_DOC_SOURCE_TYPES)

// Column-header sorting (support feedback: "filtrera/sortera alla rubriker").
// The sort order is a priority-ordered STACK of keys (max 3): the second key
// breaks ties in the first, and so on. Plain click sets a single key;
// shift-click stacks.
type SortColumn = 'voucher' | 'date' | 'description' | 'total'
type SortDirection = 'asc' | 'desc'
interface SortKey {
  column: SortColumn
  direction: SortDirection
}

// Per-company persistence of the sort order. Mirrors the localStorage
// convention used by FiscalYearSelector ('Accounted:fiscal-year:<companyId>').
// The stored value is the serialized stack (see serializeSortStack).
const SORT_STORAGE_KEY_PREFIX = 'Accounted:journal-sort:'
const MAX_SORT_KEYS = 3
const SORT_TOKEN_RE = /^(voucher|date|description|total)_(asc|desc)$/

// The list's resting order, and the exit of the header toggle cycle.
const DEFAULT_SORT_STACK: SortKey[] = [{ column: 'date', direction: 'desc' }]

// 'total_desc,description_asc' <-> [{total desc}, {description asc}]. The
// single-token form is the pre-stack format, so persisted values from before
// stacking (and the dialog's single-choice select) parse with the same code.
// Any invalid token rejects the whole value: a corrupt stored string falls
// back to the default rather than silently sorting by half a stack.
function parseSortStack(raw: string | null): SortKey[] | null {
  if (!raw) return null
  const keys: SortKey[] = []
  for (const token of raw.split(',')) {
    const m = SORT_TOKEN_RE.exec(token.trim())
    if (!m) return null
    const column = m[1] as SortColumn
    if (keys.some((k) => k.column === column)) continue
    keys.push({ column, direction: m[2] as SortDirection })
    if (keys.length === MAX_SORT_KEYS) break
  }
  return keys.length > 0 ? keys : null
}

const serializeSortStack = (stack: SortKey[]): string =>
  stack.map((k) => `${k.column}_${k.direction}`).join(',')

const sortStacksEqual = (a: SortKey[], b: SortKey[]): boolean =>
  serializeSortStack(a) === serializeSortStack(b)

// The shared SortableTh with two deliberate additions: the plain-click
// cycle has a third step back to DEFAULT_SORT_STACK so a sort is always
// escapable from the header itself (the invoices list starts unsorted and
// has nothing to return to), and shift-click stacks the column as a
// secondary/tertiary key, shown with its priority number next to the arrow.
function sortHeadOf(stack: SortKey[], column: SortColumn): { direction: 'asc' | 'desc' | null; rank?: number } {
  const index = stack.findIndex((k) => k.column === column)
  if (index === -1) return { direction: null }
  return { direction: stack[index].direction, rank: stack.length > 1 ? index + 1 : undefined }
}

// Compact row density (support feedback: "kompakt visning av verifikat",
// asked again in crm#1323). Persisted per company, mirroring the sort key
// convention.
const DENSITY_STORAGE_KEY_PREFIX = 'Accounted:journal-density:'

// Page-size selector. Persisted per company, mirroring the sort key convention.
// 'all' collects everything in the current scope in chunks of the most rows
// one response may carry (collectPages); the numeric options paginate normally.
type PageSizeChoice = '20' | '50' | '100' | 'all'
const PAGE_SIZE_STORAGE_KEY_PREFIX = 'Accounted:journal-page-size:'
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const
const PAGE_SIZE_VALUES = new Set<PageSizeChoice>(['20', '50', '100', 'all'])

// The page the list lives on: its view is written into this page's address.
const LIST_PATH = '/bookkeeping'

// The search box's text as the list sends it. Require 2 or more characters:
// a single character matches almost every verifikationstext and isn't a
// useful filter, so 0-1 chars are "no search" instead of a query on every
// keystroke (ASVS V2.4).
function effectiveSearch(input: string): string {
  const trimmed = input.trim()
  return trimmed.length >= 2 ? trimmed : ''
}

export default function JournalEntryList({
  pristineSlot,
  refreshToken,
}: {
  pristineSlot?: ReactNode
  /**
   * Parent-driven refresh: bump to re-fetch IN PLACE (list stays mounted,
   * dims at opacity-60). Replaces the old key={refreshKey} remount on
   * /bookkeeping, which reset hasLoaded and blanked the whole journal to a
   * spinner after every created verifikat, destroying expanded rows,
   * selection, pagination and scroll position.
   */
  refreshToken?: number
} = {}) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  // The view the list opens on: its filters, search and page from the address
  // (crm#1998), so Back from a verifikat, the verifikat's link back here, a
  // reload and a shared link show the list as it was. Read once, on mount;
  // from then on the state below is the view and the address follows it (the
  // effect after fetchEntries). The deep links from Hem ("Verifikat utan
  // underlag", the push notification) and the bokslut preflight ("Förklara
  // luckan") arrive through the same reader: the first turns the
  // saknade-underlag filter on for all years, the second opens this visit on
  // the räkenskapsår whose gap blocked the bokslut. Neither overwrites the
  // saved fiscal-year preference.
  const [initialQuery] = useState<VerifikatListQuery>(() => readVerifikatListQuery(searchParams))
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const company = useCompanyOptional()?.company ?? null
  const t = useTranslations('journal_list')
  const tCommon = useTranslations('common')
  // Loads the BAS chart chunk after mount and re-renders once names and
  // descriptions for non-hardcoded accounts are available.
  useBasReference()
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [committingId, setCommittingId] = useState<string | null>(null)
  // Confirm-before-posting (convention 10): the draft the user is about to
  // commit, plus the predicted voucher label ("A-218") for the dialog copy.
  const [commitTarget, setCommitTarget] = useState<JournalEntry | null>(null)
  const [commitVoucherPreview, setCommitVoucherPreview] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  // Only the very first load may replace the table with a skeleton. Every
  // later refetch (filter, sort, page, search) keeps the rows on screen and
  // dims them, so the list never collapses to a spinner and springs back to
  // full height under the pointer. Growing lists were causing real mis-clicks.
  const [hasLoaded, setHasLoaded] = useState(false)
  // A failed list fetch must NEVER render as an empty ledger: the sort order
  // is persisted per company, so a sort the backend rejects (e.g. a computed
  // column missing on this environment) would otherwise masquerade as "all
  // entries gone" on every reload, with no toolbar to escape through.
  const [loadFailed, setLoadFailed] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [count, setCount] = useState(0)
  // Badge next to "Visa saknade underlag": the total of the last SUCCESSFUL
  // filtered fetch, null otherwise. Borrowing `count` showed 0 on a failed
  // first load and the whole ledger's total after a toggle (#2395); a badge
  // with no honest source is hidden, not guessed.
  const [missingCount, setMissingCount] = useState<number | null>(null)
  const [page, setPage] = useState(initialQuery.page)
  const [attachmentCounts, setAttachmentCounts] = useState<Record<string, number>>({})
  // Entries a customer invoice points at (registration link or payment row):
  // backed by that invoice under BFL 5 kap 7 § (hänvisning), the same verdict
  // the dashboard badge (verifikat_without_documents) and the verifikat page
  // reach. Not a document, so no paperclip; but no "Underlag saknas" either.
  const [invoiceReferenced, setInvoiceReferenced] = useState<Set<string>>(new Set())
  // Counts arrive in a second request, after the rows are already painted.
  // Until they land, every row looks like it has no underlag, so rendering the
  // chip eagerly flashes a false "Saknar underlag" compliance warning on every
  // load, sort, filter and page change. Render nothing until we actually know.
  const [attachmentCountsLoaded, setAttachmentCountsLoaded] = useState(false)
  // Entries with inline rättelser (journal_entry_rattelse_log rows): drives
  // the "Rättad" marker so a rättelse is discoverable from the list
  // (BFL 5 kap 5 §), not only on the detail page.
  const [rattelseFlags, setRattelseFlags] = useState<Set<string>>(new Set())
  const [noDocRequired, setNoDocRequired] = useState<Map<string, string | null>>(new Map())
  const [showMissingOnly, setShowMissingOnly] = useState(initialQuery.missingOnly)
  // Unexplained voucher gaps the VoucherGapNotice attn line is showing. The
  // page has one attn slot (convention 6) and a missing BFNAR 2013:2
  // explanation outranks the SIE import pointer, so that line yields.
  const [unexplainedGapCount, setUnexplainedGapCount] = useState(0)
  // Radix' onCheckedChange carries no mouse event: the click that precedes it
  // records whether shift was held, for range selection.
  const shiftHeld = useRef(false)
  const [batchReason, setBatchReason] = useState('')
  const [batchSubmitting, setBatchSubmitting] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkCount, setBulkCount] = useState<number | null>(null)
  const [bulkReason, setBulkReason] = useState('')
  const [bulkSubmitting, setBulkSubmitting] = useState(false)
  const [correctionEntry, setCorrectionEntry] = useState<JournalEntry | null>(null)
  const [reverseEntryTarget, setReverseEntryTarget] = useState<JournalEntry | null>(null)
  // Vänd or Rätta on a verifikat an object owns: its own action first
  // (OwnedVoucherActionDialog), as on the verifikat page.
  const [ownedAction, setOwnedAction] = useState<{
    entry: JournalEntry
    owner: VoucherOwner
    intent: 'reverse' | 'correct'
  } | null>(null)
  const [previewEntryId, setPreviewEntryId] = useState<string | null>(null)
  const [sortStack, setSortStack] = useState<SortKey[]>(DEFAULT_SORT_STACK)
  const [sortHydrated, setSortHydrated] = useState(false)
  // The year is app-wide context (the sidebar, useFiscalScope). A deep link
  // can scope this one visit, in memory only, without touching it: the
  // missing-underlag filter arrives on all years (the set the all-years
  // dashboard badge counted), a bokslut gap blocker on the year it named
  // (or the current one if that year is gone). Choosing a year in the
  // sidebar ends the visit's scope.
  const fiscalScope = useFiscalScope()
  const [visitScope, setVisitScope] = useState<{ periodId: string | null } | null>(initialQuery.visitScope)
  const [seenYear, setSeenYear] = useState<string | null | undefined>(undefined)
  if (fiscalScope.ready && seenYear !== fiscalScope.periodId) {
    setSeenYear(fiscalScope.periodId)
    if (seenYear !== undefined) {
      setVisitScope(null)
      setPage(0)
    }
  }
  const periodId = visitScope
    ? visitScope.periodId === null
      ? null
      : effectiveFiscalScope(fiscalScope.periods, visitScope.periodId, { allowAll: false }).periodId
    : fiscalScope.periodId
  // Hold the first fetch until the scope is known; an all-years visit knows it at once.
  const periodHydrated = visitScope?.periodId === null || fiscalScope.ready
  const [filterOpen, setFilterOpen] = useState(false)
  const [dateFrom, setDateFrom] = useState(initialQuery.dateFrom)
  const [dateTo, setDateTo] = useState(initialQuery.dateTo)
  const [dateFromInput, setDateFromInput] = useState(initialQuery.dateFrom)
  const [dateToInput, setDateToInput] = useState(initialQuery.dateTo)
  const [seriesFilter, setSeriesFilter] = useState<string>(initialQuery.series ?? 'all')
  const seriesLetters = useSeriesFilterLetters(company?.id, seriesFilter)
  // Each letter with the name the company gave the series, or the standard
  // name, through the one resolver every series picker uses (crm#1997).
  const seriesLabels = useCompanySettings().settings?.voucher_series_labels ?? null
  const [searchInput, setSearchInput] = useState(initialQuery.search)
  const [search, setSearch] = useState(() => effectiveSearch(initialQuery.search))
  // Verifikat (committed) vs Utkast (drafts) view. Drafts are excluded from the
  // committed list server-side and surfaced here behind a count badge.
  const [listMode, setListMode] = useState<'committed' | 'drafts'>(initialQuery.mode)
  // Storno and reversed (Omförd) rows, chosen in the filter dialog:
  // 'collapse' (default) folds a correction group to the live correction and
  // keeps a pure storno pair, so the series stays gapless (#3149); 'hide'
  // drops every storno and reversed original (PH 231); 'all' shows the chain.
  const [correctionView, setCorrectionView] = useState<'all' | 'collapse' | 'hide'>(initialQuery.correctionView)
  const [draftCount, setDraftCount] = useState(0)
  // All-years emptiness, resolved only when the scoped list comes back empty:
  // the pristine start card must key on "this ledger has never had an entry",
  // not "the selected fiscal year is empty" (the default year selection used
  // to make the pristine state unreachable on brand-new companies). null =
  // not yet known; the pristine gate requires an explicit false.
  const [ledgerHasAnyEntry, setLedgerHasAnyEntry] = useState<boolean | null>(null)
  const [pageSizeChoice, setPageSizeChoice] = useState<PageSizeChoice>('20')
  const [pageSizeHydrated, setPageSizeHydrated] = useState(false)
  const [compact, setCompact] = useState(false)
  const showingAll = pageSizeChoice === 'all'
  const pageSize = showingAll ? Number.POSITIVE_INFINITY : Number(pageSizeChoice)

  const normalizeDate = (v: string): string | null => {
    const trimmed = v.trim()
    if (!trimmed) return null
    // YYYY
    if (/^\d{4}$/.test(trimmed)) {
      const y = parseInt(trimmed, 10)
      if (y < 1900 || y > 2100) return null
      return `${trimmed}-01-01`
    }
    // YYYY-MM
    if (/^\d{4}-\d{2}$/.test(trimmed)) {
      const [y, m] = trimmed.split('-').map(Number)
      if (y < 1900 || y > 2100 || m < 1 || m > 12) return null
      return `${trimmed}-01`
    }
    // YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const d = new Date(trimmed + 'T00:00:00')
      if (isNaN(d.getTime())) return null
      // Verify the date didn't roll over (e.g. 2024-02-31 → March)
      const [y, m, day] = trimmed.split('-').map(Number)
      if (d.getFullYear() !== y || d.getMonth() + 1 !== m || d.getDate() !== day) return null
      return trimmed
    }
    return null
  }

  const applyDateFilter = () => {
    const fromVal = dateFromInput.trim()
    const toVal = dateToInput.trim()
    const nextFrom = fromVal === '' ? '' : normalizeDate(fromVal) ?? dateFrom
    const nextTo = toVal === '' ? '' : normalizeDate(toVal) ?? dateTo
    setDateFromInput(nextFrom)
    setDateToInput(nextTo)
    if (nextFrom !== dateFrom || nextTo !== dateTo) {
      setDateFrom(nextFrom)
      setDateTo(nextTo)
      setPage(0)
    }
  }

  // isCurrent: the caller's request-generation guard (see fetchGenRef). The
  // metadata writes land after their own awaits, so a stale list request's
  // late completion must not overwrite counts/flags for the rows a newer
  // request just rendered: wrong counts here flip the missing-underlag
  // warning and bulk-exemption eligibility.
  const fetchAttachmentCounts = useCallback(async (entryIds: string[], isCurrent: () => boolean = () => true) => {
    if (entryIds.length === 0) {
      setAttachmentCounts({})
      setInvoiceReferenced(new Set())
      setAttachmentCountsLoaded(true)
      return
    }
    // Deliberately keeps the previous counts in place while refetching: they
    // are keyed by entry id, so a row that survives the refetch keeps its true
    // count and a new row is covered by the loaded flag below.
    setAttachmentCountsLoaded(false)
    // The counts route caps each request at 50 IDs, so a large page ("Alla", or
    // 100/page) must be split into chunks and merged. Without this the whole
    // request 400s and every document-requiring row falsely shows the
    // missing-underlag warning until it's expanded.
    const COUNTS_BATCH_SIZE = 50
    const batches: string[][] = []
    for (let i = 0; i < entryIds.length; i += COUNTS_BATCH_SIZE) {
      batches.push(entryIds.slice(i, i + COUNTS_BATCH_SIZE))
    }
    try {
      const empty = { counts: {} as Record<string, number>, referenced: [] as string[] }
      const results = await Promise.all(
        batches.map(async (batch) => {
          const res = await fetch(
            `/api/documents/counts?journal_entry_ids=${batch.join(',')}`
          )
          if (!res.ok) return empty
          const { data, invoice_references } = await res.json()
          return {
            counts: (data || {}) as Record<string, number>,
            referenced: Object.keys((invoice_references || {}) as Record<string, number>),
          }
        })
      )
      if (!isCurrent()) return
      setAttachmentCounts(Object.assign({}, ...results.map((r) => r.counts)))
      setInvoiceReferenced(new Set(results.flatMap((r) => r.referenced)))
    } catch {
      // Non-critical: silently ignore
    } finally {
      // A stale run must not flip the loaded flag either: the newer run set
      // it false on entry and owns setting it true when ITS counts land.
      if (isCurrent()) setAttachmentCountsLoaded(true)
    }
  }, [])

  const fetchRattelseMarkers = useCallback(async (entryIds: string[], isCurrent: () => boolean = () => true) => {
    const { corrected, incomplete } = await fetchRattelseFlags(entryIds)
    if (!isCurrent()) return
    setRattelseFlags(corrected)
    if (incomplete) toast({ title: t('rattelse_flags_failed'), variant: 'destructive' })
  }, [t, toast])

  const fetchNoDocRequired = useCallback(async () => {
    try {
      const res = await fetch('/api/bookkeeping/no-doc-required')
      if (!res.ok) return
      const { data } = await res.json()
      const map = new Map<string, string | null>()
      for (const row of (data || []) as { journal_entry_id: string; reason: string | null }[]) {
        map.set(row.journal_entry_id, row.reason)
      }
      setNoDocRequired(map)
    } catch {
      // Non-critical: silently ignore
    }
  }, [])

  useEffect(() => {
    fetchNoDocRequired()
  }, [fetchNoDocRequired])

  // Restore the persisted sort order (per company). Read in an effect rather
  // than the useState initializer to avoid an SSR/client hydration mismatch.
  // sortHydrated gates the first fetch so the list is fetched once, already in
  // the saved order, no flash of the default sort.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = parseSortStack(
        window.localStorage.getItem(SORT_STORAGE_KEY_PREFIX + (company?.id ?? 'default')),
      )
      if (stored) setSortStack(stored)
    }
    setSortHydrated(true)
  }, [company?.id])


  // Restore the persisted page-size choice (per company). Same hydration pattern
  // as the sort order, read in an effect to avoid an SSR mismatch, and gate the
  // first fetch so the list is fetched once at the saved size.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY_PREFIX + (company?.id ?? 'default'))
      if (stored && PAGE_SIZE_VALUES.has(stored as PageSizeChoice)) setPageSizeChoice(stored as PageSizeChoice)
    }
    setPageSizeHydrated(true)
  }, [company?.id])

  // Restore the persisted row density (per company). Purely visual, so it
  // doesn't gate the first fetch; the effect-read avoids an SSR mismatch.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      setCompact(window.localStorage.getItem(DENSITY_STORAGE_KEY_PREFIX + (company?.id ?? 'default')) === 'compact')
    }
  }, [company?.id])

  // Belopp shows the money that moved when a verifikat records one payment
  // through one money account (crm#1280). A cash account kept outside 19xx
  // (a payment provider's balance on 1686) counts as a money account too;
  // disabled ones included, since old vouchers still sit on them.
  const { cashAccounts } = useCashAccounts()
  const extraMoneyAccounts = useMemo(
    () => new Set(cashAccounts.map((a) => a.ledger_account).filter((a): a is string => !!a)),
    [cashAccounts],
  )

  // Debounce the free-text search before it reaches the API. Only a search
  // that changes goes back to the first page: the search the list opened
  // with (from the address) keeps the page it opened on.
  useEffect(() => {
    const next = effectiveSearch(searchInput)
    if (next === search) return
    const handle = setTimeout(() => {
      setSearch(next)
      setPage(0)
    }, 300)
    return () => clearTimeout(handle)
  }, [searchInput, search])

  // Sort/filter changes fire fetchEntries while an earlier request may still
  // be in flight; only the newest request may write state, or a slow earlier
  // response would overwrite the current sort's rows after they rendered.
  const fetchGenRef = useRef(0)

  // `preserveSelection` marks a parent-driven background refresh (the
  // refreshToken contract: refresh in place, don't disturb the user's
  // working state). User-initiated reloads (filter/sort/page/mode changes,
  // commit, storno, retry) keep the default reset: selection is page-scoped.
  async function fetchEntries({ preserveSelection = false }: { preserveSelection?: boolean } = {}) {
    const gen = ++fetchGenRef.current
    const isCurrent = () => fetchGenRef.current === gen
    // Set when this load moves to another page and leaves the loading state
    // to the load that page starts.
    let movedPage = false
    setLoading(true)
    if (!preserveSelection) selection.clear() // selection is page-scoped, reset on reload
    const params = new URLSearchParams({
      sort_by: serializeSortStack(sortStack),
    })
    if (listMode === 'drafts') {
      // Drafts get their own view spanning all years: they're work-in-progress
      // and shouldn't be hidden by the selected fiscal-year scope.
      params.set('status', 'draft')
    } else {
      params.set('exclude_draft', 'true')
      if (correctionView === 'hide') params.set('hide_reversed', 'true')
      else if (correctionView === 'collapse') params.set('collapse_corrections', 'true')
      if (periodId) params.set('period_id', periodId)
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      if (seriesFilter !== 'all') params.set('series', seriesFilter)
      // Server-side filter: the missing-underlag predicate spans documents,
      // supplier-invoice references and exemptions, so the server resolves it
      // across ALL pages (count included). Filtering the fetched page here
      // could only ever show this page's missing rows.
      if (showMissingOnly) params.set('missing_underlag', 'true')
    }
    if (search) params.set('search', search)

    // One request per page. "Alla" collects the whole scope in chunks of the
    // most rows one response may carry: a single large request came back cut
    // at 1,000 rows while the count promised every verifikat. A failed chunk
    // fails the load, so a partial list never renders as all of them.
    // The rows' underlag counts ride along (include_counts) instead of a
    // second request to /api/documents/counts; a chunk that came back without
    // them sends the load to that route as before.
    const carriedCounts: Record<string, number> = {}
    const carriedReferenced: string[] = []
    let countsCarried = true
    const fetchChunk = async (offset: number, limit: number) => {
      const chunkParams = new URLSearchParams(params)
      chunkParams.set('limit', String(limit))
      chunkParams.set('offset', String(offset))
      chunkParams.set('include_counts', 'true')
      const res = await fetch(`/api/bookkeeping/journal-entries?${chunkParams}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { data, count, attachment_counts, invoice_references } = await res.json()
      if (attachment_counts && invoice_references) {
        Object.assign(carriedCounts, attachment_counts as Record<string, number>)
        carriedReferenced.push(...Object.keys(invoice_references as Record<string, number>))
      } else {
        countsCarried = false
      }
      return { data: (data || []) as JournalEntry[], count: typeof count === 'number' ? count : 0 }
    }

    try {
      const { data: loadedEntries, count: total } = showingAll
        ? await collectPages(fetchChunk, { want: Number.POSITIVE_INFINITY })
        : await fetchChunk(page * pageSize, pageSize)
      if (!isCurrent()) return
      // A page past the end (an address from before verifikat went away, or
      // typed by hand) opens the last page instead of an empty table.
      if (!showingAll && page > 0 && loadedEntries.length === 0 && (total || 0) > 0) {
        movedPage = true
        setPage(Math.ceil((total || 0) / pageSize) - 1)
        return
      }
      setLoadFailed(false)
      setEntries(loadedEntries)
      setCount(total || 0)
      setMissingCount(showMissingOnly && listMode === 'committed' ? total || 0 : null)
      // A preserved selection needs no reconcile here: rows that left the
      // page (recommitted elsewhere, filtered out) leave useBulkSelection's
      // selection when the new page renders.

      // The pristine empty card vs. the (toggle-bearing) "drafts exist" state hinges
      // on draftCount. When the committed list comes back empty, resolve the draft
      // count BEFORE clearing loading so the toggle doesn't flash out for a frame on
      // a stale count of 0. Every other case refreshes the badge in the background.
      if (loadedEntries.length === 0 && listMode === 'committed') {
        // The all-years probe runs only when its answer can change what
        // renders (lib/bookkeeping/ledger-probe.ts, crm#1390). A total with
        // the makulerade pairs hidden says nothing about whether the ledger
        // has entries, so that view probes instead of trusting the total.
        const basePlan = planLedgerProbe({ periodId, search, seriesFilter, dateFrom, dateTo, showMissingOnly })
        const probePlan = basePlan === 'from_total' && correctionView === 'hide' ? 'probe' : basePlan
        await Promise.all([
          fetchDraftCount(),
          probePlan === 'from_total'
            ? Promise.resolve(setLedgerHasAnyEntry((total || 0) > 0))
            : probePlan === 'probe'
              ? fetchLedgerHasAnyEntry(isCurrent)
              : Promise.resolve(),
        ])
      } else {
        if (listMode === 'committed' && loadedEntries.length > 0) setLedgerHasAnyEntry(true)
        fetchDraftCount()
      }
      if (!isCurrent()) return
      setHasLoaded(true)

      // Fetch attachment counts + rättelse markers for the loaded entries,
      // carrying the generation guard so their late completions can't
      // overwrite metadata a newer request just rendered.
      const ids = loadedEntries.map((e: JournalEntry) => e.id)
      if (countsCarried && ids.length > 0) {
        setAttachmentCounts(carriedCounts)
        setInvoiceReferenced(new Set(carriedReferenced))
        setAttachmentCountsLoaded(true)
      } else {
        fetchAttachmentCounts(ids, isCurrent)
      }
      fetchRattelseMarkers(ids, isCurrent)
    } catch {
      // A non-OK response or a network-level rejection (offline, aborted
      // response body): stale rows (if any) stay on screen under the
      // refresh-failed line, and the empty case renders LoadError below.
      // Without this the list stays dimmed forever.
      if (!isCurrent()) return
      setLoadFailed(true)
      setMissingCount(null)
      setHasLoaded(true)
    } finally {
      if (isCurrent() && !movedPage) setLoading(false)
    }
  }

  // Cheap count-only probe across ALL years and filters: does this ledger
  // hold any committed entry at all? Distinguishes "pristine ledger" from
  // "the selected scope is empty" for the start-card gate below.
  async function fetchLedgerHasAnyEntry(isCurrent: () => boolean) {
    // Back to unknown while the probe is in flight: a failed probe must not
    // leave a stale false behind, or the pristine card could render on data
    // this scope change never confirmed.
    if (isCurrent()) setLedgerHasAnyEntry(null)
    try {
      const res = await fetch('/api/bookkeeping/journal-entries?exclude_draft=true&limit=1')
      if (!res.ok || !isCurrent()) return
      const { count: total } = await res.json()
      if (isCurrent()) setLedgerHasAnyEntry((total || 0) > 0)
    } catch {
      // Non-fatal: an unknown probe keeps the pristine card hidden.
    }
  }

  // Cheap count-only query for the "Utkast" badge, all years, so the badge
  // surfaces drafts regardless of the selected fiscal-year scope.
  async function fetchDraftCount() {
    try {
      const res = await fetch('/api/bookkeeping/journal-entries?status=draft&limit=1')
      if (!res.ok) return
      const { count: total } = await res.json()
      setDraftCount(total || 0)
    } catch {
      // Non-fatal: the badge keeps its last value.
    }
  }

  // The stack serializes to a string for the dependency array: a stable
  // primitive, so refetches fire on real sort changes, not array identity.
  const sortParam = serializeSortStack(sortStack)

  useEffect(() => {
    if (!sortHydrated || !periodHydrated || !pageSizeHydrated) return
    fetchEntries()
  }, [periodId, page, pageSize, sortParam, dateFrom, dateTo, seriesFilter, search, listMode, correctionView, showMissingOnly, sortHydrated, periodHydrated, pageSizeHydrated])

  // The address follows the view (crm#1998): the list's own keys are
  // rewritten, every other parameter stays. The History API with no state of
  // its own, which Next keeps in step with useSearchParams: no navigation and
  // no server render per filter change or search.
  const viewQuery: VerifikatListQuery = {
    mode: listMode,
    series: seriesFilter === 'all' ? null : seriesFilter,
    dateFrom,
    dateTo,
    search,
    correctionView,
    missingOnly: showMissingOnly,
    visitScope,
    page,
  }
  const currentQuery = searchParams.toString()
  const wantedQuery = writeVerifikatListQuery(currentQuery, viewQuery).toString()
  useEffect(() => {
    if (pathname !== LIST_PATH || wantedQuery === currentQuery) return
    window.history.replaceState(null, '', wantedQuery ? `${LIST_PATH}?${wantedQuery}` : LIST_PATH)
  }, [wantedQuery, currentQuery, pathname])

  // Parent-driven in-place refresh (see the refreshToken prop). Skips the
  // mount value: the main effect above owns the initial fetch, and a token
  // bump before hydration is covered by that same initial fetch.
  const lastRefreshTokenRef = useRef(refreshToken)
  useEffect(() => {
    if (refreshToken === undefined || refreshToken === lastRefreshTokenRef.current) return
    lastRefreshTokenRef.current = refreshToken
    if (!sortHydrated || !periodHydrated || !pageSizeHydrated) return
    // In-place refresh: the user didn't ask for a reload, so their current
    // selection survives (reconciled against the refreshed page).
    fetchEntries({ preserveSelection: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken, sortHydrated, periodHydrated, pageSizeHydrated])

  // Render-time ref mirrors so the stable [] callback below can read current
  // state and call the current fetchEntries (same pattern as
  // JournalEntryAttachments' onCountChangeRef).
  const showMissingOnlyRef = useRef(showMissingOnly)
  showMissingOnlyRef.current = showMissingOnly
  const fetchEntriesRef = useRef(fetchEntries)
  fetchEntriesRef.current = fetchEntries
  // Entry ids that already triggered a filter refetch after gaining underlag:
  // if the server still included the row after that refetch (predicate
  // disagreement), a remount would re-fire the callback and loop forever.
  const refetchedAfterAttachRef = useRef<Set<string>>(new Set())

  const handleAttachmentCountChange = useCallback((entryId: string, count: number) => {
    setAttachmentCounts((prev) => ({ ...prev, [entryId]: count }))
    // With the server-side saknade-underlag filter on, a listed row that just
    // received its first underlag no longer belongs to the filtered set:
    // refetch in place so it leaves the list, as the old client-side filter
    // did. Listed rows arrive with zero underlag by definition, so a count
    // above zero here can only follow a user action.
    if (
      count > 0 &&
      showMissingOnlyRef.current &&
      !refetchedAfterAttachRef.current.has(entryId)
    ) {
      refetchedAfterAttachRef.current.add(entryId)
      void fetchEntriesRef.current({ preserveSelection: true })
    }
  }, [])

  const toggleExpand = (id: string) => {
    setExpandedId(expandedId === id ? null : id)
  }

  function switchMode(mode: 'committed' | 'drafts') {
    if (mode === listMode) return
    setListMode(mode)
    setPage(0)
    selection.clear()
    if (mode === 'drafts') setShowMissingOnly(false)
  }

  // Open the confirm dialog and fetch the predicted voucher number. The
  // prediction is indicative (numbers are assigned atomically at commit,
  // and a draft in another period/series may land elsewhere); the success
  // toast always shows the real one.
  const openCommitConfirm = (entry: JournalEntry) => {
    setCommitTarget(entry)
    setCommitVoucherPreview(null)
    fetch('/api/bookkeeping/voucher-sequences/next')
      .then((r) => r.json())
      .then(({ data }) => {
        if (data?.next != null) setCommitVoucherPreview(`${data.series}${data.next}`)
      })
      .catch(() => {})
  }

  // The commit meets the booking-time voucher warnings (useCommitDraft).
  const { commit: commitDraft, dialog: commitWarningsDialog } = useCommitDraft<{ voucher_series?: string | null; voucher_number?: number | null } | null>({
    onPosted: async (posted) => {
      toast({
        title: t('toast_posted_title'),
        description: t('toast_posted_description', { voucher: formatVoucher(posted ?? {}) }),
      })
      await fetchEntries()
    },
    onFailed: (result) => {
      toast({ title: t('toast_post_failed'), description: getErrorMessage(result, { context: 'journal_entry' }), variant: 'destructive' })
    },
  })

  const handleCommit = async (entryId: string) => {
    setCommittingId(entryId)
    try {
      await commitDraft(entryId)
    } catch {
      toast({ title: t('toast_post_failed_generic'), variant: 'destructive' })
    } finally {
      setCommittingId(null)
    }
  }

  // Pure reversal (storno), shared with the verifikat page (useReverseJournalEntry).
  const { reverse, isReversing } = useReverseJournalEntry({
    onReversed: async () => {
      setReverseEntryTarget(null)
      await fetchEntries()
    },
  })
  const handleReverse = async () => {
    if (reverseEntryTarget) await reverse(reverseEntryTarget.id)
  }

  // Vänd and Rätta ask for the verifikat's owner first, only for the source
  // types that can have one; any other verifikat (or a failed lookup) goes
  // straight on, so the list never waits on advice.
  const startVoucherAction = async (entry: JournalEntry, intent: 'reverse' | 'correct') => {
    const proceed = () => (intent === 'reverse' ? setReverseEntryTarget(entry) : setCorrectionEntry(entry))
    if (!mayHaveVoucherOwner(entry.source_type)) return proceed()
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${entry.id}/references`)
      const owner = res.ok ? (((await res.json())?.data?.owned_by ?? null) as VoucherOwner | null) : null
      if (owner) setOwnedAction({ entry, owner, intent })
      else proceed()
    } catch {
      proceed()
    }
  }

  // A posted, document-requiring entry with no attachment yet and not already
  // exempt, i.e. the rows that show the warning triangle. Only these can be
  // batch-marked "Inget underlag krävs".
  const isEligibleForExempt = useCallback(
    (entry: JournalEntry) =>
      entry.status === 'posted' &&
      NEEDS_ATTACHMENT.has(entry.source_type) &&
      !attachmentCounts[entry.id] &&
      !invoiceReferenced.has(entry.id) &&
      !noDocRequired.has(entry.id),
    [attachmentCounts, invoiceReferenced, noDocRequired],
  )

  // Imported verifikat missing underlag: the rows that used to carry the
  // per-row "Underlag saknas" chip, counted once in the line above the table
  // instead (2026-10-18: a migrated year was a wall of chips). Same
  // population as the chip: posted, import, no attachment, not
  // invoice-referenced, not marked "Inget underlag krävs". Counted over the
  // loaded rows, so the line says "på den här sidan" unless the whole scope
  // is on screen. NEEDS_DOC_SOURCE_TYPES and the worklist counts are
  // untouched; only the list rows change.
  const importedMissingCount = attachmentCountsLoaded
    ? entries.filter((e) => e.source_type === 'import' && isEligibleForExempt(e)).length
    : 0
  const wholeScopeLoaded = entries.length >= count

  const handleBatchExempt = async () => {
    const ids = Array.from(selectedIds)
    if (ids.length === 0) return
    setBatchSubmitting(true)
    const reason = batchReason.trim() || null
    try {
      const res = await fetch('/api/bookkeeping/no-doc-required/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ journal_entry_ids: ids, reason }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        // Resolve via the parsed body plus the status: the route answers
        // thrown errors with the canonical envelope `{ error: { code,
        // message } }`, and rendering that object as the toast description
        // would crash React ("Objects are not valid as a React child").
        toast({
          title: t('no_doc_required_save_failed'),
          description: getErrorMessage(body, { statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      // Reflect the new exemptions locally: triangle → muted "no doc" indicator.
      setNoDocRequired((prev) => {
        const next = new Map(prev)
        for (const id of ids) next.set(id, reason)
        return next
      })
      selection.clear()
      setBatchReason('')
      toast({
        title: t('batch_no_doc_done_title'),
        description: t('batch_no_doc_done_description', { count: body.data?.exempted ?? ids.length }),
      })
      // With the server-side saknade-underlag filter on, the exempted rows no
      // longer belong to the filtered set: refetch so they leave the list and
      // the count updates (the pre-server-filter behavior).
      if (showMissingOnly) await fetchEntries()
    } catch {
      toast({ title: t('no_doc_required_save_failed'), variant: 'destructive' })
    } finally {
      setBatchSubmitting(false)
    }
  }

  // Filter-scoped bulk mark: mark EVERY missing-doc verifikat matching the active
  // filters (period/series/date/search), across all pages: the scalable remedy
  // for a post-import flood. A dry_run first surfaces the exact count to confirm.
  const filterPayload = () => ({
    period_id: periodId,
    series: seriesFilter !== 'all' ? seriesFilter : null,
    date_from: dateFrom || null,
    date_to: dateTo || null,
    search: search || null,
  })

  const openBulk = async () => {
    setBulkOpen(true)
    setBulkCount(null)
    setBulkReason('')
    try {
      const res = await fetch('/api/bookkeeping/no-doc-required/bulk-missing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...filterPayload(), dry_run: true }),
      })
      const body = await res.json().catch(() => ({}))
      setBulkCount(res.ok ? (body.data?.count ?? 0) : 0)
    } catch {
      setBulkCount(0)
    }
  }

  const handleBulkConfirm = async () => {
    setBulkSubmitting(true)
    try {
      const res = await fetch('/api/bookkeeping/no-doc-required/bulk-missing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...filterPayload(), reason: bulkReason.trim() || null }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({
          title: t('no_doc_required_save_failed'),
          description: getErrorMessage(body, { statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      setBulkOpen(false)
      setBulkCount(null)
      setBulkReason('')
      selection.clear()
      toast({
        title: t('batch_no_doc_done_title'),
        description: t('batch_no_doc_done_description', { count: body.data?.exempted ?? 0 }),
      })
      await fetchNoDocRequired()
      await fetchEntries()
    } catch {
      toast({ title: t('no_doc_required_save_failed'), variant: 'destructive' })
    } finally {
      setBulkSubmitting(false)
    }
  }

  // The missing-underlag filter is applied SERVER-side (missing_underlag=true
  // in fetchEntries): the server's set spans all pages and includes reference
  // -aware document checks the client can't see. Re-filtering here against the
  // late-arriving attachmentCounts could hide rows the server included and
  // desync the visible rows from the returned count, so the fetched page is
  // rendered as-is.
  const filteredEntries = entries

  // Detail-pager context: the loaded page as rendered, written when the user
  // opens a verifikat. Server-paginated, so prev/next spans this page only.
  // The list's own address rides along for the verifikat's link back here.
  const rememberListContext = () => {
    const listQuery = writeVerifikatListQuery('', viewQuery).toString()
    writeListContext(listContextKey('bookkeeping', company?.id), {
      ids: filteredEntries.map((e) => e.id),
      href: listQuery ? `${LIST_PATH}?${listQuery}` : LIST_PATH,
    })
  }

  // Count of active dialog filters, shown as a badge on the Filtrera button so
  // the user can tell the list is scoped without opening the dialog. Sort order
  // is a view preference (always set), not a filter, so it is excluded.
  // Filters that live inside the Filtrera dialog. The fiscal-year scope is its
  // own control now, so it no longer counts toward the dialog badge (it would
  // otherwise always read "1" for the default year).
  const dialogFilterCount =
    (seriesFilter !== 'all' ? 1 : 0) +
    (dateFrom || dateTo ? 1 : 0) +
    (showMissingOnly ? 1 : 0) +
    // Hidden makulerade pairs count: the badge is the hint that rows are
    // hidden, which the list lacked when stornos vanished silently (#3149).
    (correctionView === 'hide' ? 1 : 0)
  // Year scope included: drives empty-state messaging + keeping the bar mounted.
  // The year is app-wide context, not a page filter.
  const activeFilterCount = dialogFilterCount

  // The search box says what the request it sends can find. With "Visa
  // saknade underlag" on, the list is read by an RPC that takes the text and
  // the voucher label only (lib/bookkeeping/missing-underlag.ts). With no
  // fiscal year on the request (all years, or the drafts view, which spans
  // them) the route reads no amount (isBoundedVerifikatScope).
  const searchReadsAmounts = listMode === 'committed' && isBoundedVerifikatScope({ periodId })
  const searchPlaceholder = showMissingOnly
    ? t('search_placeholder_missing')
    : searchReadsAmounts
      ? t('search_placeholder')
      : t('search_placeholder_all_years')
  const searchHint = showMissingOnly
    ? t('search_hint_missing')
    : searchReadsAmounts
      ? t('search_hint')
      : t('search_hint_all_years')

  // When any filter or search is active we keep the filter bar mounted even
  // with zero results, so the user can edit or clear their query. The pristine
  // "no entries yet" state below only applies to an untouched, empty ledger.
  const hasActiveFilters = Boolean(search) || activeFilterCount > 0


  // Change how many verifikat are shown per page. Resets to the first page and
  // persists the choice per company (same convention as the sort order).
  const handlePageSizeChange = (next: PageSizeChoice) => {
    setPageSizeChoice(next)
    setPage(0)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY_PREFIX + (company?.id ?? 'default'), next)
    }
  }

  const toggleDensity = () => {
    const next = !compact
    setCompact(next)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(DENSITY_STORAGE_KEY_PREFIX + (company?.id ?? 'default'), next ? 'compact' : 'comfortable')
    }
  }

  // Apply a sort stack, whether it came from a column header or the dialog
  // select. Resets to the first page and persists the choice per company.
  const applySort = (next: SortKey[]) => {
    setSortStack(next)
    setPage(0)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(
        SORT_STORAGE_KEY_PREFIX + (company?.id ?? 'default'),
        serializeSortStack(next),
      )
    }
  }

  // Plain click: single-key tri-state, replacing any stack: ascending ->
  // descending -> back to the default order. On the DATUM column descending
  // IS the default, so that column degenerates to a plain asc/desc toggle
  // instead of wasting the third click on a no-op.
  // Shift-click stacks (max 3 keys): adds the column as the next priority
  // (ascending), a second shift-click flips it, a third removes it again.
  const handleHeaderSort = (column: SortColumn, additive: boolean) => {
    if (additive) {
      const index = sortStack.findIndex((k) => k.column === column)
      if (index === -1) {
        if (sortStack.length >= MAX_SORT_KEYS) return
        applySort([...sortStack, { column, direction: 'asc' }])
      } else if (sortStack[index].direction === 'asc') {
        applySort(
          sortStack.map((k, i) => (i === index ? { column, direction: 'desc' as const } : k)),
        )
      } else {
        const next = sortStack.filter((_, i) => i !== index)
        applySort(next.length > 0 ? next : DEFAULT_SORT_STACK)
      }
      return
    }
    const solo = sortStack.length === 1 && sortStack[0].column === column ? sortStack[0] : null
    if (!solo) {
      applySort([{ column, direction: 'asc' }])
    } else if (solo.direction === 'asc') {
      applySort([{ column, direction: 'desc' }])
    } else if (sortStacksEqual(sortStack, DEFAULT_SORT_STACK)) {
      applySort([{ column, direction: 'asc' }])
    } else {
      applySort(DEFAULT_SORT_STACK)
    }
  }

  const clearAllFilters = () => {
    // A deep link's one-visit year scope goes with the filters it came with.
    setVisitScope(null)
    setSeriesFilter('all')
    setShowMissingOnly(false)
    setCorrectionView((v) => (v === 'hide' ? 'collapse' : v))
    setDateFrom('')
    setDateTo('')
    setDateFromInput('')
    setDateToInput('')
    setPage(0)
  }

  // Rows on this page the user can batch-mark "Inget underlag krävs".
  const eligibleEntries = canWrite ? filteredEntries.filter(isEligibleForExempt) : []
  // Page-scoped: the selection holds only eligible rows of this page, so a
  // search, a filter or an exemption that hides or disqualifies a row drops
  // it before the batch call can carry it.
  const selection = useBulkSelection(eligibleEntries.map((e) => e.id))
  const selectedIds = selection.selectedIds
  const toggleSelect = (id: string, extend?: boolean) => selection.toggle(id, extend)

  // Pristine, untouched ledger: nothing posted in ANY year, no drafts, no
  // search or dialog filters, and we're on the committed view. The fiscal-year
  // scope deliberately does NOT count here: every company has a period
  // selected by default, and requiring "no scope" made this state unreachable
  // (the empty current year fell through to "inga träffar" on brand-new
  // ledgers). ledgerHasAnyEntry must be an explicit false: while the
  // all-years probe is in flight we show the filtered-empty state, never a
  // flash of the start card. ONLY this genuinely-empty case may short-circuit
  // the whole component: every other empty state (a draft exists, or we're in
  // the drafts view) must fall through to the main render below so the
  // Verifikat/Utkast toggle stays reachable.
  if (!loading && entries.length === 0 && !loadFailed && !search && dialogFilterCount === 0 && ledgerHasAnyEntry === false && listMode === 'committed' && draftCount === 0) {
    if (pristineSlot) {
      return <>{pristineSlot}</>
    }
    return (
      <DataList className="stagger-enter">
        <DataListEmpty
          icon={<BookOpenIcon className="h-6 w-6" />}
          title={t('empty_title')}
          description={t('empty_description')}
        />
      </DataList>
    )
  }

  // Compact rows take the same 7px off every cell's top and bottom padding
  // (and the copy button's tap padding, below), so a row goes from 49px to
  // 31px and the cells keep their alignment.
  const cellPad = compact ? 'py-1' : undefined
  const controlCellPad = compact ? 'py-[2px]' : 'py-[9px]'

  return (
    <div className="space-y-4">
      {/* Control bar: view toggle + search + filters + active fiscal-year scope
          on one aligned row (wraps on narrow screens) rather than four stacked rows. */}
      <div className="flex flex-wrap items-center gap-2">
        {/* Verifikat vs Utkast. Drafts live in their own view with a count badge so
            they don't sink to the last page of the committed list. */}
        <SegmentedControl
          value={listMode}
          onChange={switchMode}
          options={[
            { value: 'committed', label: t('mode_vouchers') },
            { value: 'drafts', label: t('mode_drafts'), count: draftCount },
          ]}
        />
        <Dialog open={filterOpen} onOpenChange={setFilterOpen}>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size="toolbar"
              className="gap-2 shrink-0"
              aria-label={
                dialogFilterCount > 0
                  ? t('filter_with_count', { count: dialogFilterCount })
                  : t('filter')
              }
            >
              <AdjustmentsHorizontalIcon className="h-3.5 w-3.5" />
              {t('filter')}
              {dialogFilterCount > 0 && (
                <Badge
                  variant="secondary"
                  className="h-4 min-w-4 justify-center px-1 text-xs tabular-nums"
                >
                  {dialogFilterCount}
                </Badge>
              )}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t('filter_dialog_title')}</DialogTitle>
            </DialogHeader>

            <div className="space-y-4">
              {/* Sortering */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('filter_section_sort')}</Label>
                {/* The select models a SINGLE sort key: it shows the primary
                    key of the stack, and picking an option resets the whole
                    stack to that one key. Stacking lives on the headers. */}
                <Select
                  value={`${sortStack[0].column}_${sortStack[0].direction}`}
                  onValueChange={(v) => {
                    const parsed = parseSortStack(v)
                    if (parsed) applySort(parsed)
                  }}
                >
                  <SelectTrigger className="h-9 w-full text-sm">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="date_desc">{t('sort_date_desc')}</SelectItem>
                    <SelectItem value="date_asc">{t('sort_date_asc')}</SelectItem>
                    <SelectItem value="voucher_asc">{t('sort_voucher_asc')}</SelectItem>
                    <SelectItem value="voucher_desc">{t('sort_voucher_desc')}</SelectItem>
                    <SelectItem value="total_desc">{t('sort_total_desc')}</SelectItem>
                    <SelectItem value="total_asc">{t('sort_total_asc')}</SelectItem>
                    <SelectItem value="description_asc">{t('sort_description_asc')}</SelectItem>
                    <SelectItem value="description_desc">{t('sort_description_desc')}</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {/* Verifikationsserie */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('filter_section_series')}</Label>
                <Select value={seriesFilter} onValueChange={(v) => { setSeriesFilter(v); setPage(0) }}>
                  <SelectTrigger className="h-9 w-full text-sm" aria-label={t('filter_section_series')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Alla serier</SelectItem>
                    {/* The letter and its name, as the series picker in
                        Nytt verifikat shows them; a letter without a name
                        stands alone. */}
                    {seriesLetters.map((letter) => {
                      const name = voucherSeriesLabel(letter, seriesLabels)
                      return (
                        <SelectItem key={letter} value={letter}>
                          <span className="font-mono">{letter}</span>
                          {name && <span className="ml-2 text-muted-foreground">{name}</span>}
                        </SelectItem>
                      )
                    })}
                  </SelectContent>
                </Select>
              </div>

              {/* Datumintervall */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('filter_section_date')}</Label>
                <div className="flex items-center gap-2">
                  <Input
                    type="text"
                    placeholder={t('date_from_placeholder')}
                    value={dateFromInput}
                    onChange={(e) => setDateFromInput(e.target.value)}
                    onBlur={applyDateFilter}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        applyDateFilter()
                      }
                    }}
                    className="h-9 flex-1 text-sm"
                  />
                  <span className="text-sm text-muted-foreground">-</span>
                  <Input
                    type="text"
                    placeholder={t('date_to_placeholder')}
                    value={dateToInput}
                    onChange={(e) => setDateToInput(e.target.value)}
                    onBlur={applyDateFilter}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault()
                        applyDateFilter()
                      }
                    }}
                    className="h-9 flex-1 text-sm"
                  />
                  {(dateFrom || dateTo) && (
                    <button
                      type="button"
                      onClick={() => { setDateFrom(''); setDateTo(''); setDateFromInput(''); setDateToInput(''); setPage(0) }}
                      className="p-1 rounded-sm hover:bg-secondary/60 text-muted-foreground shrink-0"
                      title={t('clear_date_filter')}
                      aria-label={t('clear_date_filter')}
                    >
                      <XMarkIcon className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </div>

              {/* Visa saknade underlag */}
              <div className="flex items-center gap-2">
                {/* Committed view only: the predicate is posted-only, so in the
                    drafts view the toggle would just mislabel the draft count. */}
                <Switch
                  id="missing-attachments"
                  checked={showMissingOnly}
                  disabled={listMode === 'drafts'}
                  onCheckedChange={(on) => {
                    setShowMissingOnly(on)
                    setMissingCount(null)
                    setPage(0)
                  }}
                />
                <Label htmlFor="missing-attachments" className="text-sm cursor-pointer">
                  {t('show_missing')}
                </Label>
                {showMissingOnly && missingCount !== null && (
                  <Badge variant="secondary" className="text-xs tabular-nums">
                    {missingCount}
                  </Badge>
                )}
              </div>

              {/* Storno and Omförd rows. The old switch ("Visa storno- och
                  rättade poster") only folded correction groups, so with it
                  off a pure storno pair still showed (PH 231). Three named
                  states instead: every option says what it hides. */}
              <div className="space-y-2">
                <Label className="text-sm font-medium">{t('filter_section_corrections')}</Label>
                <Select
                  value={correctionView}
                  disabled={listMode === 'drafts'}
                  onValueChange={(v) => {
                    if (v === 'all' || v === 'collapse' || v === 'hide') {
                      setCorrectionView(v)
                      setPage(0)
                    }
                  }}
                >
                  <SelectTrigger className="h-9 w-full text-sm" aria-label={t('filter_section_corrections')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="collapse">{t('corrections_collapse')}</SelectItem>
                    <SelectItem value="hide">{t('corrections_hide')}</SelectItem>
                    <SelectItem value="all">{t('corrections_all')}</SelectItem>
                  </SelectContent>
                </Select>
                {correctionView === 'hide' && (
                  <p className="text-xs text-muted-foreground">{t('corrections_hide_hint')}</p>
                )}
              </div>
            </div>

            <DialogFooter className="sm:justify-between">
              <Button
                variant="ghost"
                onClick={clearAllFilters}
                disabled={activeFilterCount === 0}
              >
                {t('filter_clear_all')}
              </Button>
              <DialogClose asChild>
                <Button variant="outline">{t('filter_done')}</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {/* Search sits at the right end, after the view and the filter (V7 list
            toolbars); the density toggle follows it as the last thing. Below
            640px the shared class lets the box share a row from 160px, which
            leaves its text 100px: enough for "Sök verifikat", not for a
            placeholder that names what the box finds. Here it keeps the
            240px it has on a wide screen, and takes a row of its own when
            the first has no room for that, as it already did on a phone. */}
        <div className={cn('relative', TOOLBAR_SEARCH_END_CLASS, 'min-w-60')}>
          <ToolbarSearch
            type="text"
            inputMode="search"
            placeholder={searchPlaceholder}
            aria-label={searchHint}
            title={searchHint}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            containerClassName="min-w-0 max-w-none"
            className={cn('pr-7', loading && search && 'pr-12')}
          />
          {loading && search && (
            // Search is server-side and can take a moment on a large ledger;
            // without this the only signal was the list dimming.
            <SpinnerIcon
              className="absolute right-7 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          )}
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-sm hover:bg-secondary/60 text-muted-foreground"
              title={t('clear_search')}
              aria-label={t('clear_search')}
            >
              <XMarkIcon className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        {/* Row density: comfortable vs compact, persisted per company. A toggle
            (aria-pressed) rather than a mode buried in the filter dialog. It
            carries its name like the Filter button beside it: as a bare icon
            the only way to learn what it did was to press it, and people
            pressed it back and forth. On is a check, not the tint alone. A
            phone keeps the icon only; the toolbar has no room there. */}
        <Button
          variant="outline"
          size="toolbar"
          onClick={toggleDensity}
          aria-pressed={compact}
          aria-label={t('density_compact')}
          className={cn('gap-2 shrink-0', compact ? 'bg-secondary text-foreground' : 'text-muted-foreground')}
        >
          {compact ? <CheckIcon className="h-3.5 w-3.5" /> : <QueueListIcon className="h-3.5 w-3.5" />}
          <span className="hidden sm:inline">{t('density_compact')}</span>
        </Button>
      </div>

      {/* Holes in this year's voucher numbering: one attn line with the
          Förklara action for unexplained gaps, explained ones behind a quiet
          disclosure. The surface that satisfies the BFNAR 2013:2
          documentation requirement the bokslut preflight checks. Scoped to
          the selected räkenskapsår, or the current one under "Alla
          räkenskapsår"; hidden on the drafts view and when the series is
          unbroken. */}
      {/* A failed refresh keeps the rows and takes the page's one attention
          line, in place of the gap notice. */}
      {loadFailed && filteredEntries.length > 0 ? (
        <AttnLine action={{ label: tCommon('retry'), onClick: () => void fetchEntries() }}>
          {tCommon('refresh_failed')}
        </AttnLine>
      ) : listMode === 'committed' && periodHydrated && (
        <VoucherGapNotice
          periodId={
            periodId ??
            resolveCurrentPeriodId(fiscalScope.periods, todayIsoStockholm())
          }
          series={seriesFilter !== 'all' ? seriesFilter : null}
          refreshToken={refreshToken}
          onUnexplainedCountChange={setUnexplainedGapCount}
        />
      )}

      {loading && !hasLoaded ? (
        <LateReveal>
          <DataList className="stagger-enter">
            <DataListLoading />
          </DataList>
        </LateReveal>
      ) : loadFailed && filteredEntries.length === 0 ? (
        // Failed load with nothing on screen: an explicit error state with a
        // retry, never the "empty ledger" card. The toolbar above stays
        // mounted so the sort/filter that caused the failure can be changed.
        <div className={cn(loading && 'opacity-60')} aria-busy={loading || undefined}>
          <LoadError
            title={t('load_failed_title')}
            description={t('load_failed_description')}
            onRetry={() => void fetchEntries()}
          />
        </div>
      ) : filteredEntries.length === 0 && listMode === 'committed' && hasActiveFilters ? (
        // No hits for the search or filters: one muted line where the rows
        // would be, with the quiet way back (convention 17).
        <p
          className={cn('px-1 py-3 text-[13px] text-muted-foreground', loading && 'opacity-60')}
          aria-busy={loading || undefined}
        >
          {t('no_results_line')}{' '}
          <button
            type="button"
            className={QUIET_LINK_CLASS}
            onClick={() => {
              setSearchInput('')
              setSearch('')
              clearAllFilters()
            }}
          >
            {t('filter_clear_all')}
          </button>
        </p>
      ) : filteredEntries.length === 0 ? (
        // Empty placeholder, scoped to the situation: an empty drafts view, or
        // a committed view with no posted entries yet (but drafts exist, hence
        // we got here, not the pristine early return above). Carries the same
        // busy treatment as the table branch.
        <DataList
          className={cn('stagger-enter', loading && 'opacity-60')}
          aria-busy={loading || undefined}
        >
          <DataListEmpty
            icon={<BookOpenIcon className="h-6 w-6" />}
            title={listMode === 'drafts' ? t('empty_drafts_title') : t('empty_title')}
            description={listMode === 'drafts' ? t('empty_drafts_description') : t('empty_description')}
          />
        </DataList>
      ) : (
      <div
        aria-busy={loading || undefined}
        className={cn(
          'transition-opacity duration-150',
          loading && 'pointer-events-none opacity-60',
        )}
      >
        {/* Bulkbar (concept): hidden until at least one verifikat is
            selected via the hover checkboxes, then it pops in with the
            count and the batch actions. Select-all and the filter-scoped
            bulk mark live inside it as quiet actions. */}
        <BulkSelectionBar
          selection={selection}
          selectableCount={eligibleEntries.length}
          countLabel={t('bulkbar_selected', { count: selectedIds.size })}
          selectAllLabel={t('batch_select_all', { count: eligibleEntries.length })}
          clearLabel={t('batch_clear_selection')}
          busy={batchSubmitting}
        >
          <Input
            value={batchReason}
            onChange={(e) => setBatchReason(e.target.value)}
            placeholder={t('no_doc_required_reason_placeholder')}
            list="batch-no-doc-suggestions"
            maxLength={200}
            className="h-8 w-56 text-xs"
            disabled={batchSubmitting}
          />
          <datalist id="batch-no-doc-suggestions">
            <option value={t('no_doc_required_suggestion_bank_fee')} />
            <option value={t('no_doc_required_suggestion_interest')} />
            <option value={t('no_doc_required_suggestion_internal_transfer')} />
            <option value={t('no_doc_required_suggestion_tax_payment')} />
            <option value={t('no_doc_required_suggestion_salary')} />
            <option value={t('no_doc_required_suggestion_archived_elsewhere')} />
          </datalist>
          <Button onClick={handleBatchExempt} loading={batchSubmitting}>
            {t('batch_mark_no_doc')}
          </Button>
          {/* Filter-scoped: mark every missing-doc verifikat matching the
              active filters across all pages: scales to a post-import flood. */}
          <button type="button" className={QUIET_LINK_CLASS} onClick={openBulk}>
            {t('batch_mark_all_missing')}
          </button>
        </BulkSelectionBar>

        {/* The page's one page-domain attn slot (convention 6), in priority
            order: unexplained voucher gaps (VoucherGapNotice above) win,
            then imported verifikat missing underlag, then the "Ångra import"
            pointer (issue #1883). The missing-underlag line opens the
            existing "Underlag till importerade verifikat" import, which
            attaches a folder of receipts by voucher number; the import
            history stays one quiet link away in the same line. Only
            source_type 'import' is an SIE marker: 'opening_balance' is also
            written by year-end closing and the manual IB flows, which have
            nothing to undo here. */}
        {unexplainedGapCount === 0 && importedMissingCount > 0 ? (
          <AttnLine
            className="px-1 pb-2"
            action={{ label: t('import_missing_attn_action'), href: '/import?mode=underlag' }}
            trailing={
              <>
                <span className="text-muted-foreground print:hidden"> · </span>
                <IntentLink href="/import?history=sie" className={cn(QUIET_LINK_CLASS, 'print:hidden')}>
                  {t('import_attn_action')}
                </IntentLink>
              </>
            }
          >
            {wholeScopeLoaded
              ? t('import_missing_attn', { count: importedMissingCount })
              : t('import_missing_attn_page', { count: importedMissingCount })}
          </AttnLine>
        ) : (
          unexplainedGapCount === 0 &&
          entries.some((e) => e.source_type === 'import') && (
            <AttnLine
              className="px-1 pb-2"
              action={{ label: t('import_attn_action'), href: '/import?history=sie' }}
            >
              {t('import_attn')}
            </AttnLine>
          )
        )}

        <div className="-mx-2 overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={cn(TH_CLASS, 'w-[26px] !pl-1')} aria-hidden="true"></th>
                <SortableTh
                  label={t('th_voucher')}
                  {...sortHeadOf(sortStack, 'voucher')}
                  onSort={(e) => handleHeaderSort('voucher', e.shiftKey)}
                />
                <SortableTh
                  label={t('th_date')}
                  {...sortHeadOf(sortStack, 'date')}
                  onSort={(e) => handleHeaderSort('date', e.shiftKey)}
                  className="hidden sm:table-cell"
                />
                <SortableTh
                  label={t('th_description')}
                  {...sortHeadOf(sortStack, 'description')}
                  onSort={(e) => handleHeaderSort('description', e.shiftKey)}
                  className="w-full"
                />
                <SortableTh
                  label={t('th_amount')}
                  {...sortHeadOf(sortStack, 'total')}
                  onSort={(e) => handleHeaderSort('total', e.shiftKey)}
                  className="text-right"
                  align="right"
                />
                <th className={TH_CLASS} aria-hidden="true"></th>
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {filteredEntries.map((entry) => {
                const isExpanded = expandedId === entry.id
                const lines = (entry.lines || []) as JournalEntryLine[]
                // The money line when the verifikat records one payment, else
                // the omslutning (sum of the debit side); see
                // lib/bookkeeping/voucher-display-amount.ts. The amount sort
                // orders by its SQL mirror (the display_amount column).
                const displayAmount = voucherDisplayAmount(entry, extraMoneyAccounts)
                const selectable = canWrite && isEligibleForExempt(entry)
                // A makulerad verifikat should read as struck out, the way
                // Grundbok already renders it. Applied per data cell rather
                // than on the row: text-decoration propagates to descendants
                // and a child cannot opt out, so striking the <tr> would draw
                // a line through the row's action controls too.
                //
                // No opacity on the row: the strike plus the Makulerad chip
                // already carry the state, and dimming muted-foreground text
                // pushes the date column under the AA contrast floor.
                const struckCell = entry.status === 'reversed' ? 'line-through' : undefined

                return (
                  <Fragment key={entry.id}>
                    <tr
                      className={cn(
                        'group cursor-pointer transition-colors duration-150',
                        isExpanded ? 'bg-secondary/25' : 'hover:bg-secondary/35',
                        selectedIds.has(entry.id) && 'bg-secondary/40',
                      )}
                      role="button"
                      tabIndex={0}
                      aria-expanded={isExpanded}
                      onClick={() => toggleExpand(entry.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          toggleExpand(entry.id)
                        }
                      }}
                    >
                      {/* Hover-revealed selection checkbox (concept .cb) */}
                      <td
                        className={cn(TD_CLASS, 'w-[26px] !pl-1 select-none', controlCellPad)}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {selectable && (
                          <RowSelectCheckbox
                            checked={selectedIds.has(entry.id)}
                            dense={compact}
                            onClick={(e) => {
                              shiftHeld.current = e.shiftKey
                            }}
                            onCheckedChange={() => toggleSelect(entry.id, shiftHeld.current)}
                            aria-label={t('batch_select_row')}
                          />
                        )}
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap', cellPad)}>
                        <span className="inline-flex items-center gap-1">
                          <IntentLink
                            href={`/bookkeeping/${entry.id}`}
                            className={cn(
                              'font-mono text-[13px] tabular-nums hover:underline',
                              struckCell,
                            )}
                            onClick={(e) => {
                              e.stopPropagation()
                              rememberListContext()
                            }}
                            // The row's Enter/Space handler calls
                            // preventDefault(), so without this the voucher
                            // link expands the row instead of opening it.
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            {formatVoucher(entry)}
                          </IntentLink>
                          <OpenInNewTab href={`/bookkeeping/${entry.id}`} />
                        </span>
                      </td>
                      <td className={cn(TD_CLASS, 'hidden sm:table-cell whitespace-nowrap date-figures text-muted-foreground', struckCell, cellPad)}>
                        {formatDate(entry.entry_date)}
                      </td>
                      {/* overflow-hidden: see #2003, the shrink-0 status
                          chips cannot truncate and would paint over Belopp. */}
                      <td className={cn(TD_CLASS, 'max-w-0 w-full overflow-hidden', cellPad)}>
                        <span className="flex min-w-0 items-center gap-2">
                          <span className={cn('truncate', struckCell)}>{entry.description}</span>
                          {entry.out_of_period && (
                            <Badge
                              variant="outline"
                              className="text-xs font-normal shrink-0"
                              title={t('out_of_period_tooltip')}
                            >
                              {t('out_of_period_label')}
                            </Badge>
                          )}
                          {(entry.status === 'reversed' || entry.status === 'draft' || entry.source_type === 'storno' || entry.source_type === 'correction') && (
                            <JournalEntryStatusBadge entry={entry} showStatus={entry.status === 'reversed' || entry.status === 'draft'} />
                          )}
                          {rattelseFlags.has(entry.id) && (
                            <Badge
                              variant="outline"
                              className="text-xs font-normal shrink-0"
                              title={t('rattelse_badge_tooltip')}
                            >
                              {t('rattelse_badge')}
                            </Badge>
                          )}
                        </span>
                      </td>
                      <td
                        className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums rr-mask', struckCell, cellPad)}
                        title={
                          displayAmount.amount !== displayAmount.debitTotal
                            ? t('amount_money_tooltip', {
                                total: formatCurrency(displayAmount.debitTotal, 'SEK', { minimumFractionDigits: 2 }),
                              })
                            : undefined
                        }
                      >
                        {formatAmount(displayAmount.amount)}
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right', controlCellPad)}>
                        <span className="inline-flex items-center justify-end gap-2">
                          {/* The internal note, readable on hover; the row's
                              foldout shows it in full (accounted#183). */}
                          {entry.notes?.trim() && (
                            <span
                              role="img"
                              aria-label={t('note_indicator_aria')}
                              title={entry.notes}
                              className="inline-flex text-muted-foreground"
                            >
                              <ChatBubbleLeftIcon className="h-3.5 w-3.5" />
                            </span>
                          )}
                          {attachmentCounts[entry.id] ? (
                            <button
                              type="button"
                              aria-label={t('view_attachments')}
                              title={t('attachment_count_tooltip', { count: attachmentCounts[entry.id] })}
                              onClick={(e) => {
                                e.stopPropagation()
                                setPreviewEntryId(entry.id)
                              }}
                              className="inline-flex items-center gap-0.5 rounded-sm text-muted-foreground transition-colors duration-150 hover:text-foreground"
                            >
                              <PaperClipIcon className="h-3.5 w-3.5" />
                              <span className="text-xs tabular-nums">{attachmentCounts[entry.id]}</span>
                            </button>
                          ) : (
                            attachmentCountsLoaded && NEEDS_ATTACHMENT.has(entry.source_type) && entry.status === 'posted' && !invoiceReferenced.has(entry.id) && (
                              noDocRequired.has(entry.id) ? (
                                <span title={t('no_doc_required_indicator_tooltip')}>
                                  <NoSymbolIcon className="h-3.5 w-3.5 text-muted-foreground" />
                                </span>
                              ) : (
                                // Imported rows are counted once in the line
                                // above the table, not chipped row by row.
                                entry.source_type !== 'import' && (
                                  <Badge variant="warning" title={t('missing_attachment_tooltip')}>
                                    {t('missing_attachment_chip')}
                                  </Badge>
                                )
                              )
                            )
                          )}
                          {entry.status === 'draft' && (
                            <Button
                              variant="outline"
                              disabled={!canWrite}
                              loading={committingId === entry.id}
                              title={!canWrite ? t('read_only_tooltip') : undefined}
                              onClick={(e) => {
                                e.stopPropagation()
                                openCommitConfirm(entry)
                              }}
                            >
                              {t('post')}
                            </Button>
                          )}
                          {canWrite && (
                            <button
                              type="button"
                              aria-label={t('copy_voucher_tooltip')}
                              title={t('copy_voucher_tooltip')}
                              onClick={(e) => {
                                e.stopPropagation()
                                router.push(`/bookkeeping?copy_from=${entry.id}`)
                              }}
                              className={cn(
                                // p-2 grows the tap target to 30px without
                                // changing row height (the row is ~40px from
                                // the description cell).
                                'inline-flex items-center rounded-sm p-2 text-muted-foreground hover:text-foreground',
                                // Compact rows: at 30px the button would set
                                // the row height on its own.
                                compact && 'p-1',
                                // Quiet at rest; coarse pointers (phones and
                                // tablets) keep the icon visible, since the
                                // table has no mobile card to fall back on.
                                HOVER_REVEAL_CLASS,
                              )}
                            >
                              <Square2StackIcon className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <ChevronRightIcon
                            className={cn(
                              'h-3.5 w-3.5 text-muted-foreground transition-[transform,opacity] duration-150',
                              isExpanded
                                ? 'rotate-90 opacity-100'
                                : 'opacity-0 group-hover:opacity-100',
                            )}
                          />
                        </span>
                      </td>
                    </tr>
                    {isExpanded && (
                      <tr data-no-stagger>
                        <td colSpan={6} className="border-b-hairline p-0">
                          <RowFoldout>
                            <div className="px-1 pb-6 pt-1 sm:pl-9 sm:pr-4">
                              {lines.length === 0 ? (
                                <p className="text-sm text-muted-foreground py-2">{t('no_lines')}</p>
                              ) : (
                                <VoucherLinesTable
                                  aria-label={formatVoucher(entry)}
                                  showTotals
                                  redundantTexts={[entry.description]}
                                  lines={voucherLineViews(
                                    lines.slice().sort((a, b) => a.sort_order - b.sort_order),
                                  )}
                                />
                              )}

                              {entry.notes && (
                                <p className="mt-3 text-xs text-muted-foreground italic">
                                  {entry.notes}
                                </p>
                              )}

                              {/* The händelse this verifikat books or settles: the
                                  mirror of "Visa verifikat" on the transactions page. */}
                              <JournalEntryTransactionLinks journalEntryId={entry.id} />

                              <JournalEntryAttachments
                                journalEntryId={entry.id}
                                onCountChange={(c) => handleAttachmentCountChange(entry.id, c)}
                              />

                              {entry.status === 'posted' && NEEDS_ATTACHMENT.has(entry.source_type) && (
                                <NoDocRequiredToggle
                                  entryId={entry.id}
                                  initialExempt={noDocRequired.has(entry.id)}
                                  initialReason={noDocRequired.get(entry.id) ?? null}
                                  canWrite={canWrite}
                                  onChange={(exempted, reason) => {
                                    setNoDocRequired((prev) => {
                                      const next = new Map(prev)
                                      if (exempted) next.set(entry.id, reason ?? null)
                                      else next.delete(entry.id)
                                      return next
                                    })
                                    // Server-side saknade-underlag filter on: an
                                    // exempted row leaves the filtered set, so
                                    // refetch in place (keeps expansion state
                                    // semantics of a background refresh). The
                                    // toggle reports only once the mark and its
                                    // reason are saved, so the row cannot leave
                                    // before the reason was entered (crm#1003).
                                    if (exempted && showMissingOnly) {
                                      void fetchEntries({ preserveSelection: true })
                                    }
                                  }}
                                />
                              )}

                              {/* Quiet link actions (concept vact); posting keeps
                                  its pill because it changes legal state. */}
                              <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
                                {entry.status === 'draft' && (
                                  <Button
                                    onClick={() => openCommitConfirm(entry)}
                                    disabled={!canWrite}
                                    loading={canWrite && committingId === entry.id}
                                    title={!canWrite ? t('read_only_tooltip') : undefined}
                                  >
                                    {!canWrite && <LockClosedIcon className="h-4 w-4" />}
                                    {t('post')}
                                  </Button>
                                )}
                                <IntentLink
                                  href={`/bookkeeping/${entry.id}`}
                                  className={QUIET_LINK_CLASS}
                                  onClick={rememberListContext}
                                >
                                  {t('show_details')}
                                </IntentLink>
                                {canWrite && entry.status === 'posted' && entry.source_type !== 'storno' && entry.source_type !== 'correction' && (
                                  <button type="button" className={QUIET_LINK_CLASS} onClick={() => void startVoucherAction(entry, 'correct')}>
                                    {t('create_correction')}
                                  </button>
                                )}
                                {canWrite && entry.status === 'posted' && entry.source_type !== 'storno' && entry.source_type !== 'correction' && (
                                  <button type="button" className={QUIET_LINK_CLASS} onClick={() => void startVoucherAction(entry, 'reverse')}>
                                    {t('reverse_action')}
                                  </button>
                                )}
                                {canWrite && (
                                  <button type="button" className={QUIET_LINK_CLASS} onClick={() => router.push(`/bookkeeping?copy_from=${entry.id}`)}>
                                    {t('copy')}
                                  </button>
                                )}
                              </div>
                            </div>
                          </RowFoldout>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>
      )}

      {/* Filter-scoped bulk "Inget underlag krävs" confirmation */}
      <Dialog
        open={bulkOpen}
        onOpenChange={(o) => {
          if (bulkSubmitting) return
          setBulkOpen(o)
          if (!o) {
            setBulkCount(null)
            setBulkReason('')
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('bulk_mark_title')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-sm">
            {bulkCount === null ? (
              <div className="flex items-center gap-2 text-muted-foreground">
                <SpinnerIcon className="h-4 w-4 animate-spin" />
                {t('bulk_mark_counting')}
              </div>
            ) : bulkCount === 0 ? (
              <p className="text-muted-foreground">{t('bulk_mark_none')}</p>
            ) : (
              <>
                <p>{t('bulk_mark_body', { count: bulkCount })}</p>
                <div className="space-y-1">
                  <Label className="text-xs text-muted-foreground">{t('no_doc_required_reason_add')}</Label>
                  <Input
                    value={bulkReason}
                    onChange={(e) => setBulkReason(e.target.value)}
                    placeholder={t('no_doc_required_reason_placeholder')}
                    list="bulk-no-doc-suggestions"
                    maxLength={200}
                    className="h-8 text-xs"
                    disabled={bulkSubmitting}
                  />
                  <datalist id="bulk-no-doc-suggestions">
                    <option value={t('no_doc_required_suggestion_bank_fee')} />
                    <option value={t('no_doc_required_suggestion_interest')} />
                    <option value={t('no_doc_required_suggestion_internal_transfer')} />
                    <option value={t('no_doc_required_suggestion_tax_payment')} />
                    <option value={t('no_doc_required_suggestion_salary')} />
                    <option value={t('no_doc_required_suggestion_archived_elsewhere')} />
                  </datalist>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkOpen(false)} disabled={bulkSubmitting}>
              {t('bulk_cancel')}
            </Button>
            <Button onClick={handleBulkConfirm} disabled={!bulkCount} loading={bulkSubmitting}>
              {t('bulk_mark_confirm', { count: bulkCount ?? 0 })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Correction dialog */}
      {correctionEntry && (
        <CorrectionEntryDialog
          entry={correctionEntry}
          open={!!correctionEntry}
          onOpenChange={(open) => { if (!open) setCorrectionEntry(null) }}
          onCorrected={() => { setCorrectionEntry(null); fetchEntries() }}
        />
      )}

      {/* Confirm-before-posting for drafts (convention 10): describes the
          outcome ("Bokförs som A-218 ...") before the commit runs. */}
      {commitTarget && (
        <ConfirmDialog
          open={!!commitTarget}
          onOpenChange={(open) => {
            if (!open && committingId === null) setCommitTarget(null)
          }}
          title={t('confirm_post_title')}
          description={
            commitVoucherPreview
              ? t('confirm_post_description', {
                  voucher: commitVoucherPreview,
                  description: commitTarget.description || '',
                  amount: formatCurrency(voucherDisplayAmount(commitTarget, extraMoneyAccounts).amount),
                })
              : t('confirm_post_description_generic', {
                  description: commitTarget.description || '',
                })
          }
          confirmLabel={t('post')}
          onConfirm={async () => {
            await handleCommit(commitTarget.id)
            setCommitTarget(null)
          }}
        />
      )}

      {ownedAction && (
        <OwnedVoucherActionDialog
          owner={ownedAction.owner}
          intent={ownedAction.intent}
          open
          onOpenChange={(open) => {
            if (!open) setOwnedAction(null)
          }}
          onProceed={() =>
            ownedAction.intent === 'reverse'
              ? setReverseEntryTarget(ownedAction.entry)
              : setCorrectionEntry(ownedAction.entry)
          }
        />
      )}

      {/* Reverse (storno) confirmation dialog */}
      {reverseEntryTarget && (
        <ConfirmationDialog
          open={!!reverseEntryTarget}
          onOpenChange={(open) => { if (!open && !isReversing) setReverseEntryTarget(null) }}
          onConfirm={handleReverse}
          isSubmitting={isReversing}
          title={t('reverse_confirm_title')}
          warningText={t('reverse_warning')}
          confirmLabel={t('reverse_confirm_label')}
        >
          <div className="space-y-1 text-sm">
            <p className="font-medium">{t('reverse_dialog_heading', { voucher: formatVoucher(reverseEntryTarget) })}</p>
            <p className="text-muted-foreground">{t('reverse_dialog_body')}</p>
          </div>
        </ConfirmationDialog>
      )}

      {/* Booking-time voucher warnings on a draft's commit */}
      {commitWarningsDialog}

      {/* Attachment preview sheet */}
      <AttachmentPreviewSheet
        entryId={previewEntryId}
        open={previewEntryId !== null}
        onOpenChange={(open) => { if (!open) setPreviewEntryId(null) }}
      />

      {/* Pagination + page-size selector. Shown when the result set spans more
          than one page at the default size, OR when a non-default page size
          ('all' included) is active, so a user who narrowed the list below the
          default can always switch the size back. Hidden for an empty result. */}
      {count > 0 && (count > PAGE_SIZE_OPTIONS[0] || pageSizeChoice !== '20') && (
        <div className="flex flex-col gap-3 pt-2 sm:flex-row sm:items-center sm:justify-between">
          {/* Page size + result range */}
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Label htmlFor="journal-page-size" className="text-xs font-normal shrink-0">
              {t('page_size_label')}
            </Label>
            <Select value={pageSizeChoice} onValueChange={(v) => handlePageSizeChange(v as PageSizeChoice)}>
              <SelectTrigger id="journal-page-size" className="h-8 w-[88px] text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAGE_SIZE_OPTIONS.map((n) => (
                  <SelectItem key={n} value={String(n)} className="text-xs tabular-nums">
                    {n}
                  </SelectItem>
                ))}
                <SelectItem value="all" className="text-xs">{t('page_size_all')}</SelectItem>
              </SelectContent>
            </Select>
            <span className="tabular-nums whitespace-nowrap">
              {/* "Alla" says all only when every counted row is on screen;
                  otherwise it states the range it actually holds. */}
              {showingAll && entries.length >= count
                ? t('showing_all', { total: count })
                : showingAll
                ? t('showing_range', { from: entries.length === 0 ? 0 : 1, to: entries.length, total: count })
                : t('showing_range', {
                    from: count === 0 ? 0 : page * pageSize + 1,
                    to: Math.min((page + 1) * pageSize, count),
                    total: count,
                  })}
            </span>
          </div>

          {/* Page navigation: hidden when showing all or when everything fits on one page */}
          {!showingAll && count > pageSize && (
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="icon"
                disabled={page === 0}
                onClick={() => setPage(0)}
                aria-label={t('first_page')}
                title={t('first_page')}
              >
                <ChevronDoubleLeftIcon className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
                aria-label={t('previous')}
                title={t('previous')}
              >
                <ChevronLeftIcon className="h-4 w-4" />
              </Button>
              <span className="px-2 text-xs text-muted-foreground tabular-nums self-center whitespace-nowrap">
                {t('page_of', { page: page + 1, total: Math.ceil(count / pageSize) })}
              </span>
              <Button
                variant="outline"
                size="icon"
                disabled={(page + 1) * pageSize >= count}
                onClick={() => setPage(page + 1)}
                aria-label={t('next')}
                title={t('next')}
              >
                <ChevronRightIcon className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                disabled={(page + 1) * pageSize >= count}
                onClick={() => setPage(Math.ceil(count / pageSize) - 1)}
                aria-label={t('last_page')}
                title={t('last_page')}
              >
                <ChevronDoubleRightIcon className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
