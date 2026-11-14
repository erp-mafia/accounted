'use client'

import { Fragment, useMemo, useState, useEffect, useRef } from 'react'
import dynamic from 'next/dynamic'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { groupRows } from '@/lib/lists/group-rows'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { fetchPayeeAlertMarkers, type PayeeAlertMarker } from '@/components/payments/payee-change-client'
import { Button } from '@/components/ui/button'
import { BulkSelectionBar } from '@/components/ui/bulk-selection-bar'
import { Checkbox } from '@/components/ui/checkbox'
import { IntentLink } from '@/components/ui/intent-link'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { DataListEmpty } from '@/components/ui/data-list'
import {
  TH_CLASS,
  TD_CLASS,
  QUIET_LINK_CLASS,
  RowSelectCheckbox,
  HOVER_REVEAL_CLASS,
  SortableTh,
  SHOW_MORE_STEP,
  ShowMoreFooter,
} from '@/components/ui/dry-table'
import { useBulkSelection } from '@/lib/hooks/use-bulk-selection'
import { FyPicker } from '@/components/common/FyPicker'
import { ContextPicker } from '@/components/common/ContextPicker'
import { HelpPopover } from '@/components/ui/help-popover'
import {
  AdjustmentsHorizontalIcon,
  DocumentArrowUpIcon,
  LockClosedIcon,
  PlusIcon,
} from '@/components/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { DialogLoadingSkeleton } from '@/components/ui/dialog-loading-skeleton'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { supplierInvoiceDisplayFigures } from '@/lib/bookkeeping/supplier-invoice-display-figures'
import {
  canApproveSupplierInvoice,
  canMarkSupplierInvoiceBankEntered,
  companyAttestsSupplierInvoices,
} from '@/lib/supplier-invoices/lifecycle'
import { isAttestedInList, isAwaitingAttestInList, isToPayInList } from '@/lib/supplier-invoices/list-tabs'
import {
  sortSupplierInvoiceList,
  type SupplierInvoiceListSort,
  type SupplierInvoiceListSortColumn,
} from '@/lib/supplier-invoices/supplier-invoice-list-sort'
import { listContextKey, writeListContext } from '@/lib/navigation/list-context'
import { useCompanyOptional } from '@/contexts/CompanyContext'
import type { FiscalPeriod, SupplierInvoice } from '@/types'
import { useCompanySettings } from '@/components/settings/useSettings'
import { fetchPaymentsAvailability, type CompanyVerification } from '@/components/payments/payments-client'
import { PaymentsVerificationLine } from '@/components/payments/PaymentsVerificationLine'
import { SupplierInboxAddress } from '@/components/supplier-invoices/SupplierInboxAddress'
import { supplierInvoiceStatusDisplay } from '@/lib/supplier-invoices/status-display'
import {
  openPaymentMarker,
  OPEN_PAYMENT_MARKER_LABEL_KEYS,
  type OpenPaymentInstruction,
} from '@/lib/supplier-invoices/stages'

const NewSupplierInvoiceDialog = dynamic(
  () => import('@/components/supplier-invoices/NewSupplierInvoiceDialog'),
  { loading: DialogLoadingSkeleton },
)

const PaymentFileDialog = dynamic(
  () => import('@/components/supplier-invoices/PaymentFileDialog'),
  { loading: DialogLoadingSkeleton },
)

// Betala via banken (connections plan, milestone 1): shown only for companies
// where bank payments are switched on (GET /api/payments/availability).
const PayViaBankDialog = dynamic(
  () => import('@/components/payments/PayViaBankDialog'),
  { loading: DialogLoadingSkeleton },
)

// Rough client-side gate for the payment-file bulk selection: the statuses
// mark-paid accepts, SEK only, something left to pay, not a credit note, not
// debited by the supplier itself (crm#1463). The preview re-evaluates
// server-side (payee, OCR, active batches), so this only decides which rows
// get a checkbox.
function isBatchSelectable(inv: SupplierInvoice): boolean {
  return (
    ['registered', 'approved', 'partially_paid', 'overdue'].includes(inv.status) &&
    !inv.is_credit_note &&
    !inv.auto_debit &&
    inv.currency === 'SEK' &&
    inv.remaining_amount > 0.005
  )
}

