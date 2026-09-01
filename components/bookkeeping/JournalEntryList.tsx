'use client'

import { Fragment, useState, useEffect, useCallback, useRef, type ReactNode } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  DataList,
  DataListEmpty,
  DataListLoading,
} from '@/components/ui/data-list'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogFooter,
  DialogClose,
} from '@/components/ui/dialog'
import {
  STORAGE_KEY_PREFIX as FISCAL_YEAR_STORAGE_KEY_PREFIX,
  ALL_YEARS_VALUE as FISCAL_YEAR_ALL_VALUE,
} from '@/components/common/FiscalYearSelector'
import { FyPicker } from '@/components/common/FyPicker'
import { AttnLine } from '@/components/ui/attn-line'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { OpenInNewTab } from '@/components/ui/open-in-new-tab'
import {
  TH_CLASS,
  TD_CLASS,
  VTH_CLASS,
  VTD_CLASS,
  QUIET_LINK_CLASS,
  CHECKBOX_REVEAL_CLASS,
  RowFoldout,
} from '@/components/ui/dry-table'
import { ArrowDown, ArrowUp, ArrowUpDown, ChevronRight, ChevronLeft, ChevronsLeft, ChevronsRight, Copy, Paperclip, CircleSlash, Loader2, BookOpen, X, Lock, Search, SlidersHorizontal, RotateCcw } from 'lucide-react'
import { cn, formatDate, formatCurrency } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { resolveCurrentPeriodId } from '@/lib/bookkeeping/suggest-fiscal-period'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import { Input } from '@/components/ui/input'
import { AccountNumber } from '@/components/ui/account-number'
import { getAccountDescription } from '@/lib/bookkeeping/account-descriptions'
import { useBasReference } from '@/lib/bookkeeping/use-bas-reference'
import JournalEntryAttachments from '@/components/bookkeeping/JournalEntryAttachments'
import NoDocRequiredToggle from '@/components/bookkeeping/NoDocRequiredToggle'
import CorrectionEntryDialog from '@/components/bookkeeping/CorrectionEntryDialog'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import JournalEntryStatusBadge from '@/components/bookkeeping/JournalEntryStatusBadge'
import AttachmentPreviewSheet from '@/components/bookkeeping/AttachmentPreviewSheet'
import { useToast } from '@/components/ui/use-toast'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import { listContextKey, writeListContext } from '@/lib/navigation/list-context'
import { NEEDS_DOC_SOURCE_TYPES } from '@/lib/worklist/types'
import type { JournalEntry, JournalEntryLine } from '@/types'

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

// Same shape as the invoices list header (app/(dashboard)/invoices/page.tsx):
// click cycles the sort, inactive columns show a dimmed two-way arrow. Two
// deliberate differences: the plain-click cycle has a third step back to
// DEFAULT_SORT_STACK so a sort is always escapable from the header itself
// (the invoices list starts unsorted and has nothing to return to), and
// shift-click stacks the column as a secondary/tertiary key, shown with a
// priority number next to the arrow.
interface SortableHeaderProps {
  label: string
  sortLabel: string
  column: SortColumn
  stack: SortKey[]
  onSort: (column: SortColumn, additive: boolean) => void
  className?: string
  align?: 'left' | 'right'
}

function SortableHeader({
  label,
  sortLabel,
  column,
  stack,
  onSort,
  className,
  align = 'left',
}: SortableHeaderProps) {
  const index = stack.findIndex((k) => k.column === column)
  const active = index !== -1
  const direction = active ? stack[index].direction : null
  const SortIcon = !active ? ArrowUpDown : direction === 'asc' ? ArrowUp : ArrowDown

  return (
    <th
      className={cn(TH_CLASS, className)}
      aria-sort={active ? (direction === 'asc' ? 'ascending' : 'descending') : 'none'}
    >
      {/* Preflight sets text-transform: none on buttons, which would drop the
          TH_CLASS uppercase idiom inside the sort control. */}
      <button
        type="button"
        className={cn(
          '-mx-2 inline-flex min-h-10 items-center gap-1 rounded-sm px-2 uppercase focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2',
          align === 'right' && 'ml-auto justify-end',
        )}
        aria-label={sortLabel}
        onClick={(e) => onSort(column, e.shiftKey)}
      >
        <span>{label}</span>
        <SortIcon
          aria-hidden="true"
          className={cn('h-3.5 w-3.5 shrink-0', !active && 'text-muted-foreground/60')}
        />
        {active && stack.length > 1 && (
          <span className="text-[10px] font-medium tabular-nums text-muted-foreground" aria-hidden="true">
            {index + 1}
          </span>
        )}
      </button>
    </th>
  )
}

// Compact row density (support feedback: "kompakt visning av verifikat").
// Persisted per company, mirroring the sort key convention.

