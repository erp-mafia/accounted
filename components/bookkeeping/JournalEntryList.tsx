'use client'

import { useState, useEffect, useCallback } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  DataList,
  DataListHeader,
  DataListRow,
  DataListEmpty,
  DataListLoading,
} from '@/components/ui/data-list'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Table, TableHeader, TableBody, TableFooter, TableHead, TableRow, TableCell } from '@/components/ui/table'
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
  FiscalYearSelector,
  STORAGE_KEY_PREFIX as FISCAL_YEAR_STORAGE_KEY_PREFIX,
  ALL_YEARS_VALUE as FISCAL_YEAR_ALL_VALUE,
} from '@/components/common/FiscalYearSelector'
import { ChevronDown, ChevronRight, ChevronLeft, ChevronsLeft, ChevronsRight, Paperclip, AlertTriangle, CircleSlash, Loader2, BookOpen, X, Copy, Lock, Search, SlidersHorizontal, RotateCcw } from 'lucide-react'
import { formatDate, formatCurrency } from '@/lib/utils'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { resolveCurrentPeriodId } from '@/lib/bookkeeping/suggest-fiscal-period'
import { Input } from '@/components/ui/input'
import { AccountNumber } from '@/components/ui/account-number'
import { getAccountDescription } from '@/lib/bookkeeping/account-descriptions'
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
import type { FiscalPeriod, JournalEntry, JournalEntryLine } from '@/types'

const NEEDS_ATTACHMENT = new Set([
  'manual',
  'bank_transaction',
  'supplier_invoice_registered',
  'supplier_invoice_paid',
  'supplier_invoice_cash_payment',
  'import',
])

type SortBy = 'date_desc' | 'date_asc' | 'voucher_asc' | 'voucher_desc'

// Per-company persistence of the sort dropdown. Mirrors the localStorage
// convention used by FiscalYearSelector ('Accounted:fiscal-year:<companyId>').
const SORT_STORAGE_KEY_PREFIX = 'Accounted:journal-sort:'
const SORT_VALUES = new Set<SortBy>(['date_desc', 'date_asc', 'voucher_asc', 'voucher_desc'])

// Page-size selector. Persisted per company, mirroring the sort key convention.
// 'all' fetches everything in the current scope (capped server-side at MAX_LIMIT);
// the numeric options paginate normally.
type PageSizeChoice = '20' | '50' | '100' | 'all'
const PAGE_SIZE_STORAGE_KEY_PREFIX = 'Accounted:journal-page-size:'
const PAGE_SIZE_OPTIONS = [20, 50, 100] as const
const PAGE_SIZE_VALUES = new Set<PageSizeChoice>(['20', '50', '100', 'all'])
// Sentinel limit sent for "Alla". The route clamps this to its own MAX_LIMIT.
const ALL_PAGE_SIZE = 100000