/** A list row: the invoice, its supplier, and the payment instruction that already covers it (GET /api/supplier-invoices). */
type ListInvoice = SupplierInvoice & {
  supplier?: { id: string; name: string }
  open_payment?: OpenPaymentInstruction | null
}

const TABS = ['all', 'registered', 'approved', 'to_pay', 'in_payment', 'paid'] as const
type ListTab = (typeof TABS)[number]

const TAB_LABEL_KEYS: Record<ListTab, string> = {
  all: 'tab_all',
  registered: 'tab_registered',
  approved: 'tab_approved',
  to_pay: 'tab_to_pay',
  in_payment: 'tab_in_payment',
  paid: 'tab_paid',
}


/** Debited by the supplier itself on the due date and not settled yet (crm#1463). */
function awaitsAutoDebit(inv: ListInvoice): boolean {
  return (
    !!inv.auto_debit &&
    !inv.is_credit_note &&
    ['registered', 'approved', 'partially_paid', 'overdue'].includes(inv.status)
  )
}

// Same shape as the invoices list header (app/(dashboard)/invoices/page.tsx).
// Like the verifikat list (and unlike /invoices, which starts unsorted), this
// list has a meaningful default order (förfallodatum stigande from the API),
// so the click cycle is tri-state: asc → desc → back to the default.
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
  const [invoices, setInvoices] = useState<ListInvoice[]>([])
  const [isLoading, setIsLoading] = useState(true)
  // ?tab= opens a status tab directly: the Att göra row and the byrå client
  // list link to Att betala (to_pay) and the attest queue (registered).
  const [activeTab, setActiveTab] = useState<ListTab>(() => {
    const param = searchParams.get('tab')
    return param && TABS.includes(param as never) ? (param as ListTab) : 'all'
  })
  // The flow (UI v2 PR 6) lives on each invoice as a strip; the list keeps
  // the status picker (founder call 2026-09-07: a bar of stages over two
  // invoices was chrome, not information).
  const { settings: companySettings } = useCompanySettings()
  // Kontantmetoden never attests: there 'registered' is the normal open
  // state, so the row reads "Att betala" instead of the attest chip.
  const attests = companyAttestsSupplierInvoices(companySettings?.accounting_method)
  const [searchTerm, setSearchTerm] = useState('')
  // The list draws its first 100 rows and more on request, as the invoice
  // list does. It drew every row: 8 500 for the largest register in
  // production, each with its links, chips and checkboxes, on every render
  // and every keystroke in the search. Counts, select-all and the detail
  // pager still cover the whole filtered list.
  const [visibleCount, setVisibleCount] = useState(SHOW_MORE_STEP)
  const resetPaging = () => setVisibleCount(SHOW_MORE_STEP)
  // null = the API's default order (förfallodatum stigande).
  const [sort, setSort] = useState<SupplierInvoiceListSort | null>(null)
  // Grouping sits behind a gear at the right and Betalfiler is in the nav,
  // so the toolbar is the status chip, the search and the year.
  const [groupMode, setGroupMode] = useState<GroupMode>(() => {
    const param = searchParams.get('group')
    return param && GROUP_MODES.includes(param as never) ? (param as GroupMode) : 'none'
  })
  // Fiscal-year scope (convention 8): null = all years.
  const [fyPeriodId, setFyPeriodId] = useState<string | null>(null)
  const [fyPeriod, setFyPeriod] = useState<FiscalPeriod | null>(null)
  // A new tab, search or year starts the list from its first rows again.
  const changeTab = (tab: ListTab) => {
    setActiveTab(tab)
    resetPaging()
  }
  const changeSearch = (term: string) => {
    setSearchTerm(term)
    resetPaging()
  }
  const changeFiscalYear = (periodId: string | null, period: FiscalPeriod | null) => {
    setFyPeriodId(periodId)
    setFyPeriod(period)
    resetPaging()
  }
  const [approvingId, setApprovingId] = useState<string | null>(null)
  // "Inlagd i banken" (#2220) in flight for one row: the bock disables while
  // the server confirms, so a double click cannot flip it twice.
  const [bankEnteringId, setBankEnteringId] = useState<string | null>(null)
  // Payment-file bulk selection. Radix' onCheckedChange carries no mouse
  // event: the preceding click records whether shift was held, for range
  // selection.
  const shiftHeld = useRef(false)
  const [showPaymentDialog, setShowPaymentDialog] = useState(false)
  const [showPayViaBankDialog, setShowPayViaBankDialog] = useState(false)
  // Whether this company can pay through the bank: read once per page load;
  // false (the default) hides every bank-payment control, so companies outside
  // the pilot see the list exactly as before.
  const [bankPaymentsAvailable, setBankPaymentsAvailable] = useState(false)
  // The company's verification, when it stands between the company and a
  // bank payment (readiness verification_needed or _pending): one line in
  // the bulk bar beside the payment buttons, with the step that starts it.
  const [verificationInTheWay, setVerificationInTheWay] = useState<CompanyVerification | null>(null)

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

  // Invoices whose stated bank details hold their payment back: a marker per
  // row (lib/payments/payee-alerts.ts). Marker data only: the list renders without it.
  const [payeeMarkers, setPayeeMarkers] = useState<Map<string, PayeeAlertMarker>>(new Map())
  async function fetchPayeeMarkers() {
    try {
      setPayeeMarkers(await fetchPayeeAlertMarkers())
    } catch {
      // The list stays functional without it.
    }
  }

  useEffect(() => {
    fetchInvoices()
    fetchPayeeMarkers()
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

  // "Att betala" is what waits to be paid (lib/supplier-invoices/to-pay.ts):
  // registered invoices are booked as debt (2440) and the payment file pays
  // them, so they belong here, unless the attest policy holds them back;
  // unapproved rows get a hover approve.
  // "I betalning" is what is already set up for payment (isToPayInList).
  const filteredInvoices = invoices.filter((inv) => {
    const matchesTab = (() => {
      switch (activeTab) {
        // Not attested yet, overdue ones included (lib/supplier-invoices/list-tabs.ts).
        case 'registered': return isAwaitingAttestInList(inv)
        // Attested, past its due date or not (stored as 'overdue' then).
        case 'approved': return isAttestedInList(inv)
        case 'to_pay': return isToPayInList(inv)
        case 'in_payment': return openPaymentMarker(inv) !== null
        case 'paid': return inv.status === 'paid'
        default: return true
      }
    })()
    const query = searchTerm.trim().toLowerCase()
    const matchesSearch =
      !query ||
      (inv.supplier?.name ?? '').toLowerCase().includes(query) ||
      (inv.supplier_invoice_number ?? '').toLowerCase().includes(query) ||
      (inv.fortnox_number ?? '').toLowerCase().includes(query) ||
      String(inv.arrival_number ?? '').includes(query)
    const matchesFy =
      !fyPeriod ||
      (inv.invoice_date >= fyPeriod.period_start && inv.invoice_date <= fyPeriod.period_end)
    return matchesTab && matchesSearch && matchesFy
  })


  // Tri-state cycle: asc → desc → back to the API default (due date asc).
  const updateSort = (column: SupplierInvoiceListSortColumn) => {
    resetPaging()
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
  // The rows on screen: the ordered list cut at visibleCount.
  const visibleInvoices = orderedInvoices.slice(0, visibleCount)
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
    resetPaging()
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

  const registeredCount = invoices.filter(isAwaitingAttestInList).length
  const toPayCount = invoices.filter(isToPayInList).length
  const inPaymentCount = invoices.filter((inv) => openPaymentMarker(inv) !== null).length

  // An invoice with an open bank payment takes no new payment: no checkbox
  // (the server refuses it in both channels anyway).
  const isRowSelectable = (inv: ListInvoice) => isBatchSelectable(inv) && openPaymentMarker(inv) !== 'bank_payment'
  const selectableInvoices = filteredInvoices.filter(isRowSelectable)
  // The selection is the payable invoices of the current tab, filter and
  // search: a row they hide leaves it (useBulkSelection). Ranges walk the
  // rows on screen in rendered order (sorted, then sectioned by the active
  // grouping): the list is cut at visibleCount, so rows below it are not in
  // a range, as on the invoice list.
  const selection = useBulkSelection(
    selectableInvoices.map((inv) => inv.id),
    { rangeIds: visibleInvoices.filter(isRowSelectable).map((inv) => inv.id) },
  )
  const { selectedIds, toggle: toggleSelect } = selection

  // Labels the excluded rows in the payment dialog ("Derome CD3014794407"),
  // so a server-side exclusion never reads as a bare UUID. An invoice without
  // a supplier number is labelled by its supplier alone.
  const invoiceLabelById = new Map(
    invoices.map((inv) => [
      inv.id,
      `${inv.supplier?.name ?? ''} ${inv.supplier_invoice_number ?? ''}`.trim(),
    ]),
  )

  const handleBatchCreated = () => {
    selection.clear()
    fetchInvoices()
  }

  useEffect(() => {
    let cancelled = false
    fetchPaymentsAvailability()
      .then((data) => {
        if (cancelled) return
        setBankPaymentsAvailable(data.available)
        const inTheWay = data.readiness === 'verification_needed' || data.readiness === 'verification_pending'
        setVerificationInTheWay(inTheWay && data.verification ? data.verification : null)
      })
      .catch(() => {
        if (!cancelled) setBankPaymentsAvailable(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Drafts made, approved or sent to the bank: the list and the chips move.
  const handleBankPaymentDone = () => {
    selection.clear()
    fetchInvoices()
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
              ? { ...inv, status: approved.status!, approved_at: approved.approved_at!, waits_for_attest: false }
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
      <div className="page-header flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <span className="flex items-center gap-2">
          <h1 className="page-header-title font-display text-2xl leading-8 tracking-tight">{t('title')}</h1>
          <HelpPopover>{t('help_body')}</HelpPopover>
        </span>
        {/* The two ways an invoice gets here: mailed in by the supplier,
            or registered by hand. */}
        <div className="flex min-w-0 items-center gap-2">
          <SupplierInboxAddress />
          {canWrite ? (
            <Button size="sm" onClick={openNewInvoice}>
              <PlusIcon className="mr-2 h-4 w-4" />
              {t('register_invoice')}
            </Button>
          ) : (
            <Button size="sm" disabled title={t('viewer_disabled_tooltip')}>
              <LockClosedIcon className="mr-2 h-4 w-4" />
              {t('register_invoice')}
            </Button>
          )}
        </div>
      </div>

      {/* Toolbar: one status chip-picker (founder direction: the status
          views live behind a filter chip, not a seg), sök, FyPicker far
          right. Counts ride as row annotations and on the trigger. */}
      <div className="flex flex-wrap items-center gap-2">
        <ContextPicker
          value={activeTab}
          onChange={(id) => changeTab(id as ListTab)}
          ariaLabel={t('status_picker_aria')}
          triggerLabel={(() => {
            const count =
              activeTab === 'registered'
                ? registeredCount
                : activeTab === 'to_pay'
                  ? toPayCount
                  : activeTab === 'in_payment'
                    ? inPaymentCount
                    : 0
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
                  : tab === 'in_payment' && inPaymentCount > 0
                    ? String(inPaymentCount)
                    : undefined,
          }))}
        />
        <ToolbarSearch
          containerClassName="min-w-[190px]"
          placeholder={t('search_placeholder')}
          value={searchTerm}
          onChange={(e) => changeSearch(e.target.value)}
        />
        <div className="ml-auto flex items-center gap-4">
          <FyPicker
            value={fyPeriodId}
            onChange={(periodId, period) => changeFiscalYear(periodId, period ?? null)}
            includeAllOption
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                className={cn('text-muted-foreground hover:text-foreground', groupMode !== 'none' && 'text-foreground')}
                aria-label={t('group_picker_aria')}
                title={t('group_by')}
              >
                <AdjustmentsHorizontalIcon className="h-4 w-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuRadioGroup value={groupMode} onValueChange={(v) => updateGroup(v as GroupMode)}>
                {GROUP_MODES.map((mode) => (
                  <DropdownMenuRadioItem key={mode} value={mode}>
                    {t(GROUP_LABEL_KEYS[mode])}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Bulkbar: appears once anything is selected (transactions-page shape). */}
      <BulkSelectionBar
        selection={selection}
        selectableCount={selectableInvoices.length}
        countLabel={t('bulkbar_selected', { count: selectedIds.size })}
        selectAllLabel={t('bulk_select_all', { count: selectableInvoices.length })}
        clearLabel={t('bulk_clear')}
      >
        {bankPaymentsAvailable && verificationInTheWay && <PaymentsVerificationLine verification={verificationInTheWay} compact onChange={setVerificationInTheWay} />}
        {bankPaymentsAvailable && (
          <Button size="sm" onClick={() => setShowPayViaBankDialog(true)}>
            {t('bulk_pay_via_bank')}
          </Button>
        )}
        <Button size="sm" variant={bankPaymentsAvailable ? 'outline' : 'default'} onClick={() => setShowPaymentDialog(true)}>
          {t('bulk_create_file')}
        </Button>
      </BulkSelectionBar>

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
          icon={<DocumentArrowUpIcon className="h-6 w-6" />}
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
        /* Column budget (#2262): the content column is the viewport minus the
           sidebar, the frame gutter and the page padding, about 1000px on a
           1280-wide laptop. Every nowrap column adds its
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
                <SortableTh
                  label={t('th_supplier')}
                  className="w-full"
                  direction={sort?.column === 'supplier' ? sort.direction : null}
                  onSort={() => updateSort('supplier')}
                />
                <SortableTh
                  label={t('th_invoice_number')}
                  direction={sort?.column === 'number' ? sort.direction : null}
                  onSort={() => updateSort('number')}
                />
                <SortableTh
                  label={t('th_due_date')}
                  className="hidden text-right sm:table-cell"
                  align="right"
                  direction={sort?.column === 'due' ? sort.direction : null}
                  onSort={() => updateSort('due')}
                />
                <SortableTh
                  label={t('th_amount')}
                  className="text-right"
                  align="right"
                  direction={sort?.column === 'amount' ? sort.direction : null}
                  onSort={() => updateSort('amount')}
                />
                <SortableTh
                  label={t('th_remaining')}
                  className="hidden text-right lg:table-cell"
                  align="right"
                  direction={sort?.column === 'remaining' ? sort.direction : null}
                  onSort={() => updateSort('remaining')}
                />
                <SortableTh
                  label={t('th_status')}
                  direction={sort?.column === 'status' ? sort.direction : null}
                  onSort={() => updateSort('status')}
                />
                <th className={cn(TH_CLASS, 'w-[108px]')} aria-hidden="true"></th>
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {visibleInvoices.map((inv, rowIndex) => {
                // One chip per row, the same as the detail header and the
                // supplier page (lib/supplier-invoices/status-display.ts).
                const statusDisplay = supplierInvoiceStatusDisplay(inv.status, { attests })
                const chipVariant = statusDisplay?.chip ?? undefined
                const chipLabel =
                  inv.status === 'paid' && inv.paid_at
                    ? t('status_paid_date', { date: formatDate(inv.paid_at) })
                    : statusDisplay
                      ? t(statusDisplay.labelKey)
                      : inv.status
                // Aged-but-unapproved invoices sit on 'overdue' (the cron flips
                // them there), so attest keys off approved_at, not the status.
                // Kontantmetoden has no attest step, so nothing waits for it.
                const canApprove =
                  attests && canApproveSupplierInvoice(inv) && !inv.is_credit_note && canWrite
                const selectable = canWrite && isRowSelectable(inv)
                // What already covers the invoice: a bank payment, a standing
                // "I banken" tick, or a file (openPaymentMarker).
                const openPayment = openPaymentMarker(inv)
                // "Inlagd i banken" (#2220) shares the trailing slot with
                // Godkänn, so it appears once attest is done. Viewers see the
                // bock only when it is set (state, not a control). Paying by
                // hand is no option while a bank payment is open.
                const bankEntered = !!inv.bank_entered_at
                const showBankEntered =
                  !canApprove &&
                  !inv.auto_debit &&
                  canMarkSupplierInvoiceBankEntered(inv, companySettings?.accounting_method) &&
                  (bankEntered || (canWrite && openPayment !== 'bank_payment'))
                // Same shape as the customer list: the section header is a
                // sibling row decided from the previous row's key.
                const groupKey = rowGroupKeys.get(inv.id) ?? null
                const prevKey =
                  rowIndex > 0 ? rowGroupKeys.get(visibleInvoices[rowIndex - 1].id) ?? null : undefined
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
                    // The whole row opens the invoice, so the press warms its
                    // route as the number link does on hover.
                    onMouseDown={() => router.prefetch(`/supplier-invoices/${inv.id}`)}
                    onTouchStart={() => router.prefetch(`/supplier-invoices/${inv.id}`)}
                  >
                    {/* Hover-revealed selection checkbox (JournalEntryList shape). */}
                    {canWrite && (
                      <td
                        className={cn(TD_CLASS, 'w-[26px] !pl-1 py-[9px] select-none')}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {selectable && (
                          <RowSelectCheckbox
                            checked={selectedIds.has(inv.id)}
                            revealed={selectedIds.size > 0}
                            onClick={(e) => {
                              shiftHeld.current = e.shiftKey
                            }}
                            onCheckedChange={() => toggleSelect(inv.id, shiftHeld.current)}
                            aria-label={t('bulk_select_row')}
                          />
                        )}
                      </td>
                    )}
                    <td className={cn(TD_CLASS, 'max-w-0 w-full')}>
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate">{inv.supplier?.name || '-'}</span>
                        {payeeMarkers.has(inv.id) && (
                          <Badge variant="warning" className="shrink-0 font-normal">
                            {t('payee_alert_badge')}
                          </Badge>
                        )}
                      </span>
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap tabular-nums')}>
                      <IntentLink
                        href={`/supplier-invoices/${inv.id}`}
                        className="hover:underline"
                        onClick={(e) => {
                          e.stopPropagation()
                          rememberListContext()
                        }}
                      >
                        {inv.supplier_invoice_number ?? (
                          <span className="text-muted-foreground">{t('number_missing')}</span>
                        )}
                      </IntentLink>
                      {/* A självfaktura: the number is the company's own (crm#1367). */}
                      {inv.is_self_billed && (
                        <Badge variant="outline" className="ml-2 font-normal">
                          {t('badge_self_billed')}
                        </Badge>
                      )}
                    </td>
                    <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums text-muted-foreground sm:table-cell')}>
                      {formatDate(inv.due_date)}
                    </td>
                    {/* Belopp rounds like the detail page when the invoice's
                        öresavrundning flag is on; "kvar att betala" stays
                        öre-exact (it is the actual outstanding debt). */}
                    <td className={cn(TD_CLASS, 'whitespace-nowrap text-right tabular-nums rr-mask')}>
                      {formatCurrency(supplierInvoiceDisplayFigures({
                        total: inv.total,
                        currency: inv.currency,
                        ore_rounding: inv.ore_rounding,
                      }).toPay, inv.currency)}
                    </td>
                    <td className={cn(TD_CLASS, 'hidden whitespace-nowrap text-right tabular-nums rr-mask lg:table-cell')}>
                      {formatCurrency(inv.remaining_amount, inv.currency)}
                    </td>
                    <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                      <span className="inline-flex items-center gap-1">
                        {chipVariant ? (
                          <Badge variant={chipVariant} className="font-normal">
                            {chipLabel}
                          </Badge>
                        ) : (
                          <span className="text-xs text-muted-foreground">{chipLabel}</span>
                        )}
                        {/* A standing "I banken" tick is its own mark on the
                            row (the bock in the trailing cell): no second chip. */}
                        {openPayment && !(openPayment === 'bank_entered' && showBankEntered) && (
                          <Badge variant="outline" className="font-normal">
                            {t(OPEN_PAYMENT_MARKER_LABEL_KEYS[openPayment])}
                          </Badge>
                        )}
                        {awaitsAutoDebit(inv) && (
                          <Badge variant="outline" className="font-normal">
                            {t('auto_debit_badge', { date: formatDate(inv.due_date) })}
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
                            HOVER_REVEAL_CLASS,
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

      {!isLoading && (
        <ShowMoreFooter
          shown={visibleCount}
          total={orderedInvoices.length}
          onMore={() => setVisibleCount((count) => count + SHOW_MORE_STEP)}
        />
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

      {showPayViaBankDialog && (
        <PayViaBankDialog
          open
          onOpenChange={(open) => {
            if (!open) setShowPayViaBankDialog(false)
          }}
          invoiceIds={Array.from(selectedIds)}
          invoiceLabelById={invoiceLabelById}
          onDone={handleBankPaymentDone}
        />
      )}
    </div>
  )
}
