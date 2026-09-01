'use client'

import { Fragment, useState, useEffect, useMemo, useRef } from 'react'
import { useCompanySettings } from '@/lib/reference-data/hooks'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { RowStatus, type RowStatusDescriptor } from '@/components/ui/row-status'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { Skeleton } from '@/components/ui/skeleton'
import { Dialog, DialogContent, DialogTitle, DialogVeil } from '@/components/ui/dialog'
import { DataListEmpty } from '@/components/ui/data-list'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS, CHECKBOX_REVEAL_CLASS } from '@/components/ui/dry-table'
import { useRangeSelect } from '@/lib/hooks/use-range-select'
import { FyPicker } from '@/components/common/FyPicker'
import { ContextPicker } from '@/components/common/ContextPicker'
import { SplitButton, type SplitButtonOption } from '@/components/ui/split-button'
import { useUiState } from '@/lib/hooks/use-ui-state'
import { resolveInitialMode } from '@/lib/ui-state/client'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { invoiceDisplayNumber } from '@/lib/invoices/display'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import {
  sortInvoiceList,
  type InvoiceListSort,
  type InvoiceListSortColumn,
} from '@/lib/invoices/invoice-list-sort'
import { listContextKey, writeListContext } from '@/lib/navigation/list-context'
import {
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  Plus,
  ReceiptText,
  Repeat,
  FileInput,
  FileDown,
} from 'lucide-react'
import { StartCard } from '@/components/dashboard/StartCard'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { FiscalPeriod, Invoice } from '@/types'

function NewInvoiceDialogLoading() {
  const t = useTranslations('invoices')
  // Non-modal + veil, matching NewInvoiceDialog: a modal fallback would lock
  // the whole route (body pointer-events: none, no close path) if this chunk
  // ever hangs or 404s on a stale deploy, and would dead-click the agent
  // sheet meanwhile.
  return (
    <Dialog open modal={false}>
      <DialogVeil />
      <DialogContent className="sm:max-w-3xl">
        <DialogTitle>{t('new_invoice')}</DialogTitle>
        <div className="space-y-4 py-4" role="status">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-24 w-full" />
          <Skeleton className="h-10 w-40" />
        </div>
      </DialogContent>
    </Dialog>
  )
}

const NewInvoiceDialog = dynamic(
  () => import('@/components/invoices/NewInvoiceDialog'),
  { loading: NewInvoiceDialogLoading },
)

const RotRutPayoutDialog = dynamic(
  () => import('@/components/invoices/RotRutPayoutDialog'),
)

const INITIAL_VISIBLE_ROWS = 100

const CREATE_MODES = ['faktura', 'aterkommande', 'sjalvfaktura'] as const

// Main views (concept seg) and the low-frequency views behind "Fler …".
const SEG_TABS = ['all', 'unpaid', 'overdue', 'draft'] as const
const MORE_TABS = ['paid', 'proforma', 'delivery_note', 'credit', 'cancelled'] as const
const ALL_TABS = [...SEG_TABS, ...MORE_TABS]
type ListTab = (typeof SEG_TABS)[number] | (typeof MORE_TABS)[number]

// The one status predicate: both the visible rows and the per-view counts in
// the ContextPicker go through it, so the annotation always matches what the
// view will show.
function matchesListTab(invoice: Invoice, tab: ListTab): boolean {
  const isCreditNote = !!invoice.credited_invoice_id
  const docType = (invoice as Invoice & { document_type?: string }).document_type || 'invoice'
  return (
    (tab === 'all' && invoice.status !== 'cancelled') ||
    (tab === 'unpaid' &&
      ['sent', 'overdue'].includes(invoice.status) &&
      !isCreditNote &&
      docType === 'invoice') ||
    (tab === 'overdue' &&
      invoice.status === 'overdue' &&
      !isCreditNote &&
      docType === 'invoice') ||
    (tab === 'draft' &&
      invoice.status === 'draft' &&
      docType === 'invoice' &&
      !isCreditNote) ||
    (tab === 'paid' && invoice.status === 'paid') ||
    (tab === 'credit' && isCreditNote) ||
    (tab === 'proforma' && docType === 'proforma' && invoice.status !== 'cancelled') ||
    (tab === 'delivery_note' &&
      docType === 'delivery_note' &&
      invoice.status !== 'cancelled') ||
    (tab === 'cancelled' && invoice.status === 'cancelled')
  )
}

// Row grouping: sections in the table body. 'status' is the default and
// mirrors the supplier-invoices layout (payment queue as its own section).
const GROUP_MODES = ['status', 'customer', 'month', 'none'] as const
type GroupMode = (typeof GROUP_MODES)[number]
const GROUP_LABEL_KEYS: Record<GroupMode, string> = {
  status: 'group_status',
  customer: 'group_customer',
  month: 'group_month',
  none: 'group_none',
}

