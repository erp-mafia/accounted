'use client'

import { Fragment, useMemo, useState, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { groupRows } from '@/lib/lists/group-rows'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { DataListEmpty } from '@/components/ui/data-list'
import { TH_CLASS, TD_CLASS, QUIET_LINK_CLASS, CHECKBOX_REVEAL_CLASS, HOVER_REVEAL_CLASS } from '@/components/ui/dry-table'
import { useRangeSelect } from '@/lib/hooks/use-range-select'
import { FyPicker } from '@/components/common/FyPicker'
import { ContextPicker } from '@/components/common/ContextPicker'
import { HelpPopover } from '@/components/ui/help-popover'
import { Plus, FileInput, Lock, ArrowUp, ArrowDown, ArrowUpDown } from 'lucide-react'
import Link from 'next/link'
import { DialogLoadingSkeleton } from '@/components/ui/dialog-loading-skeleton'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import {
  canApproveSupplierInvoice,
  canMarkSupplierInvoiceBankEntered,
} from '@/lib/supplier-invoices/lifecycle'
import {
  sortSupplierInvoiceList,
  type SupplierInvoiceListSort,
  type SupplierInvoiceListSortColumn,
} from '@/lib/supplier-invoices/supplier-invoice-list-sort'
import { listContextKey, writeListContext } from '@/lib/navigation/list-context'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import type { FiscalPeriod, SupplierInvoice } from '@/types'

const NewSupplierInvoiceDialog = dynamic(
  () => import('@/components/supplier-invoices/NewSupplierInvoiceDialog'),
  { loading: DialogLoadingSkeleton },
)

const PaymentFileDialog = dynamic(
  () => import('@/components/supplier-invoices/PaymentFileDialog'),
  { loading: DialogLoadingSkeleton },
)

// Rough client-side gate for the payment-file bulk selection: the statuses
// mark-paid accepts, SEK only, something left to pay, not a credit note. The
// preview re-evaluates server-side (payee, OCR, active batches), so this only
// decides which rows get a checkbox.
function isBatchSelectable(inv: SupplierInvoice): boolean {
  return (
    ['registered', 'approved', 'partially_paid', 'overdue'].includes(inv.status) &&
    !inv.is_credit_note &&
    inv.currency === 'SEK' &&
    inv.remaining_amount > 0.005
  )
}

// One derivable chip per row (concept scene 21): Registrerad is the "waiting
// for attest" state (outline), Godkänd the beige ready-to-pay state; paid is
// the sage exception-free end state.
const STATUS_VARIANTS: Record<string, 'default' | 'secondary' | 'success' | 'warning' | 'destructive' | 'outline'> = {
  registered: 'outline',
  approved: 'secondary',
  paid: 'success',
  partially_paid: 'warning',
  overdue: 'destructive',
  disputed: 'warning',
  credited: 'secondary',
  reversed: 'secondary',
}

const STATUS_LABEL_KEYS: Record<string, string> = {
  registered: 'status_registered',
  approved: 'status_approved',
  paid: 'status_paid',
  partially_paid: 'status_partially_paid',
  overdue: 'status_overdue',
  disputed: 'status_disputed',
  credited: 'status_credited',
  reversed: 'status_reversed',
}

const TABS = ['all', 'registered', 'approved', 'to_pay', 'paid'] as const
type ListTab = (typeof TABS)[number]

const TAB_LABEL_KEYS: Record<ListTab, string> = {
  all: 'tab_all',
  registered: 'tab_registered',
  approved: 'tab_approved',
  to_pay: 'tab_to_pay',
  paid: 'tab_paid',
}

// Same shape as the invoices list header (app/(dashboard)/invoices/page.tsx).
// Like the verifikat list (and unlike /invoices, which starts unsorted), this
// list has a meaningful default order (förfallodatum stigande from the API),
// so the click cycle is tri-state: asc → desc → back to the default.
interface SortableHeaderProps {
  label: string
  sortLabel: string
  column: SupplierInvoiceListSortColumn
  sort: SupplierInvoiceListSort | null
  onSort: (column: SupplierInvoiceListSortColumn) => void
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


// Row grouping (same pattern as the customer invoice list): 'none' (the flat
// list) is the default; the other modes are opt-in via ?group=, and 'status'
// reproduces the payment-queue sections.
/** Mirrors PAYABLE_STATUSES in lib/invoices/bulk-reconcile-supplier-vouchers.ts:
 *  a partially paid invoice still belongs in the payment queue. */
const AWAITING_PAYMENT_STATUSES = ['registered', 'approved', 'overdue', 'partially_paid']
const isAwaitingPayment = (status: string | null | undefined) =>
  !!status && AWAITING_PAYMENT_STATUSES.includes(status)
const STATUS_SECTION_ORDER = ['awaiting', 'settled'] as const
/** Sentinel bucket for rows with no supplier or no date. */
const UNKNOWN_GROUP_KEY = 'unknown'
const GROUP_MODES = ['status', 'supplier', 'month', 'none'] as const
type GroupMode = (typeof GROUP_MODES)[number]
const GROUP_LABEL_KEYS: Record<GroupMode, string> = {
  status: 'group_status',
  supplier: 'group_supplier',
  month: 'group_month',
  none: 'group_none',
}

export default function SupplierInvoicesPage() {
  const t = useTranslations('supplier_invoices')
  const locale = useLocale()
  const { canWrite } = useCanWrite()
  const { toast } = useToast()
  const router = useRouter()
  const searchParams = useSearchParams()
  const company = useCompanyOptional()?.company ?? null
  const [invoices, setInvoices] = useState<(SupplierInvoice & { supplier?: { id: string; name: string } })[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [activeTab, setActiveTab] = useState<ListTab>('all')
  const [searchTerm, setSearchTerm] = useState('')
  // null = the API's default order (förfallodatum stigande).
  const [sort, setSort] = useState<SupplierInvoiceListSort | null>(null)
  const [groupMode, setGroupMode] = useState<GroupMode>(() => {
    const param = searchParams.get('group')
    return param && GROUP_MODES.includes(param as never) ? (param as GroupMode) : 'none'
  })
  // Fiscal-year scope (convention 8): null = all years.
  const [fyPeriodId, setFyPeriodId] = useState<string | null>(null)
  const [fyPeriod, setFyPeriod] = useState<FiscalPeriod | null>(null)
  const [approvingId, setApprovingId] = useState<string | null>(null)
  // "Inlagd i banken" (#2220) in flight for one row: the bock disables while
  // the server confirms, so a double click cannot flip it twice.
  const [bankEnteringId, setBankEnteringId] = useState<string | null>(null)
  // Payment-file bulk selection + the "already in an active betalfil" chip map.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // Radix' onCheckedChange carries no mouse event: the preceding click records
  // whether shift was held, for range selection.
  const shiftHeld = useRef(false)
  const [activeBatchInvoiceIds, setActiveBatchInvoiceIds] = useState<Set<string>>(new Set())
  const [showPaymentDialog, setShowPaymentDialog] = useState(false)

  // The "Registrera leverantörsfaktura" modal is driven by the URL (?new=1,
  // optionally with inbox_item_id for the invoice-inbox conversion flow) so
  // every entry point (the header button, the empty state, the command
  // palette, and the legacy /supplier-invoices/new redirect) opens the same
  // dialog, and the browser back button closes it.
  const showNewInvoice = searchParams.has('new')
  const inboxItemId = searchParams.get('inbox_item_id')
  const closeNewInvoice = () => router.replace('/supplier-invoices', { scroll: false })
  const openNewInvoice = () => router.push('/supplier-invoices?new=1', { scroll: false })

  async function fetchInvoices() {
    // Skeleton takeover only while nothing is on screen: refetches after an
    // action (register, betalfil, approve fallback) reconcile BEHIND the
    // rendered table instead of collapsing it to 4 skeleton stubs and
    // replaying the entrance animation.
    if (invoices.length === 0) setIsLoading(true)
    try {
      const res = await fetch('/api/supplier-invoices?status=all')
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const { data } = await res.json()
      setInvoices(data || [])
    } catch {
      // Without this, a failed fetch either stuck the skeleton forever or
      // silently rendered the empty state as if the invoices were gone.
      toast({
        title: t('load_failed_title'),
        description: t('load_failed_description'),
        variant: 'destructive',
      })
    } finally {
      setIsLoading(false)
    }
  }

  // Which invoices already sit in an active (not cancelled) betalfil: feeds
  // the "I betalfil" chip. Non-blocking; the list renders without it.
  async function fetchActiveBatchMembership() {
    try {
      const res = await fetch('/api/supplier-invoices/payment-batches?status=created')
      if (!res.ok) return
      const { data } = await res.json()
      const ids = new Set<string>()
      for (const batch of (data ?? []) as Array<{ supplier_invoice_ids?: string[] }>) {
        for (const id of batch.supplier_invoice_ids ?? []) ids.add(id)
      }
      setActiveBatchInvoiceIds(ids)
    } catch {
      // Chip data only; the list stays functional without it.
    }
  }

  useEffect(() => {
    fetchInvoices()
    fetchActiveBatchMembership()
    // Mount-only fetch (same pattern as /invoices): fetchInvoices reads state
    // only to decide skeleton vs background refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Mirrors the old standalone page's post-create navigation: inbox
  // conversions land back in the inbox, a created invoice opens its detail
  // page, and flows that end here (e.g. private expense) close the modal and
  // refresh the list in place.
  const handleCreated = (invoiceId?: string) => {
    if (inboxItemId) {
      router.push('/e/general/invoice-inbox')
      return
    }
    if (invoiceId) {
      router.push(`/supplier-invoices/${invoiceId}`)
      return
    }
    closeNewInvoice()
    fetchInvoices()
  }

  // "Att betala" is the full payment queue: registered invoices are already
  // booked as debt (2440), so they belong here too. Approval stays the gate
  // for paying, not for visibility; unapproved rows get a hover approve.
  const filteredInvoices = invoices.filter((inv) => {
    const matchesTab = (() => {
      switch (activeTab) {
        case 'registered': return inv.status === 'registered'
        case 'approved': return inv.status === 'approved'
        case 'to_pay': return inv.status === 'registered' || inv.status === 'approved' || inv.status === 'overdue'
        case 'paid': return inv.status === 'paid'
        default: return true
      }
    })()
    const query = searchTerm.trim().toLowerCase()
    const matchesSearch =
      !query ||
      (inv.supplier?.name ?? '').toLowerCase().includes(query) ||
      (inv.supplier_invoice_number ?? '').toLowerCase().includes(query) ||
      String(inv.arrival_number ?? '').includes(query)
    const matchesFy =
      !fyPeriod ||
      (inv.invoice_date >= fyPeriod.period_start && inv.invoice_date <= fyPeriod.period_end)
    return matchesTab && matchesSearch && matchesFy
  })


  // Tri-state cycle: asc → desc → back to the API default (due date asc).
  const updateSort = (column: SupplierInvoiceListSortColumn) => {
    setSort((current) => {
      if (current?.column !== column) return { column, direction: 'asc' }
      return current.direction === 'asc' ? { column, direction: 'desc' } : null
    })
  }

  const sortedInvoices = sort ? sortSupplierInvoiceList(filteredInvoices, sort) : filteredInvoices

  // Grouping: bucket the sorted rows through the shared helper and flatten
  // back so paging, range selection and the detail pager walk the exact
  // rendered order. Order is never touched here: for a payment queue the
  // API's forfallodatum-ascending default is the order that matters (what
  // falls due first goes first), and an active column sort governs the rest.
  const { orderedInvoices, rowGroupKeys, groupMeta } = useMemo(() => {
    const keys = new Map<string, string | null>()
    if (groupMode === 'none') {
      for (const inv of sortedInvoices) keys.set(inv.id, null)
      return {
        orderedInvoices: sortedInvoices,
        rowGroupKeys: keys,
        groupMeta: new Map<string, { label: string; count: number }>(),
      }
    }
    const grouped =
      groupMode === 'status'
        ? groupRows(sortedInvoices, {
            keyOf: (inv) => {
              const key = isAwaitingPayment(inv.status) ? 'awaiting' : 'settled'
              return { key, label: key }
            },
            order: STATUS_SECTION_ORDER,
          })
        : groupMode === 'supplier'
          ? groupRows(sortedInvoices, {
              keyOf: (inv) => {
                const label = inv.supplier?.name ?? UNKNOWN_GROUP_KEY
                // Bucket by id, not display name: two suppliers can share one.
                return { key: inv.supplier_id ?? label, label }
              },
              order: (a, b) => a.label.localeCompare(b.label, 'sv'),
            })
          : groupRows(sortedInvoices, {
              keyOf: (inv) => {
                const key = (inv.invoice_date ?? '').slice(0, 7) || UNKNOWN_GROUP_KEY
                return { key, label: key }
              },
              order: (a, b) => b.key.localeCompare(a.key),
            })
    const flat: typeof sortedInvoices = []
    for (const entry of grouped.rows) {
      keys.set(entry.row.id, entry.groupKey)
      flat.push(entry.row)
    }
    return { orderedInvoices: flat, rowGroupKeys: keys, groupMeta: grouped.meta }
  }, [groupMode, sortedInvoices])
  // Status sections only earn headers when there is more than one of them;
  // supplier/month grouping is an explicit ask, so headers always show.
  const showGroupHeaders = groupMode !== 'none' && (groupMode !== 'status' || groupMeta.size > 1)

  const monthFormatter = useMemo(
    () => new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'sv-SE', { month: 'long', year: 'numeric' }),
    [locale],
  )
  function groupHeaderLabel(key: string): string {
    const meta = groupMeta.get(key)
    const count = meta?.count ?? 0
    if (groupMode === 'status') {
      return key === 'awaiting' ? t('section_awaiting', { count }) : t('section_settled', { count })
    }
    if (groupMode === 'month' && key !== UNKNOWN_GROUP_KEY) {
      const label = monthFormatter.format(new Date(`${key}-01T00:00:00`))
      return `${label.charAt(0).toLocaleUpperCase('sv-SE')}${label.slice(1)} (${count})`
    }
    if (key === UNKNOWN_GROUP_KEY) return `${t('group_unknown')} (${count})`
    return `${meta?.label ?? key} (${count})`
  }

  const updateGroup = (mode: GroupMode) => {
    setGroupMode(mode)
    const params = new URLSearchParams(searchParams.toString())
    // Flat is the default, so it owns the URL-less state; every other mode
    // is written out so it round-trips through reload and back-navigation.
    if (mode === 'none') params.delete('group')
    else params.set('group', mode)
    const qs = params.toString()
    router.replace(qs ? `/supplier-invoices?${qs}` : '/supplier-invoices', { scroll: false })
  }

  // Detail-pager context: the list as rendered (filtered + sectioned +
  // sorted), written when the user navigates into a row.
  const rememberListContext = () => {
    writeListContext(listContextKey('supplier-invoices', company?.id), {
      ids: orderedInvoices.map((inv) => inv.id),
    })
  }

  const registeredCount = invoices.filter((inv) => inv.status === 'registered').length
  const toPayCount = invoices.filter(
    (inv) => inv.status === 'registered' || inv.status === 'approved' || inv.status === 'overdue',
  ).length

  const selectableInvoices = filteredInvoices.filter(isBatchSelectable)
  const allSelectableSelected =
    selectableInvoices.length > 0 && selectableInvoices.every((inv) => selectedIds.has(inv.id))

  // Ranges walk the selectable rows in rendered order: sorted, then sectioned
  // by the active grouping, which is what the user sees on screen.
  const range = useRangeSelect({
    visibleIds: orderedInvoices.filter(isBatchSelectable).map((inv) => inv.id),
    selectedIds,
    setSelectedIds,
  })

  function toggleSelect(id: string, extend?: boolean) {
    range.toggle(id, extend)
  }

  // Labels the excluded rows in the payment dialog ("Derome CD3014794407"),
  // so a server-side exclusion never reads as a bare UUID.
  const invoiceLabelById = new Map(
    invoices.map((inv) => [
      inv.id,
      `${inv.supplier?.name ?? ''} ${inv.supplier_invoice_number}`.trim(),
    ]),
  )

  const handleBatchCreated = () => {
    setSelectedIds(new Set())
    fetchInvoices()
    fetchActiveBatchMembership()
  }

  async function handleApprove(id: string) {
    setApprovingId(id)
    try {
      const res = await fetch(`/api/supplier-invoices/${id}/approve`, { method: 'POST' })
      const result = await res.json()
      if (!res.ok) {
        toast({ title: t('approve_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
        // Re-sync from the server: an operator about to pay must see the
        // invoice's true approval state, not an optimistic guess.
        fetchInvoices()
      } else {
        toast({ title: t('approved_title'), description: t('approved_description') })
        // Trust the server's status: an attested invoice that is still past due
        // stays labelled 'overdue' rather than flipping to 'approved'. An
        // incomplete payload is not an excuse to invent either field: the row an
        // operator is about to pay must show real state, so re-read instead.
        const approved = result?.data as Partial<SupplierInvoice> | undefined
        if (!approved?.status || !approved.approved_at) {
          fetchInvoices()
          return
        }
        setInvoices((prev) =>
          prev.map((inv) =>
            inv.id === id
              ? { ...inv, status: approved.status!, approved_at: approved.approved_at! }
              : inv,
          ),
        )
      }
    } catch {
      toast({ title: t('approve_failed_title'), description: getErrorMessage(null, { context: 'supplier_invoice' }), variant: 'destructive' })
      fetchInvoices()
    } finally {
      setApprovingId(null)
    }
  }

  // "Inlagd i banken" (#2220): the payment was typed into the bank by hand.
  // A mark, not a payment: the server writes one timestamp and the DB clears
  // it when the payment lands, so the row patch here is the whole story.
  async function handleBankEntered(id: string, entered: boolean) {
    setBankEnteringId(id)
    try {
      const res = await fetch(`/api/supplier-invoices/${id}/bank-entered`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ entered }),
      })
      const result = await res.json()
      if (!res.ok) {
        toast({ title: t('bank_entered_failed_title'), description: getErrorMessage(result, { context: 'supplier_invoice' }), variant: 'destructive' })
        // The refusal usually means the row moved (paid meanwhile): re-read
        // rather than leave a bock the server does not agree with.
        fetchInvoices()
        return
      }
      const updated = result?.data as { bank_entered_at?: string | null } | undefined
      setInvoices((prev) =>
        prev.map((inv) =>
          inv.id === id ? { ...inv, bank_entered_at: updated?.bank_entered_at ?? null } : inv,
        ),
      )
    } catch {
      toast({ title: t('bank_entered_failed_title'), description: getErrorMessage(null, { context: 'supplier_invoice' }), variant: 'destructive' })
      fetchInvoices()
    } finally {
      setBankEnteringId(null)
    }
  }

  return (
    <div className="space-y-8">
      {/* Page header (concept scene 21): title + help + primary action.
          The help popover carries the payment model (convention 7): approval
          attests for payment; payments reconcile via bank matching, so there
          is deliberately no mark-as-paid button here. */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-center gap-2">
          <h1 className="font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
          <HelpPopover>{t('help_body')}</HelpPopover>
        </span>
        {canWrite ? (
          <Button onClick={openNewInvoice}>
            <Plus className="mr-2 h-4 w-4" />
            {t('register_invoice')}
          </Button>
        ) : (
          <Button disabled title={t('viewer_disabled_tooltip')}>
            <Lock className="mr-2 h-4 w-4" />
            {t('register_invoice')}
          </Button>
        )}
      </div>

      {/* Toolbar: one status chip-picker (founder direction: the status
          views live behind a filter chip, not a seg), sök, FyPicker far
          right. Counts ride as row annotations and on the trigger. */}
      <div className="flex flex-wrap items-center gap-2">
        <ContextPicker
          value={activeTab}
          onChange={(id) => setActiveTab(id as ListTab)}
          ariaLabel={t('status_picker_aria')}
          triggerLabel={(() => {
            const count =
              activeTab === 'registered' ? registeredCount : activeTab === 'to_pay' ? toPayCount : 0
            return count > 0
              ? `${t(TAB_LABEL_KEYS[activeTab])} · ${count}`
              : t(TAB_LABEL_KEYS[activeTab])
          })()}
          items={TABS.map((tab) => ({
            id: tab,
            label: t(TAB_LABEL_KEYS[tab]),
            annotation:
              tab === 'registered' && registeredCount > 0
                ? String(registeredCount)
                : tab === 'to_pay' && toPayCount > 0
                  ? String(toPayCount)
                  : undefined,
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
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        <div className="ml-auto flex items-center gap-4">
          <Link href="/supplier-invoices/payment-files" className={QUIET_LINK_CLASS}>
            {t('payment_files_link')}
          </Link>
          <FyPicker
            value={fyPeriodId}
            onChange={(periodId, period) => {
              setFyPeriodId(periodId)
              setFyPeriod(period ?? null)
            }}
            includeAllOption
          />
        </div>
      </div>

      {/* Bulkbar: appears once anything is selected (transactions-page shape). */}
      {selectedIds.size > 0 && (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-1 py-2.5 text-[12.5px] animate-fade-in">
          <span className="whitespace-nowrap">
            <strong className="font-semibold tabular-nums">{selectedIds.size}</strong>{' '}
            {t('bulkbar_selected', { count: selectedIds.size })}
          </span>
          <Button size="sm" onClick={() => setShowPaymentDialog(true)}>
            {t('bulk_create_file')}
          </Button>
          {!allSelectableSelected && (
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
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-20 flex-1" />
              <Skeleton className="h-4 w-20" />
              <Skeleton className="h-5 w-16" />
            </div>
          ))}
        </div>
      ) : filteredInvoices.length === 0 ? (
        <DataListEmpty
          icon={<FileInput className="h-6 w-6" />}
          title={t('empty_title')}
          description={
            activeTab === 'all' && !searchTerm
              ? t('empty_description_all')
              : t('empty_description_category')
          }
          action={
            activeTab === 'all' && !searchTerm && canWrite ? (
              <Button onClick={openNewInvoice}>{t('register_invoice')}</Button>
            ) : undefined
          }
        />
      ) : (
        /* Column budget (#2262): the content column is at most 960px (max-w-5xl
           minus px-8) and 948px on a 1280-wide laptop, at every desktop size,
           so viewport breakpoints cannot buy room. Every nowrap column adds its
           widest header or cell to the table's minimum width; past the budget
           the wrapper scrolls sideways, Leverantör collapses to its header
           width and Status is cut at the edge. That is why the list carries
           one date (förfaller: the payer's date and the default order) and a
           short Kvar header; fakturadatum lives in the detail view. The
           trailing column is one slot for the row's next step: Godkänn while
           attest is pending, the I banken bock (#2220) once attested; it is
           sized for the bock plus its label, the wider of the two. */
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                {canWrite && <th className={cn(TH_CLASS, 'w-[26px] !pl-1')} aria-hidden="true"></th>}
                <SortableHeader
                  label={t('th_supplier')}
                  sortLabel={t('sort_by', { column: t('th_supplier') })}
                  column="supplier"
                  sort={sort}
                  onSort={updateSort}
                  className="w-full"
                />
                <SortableHeader
                  label={t('th_invoice_number')}
                  sortLabel={t('sort_by', { column: t('th_invoice_number') })}
                  column="number"
                  sort={sort}
                  onSort={updateSort}
                />
                <SortableHeader
                  label={t('th_due_date')}
                  sortLabel={t('sort_by', { column: t('th_due_date') })}
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
                  label={t('th_remaining')}
                  sortLabel={t('sort_by', { column: t('th_remaining') })}
                  column="remaining"
                  sort={sort}
                  onSort={updateSort}
                  className="hidden text-right lg:table-cell"
                  align="right"
                />
                <SortableHeader
                  label={t('th_status')}
                  sortLabel={t('sort_by', { column: t('th_status') })}
                  column="status"
                  sort={sort}
                  onSort={updateSort}
                />
                <th className={cn(TH_CLASS, 'w-[108px]')} aria-hidden="true"></th>
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {orderedInvoices.map((inv, rowIndex) => {
                const chipVariant = STATUS_VARIANTS[inv.status] || 'secondary'
                const chipLabel =
                  inv.status === 'paid' && inv.paid_at
                    ? t('status_paid_date', { date: formatDate(inv.paid_at) })
                    : STATUS_LABEL_KEYS[inv.status]
                      ? t(STATUS_LABEL_KEYS[inv.status])
                      : inv.status
                // Aged-but-unapproved invoices sit on 'overdue' (the cron flips
                // them there), so attest keys off approved_at, not the status.
                const canApprove =
                  canApproveSupplierInvoice(inv) && !inv.is_credit_note && canWrite
                const selectable = canWrite && isBatchSelectable(inv)
                // "Inlagd i banken" (#2220) shares the trailing slot with
                // Godkänn, so it appears once attest is done. Viewers see the
                // bock only when it is set (state, not a control).
                const bankEntered = !!inv.bank_entered_at
                const showBankEntered =
                  !canApprove &&
                  canMarkSupplierInvoiceBankEntered(inv) &&
                  (canWrite || bankEntered)
                // Same shape as the customer list: the section header is a
                // sibling row decided from the previous row's key.
                const groupKey = rowGroupKeys.get(inv.id) ?? null
                const prevKey =
                  rowIndex > 0 ? rowGroupKeys.get(orderedInvoices[rowIndex - 1].id) ?? null : undefined
                const showHeader = showGroupHeaders && groupKey !== null && groupKey !== prevKey
                return (
                  <Fragment key={inv.id}>
                    {showHeader && (
                      <tr data-no-stagger>
                        <td
                          colSpan={canWrite ? 9 : 8}
                          className={cn(
                            'border-b border-border px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground',
                            rowIndex === 0 ? 'pt-4' : 'pt-6',
                          )}
                        >
                          {groupHeaderLabel(groupKey)}
                        </td>
                      </tr>
                    )}
                  <tr
                    className={cn(
                      'group cursor-pointer transition-colors duration-150 hover:bg-secondary/35',
                      selectedIds.has(inv.id) && 'bg-secondary/40',
                    )}
                    onClick={() => {
                      rememberListContext()
                      router.push(`/supplier-invoices/${inv.id}`)
                    }}
                  >
                    {/* Hover-revealed selection checkbox (JournalEntryList shape). */}
                    {canWrite && (
                      <td
                        className={cn(TD_CLASS, 'w-[26px] !pl-1 py-[9px] select-none')}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {selectable && (
                          <Checkbox
                            checked={selectedIds.has(inv.id)}
                            onClick={(e) => {
                              shiftHeld.current = e.shiftKey
                            }}
                            onCheckedChange={() => toggleSelect(inv.id, shiftHeld.current)}
                            aria-label={t('bulk_select_row')}
                            className={cn(
                              'border-foreground duration-150',
                              selectedIds.has(inv.id) || selectedIds.size > 0
                                ? 'opacity-100'
                                : CHECKBOX_REVEAL_CLASS,
                            )}
                          />
                        )}
                      </td>
                    )}
                    <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
                      <span className="block truncate">{inv.supplier?.name || '-'}</span>
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>
                      <Link
                        href={`/supplier-invoices/${inv.id}`}
                        className="hover:underline"
                        onClick={(e) => {
                          e.stopPropagation()
                          rememberListContext()
                        }}
                      >
                        {inv.supplier_invoice_number}
                      </Link>
                    </td>
                    <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums text-muted-foreground sm:table-cell')}>
                      {formatDate(inv.due_date)}
                    </td>
                    {/* Belopp rounds like the detail page when the invoice's
                        öresavrundning flag is on; "kvar att betala" stays
                        öre-exact (it is the actual outstanding debt). */}
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums rr-mask')}>
                      {formatCurrency(getDisplayTotal(
                        { total: inv.total, currency: inv.currency, ore_rounding: inv.ore_rounding },
                        { ore_rounding: false },
                      ).displayed, inv.currency)}
                    </td>
                    <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums rr-mask lg:table-cell')}>
                      {formatCurrency(inv.remaining_amount, inv.currency)}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                      <span className="inline-flex items-center gap-1">
                        <Badge variant={chipVariant} className="font-normal">
                          {chipLabel}
                        </Badge>
                        {activeBatchInvoiceIds.has(inv.id) && inv.status !== 'paid' && (
                          <Badge variant="outline" className="font-normal">
                            {t('in_batch_chip')}
                          </Badge>
                        )}
                      </span>
                    </td>
                    {/* Attest as a hover action on registered rows (concept):
                        approval gates payment, so it lives right on the row. */}
                    <td
                      className={cn(TD_CLASS, 'whitespace-nowrap text-right')}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {canApprove && (
                        <button
                          type="button"
                          className={cn(
                            QUIET_LINK_CLASS,
                            'opacity-0 transition-opacity duration-150 focus-visible:opacity-100 group-hover:opacity-100',
                            approvingId !== null && 'pointer-events-none opacity-50',
                          )}
                          onClick={() => handleApprove(inv.id)}
                        >
                          {t('approve')}
                        </button>
                      )}
                      {/* The bock (#2220): hover-revealed until set, then it
                          stays, because a set bock is the state the payer
                          scans for. */}
                      {showBankEntered && (
                        <label
                          className={cn(
                            'inline-flex select-none items-center gap-2 text-[12.5px] text-muted-foreground',
                            canWrite ? 'cursor-pointer' : 'cursor-default',
                            bankEntered ? 'opacity-100' : HOVER_REVEAL_CLASS,
                            bankEnteringId === inv.id && 'pointer-events-none opacity-50',
                          )}
                        >
                          <Checkbox
                            checked={bankEntered}
                            disabled={!canWrite}
                            onCheckedChange={(value) => handleBankEntered(inv.id, value === true)}
                            aria-label={t('bank_entered_aria')}
                            className="border-foreground duration-150"
                          />
                          {t('bank_entered_label')}
                        </label>
                      )}
                    </td>
                  </tr>
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {showNewInvoice && (
        <NewSupplierInvoiceDialog
          open
          onOpenChange={(open) => {
            if (!open) closeNewInvoice()
          }}
          inboxItemId={inboxItemId}
          onCreated={handleCreated}
        />
      )}

      {showPaymentDialog && (
        <PaymentFileDialog
          open
          onOpenChange={(open) => {
            if (!open) setShowPaymentDialog(false)
          }}
          invoiceIds={Array.from(selectedIds)}
          invoiceLabelById={invoiceLabelById}
          onCreated={handleBatchCreated}
        />
      )}
    </div>
  )
}