// Page-size selector. Persisted per company, mirroring the sort key convention.
// 'all' fetches everything in the current scope (capped server-side at MAX_LIMIT);
// the numeric options paginate normally.
type PageSizeChoice = '20' | '50' | '100' | 'all'
const PAGE_SIZE_STORAGE_KEY_PREFIX = 'Accounted:journal-page-size:'
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const
const PAGE_SIZE_VALUES = new Set<PageSizeChoice>(['20', '50', '100', 'all'])
// Sentinel limit sent for "Alla". The route clamps this to its own MAX_LIMIT.
const ALL_PAGE_SIZE = 100000

export default function JournalEntryList({
  pristineSlot,
  refreshToken,
  initialShowMissingOnly = false,
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
  /**
   * Deep-link arrival (dashboard "Verifikat utan underlag" card,
   * push-notification link): start with the "Visa saknade underlag" filter on
   * and, for this visit only, scope to all fiscal years so the visible set
   * matches the all-years dashboard count. The saved fiscal-year preference
   * is not overwritten.
   */
  initialShowMissingOnly?: boolean
} = {}) {
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const company = useCompanyOptional()?.company ?? null
  const t = useTranslations('journal_list')
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
  const [page, setPage] = useState(0)
  const [attachmentCounts, setAttachmentCounts] = useState<Record<string, number>>({})
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
  const [showMissingOnly, setShowMissingOnly] = useState(initialShowMissingOnly)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [batchReason, setBatchReason] = useState('')
  const [batchSubmitting, setBatchSubmitting] = useState(false)
  const [bulkOpen, setBulkOpen] = useState(false)
  const [bulkCount, setBulkCount] = useState<number | null>(null)
  const [bulkReason, setBulkReason] = useState('')
  const [bulkSubmitting, setBulkSubmitting] = useState(false)
  const [correctionEntry, setCorrectionEntry] = useState<JournalEntry | null>(null)
  const [reverseEntryTarget, setReverseEntryTarget] = useState<JournalEntry | null>(null)
  const [isReversing, setIsReversing] = useState(false)
  const [previewEntryId, setPreviewEntryId] = useState<string | null>(null)
  const [sortStack, setSortStack] = useState<SortKey[]>(DEFAULT_SORT_STACK)
  const [sortHydrated, setSortHydrated] = useState(false)
  const [periodId, setPeriodId] = useState<string | null>(null)
  const [periodHydrated, setPeriodHydrated] = useState(false)
  // One-shot: a deep-link arrival scopes the first period resolution to all
  // years (see the period effect below) without touching the saved preference.
  const deepLinkAllYearsRef = useRef(initialShowMissingOnly)
  const [filterOpen, setFilterOpen] = useState(false)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [dateFromInput, setDateFromInput] = useState('')
  const [dateToInput, setDateToInput] = useState('')
  const [seriesFilter, setSeriesFilter] = useState<string>('all')
  const [searchInput, setSearchInput] = useState('')
  const [search, setSearch] = useState('')
  // Verifikat (committed) vs Utkast (drafts) view. Drafts are excluded from the
  // committed list server-side and surfaced here behind a count badge.
  const [listMode, setListMode] = useState<'committed' | 'drafts'>('committed')
  // Collapse correction groups to the live correction (hide storno + reversed
  // original). Toggled off via the filter dialog to reveal the full chain.
  const [collapseCorrections, setCollapseCorrections] = useState(true)
  const [draftCount, setDraftCount] = useState(0)
  // All-years emptiness, resolved only when the scoped list comes back empty:
  // the pristine start card must key on "this ledger has never had an entry",
  // not "the selected fiscal year is empty" (the default year selection used
  // to make the pristine state unreachable on brand-new companies). null =
  // not yet known; the pristine gate requires an explicit false.
  const [ledgerHasAnyEntry, setLedgerHasAnyEntry] = useState<boolean | null>(null)
  const [pageSizeChoice, setPageSizeChoice] = useState<PageSizeChoice>('20')
  const [pageSizeHydrated, setPageSizeHydrated] = useState(false)
  const showingAll = pageSizeChoice === 'all'
  const pageSize = showingAll ? ALL_PAGE_SIZE : Number(pageSizeChoice)

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
      const results = await Promise.all(
        batches.map(async (batch) => {
          const res = await fetch(
            `/api/documents/counts?journal_entry_ids=${batch.join(',')}`
          )
          if (!res.ok) return {} as Record<string, number>
          const { data } = await res.json()
          return (data || {}) as Record<string, number>
        })
      )
      if (!isCurrent()) return
      setAttachmentCounts(Object.assign({}, ...results))
    } catch {
      // Non-critical: silently ignore
    } finally {
      // A stale run must not flip the loaded flag either: the newer run set
      // it false on entry and owns setting it true when ITS counts land.
      if (isCurrent()) setAttachmentCountsLoaded(true)
    }
  }, [])

  const fetchRattelseFlags = useCallback(async (entryIds: string[], isCurrent: () => boolean = () => true) => {
    if (entryIds.length === 0) {
      setRattelseFlags(new Set())
      return
    }
    try {
      const res = await fetch(
        `/api/bookkeeping/journal-entries/rattelse-flags?ids=${entryIds.join(',')}`
      )
      if (!res.ok) return
      const { data } = await res.json()
      if (!isCurrent()) return
      setRattelseFlags(new Set((data || []) as string[]))
    } catch {
      // Non-critical: silently ignore
    }
  }, [])

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

  // Resolve the initial fiscal-year scope from the session-cached period list.
  // The list is period-oriented (BFL): verifikationsnummer run as an unbroken
  // series *per räkenskapsår*, so the same number (e.g. A42) recurs once per
  // year. Showing every year at once makes those look like duplicates and makes
  // a bare "A42" reference ambiguous, so we default to the räkenskapsår the
  // user is currently in rather than "all years". An explicit "Alla
  // räkenskapsår" choice (persisted as ALL_YEARS_VALUE) is still honoured.
  // Resolving the scope here, not in the dialog's FiscalYearSelector, which
  // only mounts when opened, keeps the first fetch correct. periodHydrated
  // gates that first fetch so the list loads already scoped to the resolved year.
  //
  // The periods come from useFiscalPeriods (seeded by the dashboard layout),
  // so on a normal visit this resolves in the first effect tick with no
  // round trip; the saved-scope shortcut below still unblocks the entries
  // fetch first when the list is not cached yet. Resolution runs once per
  // company: a background revalidation of the list must not snap the scope
  // back (the deep-link "all years" visit in particular).
  const { periods: fiscalPeriods, isLoading: fiscalPeriodsLoading } = useFiscalPeriods()
  const periodScopeResolvedForRef = useRef<string | null>(null)
  useEffect(() => {
    if (!company?.id) {
      setPeriodId(null)
      setPeriodHydrated(true)
      return
    }
    if (periodScopeResolvedForRef.current === company.id) return

    // Deep-link arrival with the missing-underlag filter: scope this visit to
    // all fiscal years (in memory only) so the list can show the same set the
    // all-years dashboard badge counted. Consumed once; picking a year in the
    // FyPicker afterwards works and persists as usual.
    if (deepLinkAllYearsRef.current) {
      deepLinkAllYearsRef.current = false
      periodScopeResolvedForRef.current = company.id
      setPeriodId(null)
      setPeriodHydrated(true)
      return
    }

    const stored =
      typeof window !== 'undefined'
        ? window.localStorage.getItem(FISCAL_YEAR_STORAGE_KEY_PREFIX + company.id)
        : null
    // Optimistic hydration: a saved scope unblocks the first entries fetch
    // immediately instead of waiting for the period list (the common
    // returning-user case without a seed). The validation below still
    // re-scopes to the current räkenskapsår if the saved id went stale (e.g.
    // the period was deleted); the entries effect then refires with the
    // corrected scope.
    if (stored) {
      // FISCAL_YEAR_ALL_VALUE = user explicitly chose "all years", respect it.
      setPeriodId(stored === FISCAL_YEAR_ALL_VALUE ? null : stored)
      setPeriodHydrated(true)
    }

    // Not cached yet and no seed: wait for the list, this effect re-runs.
    if (fiscalPeriodsLoading) return
    periodScopeResolvedForRef.current = company.id

    if (stored === FISCAL_YEAR_ALL_VALUE) return
    if (stored && fiscalPeriods.some((p) => p.id === stored)) return

    // No (valid) saved scope → default to the current räkenskapsår.
    const today = new Date().toISOString().split('T')[0]
    setPeriodId(resolveCurrentPeriodId(fiscalPeriods, today))
    setPeriodHydrated(true)
  }, [company?.id, fiscalPeriods, fiscalPeriodsLoading])

  // Debounce the free-text search before it reaches the API. Require ≥2 chars:
  // a single character matches almost every verifikationstext and isn't a useful
  // filter, so 0-1 chars are treated as "no search" instead of firing a query on
  // every keystroke (ASVS V2.4).
  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = searchInput.trim()
      setSearch(trimmed.length >= 2 ? trimmed : '')
      setPage(0)
    }, 300)
    return () => clearTimeout(handle)
  }, [searchInput])

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
    setLoading(true)
    if (!preserveSelection) setSelectedIds(new Set()) // selection is page-scoped, reset on reload
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(page * pageSize),
      sort_by: serializeSortStack(sortStack),
    })
    if (listMode === 'drafts') {
      // Drafts get their own view spanning all years: they're work-in-progress
      // and shouldn't be hidden by the selected fiscal-year scope.
      params.set('status', 'draft')
    } else {
      params.set('exclude_draft', 'true')
      if (collapseCorrections) params.set('collapse_corrections', 'true')
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

    try {
      const res = await fetch(`/api/bookkeeping/journal-entries?${params}`)
      if (!isCurrent()) return
      if (!res.ok) {
        // Surface the failure: stale rows (if any) stay on screen, the empty
        // case renders the error state below, and the toast covers refetches.
        setLoadFailed(true)
        toast({ title: t('load_failed_title'), variant: 'destructive' })
        setHasLoaded(true)
        return
      }
      setLoadFailed(false)
      const { data, count: total } = await res.json()
      if (!isCurrent()) return
      const loadedEntries = data || []
      setEntries(loadedEntries)
      setCount(total || 0)
      if (preserveSelection) {
        // Reconcile with the refreshed page: rows that left it (recommitted
        // elsewhere, filtered out by the new data) must leave the selection
        // too, or the bulk bar would act on rows no longer on screen.
        const visibleIds = new Set(loadedEntries.map((e: JournalEntry) => e.id))
        setSelectedIds((prev) => {
          const next = new Set([...prev].filter((id) => visibleIds.has(id)))
          return next.size === prev.size ? prev : next
        })
      }

      // The pristine empty card vs. the (toggle-bearing) "drafts exist" state hinges
      // on draftCount. When the committed list comes back empty, resolve the draft
      // count BEFORE clearing loading so the toggle doesn't flash out for a frame on
      // a stale count of 0. Every other case refreshes the badge in the background.
      if (loadedEntries.length === 0 && listMode === 'committed') {
        // A missing-underlag-filtered total of 0 says nothing about whether
        // the ledger has entries, so that mode never short-circuits the probe.
        const unscopedQuery =
          !periodId && !dateFrom && !dateTo && seriesFilter === 'all' && !search && !showMissingOnly
        await Promise.all([
          fetchDraftCount(),
          unscopedQuery
            ? Promise.resolve(setLedgerHasAnyEntry((total || 0) > 0))
            : fetchLedgerHasAnyEntry(isCurrent),
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
      fetchAttachmentCounts(ids, isCurrent)
      fetchRattelseFlags(ids, isCurrent)
    } catch {
      // Network-level rejection (offline, aborted response body): same
      // surfacing as a non-OK response, or the list stays dimmed forever.
      if (!isCurrent()) return
      setLoadFailed(true)
      setHasLoaded(true)
      toast({ title: t('load_failed_title'), variant: 'destructive' })
    } finally {
      if (isCurrent()) setLoading(false)
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
  }, [periodId, page, pageSize, sortParam, dateFrom, dateTo, seriesFilter, search, listMode, collapseCorrections, showMissingOnly, sortHydrated, periodHydrated, pageSizeHydrated])

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
    setSelectedIds(new Set())
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

  const handleCommit = async (entryId: string) => {
    setCommittingId(entryId)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${entryId}/commit`, { method: 'POST' })
      const result = await res.json()
      if (res.ok) {
        const posted = result.data
        toast({
          title: t('toast_posted_title'),
          description: t('toast_posted_description', { voucher: formatVoucher(posted ?? {}) }),
        })
        await fetchEntries()
      } else {
        toast({ title: t('toast_post_failed'), description: getErrorMessage(result, { context: 'journal_entry' }), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('toast_post_failed_generic'), variant: 'destructive' })
    } finally {
      setCommittingId(null)
    }
  }

  // Pure reversal (storno) of a posted verifikat: books a stornoverifikation
  // with no replacement, per BFL 5 kap 5§. Routes through the engine's
  // reverseEntry (storno + reverses_id link; original → 'reversed', never
  // deleted). "Rätta" stays the path for booking a replacement entry instead.
  const handleReverse = async () => {
    const target = reverseEntryTarget
    if (!target) return
    setIsReversing(true)
    try {
      const res = await fetch(`/api/bookkeeping/journal-entries/${target.id}/reverse`, { method: 'POST' })
      const result = await res.json()
      if (res.ok) {
        const storno = result.data
        toast({
          title: t('toast_reverse_done_title'),
          description: t('toast_reverse_done_description', { voucher: formatVoucher(storno ?? {}) }),
        })
        setReverseEntryTarget(null)
        await fetchEntries()
      } else {
        toast({ title: t('toast_reverse_failed'), description: getErrorMessage(result, { context: 'journal_entry' }), variant: 'destructive' })
      }
    } catch {
      toast({ title: t('toast_reverse_failed'), variant: 'destructive' })
    } finally {
      setIsReversing(false)
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
      !noDocRequired.has(entry.id),
    [attachmentCounts, noDocRequired],
  )

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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
      setSelectedIds(new Set())
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
      setSelectedIds(new Set())
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
  const rememberListContext = () => {
    writeListContext(listContextKey('bookkeeping', company?.id), {
      ids: filteredEntries.map((e) => e.id),
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
    (showMissingOnly ? 1 : 0)
  // Year scope included: drives empty-state messaging + keeping the bar mounted.
  const activeFilterCount = (periodId ? 1 : 0) + dialogFilterCount

  // When any filter or search is active we keep the filter bar mounted even
  // with zero results, so the user can edit or clear their query. The pristine
  // "no entries yet" state below only applies to an untouched, empty ledger.
  const hasActiveFilters = Boolean(search) || activeFilterCount > 0

  // Apply a fiscal-year selection. The FiscalYearSelector (now an inline control
  // in the toolbar, not buried in the filter dialog) persists the choice to
  // localStorage itself; here we only mirror it into local state and reset
  // pagination.
  const handlePeriodChange = (next: string | null) => {
    setPeriodId(next)
    setPage(0)
  }

  // Change how many verifikat are shown per page. Resets to the first page and
  // persists the choice per company (same convention as the sort order).
  const handlePageSizeChange = (next: PageSizeChoice) => {
    setPageSizeChoice(next)
    setPage(0)
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(PAGE_SIZE_STORAGE_KEY_PREFIX + (company?.id ?? 'default'), next)
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
    setPeriodId(null)
    // Mirror the selector's "Alla räkenskapsår" write so the cleared scope
    // survives a remount/reload instead of being restored from a stale value.
    if (company?.id && typeof window !== 'undefined') {
      window.localStorage.setItem(FISCAL_YEAR_STORAGE_KEY_PREFIX + company.id, FISCAL_YEAR_ALL_VALUE)
    }
    setSeriesFilter('all')
    setShowMissingOnly(false)
    setDateFrom('')
    setDateTo('')
    setDateFromInput('')
    setDateToInput('')
    setPage(0)
  }

  // Rows on this page the user can batch-mark "Inget underlag krävs".
  const eligibleEntries = canWrite ? filteredEntries.filter(isEligibleForExempt) : []
  const allEligibleSelected =
    eligibleEntries.length > 0 && eligibleEntries.every((e) => selectedIds.has(e.id))
  const toggleSelectAll = () => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (allEligibleSelected) {
        for (const e of eligibleEntries) next.delete(e.id)
      } else {
        for (const e of eligibleEntries) next.add(e.id)
      }
      return next
    })
  }

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
          icon={<BookOpen className="h-6 w-6" />}
          title={t('empty_title')}
          description={t('empty_description')}
        />
      </DataList>
    )
  }

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
        <div className="relative flex-1 sm:flex-none sm:w-[280px]">
          <ToolbarSearch
            type="text"
            inputMode="search"
            placeholder={t('search_placeholder')}
            aria-label={t('search_placeholder')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            containerClassName="min-w-0 max-w-none"
            className={cn('pr-7', loading && search && 'pr-12')}
          />
          {loading && search && (
            // Search is server-side and can take a moment on a large ledger;
            // without this the only signal was the list dimming.
            <Loader2
              className="absolute right-7 top-1/2 h-3.5 w-3.5 -translate-y-1/2 animate-spin text-muted-foreground"
              aria-hidden="true"
            />
          )}
          {searchInput && (
            <button
              type="button"
              onClick={() => setSearchInput('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 p-0.5 rounded-sm hover:bg-muted text-muted-foreground"
              title={t('clear_search')}
              aria-label={t('clear_search')}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <Dialog open={filterOpen} onOpenChange={setFilterOpen}>
          <DialogTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className="h-8 gap-2 text-xs shrink-0"
              aria-label={
                dialogFilterCount > 0
                  ? t('filter_with_count', { count: dialogFilterCount })
                  : t('filter')
              }
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              {t('filter')}
              {dialogFilterCount > 0 && (
                <Badge
                  variant="secondary"
                  className="h-4 min-w-4 justify-center px-1 text-[10px] tabular-nums"
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
                  <SelectTrigger className="h-9 w-full text-sm font-mono" aria-label={t('filter_section_series')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Alla serier</SelectItem>
                    {'ABCDEFG'.split('').map((letter) => (
                      <SelectItem key={letter} value={letter} className="font-mono">
                        Serie {letter}
                      </SelectItem>
                    ))}
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
                      className="p-1 rounded-sm hover:bg-muted text-muted-foreground shrink-0"
                      title={t('clear_date_filter')}
                      aria-label={t('clear_date_filter')}
                    >
                      <X className="h-4 w-4" />
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
                    setPage(0)
                  }}
                />
                <Label htmlFor="missing-attachments" className="text-sm cursor-pointer">
                  {t('show_missing')}
                </Label>
                {showMissingOnly && (
                  <Badge variant="secondary" className="text-xs tabular-nums">
                    {count}
                  </Badge>
                )}
              </div>

              {/* Reveal the storno + reversed-original rows the default view folds
                  into the surviving correction (3 rows → 1). */}
              <div className="flex items-center gap-2">
                <Switch
                  id="show-correction-chain"
                  checked={!collapseCorrections}
                  onCheckedChange={(on) => { setCollapseCorrections(!on); setPage(0) }}
                />
                <Label htmlFor="show-correction-chain" className="text-sm cursor-pointer">
                  {t('show_correction_chain')}
                </Label>
              </div>
            </div>

            <DialogFooter className="sm:justify-between">
              <Button
                variant="ghost"
                size="sm"
                onClick={clearAllFilters}
                disabled={activeFilterCount === 0}
              >
                {t('filter_clear_all')}
              </Button>
              <DialogClose asChild>
                <Button variant="outline" size="sm">{t('filter_done')}</Button>
              </DialogClose>
            </DialogFooter>
          </DialogContent>
        </Dialog>
        {/* The page context picker (convention 8): fiscal-year scope as a
            chip-dropdown far right in the toolbar, one click to change,
            always visible per BFL. Persists to localStorage (same key as
            before); first-load scope resolution still happens
            authoritatively in the period effect. */}
        {periodHydrated && (
          <div className="sm:ml-auto">
            {/* suppressAutoRestore on deep-link visits: the arrival scope is a
                deliberate in-memory "Alla räkenskapsår" (matches the all-years
                dashboard badge); FyPicker's on-load restore of the persisted
                year would otherwise snap the scope back right after load. */}
            <FyPicker
              value={periodId}
              onChange={handlePeriodChange}
              suppressAutoRestore={initialShowMissingOnly}
            />
          </div>
        )}
      </div>

      {loading && !hasLoaded ? (
        <DataList className="stagger-enter">
          <DataListLoading />
        </DataList>
      ) : loadFailed && filteredEntries.length === 0 ? (
        // Failed load with nothing on screen: an explicit error state with a
        // retry, never the "empty ledger" card. The toolbar above stays
        // mounted so the sort/filter that caused the failure can be changed.
        <DataList className={cn('stagger-enter', loading && 'opacity-60')} aria-busy={loading || undefined}>
          <DataListEmpty
            icon={<CircleSlash className="h-6 w-6" />}
            title={t('load_failed_title')}
            description={t('load_failed_description')}
            action={
              <Button variant="outline" size="sm" onClick={() => fetchEntries()}>
                {t('load_failed_retry')}
              </Button>
            }
          />
        </DataList>
      ) : filteredEntries.length === 0 ? (
        // Empty placeholder, scoped to the situation: an empty drafts view, a
        // filtered committed view with no matches, or a committed view with no
        // posted entries yet (but drafts exist, hence we got here, not the
        // pristine early return above). Carries the same busy treatment as the
        // table branch: widening a filter from an empty result would otherwise
        // look identical to "still nothing" for the whole request.
        <DataList
          className={cn('stagger-enter', loading && 'opacity-60')}
          aria-busy={loading || undefined}
        >
          <DataListEmpty
            icon={
              listMode === 'drafts' || !hasActiveFilters ? (
                <BookOpen className="h-6 w-6" />
              ) : (
                <Search className="h-6 w-6" />
              )
            }
            title={
              listMode === 'drafts'
                ? t('empty_drafts_title')
                : hasActiveFilters
                  ? t('no_results_title')
                  : t('empty_title')
            }
            description={
              listMode === 'drafts'
                ? t('empty_drafts_description')
                : hasActiveFilters
                  ? t('no_results_description')
                  : t('empty_description')
            }
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
        {selectedIds.size > 0 && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-1 py-2.5 text-[12.5px] animate-fade-in">
            <span className="whitespace-nowrap">
              <strong className="font-semibold tabular-nums">{selectedIds.size}</strong>{' '}
              {t('bulkbar_selected', { count: selectedIds.size })}
            </span>
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
            </datalist>
            <Button size="sm" onClick={handleBatchExempt} disabled={batchSubmitting}>
              {batchSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {t('batch_mark_no_doc')}
            </Button>
            {!allEligibleSelected && (
              <button type="button" className={QUIET_LINK_CLASS} onClick={toggleSelectAll}>
                {t('batch_select_all', { count: eligibleEntries.length })}
              </button>
            )}
            {/* Filter-scoped: mark every missing-doc verifikat matching the
                active filters across all pages: scales to a post-import flood. */}
            <button type="button" className={QUIET_LINK_CLASS} onClick={openBulk}>
              {t('batch_mark_all_missing')}
            </button>
            <button
              type="button"
              className={QUIET_LINK_CLASS}
              onClick={() => setSelectedIds(new Set())}
              disabled={batchSubmitting}
            >
              {t('batch_clear_selection')}
            </button>
          </div>
        )}

        {/* Discoverability for "Ångra import" (issue #1883): when the page
            shows import-sourced vouchers, point at the SIE import history
            where a bad import can be undone in one step. One page-domain
            attn line (design convention 6). Only source_type 'import' is an
            SIE marker: 'opening_balance' is also written by year-end closing
            and the manual IB flows, which have nothing to undo here. */}
        {entries.some((e) => e.source_type === 'import') && (
          <AttnLine
            className="px-1 pb-2"
            action={{ label: t('import_attn_action'), href: '/import?history=sie' }}
          >
            {t('import_attn')}
          </AttnLine>
        )}

        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <th className={cn(TH_CLASS, 'w-[26px] !pl-1')} aria-hidden="true"></th>
                <SortableHeader
                  label={t('th_voucher')}
                  sortLabel={t('sort_by', { column: t('th_voucher') })}
                  column="voucher"
                  stack={sortStack}
                  onSort={handleHeaderSort}
                />
                <SortableHeader
                  label={t('th_date')}
                  sortLabel={t('sort_by', { column: t('th_date') })}
                  column="date"
                  stack={sortStack}
                  onSort={handleHeaderSort}
                  className="hidden sm:table-cell"
                />
                <SortableHeader
                  label={t('th_description')}
                  sortLabel={t('sort_by', { column: t('th_description') })}
                  column="description"
                  stack={sortStack}
                  onSort={handleHeaderSort}
                  className="w-full"
                />
                <SortableHeader
                  label={t('th_amount')}
                  sortLabel={t('sort_by', { column: t('th_amount') })}
                  column="total"
                  stack={sortStack}
                  onSort={handleHeaderSort}
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
                // Voucher total = sum of the debit side (= credit side when balanced).
                const voucherTotal = lines.reduce((sum, l) => sum + (Number(l.debit_amount) || 0), 0)
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
                        className={cn(TD_CLASS, 'w-[26px] !pl-1 py-[9px]')}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {selectable && (
                          <Checkbox
                            checked={selectedIds.has(entry.id)}
                            onCheckedChange={() => toggleSelect(entry.id)}
                            aria-label={t('batch_select_row')}
                            className={cn(
                              'duration-150',
                              selectedIds.has(entry.id)
                                ? 'opacity-100'
                                : CHECKBOX_REVEAL_CLASS,
                            )}
                          />
                        )}
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                        <span className="inline-flex items-center gap-1">
                          <Link
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
                          </Link>
                          <OpenInNewTab href={`/bookkeeping/${entry.id}`} />
                        </span>
                      </td>
                      <td className={cn(TD_CLASS, 'hidden sm:table-cell whitespace-nowrap tabular-nums text-muted-foreground', struckCell)}>
                        {formatDate(entry.entry_date)}
                      </td>
                      <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
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
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums rr-mask', struckCell)}>
                        {formatCurrency(voucherTotal, 'SEK', { minimumFractionDigits: 2 })}
                      </td>
                      <td className={cn(TD_CLASS, 'whitespace-nowrap text-right py-[9px]')}>
                        <span className="inline-flex items-center justify-end gap-2">
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
                              <Paperclip className="h-3.5 w-3.5" />
                              <span className="text-xs tabular-nums">{attachmentCounts[entry.id]}</span>
                            </button>
                          ) : (
                            attachmentCountsLoaded && NEEDS_ATTACHMENT.has(entry.source_type) && entry.status === 'posted' && (
                              noDocRequired.has(entry.id) ? (
                                <span title={t('no_doc_required_indicator_tooltip')}>
                                  <CircleSlash className="h-3.5 w-3.5 text-muted-foreground" />
                                </span>
                              ) : (
                                <Badge variant="warning" title={t('missing_attachment_tooltip')}>
                                  {t('missing_attachment_chip')}
                                </Badge>
                              )
                            )
                          )}
                          {entry.status === 'draft' && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-3.5 text-xs"
                              disabled={!canWrite || committingId === entry.id}
                              title={!canWrite ? t('read_only_tooltip') : undefined}
                              onClick={(e) => {
                                e.stopPropagation()
                                openCommitConfirm(entry)
                              }}
                            >
                              {committingId === entry.id && <Loader2 className="mr-1.5 h-3 w-3 animate-spin" />}
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
                                'inline-flex items-center rounded-sm p-2 text-muted-foreground transition-opacity duration-150 hover:text-foreground',
                                // Quiet at rest on desktop, but the table has no
                                // mobile card to fall back on, so touch keeps the
                                // icon visible.
                                'opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100',
                              )}
                            >
                              <Copy className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <ChevronRight
                            className={cn(
                              'h-3.5 w-3.5 text-muted-foreground transition-all duration-200',
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
                        <td colSpan={6} className="border-b border-border p-0">
                          <RowFoldout>
                            <div className="px-1 pb-6 pt-1 sm:pl-9 sm:pr-4">
                              {lines.length === 0 ? (
                                <p className="text-sm text-muted-foreground py-2">{t('no_lines')}</p>
                              ) : (
                                <table className="w-full border-collapse text-[12.5px]" aria-label={formatVoucher(entry)}>
                                  <thead>
                                    <tr>
                                      <th className={cn(VTH_CLASS, 'w-[180px]')}>{t('account_column')}</th>
                                      <th className={VTH_CLASS}>{t('description_column')}</th>
                                      <th className={cn(VTH_CLASS, 'text-right')}>{t('debit')}</th>
                                      <th className={cn(VTH_CLASS, 'text-right')}>{t('credit')}</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {lines
                                      .slice()
                                      .sort((a, b) => a.sort_order - b.sort_order)
                                      .map((line) => {
                                        const accountName = getAccountDescription(line.account_number)?.name
                                        const desc = line.line_description
                                        const showDesc = desc
                                          && desc.toLowerCase() !== accountName?.toLowerCase()
                                          && desc.toLowerCase() !== entry.description?.toLowerCase()
                                        const debit = Number(line.debit_amount) || 0
                                        const credit = Number(line.credit_amount) || 0
                                        const fx = line.currency && line.currency !== 'SEK' && line.amount_in_currency != null
                                          ? `${Number(line.amount_in_currency).toLocaleString('sv-SE', { minimumFractionDigits: 2 })} ${line.currency}`
                                          : null
                                        return (
                                          <tr key={line.id}>
                                            <td className={cn(VTD_CLASS, 'whitespace-nowrap')}>
                                              <AccountNumber number={line.account_number} showName />
                                            </td>
                                            <td className={cn(VTD_CLASS, 'text-muted-foreground')}>
                                              {showDesc ? desc : ''}
                                            </td>
                                            <td className={cn(VTD_CLASS, 'text-right tabular-nums whitespace-nowrap')}>
                                              {debit > 0 ? debit.toLocaleString('sv-SE', { minimumFractionDigits: 2 }) : ''}
                                              {debit > 0 && fx && (
                                                <span className="block text-xs text-muted-foreground tabular-nums">{fx}</span>
                                              )}
                                            </td>
                                            <td className={cn(VTD_CLASS, 'text-right tabular-nums whitespace-nowrap')}>
                                              {credit > 0 ? credit.toLocaleString('sv-SE', { minimumFractionDigits: 2 }) : ''}
                                              {credit > 0 && fx && (
                                                <span className="block text-xs text-muted-foreground tabular-nums">{fx}</span>
                                              )}
                                            </td>
                                          </tr>
                                        )
                                      })}
                                    <tr>
                                      <td colSpan={2} className="py-[7px] pr-4 font-medium">{t('sum_label')}</td>
                                      <td className="py-[7px] pr-4 text-right tabular-nums font-medium">
                                        {lines.reduce((sum, l) => sum + (Number(l.debit_amount) || 0), 0).toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
                                      </td>
                                      <td className="py-[7px] pr-4 text-right tabular-nums font-medium">
                                        {lines.reduce((sum, l) => sum + (Number(l.credit_amount) || 0), 0).toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
                                      </td>
                                    </tr>
                                  </tbody>
                                </table>
                              )}

                              {entry.notes && (
                                <p className="mt-3 text-xs text-muted-foreground italic">
                                  {entry.notes}
                                </p>
                              )}

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
                                    // semantics of a background refresh).
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
                                    size="sm"
                                    onClick={() => openCommitConfirm(entry)}
                                    disabled={!canWrite || committingId === entry.id}
                                    title={!canWrite ? t('read_only_tooltip') : undefined}
                                  >
                                    {!canWrite ? <Lock className="mr-2 h-4 w-4" /> : committingId === entry.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                                    {t('post')}
                                  </Button>
                                )}
                                <Link
                                  href={`/bookkeeping/${entry.id}`}
                                  className={QUIET_LINK_CLASS}
                                  onClick={rememberListContext}
                                >
                                  {t('show_details')}
                                </Link>
                                {entry.status === 'posted' && entry.source_type !== 'storno' && entry.source_type !== 'correction' && (
                                  <button type="button" className={QUIET_LINK_CLASS} onClick={() => setCorrectionEntry(entry)}>
                                    {t('create_correction')}
                                  </button>
                                )}
                                {canWrite && entry.status === 'posted' && entry.source_type !== 'storno' && entry.source_type !== 'correction' && (
                                  <button type="button" className={QUIET_LINK_CLASS} onClick={() => setReverseEntryTarget(entry)}>
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
                <Loader2 className="h-4 w-4 animate-spin" />
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
                  </datalist>
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setBulkOpen(false)} disabled={bulkSubmitting}>
              {t('bulk_cancel')}
            </Button>
            <Button size="sm" onClick={handleBulkConfirm} disabled={bulkSubmitting || !bulkCount}>
              {bulkSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
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
                  amount: formatCurrency(
                    ((commitTarget.lines || []) as JournalEntryLine[]).reduce(
                      (sum, l) => sum + (Number(l.debit_amount) || 0),
                      0,
                    ),
                  ),
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
          <div className="flex items-start gap-3 rounded-lg border bg-muted/50 p-4">
            <RotateCcw className="h-5 w-5 text-muted-foreground mt-0.5 shrink-0" />
            <div className="text-sm">
              <p className="font-medium mb-1">{t('reverse_dialog_heading', { voucher: formatVoucher(reverseEntryTarget) })}</p>
              <p className="text-muted-foreground">{t('reverse_dialog_body')}</p>
            </div>
          </div>
        </ConfirmationDialog>
      )}

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
              {showingAll
                ? t('showing_all', { total: count })
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
                className="h-8 w-8"
                disabled={page === 0}
                onClick={() => setPage(0)}
                aria-label={t('first_page')}
                title={t('first_page')}
              >
                <ChevronsLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
                aria-label={t('previous')}
                title={t('previous')}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="px-2 text-xs text-muted-foreground tabular-nums self-center whitespace-nowrap">
                {t('page_of', { page: page + 1, total: Math.ceil(count / pageSize) })}
              </span>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={(page + 1) * pageSize >= count}
                onClick={() => setPage(page + 1)}
                aria-label={t('next')}
                title={t('next')}
              >
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8"
                disabled={(page + 1) * pageSize >= count}
                onClick={() => setPage(Math.ceil(count / pageSize) - 1)}
                aria-label={t('last_page')}
                title={t('last_page')}
              >
                <ChevronsRight className="h-4 w-4" />
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