type StatusGroup = 'drafts' | 'awaiting' | 'settled'
function statusGroupOf(invoice: Invoice): StatusGroup {
  if (invoice.status === 'draft') return 'drafts'
  const isCreditNote = !!invoice.credited_invoice_id
  const docType = (invoice as Invoice & { document_type?: string }).document_type || 'invoice'
  if (
    ['sent', 'overdue', 'partially_paid'].includes(invoice.status) &&
    !isCreditNote &&
    docType === 'invoice'
  ) {
    return 'awaiting'
  }
  return 'settled'
}

const TAB_LABEL_KEYS: Record<ListTab, string> = {
  all: 'tab_all',
  unpaid: 'tab_unpaid',
  overdue: 'tab_overdue',
  draft: 'tab_draft',
  paid: 'tab_paid',
  proforma: 'tab_proforma',
  delivery_note: 'tab_delivery_note',
  credit: 'tab_credit',
  cancelled: 'tab_cancelled',
}

function daysOverdue(dueDateStr: string): number {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const dueDate = new Date(dueDateStr)
  dueDate.setHours(0, 0, 0, 0)
  return Math.round((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
}

interface SortableHeaderProps {
  label: string
  sortLabel: string
  column: InvoiceListSortColumn
  sort: InvoiceListSort | null
  onSort: (column: InvoiceListSortColumn) => void
  className?: string
  align?: 'left' | 'right'
}

function SortableHeader({
  label,
  sortLabel,
  column,
  sort,
  onSort,
  className,
  align = 'left',
}: SortableHeaderProps) {
  const active = sort?.column === column
  const direction = active ? sort.direction : null
  const SortIcon = direction === 'asc' ? ArrowUp : direction === 'desc' ? ArrowDown : ArrowUpDown

  return (
    <th
      className={cn(TH_CLASS, className)}
      aria-sort={direction === 'asc' ? 'ascending' : direction === 'desc' ? 'descending' : 'none'}
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
        onClick={() => onSort(column)}
      >
        <span>{label}</span>
        <SortIcon
          aria-hidden="true"
          className={cn('h-3.5 w-3.5 shrink-0', !active && 'text-muted-foreground/60')}
        />
      </button>
    </th>
  )
}

export default function InvoicesPage() {
  const { company } = useCompany()
  const { canWrite } = useCanWrite()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [invoices, setInvoices] = useState<Invoice[]>([])
  // Settings-driven gates from the session-cached settings row
  // (lib/reference-data), derived instead of copied into state.
  const { settings: companySettings } = useCompanySettings()
  const oreRounding: boolean = companySettings?.ore_rounding ?? true
  const rotRutEnabled: boolean = companySettings?.rot_rut_enabled ?? false
  // Booking mode drives which rows are bulk-bookable (kontantmetoden: none).
  const accountingMethod: string = companySettings?.accounting_method ?? 'accrual'
  const deferInvoiceBooking: boolean = companySettings?.defer_invoice_booking ?? false
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // Radix' onCheckedChange carries no mouse event: the preceding click records
  // whether shift was held, for range selection.
  const shiftHeld = useRef(false)
  const [showBulkBookConfirm, setShowBulkBookConfirm] = useState(false)
  const [isBulkBooking, setIsBulkBooking] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [searchTerm, setSearchTerm] = useState('')
  const [sort, setSort] = useState<InvoiceListSort | null>(null)
  const [activeTab, setActiveTab] = useState<ListTab>(() => {
    // Deep links from the worklist and older bookmarks: ?status= / ?tab=.
    const param = searchParams.get('status') ?? searchParams.get('tab')
    const alias: Record<string, ListTab> = { drafts: 'draft' }
    const candidate = param ? (alias[param] ?? (param as ListTab)) : null
    return candidate && ALL_TABS.includes(candidate as never)
      ? (candidate as ListTab)
      : 'all'
  })
  const [groupMode, setGroupMode] = useState<GroupMode>(() => {
    const param = searchParams.get('group')
    return param && GROUP_MODES.includes(param as never) ? (param as GroupMode) : 'status'
  })
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE_ROWS)
  // Fiscal-year scope (convention 8): null = all years.
  const [fyPeriodId, setFyPeriodId] = useState<string | null>(null)
  const [fyPeriod, setFyPeriod] = useState<FiscalPeriod | null>(null)
  const { toast } = useToast()
  const supabase = createClient()
  const t = useTranslations('invoices')
  const locale = useLocale()
  const tCommon = useTranslations('common')
  const tStart = useTranslations('start_cards')
  const { uiState, loaded: uiStateLoaded } = useUiState()

  // The "Ny faktura" modal is driven by the URL (?new=1) so every entry point
  // (the header button, empty states, the command palette, and the legacy
  // /invoices/new redirect) opens the same dialog, and the browser back
  // button closes it. No canWrite gate here: like the old /invoices/new page,
  // the editor itself disables submission for viewers. ?self=1 preselects the
  // självfaktura tab (split-button entry).
  const copyFromId = searchParams.get('copy')
  const showNewInvoice = searchParams.has('new') || copyFromId !== null
  const openSelfBilled = searchParams.has('self')
  const showRotRutPayout = searchParams.has('rot-rut')
  // Open/close handlers rewrite only their own keys: a hardcoded '/invoices'
  // would destroy the ?status= view write-back (and any other params) every
  // time a dialog opens or closes.
  const invoicesUrl = (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString())
    mutate(params)
    const qs = params.toString()
    return qs ? `/invoices?${qs}` : '/invoices'
  }
  const closeNewInvoice = () =>
    router.replace(
      invoicesUrl((p) => {
        p.delete('new')
        p.delete('self')
        p.delete('copy')
      }),
      { scroll: false },
    )
  const openNewInvoice = () =>
    router.push(invoicesUrl((p) => p.set('new', '1')), { scroll: false })
  const openNewSelfBilled = () =>
    router.push(
      invoicesUrl((p) => {
        p.set('new', '1')
        p.set('self', '1')
      }),
      { scroll: false },
    )
  const closeRotRutPayout = () =>
    router.replace(invoicesUrl((p) => p.delete('rot-rut')), { scroll: false })
  const openRotRutPayout = () =>
    router.push(invoicesUrl((p) => p.set('rot-rut', '1')), { scroll: false })

  // Begäran om utbetalning (Lag 2009:194 8 §) only concerns companies selling
  // ROT/RUT-eligible work to consumers, so the action stays out of the header
  // for everyone else. It appears once the company has invoiced a deduction
  // (the payout can never precede that invoice), or once ROT/RUT is opted into
  // in tax settings. Not scoped to the fiscal-year filter: a payout is claimed
  // the year after payment, so last year's invoices are exactly the relevant
  // ones. ?rot-rut=1 keeps working regardless, so nothing is unreachable.
  const showRotRutAction =
    rotRutEnabled || invoices.some((invoice) => (invoice.deduction_total ?? 0) > 0)

  async function fetchInvoices() {
    if (!company) return
    // Skeleton takeover only while nothing is on screen: refetches after an
    // action (bulk Bokför) reconcile BEHIND the rendered table. Collapsing
    // hundreds of rows to 3 skeleton stubs and replaying the stagger-enter
    // entrance for a row-scoped action was the "booking feels glitchy" jump.
    if (invoices.length === 0) setIsLoading(true)
    const [invoicesResult] = await Promise.allSettled([
      fetchAllRows<Invoice>(
        ({ from, to }) =>
          supabase
            .from('invoices')
            .select('*, customer:customers(name)')
            .eq('company_id', company.id)
            .order('invoice_date', { ascending: false })
            .order('id', { ascending: false })
            .range(from, to),
        { dedupeBy: (invoice) => invoice.id },
      ),
    ])

    if (invoicesResult.status === 'rejected') {
      toast({
        title: t('load_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
    } else {
      setInvoices(invoicesResult.value)
    }
    setIsLoading(false)
  }

  useEffect(() => {
    fetchInvoices()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const normalizedSearch = searchTerm.trim().toLocaleLowerCase('sv-SE')
  // Search + fiscal-year scope, before the status view: the per-view counts
  // in the ContextPicker are computed on this same base so they always equal
  // the rows the view would show.
  const scopedInvoices = useMemo(
    () =>
      invoices.filter((invoice) => {
        const matchesSearch =
          (invoice.invoice_number ?? '').toLocaleLowerCase('sv-SE').includes(normalizedSearch) ||
          (invoice.external_invoice_number ?? '')
            .toLocaleLowerCase('sv-SE')
            .includes(normalizedSearch) ||
          (invoice.customer as { name: string })?.name
            ?.toLocaleLowerCase('sv-SE')
            .includes(normalizedSearch)

        const matchesFy =
          !fyPeriod ||
          (invoice.invoice_date >= fyPeriod.period_start &&
            invoice.invoice_date <= fyPeriod.period_end)

        return matchesSearch && matchesFy
      }),
    [fyPeriod, invoices, normalizedSearch],
  )
  const filteredInvoices = useMemo(
    () => scopedInvoices.filter((invoice) => matchesListTab(invoice, activeTab)),
    [activeTab, scopedInvoices],
  )
  const sortedInvoices = useMemo(
    () => (sort ? sortInvoiceList(filteredInvoices, sort, oreRounding) : filteredInvoices),
    [filteredInvoices, oreRounding, sort],
  )
  // Grouping: bucket the sorted rows, keep the sort order inside each
  // bucket, and flatten back to one list so paging and the detail pager
  // walk the exact rendered order.
  const { flatRows, groupMeta } = useMemo(() => {
    if (groupMode === 'none') {
      return {
        flatRows: sortedInvoices.map((invoice) => ({ invoice, groupKey: null as string | null })),
        groupMeta: new Map<string, { label: string; count: number }>(),
      }
    }
    const buckets = new Map<string, { label: string; rows: Invoice[] }>()
    for (const invoice of sortedInvoices) {
      let key: string
      let label: string
      if (groupMode === 'status') {
        key = statusGroupOf(invoice)
        label = key
      } else if (groupMode === 'customer') {
        label = (invoice.customer as { name: string })?.name ?? '—'
        // Bucket by id, not display name: two customers can share a name.
        key = invoice.customer_id ?? label
      } else {
        key = (invoice.invoice_date ?? '').slice(0, 7) || '—'
        label = key
      }
      const bucket = buckets.get(key) ?? { label, rows: [] }
      bucket.rows.push(invoice)
      buckets.set(key, bucket)
    }
    let keys = [...buckets.keys()]
    if (groupMode === 'status') {
      keys = (['drafts', 'awaiting', 'settled'] as const).filter((key) => buckets.has(key))
    } else if (groupMode === 'customer') {
      keys.sort((a, b) => (buckets.get(a)?.label ?? a).localeCompare(buckets.get(b)?.label ?? b, 'sv'))
    } else {
      keys.sort((a, b) => b.localeCompare(a))
    }
    const flat: Array<{ invoice: Invoice; groupKey: string | null }> = []
    const meta = new Map<string, { label: string; count: number }>()
    for (const key of keys) {
      const bucket = buckets.get(key)!
      meta.set(key, { label: bucket.label, count: bucket.rows.length })
      for (const invoice of bucket.rows) flat.push({ invoice, groupKey: key })
    }
    return { flatRows: flat, groupMeta: meta }
  }, [groupMode, sortedInvoices])

  const visibleRows = flatRows.slice(0, visibleCount)
  // Status sections only earn headers when there is more than one of them;
  // customer/month grouping is an explicit ask, so headers always show.
  const showGroupHeaders = groupMode !== 'none' && (groupMode !== 'status' || groupMeta.size > 1)

  const monthFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'sv-SE', { month: 'long', year: 'numeric' }),
    [locale],
  )
  function groupHeaderLabel(key: string): string {
    const meta = groupMeta.get(key)
    const count = meta?.count ?? 0
    if (groupMode === 'status') {
      if (key === 'drafts') return t('section_drafts', { count })
      if (key === 'awaiting') return t('section_awaiting', { count })
      return t('section_settled', { count })
    }
    if (groupMode === 'month' && key !== '—') {
      const label = monthFormatter.format(new Date(`${key}-01T00:00:00`))
      return `${label.charAt(0).toLocaleUpperCase('sv-SE')}${label.slice(1)} (${count})`
    }
    return `${meta?.label ?? key} (${count})`
  }

  // Detail-pager context: the FULL grouped list (not the visible slice), so
  // prev/next on the detail page can walk past the paging boundary.
  const rememberListContext = () => {
    writeListContext(listContextKey('invoices', company?.id), {
      ids: flatRows.map((row) => row.invoice.id),
    })
  }

  const tabCounts = useMemo(() => {
    const counts = Object.fromEntries(ALL_TABS.map((tab) => [tab, 0])) as Record<ListTab, number>
    for (const invoice of scopedInvoices) {
      for (const tab of ALL_TABS) {
        if (matchesListTab(invoice, tab)) counts[tab] += 1
      }
    }
    return counts
  }, [scopedInvoices])

  const resetPaging = () => setVisibleCount(INITIAL_VISIBLE_ROWS)

  // Tri-state cycle: asc → desc → back to the default order (invoice date
  // desc), so an applied sort can always be released, also inside groups.
  const updateSort = (column: InvoiceListSortColumn) => {
    setSort((current) => {
      if (current?.column !== column) return { column, direction: 'asc' }
      return current.direction === 'asc' ? { column, direction: 'desc' } : null
    })
    resetPaging()
  }

  // Write the active view back to the URL (?status=) so views are shareable
  // and survive back-navigation; the mount parser above already reads it.
  // replace, not push: filter flips shouldn't stack history entries.
  const updateTab = (tab: ListTab) => {
    setActiveTab(tab)
    resetPaging()
    const params = new URLSearchParams(searchParams.toString())
    params.delete('tab')
    if (tab === 'all') params.delete('status')
    else params.set('status', tab)
    const qs = params.toString()
    router.replace(qs ? `/invoices?${qs}` : '/invoices', { scroll: false })
  }

  const updateGroup = (mode: GroupMode) => {
    setGroupMode(mode)
    resetPaging()
    const params = new URLSearchParams(searchParams.toString())
    if (mode === 'status') params.delete('group')
    else params.set('group', mode)
    const qs = params.toString()
    router.replace(qs ? `/invoices?${qs}` : '/invoices', { scroll: false })
  }

  // Bulk Bokför eligibility. Kontantmetoden books at payment, so no row is
  // selectable (the checkbox column is hidden entirely). Accrual companies
  // that book at issue select drafts ("Bokför och markera som skickade");
  // deferred companies (#967) select sent/overdue invoices that lack a
  // verifikat (worklist-canonical predicate: journal_entry_id IS NULL).
  const bulkMode: 'issue' | 'deferred' | null =
    accountingMethod !== 'accrual' ? null : deferInvoiceBooking ? 'deferred' : 'issue'
  const showSelection = canWrite && bulkMode !== null

  const isBulkSelectable = (invoice: Invoice): boolean => {
    if (!bulkMode) return false
    const docType = (invoice as Invoice & { document_type?: string }).document_type || 'invoice'
    if (docType !== 'invoice' || invoice.credited_invoice_id) return false
    if (bulkMode === 'issue') return invoice.status === 'draft'
    return ['sent', 'overdue'].includes(invoice.status) && !invoice.journal_entry_id
  }

  const selectableInvoices = filteredInvoices.filter(isBulkSelectable)
  const allSelectableSelected =
    selectableInvoices.length > 0 && selectableInvoices.every((inv) => selectedIds.has(inv.id))

  // Ranges walk the selectable rows that are actually rendered: the list is
  // sorted and cut at visibleCount, so rows below the fold are not in range.
  const range = useRangeSelect({
    visibleIds: visibleInvoices.filter(isBulkSelectable).map((inv) => inv.id),
    selectedIds,
    setSelectedIds,
  })

  function toggleSelect(id: string, extend?: boolean) {
    range.toggle(id, extend)
  }

  const selectedInvoices = invoices.filter((inv) => selectedIds.has(inv.id))
  const selectedDraftCount = selectedInvoices.filter((inv) => inv.status === 'draft').length
  const selectedSentCount = selectedInvoices.length - selectedDraftCount

  async function handleBulkBook() {
    if (selectedIds.size === 0) return
    setIsBulkBooking(true)
    try {
      const res = await fetch('/api/invoices/bulk-book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selectedIds) }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(getErrorMessage(json, { statusCode: res.status }))

      const summary = json.data?.summary as { booked: number; failed: number } | undefined
      const results = (json.data?.results ?? []) as Array<{ status: string; error?: string }>

      // One aggregate toast (TOAST_LIMIT is 1), never per-row.
      if (summary && summary.failed > 0) {
        const firstErrors = results
          .filter((r) => r.status === 'failed' && r.error)
          .slice(0, 2)
          .map((r) => r.error as string)
        toast({
          title: t('bulk_book_partial_title'),
          description: [
            t('bulk_book_partial_description', {
              booked: summary.booked,
              failed: summary.failed,
            }),
            ...firstErrors,
          ].join(' '),
          variant: 'destructive',
        })
      } else {
        toast({
          title: t('bulk_book_success_title'),
          description: t('bulk_book_success_description', {
            count: summary?.booked ?? selectedIds.size,
          }),
        })
      }
      setShowBulkBookConfirm(false)
      setSelectedIds(new Set())
      fetchInvoices()
    } catch (err) {
      toast({
        title: t('bulk_book_failed_title'),
        description: getErrorMessage(err),
        variant: 'destructive',
      })
    } finally {
      setIsBulkBooking(false)
    }
  }

  const createOptions: SplitButtonOption[] = [
    {
      key: 'faktura',
      label: t('new_invoice'),
      icon: Plus,
      description: t('create_invoice_desc'),
      disabled: !canWrite,
      disabledTitle: t('viewer_disabled_tooltip'),
      onSelect: () => openNewInvoice(),
    },
    {
      key: 'aterkommande',
      label: t('create_recurring'),
      icon: Repeat,
      description: t('create_recurring_desc'),
      onSelect: () => router.push('/invoices/recurring'),
    },
    {
      key: 'sjalvfaktura',
      label: t('create_self'),
      icon: FileInput,
      description: t('create_self_desc'),
      disabled: !canWrite,
      disabledTitle: t('viewer_disabled_tooltip'),
      onSelect: () => openNewSelfBilled(),
    },
  ]

  // One derivable status chip per row (concept scene 15). Doc-type markers
  // (proforma/följesedel/självfaktura) only appear in views where the type
  // isn't already implied.
  function statusDescriptor(invoice: Invoice): RowStatusDescriptor {
    const isCreditNote = !!invoice.credited_invoice_id
    if (invoice.status === 'cancelled') {
      return { label: t('status_cancelled'), exception: true, variant: 'secondary' }
    }
    if (isCreditNote && invoice.status !== 'paid') {
      return { label: t('badge_credit'), exception: true, variant: 'destructive' }
    }
    if (invoice.status === 'credited') {
      return { label: t('status_credited'), exception: true, variant: 'secondary' }
    }
    if (invoice.status === 'draft') {
      const docType = (invoice as Invoice & { document_type?: string }).document_type || 'invoice'
      const isUnsent =
        !!invoice.invoice_number && docType === 'invoice' && !isCreditNote && !invoice.is_self_billed
      return isUnsent
        ? { label: t('status_unsent'), exception: true, variant: 'outline' }
        : { label: t('status_draft'), exception: true, variant: 'secondary' }
    }
    if (invoice.status === 'paid') {
      return {
        label: invoice.paid_at
          ? t('status_paid_date', { date: formatDate(invoice.paid_at) })
          : t('status_paid'),
      }
    }
    if (invoice.status === 'partially_paid') {
      return { label: t('status_partially_paid'), exception: true, variant: 'warning' }
    }
    if (invoice.status === 'overdue' && invoice.due_date) {
      return {
        label: t('status_overdue_days', { days: Math.max(1, daysOverdue(invoice.due_date)) }),
        exception: true,
        variant: 'warning',
      }
    }
    return { label: t('status_sent') }
  }

  return (
    <div className="space-y-8">
      {/* Page header (concept scene 15): title + invoice actions */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
        <div className="flex flex-wrap items-center gap-2">
          {showRotRutAction && (
            <Button
              type="button"
              variant="outline"
              onClick={openRotRutPayout}
              disabled={!canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              <FileDown className="mr-2 h-4 w-4" />
              {t('rot_rut_payout_action')}
            </Button>
          )}
          <SplitButton
            key={uiStateLoaded ? 'loaded' : 'initial'}
            persistKey="invoices"
            initialModeKey={resolveInitialMode(uiState, 'invoices', CREATE_MODES, 'faktura')}
            options={createOptions}
          />
        </div>
      </div>

      {/* Toolbar: one status chip-picker (founder direction: the status
          views live behind a filter chip, not a seg), sök, FyPicker far
          right. Counts ride as row annotations and on the trigger. */}
      <div className="flex flex-wrap items-center gap-2">
        <ContextPicker
          value={activeTab}
          onChange={(id) => updateTab(id as ListTab)}
          ariaLabel={t('status_picker_aria')}
          triggerLabel={
            tabCounts[activeTab] > 0
              ? `${t(TAB_LABEL_KEYS[activeTab])} · ${tabCounts[activeTab]}`
              : t(TAB_LABEL_KEYS[activeTab])
          }
          items={ALL_TABS.map((tab) => ({
            id: tab,
            label: t(TAB_LABEL_KEYS[tab]),
            annotation: tabCounts[tab] > 0 ? String(tabCounts[tab]) : undefined,
          }))}
        />
        <ContextPicker
          value={groupMode}
          onChange={(id) => updateGroup(id as GroupMode)}
          ariaLabel={t('group_picker_aria')}
          triggerLabel={`${t('group_by')} · ${t(GROUP_LABEL_KEYS[groupMode])}`}
          items={GROUP_MODES.map((mode) => ({
            id: mode,
            label: t(GROUP_LABEL_KEYS[mode]),
          }))}
        />
        <ToolbarSearch
          containerClassName="min-w-[190px]"
          placeholder={t('search_placeholder')}
          value={searchTerm}
          onChange={(e) => {
            setSearchTerm(e.target.value)
            resetPaging()
          }}
        />
        <div className="ml-auto">
          <FyPicker
            value={fyPeriodId}
            onChange={(periodId, period) => {
              setFyPeriodId(periodId)
              setFyPeriod(period ?? null)
              resetPaging()
            }}
            includeAllOption
          />
        </div>
      </div>

      {/* Bulkbar: appears once anything is selected (supplier-invoices shape). */}
      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-1 py-2 text-[12.5px] animate-fade-in">
          <span className="whitespace-nowrap">
            <strong className="font-semibold tabular-nums">{selectedIds.size}</strong>{' '}
            {t('bulkbar_selected', { count: selectedIds.size })}
          </span>
          <Button size="sm" onClick={() => setShowBulkBookConfirm(true)}>
            {bulkMode === 'issue'
              ? t('bulk_book_and_send_action', { count: selectedIds.size })
              : t('bulk_book_action', { count: selectedIds.size })}
          </Button>
          {/* Hidden when the current view has no selectable rows: a
              "Markera alla (0)" link would only wipe the selection. */}
          {selectableInvoices.length > 0 && !allSelectableSelected && (
            <button
              type="button"
              className={QUIET_LINK_CLASS}
              onClick={() => {
                setSelectedIds(new Set(selectableInvoices.map((inv) => inv.id)))
                range.resetAnchor()
              }}
            >
              {t('bulk_select_all', { count: selectableInvoices.length })}
            </button>
          )}
          <button
            type="button"
            className={QUIET_LINK_CLASS}
            onClick={() => {
              setSelectedIds(new Set())
              range.resetAnchor()
            }}
          >
            {t('bulk_clear')}
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-48 flex-1" />
              <Skeleton className="h-5 w-24" />
            </div>
          ))}
        </div>
      ) : filteredInvoices.length === 0 ? (
        searchTerm ? (
          <DataListEmpty
            icon={<ReceiptText className="h-6 w-6" />}
            title={t('no_search_results_title')}
            description={<span data-ph-mask="">{t('no_search_results_description', { term: searchTerm })}</span>}
          />
        ) : invoices.length === 0 ? (
          <div className="animate-fade-in">
            <StartCard
              card="venice"
              layout="center"
              title={tStart('invoices_title')}
              body={tStart('invoices_body')}
              primary={{ label: tStart('invoices_primary'), href: '/import?mode=migration' }}
              secondary={{ label: tStart('invoices_secondary'), onClick: openNewInvoice }}
            />
          </div>
        ) : (
          <DataListEmpty
            icon={<ReceiptText className="h-6 w-6" />}
            title={t('no_category_title')}
            description={t('no_category_description')}
          />
        )
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {showSelection && (
                  <th className={cn(TH_CLASS, 'w-[26px] !pl-1')} aria-hidden="true"></th>
                )}
                <SortableHeader
                  label={t('th_nr')}
                  sortLabel={t('sort_by', { column: t('th_nr') })}
                  column="number"
                  sort={sort}
                  onSort={updateSort}
                />
                <SortableHeader
                  label={t('th_customer')}
                  sortLabel={t('sort_by', { column: t('th_customer') })}
                  column="customer"
                  sort={sort}
                  onSort={updateSort}
                  className="w-full"
                />
                <SortableHeader
                  label={t('th_due')}
                  sortLabel={t('sort_by', { column: t('th_due') })}
                  column="due"
                  sort={sort}
                  onSort={updateSort}
                  className="hidden text-right sm:table-cell"
                  align="right"
                />
                <SortableHeader
                  label={t('th_amount')}
                  sortLabel={t('sort_by', { column: t('th_amount') })}
                  column="amount"
                  sort={sort}
                  onSort={updateSort}
                  className="text-right"
                  align="right"
                />
                <SortableHeader
                  label={t('th_status')}
                  sortLabel={t('sort_by', { column: t('th_status') })}
                  column="status"
                  sort={sort}
                  onSort={updateSort}
                />
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {visibleRows.map(({ invoice, groupKey }, index) => {
                const prevKey = index > 0 ? visibleRows[index - 1].groupKey : undefined
                const showHeader = showGroupHeaders && groupKey !== null && groupKey !== prevKey
                const status = statusDescriptor(invoice)
                const isCreditNote = !!invoice.credited_invoice_id
                const docType = (invoice as Invoice & { document_type?: string }).document_type || 'invoice'
                const displayedTotal = getDisplayTotal(
                  { total: Number(invoice.total), currency: invoice.currency, ore_rounding: invoice.ore_rounding },
                  { ore_rounding: oreRounding },
                ).displayed
                const number = invoice.is_self_billed
                  ? invoiceDisplayNumber(invoice)
                  : invoice.invoice_number
                // Doc-type marker only where the view doesn't already imply it.
                const typeMarker =
                  activeTab === 'all'
                    ? docType === 'proforma'
                      ? t('badge_proforma')
                      : docType === 'delivery_note'
                        ? t('badge_delivery_note')
                        : invoice.is_self_billed
                          ? t('badge_self_billed')
                          : null
                    : null
                return (
                  <Fragment key={invoice.id}>
                  {showHeader && (
                    <tr>
                      <td
                        colSpan={showSelection ? 6 : 5}
                        className={cn(
                          'border-b border-border px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground',
                          index === 0 ? 'pt-4' : 'pt-6',
                        )}
                      >
                        {groupHeaderLabel(groupKey)}
                      </td>
                    </tr>
                  )}
                  <tr
                    className={cn(
                      'group cursor-pointer transition-colors duration-150 hover:bg-secondary/35',
                      selectedIds.has(invoice.id) && 'bg-secondary/40',
                    )}
                    onClick={() => {
                      rememberListContext()
                      router.push(`/invoices/${invoice.id}`)
                    }}
                  >
                    {/* Hover-revealed selection checkbox (supplier-invoices shape). */}
                    {showSelection && (
                      <td
                        className={cn(TD_CLASS, 'w-[26px] !pl-1 py-[9px] select-none')}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {isBulkSelectable(invoice) && (
                          <Checkbox
                            checked={selectedIds.has(invoice.id)}
                            onClick={(e) => {
                              shiftHeld.current = e.shiftKey
                            }}
                            onCheckedChange={() => toggleSelect(invoice.id, shiftHeld.current)}
                            aria-label={t('bulk_select_row')}
                            className={cn(
                              'transition-opacity duration-150',
                              selectedIds.has(invoice.id) || selectedIds.size > 0
                                ? 'opacity-100'
                                : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100',
                            )}
                          />
                        )}
                      </td>
                    )}
                    <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>
                      <Link
                        href={`/invoices/${invoice.id}`}
                        className="hover:underline"
                        onClick={(e) => {
                          e.stopPropagation()
                          rememberListContext()
                        }}
                      >
                        {number ?? '·'}
                      </Link>
                    </td>
                    <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
                      <span className="block truncate">
                        {(invoice.customer as { name: string })?.name ?? '-'}
                      </span>
                    </td>
                    <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums text-muted-foreground sm:table-cell')}>
                      {invoice.due_date && !isCreditNote && invoice.status !== 'draft'
                        ? formatDate(invoice.due_date)
                        : ''}
                    </td>
                    <td
                      className={cn(
                        TD_CLASS,
                        'whitespace-nowrap text-right tabular-nums rr-mask',
                        isCreditNote && 'text-destructive',
                      )}
                      title={
                        invoice.currency !== 'SEK' && invoice.total_sek
                          ? formatCurrency(Number(invoice.total_sek))
                          : undefined
                      }
                    >
                      {formatCurrency(displayedTotal, invoice.currency)}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                      <span className="inline-flex items-center gap-1.5">
                        {typeMarker && (
                          <Badge variant="outline" className="font-normal">
                            {typeMarker}
                          </Badge>
                        )}
                        <RowStatus status={status} />
                      </span>
                    </td>
                  </tr>
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {!isLoading && visibleCount < flatRows.length && (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            onClick={() => setVisibleCount((count) => count + INITIAL_VISIBLE_ROWS)}
          >
            {tCommon('load_more')}
          </Button>
        </div>
      )}

      {showNewInvoice && (
        <NewInvoiceDialog
          open
          copyFromId={copyFromId}
          selfBilled={openSelfBilled}
          onOpenChange={(open) => {
            if (!open) closeNewInvoice()
          }}
        />
      )}
      {showRotRutPayout && (
        <RotRutPayoutDialog
          open
          canWrite={canWrite}
          onOpenChange={(open) => {
            if (!open) closeRotRutPayout()
          }}
        />
      )}

      {/* Confirm-before-posting (convention 10): bulk Bokför writes immutable
          verifikat, so describe the outcome first. */}
      <ConfirmationDialog
        open={showBulkBookConfirm}
        onOpenChange={(open) => {
          if (!isBulkBooking) setShowBulkBookConfirm(open)
        }}
        onConfirm={handleBulkBook}
        isSubmitting={isBulkBooking}
        title={t('bulk_book_confirm_title', { count: selectedIds.size })}
        warningText={t('bulk_book_confirm_warning')}
        confirmLabel={t('bulk_book_confirm_label')}
      >
        <div className="space-y-2 text-sm">
          {selectedDraftCount > 0 && (
            <p>{t('bulk_book_breakdown_drafts', { count: selectedDraftCount })}</p>
          )}
          {selectedSentCount > 0 && (
            <p>{t('bulk_book_breakdown_sent', { count: selectedSentCount })}</p>
          )}
        </div>
      </ConfirmationDialog>
    </div>
  )
}