export default function JournalEntryList() {
  const router = useRouter()
  const { toast } = useToast()
  const { canWrite } = useCanWrite()
  const company = useCompanyOptional()?.company ?? null
  const t = useTranslations('journal_list')
  const [entries, setEntries] = useState<JournalEntry[]>([])
  const [committingId, setCommittingId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [count, setCount] = useState(0)
  const [page, setPage] = useState(0)
  const [attachmentCounts, setAttachmentCounts] = useState<Record<string, number>>({})
  const [noDocRequired, setNoDocRequired] = useState<Map<string, string | null>>(new Map())
  const [showMissingOnly, setShowMissingOnly] = useState(false)
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
  const [sortBy, setSortBy] = useState<SortBy>('date_desc')
  const [sortHydrated, setSortHydrated] = useState(false)
  const [periodId, setPeriodId] = useState<string | null>(null)
  const [periodHydrated, setPeriodHydrated] = useState(false)
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

  const fetchAttachmentCounts = useCallback(async (entryIds: string[]) => {
    if (entryIds.length === 0) {
      setAttachmentCounts({})
      return
    }
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
      setAttachmentCounts(Object.assign({}, ...results))
    } catch {
      // Non-critical — silently ignore
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
      // Non-critical — silently ignore
    }
  }, [])

  useEffect(() => {
    fetchNoDocRequired()
  }, [fetchNoDocRequired])

  // Restore the persisted sort order (per company). Read in an effect rather
  // than the useState initializer to avoid an SSR/client hydration mismatch.
  // sortHydrated gates the first fetch so the list is fetched once, already in
  // the saved order — no flash of the default sort.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(SORT_STORAGE_KEY_PREFIX + (company?.id ?? 'default'))
      if (stored && SORT_VALUES.has(stored as SortBy)) setSortBy(stored as SortBy)
    }
    setSortHydrated(true)
  }, [company?.id])

  // Restore the persisted page-size choice (per company). Same hydration pattern
  // as the sort order — read in an effect to avoid an SSR mismatch, and gate the
  // first fetch so the list is fetched once at the saved size.
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const stored = window.localStorage.getItem(PAGE_SIZE_STORAGE_KEY_PREFIX + (company?.id ?? 'default'))
      if (stored && PAGE_SIZE_VALUES.has(stored as PageSizeChoice)) setPageSizeChoice(stored as PageSizeChoice)
    }
    setPageSizeHydrated(true)
  }, [company?.id])

  // Fetch fiscal periods AND resolve the initial fiscal-year scope in one pass.
  // The list is period-oriented (BFL): verifikationsnummer run as an unbroken
  // series *per räkenskapsår*, so the same number (e.g. A42) recurs once per
  // year. Showing every year at once makes those look like duplicates and makes
  // a bare "A42" reference ambiguous — so we default to the räkenskapsår the
  // user is currently in rather than "all years". An explicit "Alla
  // räkenskapsår" choice (persisted as ALL_YEARS_VALUE) is still honoured.
  // Resolving the scope here — not in the dialog's FiscalYearSelector, which
  // only mounts when opened — keeps the first fetch correct. periodHydrated
  // gates that first fetch so the list loads already scoped to the resolved year.
  useEffect(() => {
    if (!company?.id) {
      setPeriodId(null)
      setPeriodHydrated(true)
      return
    }
    let cancelled = false
    ;(async () => {
      let fetched: FiscalPeriod[] = []
      try {
        const res = await fetch('/api/bookkeeping/fiscal-periods')
        if (res.ok) {
          const { data } = await res.json()
          fetched = (data || []) as FiscalPeriod[]
        }
      } catch {
        // Non-critical — fall through with an empty list (scope stays "all years").
      }
      if (cancelled) return

      const stored =
        typeof window !== 'undefined'
          ? window.localStorage.getItem(FISCAL_YEAR_STORAGE_KEY_PREFIX + company.id)
          : null
      if (stored === FISCAL_YEAR_ALL_VALUE) {
        // User explicitly chose "all years" — respect it.
        setPeriodId(null)
      } else if (stored && fetched.some((p) => p.id === stored)) {
        setPeriodId(stored)
      } else {
        // No (valid) saved scope → default to the current räkenskapsår.
        const today = new Date().toISOString().split('T')[0]
        setPeriodId(resolveCurrentPeriodId(fetched, today))
      }
      setPeriodHydrated(true)
    })()
    return () => {
      cancelled = true
    }
  }, [company?.id])

  // Debounce the free-text search before it reaches the API. Require ≥2 chars:
  // a single character matches almost every verifikationstext and isn't a useful
  // filter, so 0–1 chars are treated as "no search" instead of firing a query on
  // every keystroke (ASVS V2.4).
  useEffect(() => {
    const handle = setTimeout(() => {
      const trimmed = searchInput.trim()
      setSearch(trimmed.length >= 2 ? trimmed : '')
      setPage(0)
    }, 300)
    return () => clearTimeout(handle)
  }, [searchInput])

  async function fetchEntries() {
    setLoading(true)
    setSelectedIds(new Set()) // selection is page-scoped — reset on reload
    const params = new URLSearchParams({
      limit: String(pageSize),
      offset: String(page * pageSize),
      sort_by: sortBy,
    })
    if (listMode === 'drafts') {
      // Drafts get their own view spanning all years — they're work-in-progress
      // and shouldn't be hidden by the selected fiscal-year scope.
      params.set('status', 'draft')
    } else {
      params.set('exclude_draft', 'true')
      if (collapseCorrections) params.set('collapse_corrections', 'true')
      if (periodId) params.set('period_id', periodId)
      if (dateFrom) params.set('date_from', dateFrom)
      if (dateTo) params.set('date_to', dateTo)
      if (seriesFilter !== 'all') params.set('series', seriesFilter)
    }
    if (search) params.set('search', search)

    const res = await fetch(`/api/bookkeeping/journal-entries?${params}`)
    if (!res.ok) {
      setLoading(false)
      return
    }
    const { data, count: total } = await res.json()
    const loadedEntries = data || []
    setEntries(loadedEntries)
    setCount(total || 0)

    // The pristine empty card vs. the (toggle-bearing) "drafts exist" state hinges
    // on draftCount. When the committed list comes back empty, resolve the draft
    // count BEFORE clearing loading so the toggle doesn't flash out for a frame on
    // a stale count of 0. Every other case refreshes the badge in the background.
    if (loadedEntries.length === 0 && listMode === 'committed') {
      await fetchDraftCount()
    } else {
      fetchDraftCount()
    }
    setLoading(false)

    // Fetch attachment counts for the loaded entries
    const ids = loadedEntries.map((e: JournalEntry) => e.id)
    fetchAttachmentCounts(ids)
  }

  // Cheap count-only query for the "Utkast" badge — all years, so the badge
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

  useEffect(() => {
    if (!sortHydrated || !periodHydrated || !pageSizeHydrated) return
    fetchEntries()
  }, [periodId, page, pageSize, sortBy, dateFrom, dateTo, seriesFilter, search, listMode, collapseCorrections, sortHydrated, periodHydrated, pageSizeHydrated])

  const handleAttachmentCountChange = useCallback((entryId: string, count: number) => {
    setAttachmentCounts((prev) => ({ ...prev, [entryId]: count }))
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

  // Pure reversal (storno) of a posted verifikat — books a stornoverifikation
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
  // exempt — i.e. the rows that show the warning triangle. Only these can be
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
        toast({ title: t('no_doc_required_save_failed'), description: body.error, variant: 'destructive' })
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
    } catch {
      toast({ title: t('no_doc_required_save_failed'), variant: 'destructive' })
    } finally {
      setBatchSubmitting(false)
    }
  }

  // Filter-scoped bulk mark: mark EVERY missing-doc verifikat matching the active
  // filters (period/series/date/search), across all pages — the scalable remedy
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
        toast({ title: t('no_doc_required_save_failed'), description: body.error, variant: 'destructive' })
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

  const filteredEntries = showMissingOnly
    ? entries.filter(
        (e) =>
          NEEDS_ATTACHMENT.has(e.source_type) &&
          !attachmentCounts[e.id] &&
          e.status === 'posted' &&
          !noDocRequired.has(e.id)
      )
    : entries

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
  // Year scope included — drives empty-state messaging + keeping the bar mounted.
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

  // Pristine, untouched ledger: nothing posted, no drafts, no filters, and we're
  // on the committed view. ONLY this genuinely-empty case may short-circuit the
  // whole component — every other empty state (a draft exists, or we're in the
  // drafts view) must fall through to the main render below so the
  // Verifikat/Utkast toggle stays reachable.
  if (!loading && entries.length === 0 && !hasActiveFilters && listMode === 'committed' && draftCount === 0) {
    return (
      <DataList>
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
        <div className="inline-flex shrink-0 rounded-md border border-border p-0.5">
          <button
            type="button"
            onClick={() => switchMode('committed')}
            className={`h-7 rounded px-3 text-xs font-medium transition-colors ${listMode === 'committed' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t('mode_vouchers')}
          </button>
          <button
            type="button"
            onClick={() => switchMode('drafts')}
            className={`inline-flex h-7 items-center gap-1.5 rounded px-3 text-xs font-medium transition-colors ${listMode === 'drafts' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
          >
            {t('mode_drafts')}
            {draftCount > 0 && (
              <Badge variant="secondary" className="h-4 min-w-4 justify-center px-1 text-[10px] tabular-nums">
                {draftCount}
              </Badge>
            )}
          </button>
        </div>
        <div className="relative flex-1 sm:flex-none sm:w-[280px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input
            type="text"
            inputMode="search"
            placeholder={t('search_placeholder')}
            aria-label={t('search_placeholder')}
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="h-8 pl-8 pr-7 text-xs"
          />
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
                <Select
                  value={sortBy}
                  onValueChange={(v) => {
                    const next = v as SortBy
                    setSortBy(next)
                    setPage(0)
                    if (typeof window !== 'undefined') {
                      window.localStorage.setItem(SORT_STORAGE_KEY_PREFIX + (company?.id ?? 'default'), next)
                    }
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
                  <span className="text-sm text-muted-foreground">–</span>
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
                <Switch
                  id="missing-attachments"
                  checked={showMissingOnly}
                  onCheckedChange={setShowMissingOnly}
                />
                <Label htmlFor="missing-attachments" className="text-sm cursor-pointer">
                  {t('show_missing')}
                </Label>
                {showMissingOnly && (
                  <Badge variant="secondary" className="text-xs tabular-nums">
                    {filteredEntries.length}
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
        {/* Active fiscal-year scope as a direct one-click picker, pushed to the
            right of the control bar — keeps the räkenskapsår visible per BFL and
            changeable in one click. Distinct from Filtrera (which now holds only
            sort / series / date / underlag); previously both just opened the same
            dialog. The selector persists the choice to localStorage; the first-load
            scope resolution still happens authoritatively in the period effect. */}
        {periodHydrated && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground sm:ml-auto">
            <span className="shrink-0">{t('scope_label')}</span>
            <FiscalYearSelector
              value={periodId}
              onChange={handlePeriodChange}
              label={null}
            />
          </div>
        )}
      </div>

      {loading ? (
        <DataList>
          <DataListLoading />
        </DataList>
      ) : filteredEntries.length === 0 ? (
        // Empty placeholder, scoped to the situation: an empty drafts view, a
        // filtered committed view with no matches, or a committed view with no
        // posted entries yet (but drafts exist — hence we got here, not the
        // pristine early return above).
        <DataList>
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
      <DataList>
        {/* Batch-mark "Inget underlag krävs": select-all + contextual action bar,
            rendered as the list header so it reads as part of the ledger rather
            than a detached box above it. */}
        {(eligibleEntries.length > 0 || selectedIds.size > 0) && (
          <DataListHeader className="justify-between gap-3">
            <div className="flex items-center gap-2">
              <Checkbox
                id="select-all-missing"
                checked={allEligibleSelected}
                onCheckedChange={toggleSelectAll}
                disabled={eligibleEntries.length === 0}
              />
              <Label htmlFor="select-all-missing" className="text-sm cursor-pointer">
                {selectedIds.size > 0
                  ? t('batch_selected_count', { count: selectedIds.size })
                  : t('batch_select_all', { count: eligibleEntries.length })}
              </Label>
            </div>
            {selectedIds.size > 0 ? (
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Input
                  value={batchReason}
                  onChange={(e) => setBatchReason(e.target.value)}
                  placeholder={t('no_doc_required_reason_placeholder')}
                  list="batch-no-doc-suggestions"
                  maxLength={200}
                  className="h-8 text-xs sm:w-56"
                  disabled={batchSubmitting}
                />
                <datalist id="batch-no-doc-suggestions">
                  <option value={t('no_doc_required_suggestion_bank_fee')} />
                  <option value={t('no_doc_required_suggestion_interest')} />
                  <option value={t('no_doc_required_suggestion_internal_transfer')} />
                  <option value={t('no_doc_required_suggestion_tax_payment')} />
                  <option value={t('no_doc_required_suggestion_salary')} />
                </datalist>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={handleBatchExempt} disabled={batchSubmitting}>
                    {batchSubmitting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {t('batch_mark_no_doc')}
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setSelectedIds(new Set())}
                    disabled={batchSubmitting}
                  >
                    {t('batch_clear_selection')}
                  </Button>
                </div>
              </div>
            ) : (
              // Filter-scoped: mark every missing-doc verifikat matching the active
              // filters across all pages — scales to a post-import flood.
              <Button size="sm" variant="outline" onClick={openBulk}>
                <CircleSlash className="mr-2 h-4 w-4" />
                {t('batch_mark_all_missing')}
              </Button>
            )}
          </DataListHeader>
        )}
        {filteredEntries.map((entry) => {
          const isExpanded = expandedId === entry.id
          const lines = (entry.lines || []) as JournalEntryLine[]
          // Voucher total = sum of the debit side (= credit side when balanced).
          const voucherTotal = lines.reduce((sum, l) => sum + (Number(l.debit_amount) || 0), 0)
          const selectable = canWrite && isEligibleForExempt(entry)

          return (
            <DataListRow
              key={entry.id}
              selected={selectedIds.has(entry.id)}
              expanded={isExpanded}
              onClick={() => toggleExpand(entry.id)}
              leading={
                selectable ? (
                  <div onClick={(e) => e.stopPropagation()}>
                    <Checkbox
                      checked={selectedIds.has(entry.id)}
                      onCheckedChange={() => toggleSelect(entry.id)}
                      aria-label={t('batch_select_row')}
                    />
                  </div>
                ) : undefined
              }
              expandedContent={
                isExpanded ? (
                  <>
                    {lines.length === 0 ? (
                      <p className="text-sm text-muted-foreground py-2">{t('no_lines')}</p>
                    ) : (
                      <div className="rounded-lg border overflow-hidden">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>{t('account_column')}</TableHead>
                              <TableHead>{t('description_column')}</TableHead>
                              <TableHead className="text-right">{t('debit')}</TableHead>
                              <TableHead className="text-right">{t('credit')}</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
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
                                  <TableRow key={line.id}>
                                    <TableCell className="align-top whitespace-nowrap">
                                      <AccountNumber number={line.account_number} showName />
                                    </TableCell>
                                    <TableCell className="align-top text-muted-foreground">
                                      {showDesc ? desc : ''}
                                    </TableCell>
                                    <TableCell className="align-top text-right tabular-nums">
                                      {debit > 0 ? debit.toLocaleString('sv-SE', { minimumFractionDigits: 2 }) : ''}
                                      {debit > 0 && fx && (
                                        <span className="block text-xs text-muted-foreground tabular-nums">{fx}</span>
                                      )}
                                    </TableCell>
                                    <TableCell className="align-top text-right tabular-nums">
                                      {credit > 0 ? credit.toLocaleString('sv-SE', { minimumFractionDigits: 2 }) : ''}
                                      {credit > 0 && fx && (
                                        <span className="block text-xs text-muted-foreground tabular-nums">{fx}</span>
                                      )}
                                    </TableCell>
                                  </TableRow>
                                )
                              })}
                          </TableBody>
                          <TableFooter>
                            <TableRow>
                              <TableCell colSpan={2} className="font-medium">{t('sum_label')}</TableCell>
                              <TableCell className="text-right tabular-nums font-medium">
                                {lines.reduce((sum, l) => sum + (Number(l.debit_amount) || 0), 0).toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
                              </TableCell>
                              <TableCell className="text-right tabular-nums font-medium">
                                {lines.reduce((sum, l) => sum + (Number(l.credit_amount) || 0), 0).toLocaleString('sv-SE', { minimumFractionDigits: 2 })}
                              </TableCell>
                            </TableRow>
                          </TableFooter>
                        </Table>
                      </div>
                    )}

                    {entry.notes && (
                      <p className="mt-3 text-xs text-muted-foreground italic px-1">
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
                        }}
                      />
                    )}

                    <div className="mt-4 pt-3 border-t flex flex-col sm:flex-row gap-2">
                      {entry.status === 'draft' && (
                        <Button
                          size="sm"
                          className="w-full sm:w-auto"
                          onClick={() => handleCommit(entry.id)}
                          disabled={!canWrite || committingId === entry.id}
                          title={!canWrite ? t('read_only_tooltip') : undefined}
                        >
                          {!canWrite ? <Lock className="mr-2 h-4 w-4" /> : committingId === entry.id && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                          {t('post')}
                        </Button>
                      )}
                      <Button variant="outline" size="sm" className="w-full sm:w-auto" asChild>
                        <Link href={`/bookkeeping/${entry.id}`}>{t('show_details')}</Link>
                      </Button>
                      {entry.status === 'posted' && entry.source_type !== 'storno' && entry.source_type !== 'correction' && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full sm:w-auto"
                          onClick={() => setCorrectionEntry(entry)}
                        >
                          {t('create_correction')}
                        </Button>
                      )}
                      {canWrite && entry.status === 'posted' && entry.source_type !== 'storno' && entry.source_type !== 'correction' && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="w-full sm:w-auto"
                          onClick={() => setReverseEntryTarget(entry)}
                        >
                          <RotateCcw className="mr-2 h-4 w-4" />
                          {t('reverse_action')}
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        className="w-full sm:w-auto"
                        onClick={() => router.push(`/bookkeeping?copy_from=${entry.id}`)}
                      >
                        <Copy className="mr-2 h-4 w-4" />
                        {t('copy')}
                      </Button>
                    </div>
                  </>
                ) : undefined
              }
            >
              {/* Desktop: single row */}
              <div className="hidden sm:flex items-center gap-3">
                {isExpanded ? (
                  <ChevronDown className="h-4 w-4 shrink-0" />
                ) : (
                  <ChevronRight className="h-4 w-4 shrink-0" />
                )}
                <Link
                  href={`/bookkeeping/${entry.id}`}
                  className="font-mono text-sm text-primary hover:underline w-16"
                  onClick={(e) => e.stopPropagation()}
                >
                  {formatVoucher(entry)}
                </Link>
                <span className="text-sm text-muted-foreground tabular-nums w-24">
                  {formatDate(entry.entry_date)}
                </span>
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
                <span className="flex-1 truncate">{entry.description}</span>
                <span className="shrink-0 w-28 text-right tabular-nums text-sm font-medium">
                  {formatCurrency(voucherTotal, 'SEK', { minimumFractionDigits: 2 })}
                </span>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    asChild
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 text-muted-foreground transition-colors duration-150 hover:bg-secondary"
                  >
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={t('copy_voucher_tooltip')}
                      title={t('copy_voucher_tooltip')}
                      onClick={(e) => {
                        e.preventDefault()
                        e.stopPropagation()
                        router.push(`/bookkeeping?copy_from=${entry.id}`)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault()
                          e.stopPropagation()
                          router.push(`/bookkeeping?copy_from=${entry.id}`)
                        }
                      }}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </span>
                  </Button>
                  {/* Fixed-width attachment slot keeps the copy icon in a stable
                      column and the right edge aligned whether a row has a
                      paperclip, a warning, or nothing. */}
                  <span className="flex min-w-10 items-center justify-center">
                    {attachmentCounts[entry.id] ? (
                      <Button
                        asChild
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground transition-colors duration-150 hover:bg-secondary"
                      >
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label={t('view_attachments')}
                          title={t('attachment_count_tooltip', { count: attachmentCounts[entry.id] })}
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setPreviewEntryId(entry.id)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              e.stopPropagation()
                              setPreviewEntryId(entry.id)
                            }
                          }}
                        >
                          <span className="flex items-center gap-0.5">
                            <Paperclip className="h-3.5 w-3.5" />
                            <span className="text-xs">{attachmentCounts[entry.id]}</span>
                          </span>
                        </span>
                      </Button>
                    ) : (
                      NEEDS_ATTACHMENT.has(entry.source_type) && entry.status === 'posted' && (
                        noDocRequired.has(entry.id) ? (
                          <span title={t('no_doc_required_indicator_tooltip')}>
                            <CircleSlash className="h-3.5 w-3.5 text-muted-foreground" />
                          </span>
                        ) : (
                          <span title={t('missing_attachment_tooltip')}>
                            <AlertTriangle className="h-3.5 w-3.5 text-warning-foreground" />
                          </span>
                        )
                      )
                    )}
                  </span>
                </div>
              </div>
              {/* Mobile: two rows */}
              <div className="sm:hidden">
                <div className="flex items-center gap-2">
                  {isExpanded ? (
                    <ChevronDown className="h-4 w-4 shrink-0" />
                  ) : (
                    <ChevronRight className="h-4 w-4 shrink-0" />
                  )}
                  <Link
                    href={`/bookkeeping/${entry.id}`}
                    className="font-mono text-sm text-primary hover:underline"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {formatVoucher(entry)}
                  </Link>
                  <span className="text-sm text-muted-foreground tabular-nums">
                    {formatDate(entry.entry_date)}
                  </span>
                  {entry.out_of_period && (
                    <Badge
                      variant="outline"
                      className="text-xs font-normal shrink-0"
                      title={t('out_of_period_tooltip_mobile')}
                    >
                      {t('out_of_period_label')}
                    </Badge>
                  )}
                  {(entry.status === 'reversed' || entry.status === 'draft' || entry.source_type === 'storno' || entry.source_type === 'correction') && (
                    <JournalEntryStatusBadge entry={entry} showStatus={entry.status === 'reversed' || entry.status === 'draft'} />
                  )}
                  <span className="ml-auto flex items-center gap-1">
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8 text-muted-foreground transition-colors duration-150 hover:bg-secondary"
                    >
                      <span
                        role="button"
                        tabIndex={0}
                        aria-label={t('copy_voucher_tooltip')}
                        title={t('copy_voucher_tooltip')}
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          router.push(`/bookkeeping?copy_from=${entry.id}`)
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault()
                            e.stopPropagation()
                            router.push(`/bookkeeping?copy_from=${entry.id}`)
                          }
                        }}
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </span>
                    </Button>
                    {attachmentCounts[entry.id] ? (
                      <Button
                        asChild
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8 text-muted-foreground transition-colors duration-150 hover:bg-secondary"
                      >
                        <span
                          role="button"
                          tabIndex={0}
                          aria-label={t('view_attachments')}
                          title={t('attachment_count_tooltip', { count: attachmentCounts[entry.id] })}
                          onClick={(e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setPreviewEntryId(entry.id)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              e.stopPropagation()
                              setPreviewEntryId(entry.id)
                            }
                          }}
                        >
                          <span className="flex items-center gap-0.5">
                            <Paperclip className="h-3.5 w-3.5" />
                            <span className="text-xs">{attachmentCounts[entry.id]}</span>
                          </span>
                        </span>
                      </Button>
                    ) : (
                      NEEDS_ATTACHMENT.has(entry.source_type) && entry.status === 'posted' && (
                        noDocRequired.has(entry.id) ? (
                          <span title={t('no_doc_required_indicator_tooltip')}>
                            <CircleSlash className="h-3.5 w-3.5 text-muted-foreground" />
                          </span>
                        ) : (
                          <span title={t('missing_attachment_tooltip')}>
                            <AlertTriangle className="h-3.5 w-3.5 text-warning-foreground" />
                          </span>
                        )
                      )
                    )}
                  </span>
                </div>
                <div className="mt-1 ml-6 flex items-center justify-between gap-2">
                  <p className="text-sm truncate">{entry.description}</p>
                  <span className="shrink-0 tabular-nums text-sm font-medium">
                    {formatCurrency(voucherTotal, 'SEK', { minimumFractionDigits: 2 })}
                  </span>
                </div>
              </div>
            </DataListRow>
          )
        })}
      </DataList>
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
          ('all' included) is active — so a user who narrowed the list below the
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

          {/* Page navigation — hidden when showing all or when everything fits on one page */}
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
