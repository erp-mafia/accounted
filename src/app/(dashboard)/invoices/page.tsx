'use client'

import { Fragment, useState, useEffect, useMemo, useRef } from 'react'
import { useCompanySettings } from '@/lib/reference-data/hooks'
import { groupRows, ungrouped } from '@/lib/lists/group-rows'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { Button } from '@/components/ui/button'
import { BulkSelectionBar } from '@/components/ui/bulk-selection-bar'
import { Badge } from '@/components/ui/badge'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { RowStatus, type RowStatusDescriptor } from '@/components/ui/row-status'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { Skeleton } from '@/components/ui/skeleton'
import { DataListEmpty } from '@/components/ui/data-list'
import {
  TH_CLASS,
  TD_CLASS,
  QUIET_LINK_CLASS,
  RowSelectCheckbox,
  SortableTh,
  SHOW_MORE_STEP,
  ShowMoreFooter,
} from '@/components/ui/dry-table'
import { useBulkSelection } from '@/lib/hooks/use-bulk-selection'
import { FyPicker } from '@/components/common/FyPicker'
import { ContextPicker } from '@/components/common/ContextPicker'
import { SplitButton, type SplitButtonOption } from '@/components/ui/split-button'
import { useUiState } from '@/lib/hooks/use-ui-state'
import { resolveInitialMode } from '@/lib/ui-state/client'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { legacyListEditorHref, newEditorHref } from '@/lib/invoices/editor/new-editor-params'
import { formatCurrency, formatDate } from '@/lib/utils'
import { cn } from '@/lib/utils'
import { invoiceDisplayNumber } from '@/lib/invoices/display'
import { getDisplayTotal } from '@/lib/bookkeeping/invoice-rounding'
import { matchesInvoiceSearch } from '@/lib/invoices/invoice-search'
import {
  INVOICE_LIST_TABS,
  QUOTE_LIST_TABS,
  isQuoteRow,
  matchesInvoiceListTab,
  matchesQuoteListTab,
  parseInvoiceListTab,
  parseQuoteListTab,
  segmentViewActive,
  statusPickerTabs,
  type AnyListTab,
  type InvoiceListTab,
  type QuoteListTab,
} from '@/lib/invoices/invoice-list-tabs'
import { isInvoiceTypeEnabled, visibleInvoiceListTabs } from '@/lib/invoices/invoice-type-toggles'
import type { CollectionsStage } from '@accounted/connect-contract'
import { CHIP_LABEL_KEYS, CHIP_VARIANTS, collectionChipKind } from '@/lib/collections/stages'
import {
  capitalizeFirst,
  collectionsEntryShown,
  providerWords,
  useCollectionsAvailability,
} from '@/components/collections/collections-client'
import { BulkHandoverDialog } from '@/components/collections/BulkHandoverDialog'
import { RemindersOfferRow, RemindersStatusButton, useInvoiceListReminders } from '@/components/reminders/InvoiceListReminders'
import { TurnOnRemindersSheet } from '@/components/reminders/TurnOnRemindersSheet'
import { bulkSendable } from '@/lib/collections/bulk-handover'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useInvoiceListVariant } from '@/lib/invoices/list-variant'
import {
  fetchInvoiceRegisterCoverage,
  NO_INVOICE_REGISTER_COVERAGE,
  type InvoiceRegisterCoverage,
} from '@/lib/reports/invoice-register-coverage'
import {
  sortInvoiceList,
  type InvoiceListSort,
  type InvoiceListSortColumn,
} from '@/lib/invoices/invoice-list-sort'
import { invoiceRowTone, type InvoiceRowTone } from '@/lib/invoices/invoice-list-row-tone'
import {
  ROT_RUT_LIST_FILTERS,
  matchesRotRutListFilter,
  parseRotRutListFilter,
  payoutDialogTypeFor,
  rotRutListStateOf,
  type RotRutListFilter,
  type RotRutListItem,
  type RotRutListState,
} from '@/lib/invoices/rot-rut-list-status'
import { listContextKey, writeListContext } from '@/lib/navigation/list-context'
import {
  AdjustmentsHorizontalIcon,
  ArrowPathRoundedSquareIcon,
  DocumentArrowDownIcon,
  DocumentArrowUpIcon,
  DocumentIcon,
  DocumentTextIcon,
  PercentBadgeIcon,
  PlusIcon,
} from '@/components/icons'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { StartCard } from '@/components/dashboard/StartCard'
import { useCompany } from '@/contexts/CompanyContext'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import type { FiscalPeriod, Invoice } from '@/types'
import { invoiceRowStatus } from '@/lib/invoices/status-display'
import { todayIsoStockholm, isPastDue } from '@/lib/dates/iso'

const RotRutPayoutDialog = dynamic(
  () => import('@/components/invoices/RotRutPayoutDialog'),
)


const CREATE_MODES = ['faktura', 'aterkommande', 'sjalvfaktura'] as const

// The status views and their one predicate live in lib/invoices/invoice-list-tabs:
// the visible rows, the per-view counts in the ContextPicker and the status
// sections all go through it, so the annotation always matches what the view
// will show. The quotes variant (/quotes) swaps in the quote views; the
// status sections stay invoice-only (that grouping is hidden for quotes).
type ListTab = AnyListTab
const matchesListTab = matchesInvoiceListTab

// Row grouping: sections in the table body. 'none' (the flat list) is the
// default; the other modes are opt-in via ?group= and mirror the
// supplier-invoices layout (payment queue as its own section).
const GROUP_MODES = ['status', 'customer', 'month', 'none'] as const
type GroupMode = (typeof GROUP_MODES)[number]
const STATUS_SECTION_ORDER = ['drafts', 'unsent', 'awaiting', 'settled'] as const
/** Sentinel bucket for rows with no customer or no date. Not a display
 *  string: the header renders t('group_unknown') for it. */
const UNKNOWN_GROUP_KEY = 'unknown'
const GROUP_LABEL_KEYS: Record<GroupMode, string> = {
  status: 'group_status',
  customer: 'group_customer',
  month: 'group_month',
  none: 'group_none',
}

type StatusGroup = (typeof STATUS_SECTION_ORDER)[number]
/** Sections reuse the tab predicates so the two can never drift: what the
 *  Utkast, Ej skickade and Obetalda tabs show is what the sections bucket. */
function statusGroupOf(invoice: Invoice): StatusGroup {
  if (matchesListTab(invoice, 'draft')) return 'drafts'
  if (matchesListTab(invoice, 'unsent')) return 'unsent'
  if (matchesListTab(invoice, 'unpaid')) return 'awaiting'
  return 'settled'
}

// Row tone (#2215): the list must read without the status column. Settled
// rows recede to muted text, open rows keep the foreground, and the overdue
// chip stays the one marker on its row (one status indicator per element;
// semantic colours stay data-only, convention 12). This Record is the swap
// surface if the founder prefers colour: a row tint is
// 'bg-success/[0.04]' / 'bg-warning/[0.05]' / 'bg-destructive/[0.05]'; a
// left-edge bar is '[&>td:first-child]:border-l-2 [&>td:first-child]:border-l-success'
// and its warning/destructive siblings. Nothing else in the row changes.
const ROW_TONE_CLASS: Record<InvoiceRowTone, string> = {
  settled: 'text-muted-foreground',
  open: '',
  overdue: '',
  none: '',
}

const TAB_LABEL_KEYS: Record<ListTab, string> = {
  all: 'tab_all',
  unpaid: 'tab_unpaid',
  overdue: 'tab_overdue',
  unsent: 'tab_unsent',
  draft: 'tab_draft',
  paid: 'tab_paid',
  proforma: 'tab_proforma',
  delivery_note: 'tab_delivery_note',
  credit: 'tab_credit',
  cancelled: 'tab_cancelled',
  collections: 'tab_collections',
  written_off: 'tab_written_off',
  // Quote views (/quotes): the decision states share the row chip labels.
  open: 'quote_status_open',
  accepted: 'quote_status_accepted',
  declined: 'quote_status_declined',
  expired: 'quote_status_expired',
}

/** A list row: the invoice plus the begäran and deduction-kind embeds the
 *  skattereduktion column reads. */
type ListInvoice = Invoice & {
  rot_rut_items?: RotRutListItem[] | null
  deduction_lines?: Array<{ deduction_type: string | null }> | null
}

const ROT_RUT_STATE_LABEL_KEYS: Record<NonNullable<RotRutListState>, string> = {
  claimable: 'rot_rut_status_claimable',
  etjanst: 'rot_rut_status_etjanst',
  generated: 'rot_rut_status_generated',
  submitted: 'rot_rut_status_submitted',
  paid: 'rot_rut_status_paid',
  partially_paid: 'rot_rut_status_partially_paid',
  rejected: 'rot_rut_status_rejected',
  cancelled: 'rot_rut_status_cancelled',
}
const rotRutFilterLabelKey = (filter: RotRutListFilter): string =>
  filter === 'all' ? 'rot_rut_filter_all' : ROT_RUT_STATE_LABEL_KEYS[filter]

/** Chips mark exceptions (convention 5): a begäran on its way or approved is
 *  the normal state of a ROT/RUT invoice and reads as muted text; only a
 *  partial approval and an avslag deviate. */
const ROT_RUT_EXCEPTION_VARIANT: Partial<
  Record<NonNullable<RotRutListState>, RowStatusDescriptor['variant']>
> = {
  partially_paid: 'warning',
  rejected: 'destructive',
}

/** An open collection case on an invoice, as the list shows it (collection_open_invoice_ids). */
interface ListCollectionCase {
  stage: CollectionsStage
  inCollection: boolean
  displayName: string | null
}

/** Ids behind the "Peppol misslyckades" chip (GET /api/invoices/peppol-failed). */
async function fetchPeppolFailedInvoiceIds(): Promise<string[]> {
  const response = await fetch('/api/invoices/peppol-failed')
  if (!response.ok) throw new Error(`peppol-failed answered ${response.status}`)
  const body = (await response.json()) as { data?: unknown }
  return Array.isArray(body.data) ? body.data.filter((id): id is string => typeof id === 'string') : []
}

export default function InvoicesPage() {
  // 'invoices' (default) or 'quotes': /quotes renders this same component
  // inside InvoiceListVariantProvider. A quote is not an invoice, so the two
  // never share rows: each variant scopes the fetched list to its own kind.
  const variant = useInvoiceListVariant()
  const isQuotesList = variant === 'quotes'
  const listPath = isQuotesList ? '/quotes' : '/invoices'
  const listTabs: readonly ListTab[] = isQuotesList ? QUOTE_LIST_TABS : INVOICE_LIST_TABS
  // The Swedish calendar day Förfallna and the overdue count read (lib/invoices/overdue.ts).
  const today = todayIsoStockholm()
  // Open collection cases per invoice: the chips and the "Hos inkasso" view.
  const [collectionCases, setCollectionCases] = useState<ReadonlyMap<string, ListCollectionCase>>(() => new Map())
  const inCollectionIds = useMemo(
    () => new Set([...collectionCases].filter(([, c]) => c.inCollection).map(([id]) => id)),
    [collectionCases],
  )
  // Collection cases a person must look at (collection_attention_case_ids):
  // the Att göra row lands on "Hos inkasso", so they are listed there too.
  // `failed` holds the refused handovers, which have no open case to chip.
  const [collectionAttention, setCollectionAttention] = useState<{ all: ReadonlySet<string>; failed: ReadonlySet<string> }>(() => ({
    all: new Set(),
    failed: new Set(),
  }))
  // Collections in play for the company (offered, or something open): the
  // list then shows Förfallna and Hos inkasso as visible views and an
  // administrator can send from Förfallna. Nothing changes while collections
  // is hidden.
  const collectionsAvailability = useCollectionsAvailability()
  const collectionsShown = !isQuotesList && collectionsEntryShown(collectionsAvailability)
  const collectionsToday = collectionsShown ? todayIsoStockholm() : undefined
  const matchesTab = (invoice: Invoice, tab: ListTab): boolean =>
    isQuotesList
      ? matchesQuoteListTab(invoice, tab as QuoteListTab)
      : matchesInvoiceListTab(invoice, tab as InvoiceListTab, {
          inCollection: inCollectionIds,
          collectionAttention: collectionAttention.all,
          today,
        })
  const { company } = useCompany()
  const { canWrite } = useCanWrite()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [invoices, setInvoices] = useState<ListInvoice[]>([])
  // Issued invoices whose latest Peppol delivery failed: the
  // "Peppol misslyckades" chip. Same definition as the Att göra row.
  const [peppolFailedIds, setPeppolFailedIds] = useState<ReadonlySet<string>>(() => new Set())
  // Settings-driven gates from the session-cached settings row
  // (lib/reference-data), derived instead of copied into state.
  const { settings: companySettings } = useCompanySettings()
  const oreRounding: boolean = companySettings?.ore_rounding ?? true
  // Invoice kinds hidden in Inställningar > Försäljning drop out of the
  // Ny faktura menu and the status views; existing rows stay under Alla.
  // Quotes are not among them: they have their own page and nav row.
  const proformaEnabled = isInvoiceTypeEnabled(companySettings, 'proforma_enabled')
  const recurringEnabled = isInvoiceTypeEnabled(companySettings, 'recurring_invoices_enabled')
  const selfBillingEnabled = isInvoiceTypeEnabled(companySettings, 'self_billing_enabled')
  const rotRutEnabled: boolean = companySettings?.rot_rut_enabled ?? false
  // Booking mode drives which rows are bulk-bookable (kontantmetoden: none).
  const accountingMethod: string = companySettings?.accounting_method ?? 'accrual'
  const deferInvoiceBooking: boolean = companySettings?.defer_invoice_booking ?? false
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
    return (isQuotesList ? parseQuoteListTab(param) : parseInvoiceListTab(param)) ?? 'all'
  })
  // Grouping sits behind a gear at the right (same as Inköp).
  const [groupMode, setGroupMode] = useState<GroupMode>(() => {
    const param = searchParams.get('group')
    return param && GROUP_MODES.includes(param as never) ? (param as GroupMode) : 'none'
  })
  // ROT/RUT begäran filter (#2426), ?rotrut=. 'all' is the URL-less default.
  const [rotRutFilter, setRotRutFilter] = useState<RotRutListFilter>(
    () => parseRotRutListFilter(searchParams.get('rotrut')) ?? 'all',
  )
  const [visibleCount, setVisibleCount] = useState(SHOW_MORE_STEP)
  // Fiscal-year scope (convention 8): null = all years.
  const [fyPeriodId, setFyPeriodId] = useState<string | null>(null)
  const [fyPeriod, setFyPeriod] = useState<FiscalPeriod | null>(null)
  const { toast } = useToast()
  const supabase = createClient()
  const t = useTranslations('invoices')
  const tCollections = useTranslations('collections')
  const locale = useLocale()
  const tStart = useTranslations('start_cards')
  const { uiState, loaded: uiStateLoaded } = useUiState()
  // Reminders (accounted#104): the offer or the status control, read once
  // after the list has loaded and only while REMINDERS_SENDING_ENABLED is on.
  const reminders = useInvoiceListReminders(!isQuotesList && !isLoading)

  // "Ny faktura" (and offert, proforma, självfaktura, copy) is its own page,
  // the one-screen editor at /invoices/new. Old links that opened the list's
  // dialog (?new=1, ?quote=1, ?copy=<id>: bookmarks, agent intents) are
  // rewritten to it.
  const legacyEditorHref = legacyListEditorHref(searchParams)
  useEffect(() => {
    if (legacyEditorHref) router.replace(legacyEditorHref)
  }, [legacyEditorHref, router])
  const showRotRutPayout = searchParams.has('rot-rut')
  // Open/close handlers rewrite only their own keys: a hardcoded '/invoices'
  // would destroy the ?status= view write-back (and any other params) every
  // time a dialog opens or closes.
  const invoicesUrl = (mutate: (params: URLSearchParams) => void) => {
    const params = new URLSearchParams(searchParams.toString())
    mutate(params)
    const qs = params.toString()
    return qs ? `${listPath}?${qs}` : listPath
  }
  const openNewInvoice = () => router.push(newEditorHref())
  const openNewSelfBilled = () => router.push(newEditorHref({ type: 'self_billed' }))
  const openNewQuote = () => router.push(newEditorHref({ type: 'quote' }))
  const openNewProforma = () => router.push(newEditorHref({ type: 'proforma' }))
  const closeRotRutPayout = () =>
    router.replace(invoicesUrl((p) => p.delete('rot-rut')), { scroll: false })

  // Begäran om utbetalning (Lag 2009:194 8 §) only concerns companies selling
  // ROT/RUT-eligible work to consumers, so the action stays out of the header
  // for everyone else. It appears once the company has invoiced a deduction
  // (the payout can never precede that invoice), or once ROT/RUT is opted into
  // in tax settings. Not scoped to the fiscal-year filter: a payout is claimed
  // the year after payment, so last year's invoices are exactly the relevant
  // ones. ?rot-rut=1 keeps working regardless, so nothing is unreachable.
  const showRotRutAction =
    !isQuotesList &&
    (rotRutEnabled || invoices.some((invoice) => (invoice.deduction_total ?? 0) > 0))
  // The begäran column and its filter share that gate: a company without
  // ROT/RUT never sees an empty column or a picker with nothing to pick.
  const showRotRut = showRotRutAction
  // Dröjsmålsränta (accounted#38) has its own page; the way there appears
  // once an issued invoice is past its due date, the only case it can list.
  const showLateInterestAction =
    !isQuotesList &&
    invoices.some(
      (invoice) =>
        invoice.document_type === 'invoice' &&
        !invoice.credited_invoice_id &&
        invoice.status !== 'draft' &&
        invoice.status !== 'cancelled' &&
        isPastDue(invoice.due_date, today),
    )
  // An installer who only invoices grön teknik lands on its list, not an
  // empty ROT one.
  const rotRutPayoutType = useMemo(() => payoutDialogTypeFor(invoices), [invoices])

  // Invoice-register coverage (see lib/reports/invoice-register-coverage.ts):
  // a migrated or backfilled company has invoices that live only as verifikat,
  // so this list looks complete for periods it doesn't cover. One quiet attn
  // line discloses the boundary; without it the user's next step is "those
  // invoices were never sent" (the 2026-09-01 report: nearly double-invoiced).
  const [registerCoverage, setRegisterCoverage] = useState<InvoiceRegisterCoverage>(
    NO_INVOICE_REGISTER_COVERAGE,
  )
  useEffect(() => {
    if (!company) {
      setRegisterCoverage(NO_INVOICE_REGISTER_COVERAGE)
      return
    }
    let cancelled = false
    ;(async () => {
      const coverage = await fetchInvoiceRegisterCoverage(supabase, company.id)
      if (!cancelled) setRegisterCoverage(coverage)
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [company?.id])

  async function fetchInvoices() {
    if (!company) return
    // Skeleton takeover only while nothing is on screen: refetches after an
    // action (bulk Bokför) reconcile BEHIND the rendered table. Collapsing
    // hundreds of rows to 3 skeleton stubs and replaying the stagger-enter
    // entrance for a row-scoped action was the "booking feels glitchy" jump.
    if (invoices.length === 0) setIsLoading(true)
    const [invoicesResult, peppolFailedResult, collectionsResult, collectionAttentionResult] = await Promise.allSettled([
      fetchAllRows<Invoice>(
        ({ from, to }) => {
          const query = supabase
            .from('invoices')
            // The begäran embed feeds the ROT/RUT column and filter; the
            // items index on invoice_id keeps the reverse join cheap. The
            // deduction-line embed (kind only, deduction lines only, so
            // empty on most invoices) tells a grön teknik invoice, requested
            // in Skatteverkets e-tjänst, from one still to put in a file.
            .select(
              '*, customer:customers(name), rot_rut_items:rot_rut_payout_request_items(request:rot_rut_payout_requests(id, status, created_at)), deduction_lines:invoice_items(deduction_type)',
            )
            .eq('company_id', company.id)
          // /quotes asks the database for quotes only instead of paging
          // through every invoice to keep a handful (document_type is NOT
          // NULL, default 'invoice'). The invoice list still loads every
          // kind: its start card shows only for a company with no rows at
          // all, and a filter here would show it to a quotes-only company.
          return (isQuotesList ? query.eq('document_type', 'quote') : query)
            .not('deduction_lines.deduction_type', 'is', null)
            .order('invoice_date', { ascending: false })
            .order('id', { ascending: false })
            .range(from, to)
        },
        { dedupeBy: (invoice) => invoice.id },
      ),
      // The chip's ids: the same definition as the Att göra row
      // (peppol_failed_invoice_ids). Quotes are never sent via Peppol.
      isQuotesList ? Promise.resolve<string[]>([]) : fetchPeppolFailedInvoiceIds(),
      // Open collection cases (an obligation read: shown whatever the start
      // gates say). Quotes never have one.
      isQuotesList
        ? Promise.resolve(null)
        : Promise.resolve(supabase.rpc('collection_open_invoice_ids', { p_company_id: company.id })),
      isQuotesList
        ? Promise.resolve(null)
        : Promise.resolve(supabase.rpc('collection_attention_case_ids', { p_company_id: company.id })),
    ])

    // A failed read leaves the chips as they were: they mark an exception,
    // and the Att göra row carries the same count.
    if (peppolFailedResult.status === 'fulfilled') setPeppolFailedIds(new Set(peppolFailedResult.value))
    if (collectionsResult.status === 'fulfilled' && collectionsResult.value && !collectionsResult.value.error) {
      const rows = (collectionsResult.value.data ?? []) as Array<{
        invoice_id: string
        stage: CollectionsStage
        in_collection: boolean
        display_name: string | null
      }>
      setCollectionCases(
        new Map(rows.map((r) => [r.invoice_id, { stage: r.stage, inCollection: r.in_collection, displayName: r.display_name }])),
      )
    }
    if (collectionAttentionResult.status === 'fulfilled' && collectionAttentionResult.value && !collectionAttentionResult.value.error) {
      const rows = (collectionAttentionResult.value.data ?? []) as Array<{ invoice_id: string; reason: string }>
      setCollectionAttention({
        all: new Set(rows.map((r) => r.invoice_id)),
        failed: new Set(rows.filter((r) => r.reason === 'submission_failed').map((r) => r.invoice_id)),
      })
    }
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
  const searchScopedInvoices = useMemo(
    () =>
      invoices.filter((invoice) => {
        // Each list shows its own kind only: quotes on /quotes, the rest here.
        if (isQuoteRow(invoice) !== isQuotesList) return false
        const matchesSearch = matchesInvoiceSearch(invoice, normalizedSearch)

        const matchesFy =
          !fyPeriod ||
          (invoice.invoice_date >= fyPeriod.period_start &&
            invoice.invoice_date <= fyPeriod.period_end)

        return matchesSearch && matchesFy
      }),
    [fyPeriod, invoices, isQuotesList, normalizedSearch],
  )
  // The ROT/RUT filter sits between search/FY and the status view, so the
  // status counts honour it while its own counts are taken one level up.
  const scopedInvoices = useMemo(
    () =>
      rotRutFilter === 'all'
        ? searchScopedInvoices
        : searchScopedInvoices.filter((invoice) => matchesRotRutListFilter(invoice, rotRutFilter)),
    [rotRutFilter, searchScopedInvoices],
  )
  const filteredInvoices = useMemo(
    () => scopedInvoices.filter((invoice) => matchesTab(invoice, activeTab)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- matchesTab only varies with isQuotesList, the collection ids and today
    [activeTab, isQuotesList, scopedInvoices, inCollectionIds, collectionAttention, today],
  )
  const sortedInvoices = useMemo(
    () => (sort ? sortInvoiceList(filteredInvoices, sort, oreRounding) : filteredInvoices),
    [filteredInvoices, oreRounding, sort],
  )
  // Grouping: bucket the sorted rows through the shared helper, then flatten
  // back to one list so paging, range selection and the detail pager walk the
  // exact rendered order. Sorting stays above; the helper only sections.
  const { flatRows, groupMeta } = useMemo(() => {
    if (groupMode === 'none') {
      const flat = ungrouped(sortedInvoices)
      return { flatRows: flat.rows, groupMeta: flat.meta }
    }
    const grouped =
      groupMode === 'status'
        ? groupRows(sortedInvoices, {
            keyOf: (invoice) => ({ key: statusGroupOf(invoice), label: statusGroupOf(invoice) }),
            order: STATUS_SECTION_ORDER,
          })
        : groupMode === 'customer'
          ? groupRows(sortedInvoices, {
              keyOf: (invoice) => {
                const label = (invoice.customer as { name: string })?.name ?? UNKNOWN_GROUP_KEY
                // Bucket by id, not display name: two customers can share one.
                return { key: invoice.customer_id ?? label, label }
              },
              order: (a, b) => a.label.localeCompare(b.label, 'sv'),
            })
          : groupRows(sortedInvoices, {
              keyOf: (invoice) => {
                const key = (invoice.invoice_date ?? '').slice(0, 7) || UNKNOWN_GROUP_KEY
                return { key, label: key }
              },
              order: (a, b) => b.key.localeCompare(a.key),
            })
    return { flatRows: grouped.rows, groupMeta: grouped.meta }
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
      if (key === 'unsent') return t('section_unsent', { count })
      if (key === 'awaiting') return t('section_awaiting', { count })
      return t('section_settled', { count })
    }
    if (groupMode === 'month' && key !== UNKNOWN_GROUP_KEY) {
      const label = monthFormatter.format(new Date(`${key}-01T00:00:00`))
      return `${label.charAt(0).toLocaleUpperCase('sv-SE')}${label.slice(1)} (${count})`
    }
    if (key === UNKNOWN_GROUP_KEY) return `${t('group_unknown')} (${count})`
    return `${meta?.label ?? key} (${count})`
  }

  // Detail-pager context: the FULL grouped list (not the visible slice), so
  // prev/next on the detail page can walk past the paging boundary.
  const rememberListContext = () => {
    writeListContext(listContextKey(variant, company?.id), {
      ids: flatRows.map((entry) => entry.row.id),
    })
  }

  const tabCounts = useMemo(() => {
    const counts = Object.fromEntries(listTabs.map((tab) => [tab, 0])) as Record<ListTab, number>
    for (const invoice of scopedInvoices) {
      for (const tab of listTabs) {
        if (matchesTab(invoice, tab)) counts[tab] += 1
      }
    }
    return counts
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listTabs/matchesTab only vary with isQuotesList, the collection ids and today
  }, [isQuotesList, scopedInvoices, inCollectionIds, collectionAttention, today])

  const rotRutCounts = useMemo(() => {
    const counts = Object.fromEntries(ROT_RUT_LIST_FILTERS.map((f) => [f, 0])) as Record<
      RotRutListFilter,
      number
    >
    for (const invoice of searchScopedInvoices) {
      const state = rotRutListStateOf(invoice)
      counts.all += 1
      if (state && state in counts) counts[state as RotRutListFilter] += 1
    }
    return counts
  }, [searchScopedInvoices])

  const resetPaging = () => setVisibleCount(SHOW_MORE_STEP)
  // Status sections bucket by invoice payment state, which a quote has none of.
  const groupModes: readonly GroupMode[] = isQuotesList
    ? GROUP_MODES.filter((mode) => mode !== 'status')
    : GROUP_MODES

  const updateSort = (column: InvoiceListSortColumn) => {
    setSort((current) => ({
      column,
      direction:
        current?.column === column && current.direction === 'asc' ? 'desc' : 'asc',
    }))
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
    router.replace(qs ? `${listPath}?${qs}` : listPath, { scroll: false })
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
    router.replace(qs ? `${listPath}?${qs}` : listPath, { scroll: false })
  }

  const updateRotRut = (filter: RotRutListFilter) => {
    setRotRutFilter(filter)
    resetPaging()
    const params = new URLSearchParams(searchParams.toString())
    if (filter === 'all') params.delete('rotrut')
    else params.set('rotrut', filter)
    const qs = params.toString()
    router.replace(qs ? `${listPath}?${qs}` : listPath, { scroll: false })
  }

  // Bulk Bokför eligibility. Kontantmetoden books at payment, so no row is
  // selectable (the checkbox column is hidden entirely). Accrual companies
  // that book at issue select drafts ("Bokför och markera som skickade");
  // deferred companies (#967) select sent/overdue invoices that lack a
  // verifikat (worklist-canonical predicate: journal_entry_id IS NULL).
  const bulkMode: 'issue' | 'deferred' | null =
    accountingMethod !== 'accrual' ? null : deferInvoiceBooking ? 'deferred' : 'issue'
  // Förfallna, collections ready: the checkboxes pick invoices to send to
  // the provider ("Skicka till inkasso (N)") instead of bulk Bokför.
  const collectionsBulk =
    collectionsShown && collectionsAvailability?.start === 'ready' && canWrite && activeTab === 'overdue' && !!collectionsToday
  const showSelection = canWrite && !isQuotesList && (bulkMode !== null || collectionsBulk)
  const [showBulkHandover, setShowBulkHandover] = useState(false)

  const isBulkSelectable = (invoice: Invoice): boolean => {
    if (collectionsBulk && collectionsToday) {
      return bulkSendable(invoice, { today: collectionsToday, openCaseIds: new Set(collectionCases.keys()) })
    }
    if (!bulkMode) return false
    const docType = (invoice as Invoice & { document_type?: string }).document_type || 'invoice'
    if (docType !== 'invoice' || invoice.credited_invoice_id) return false
    if (bulkMode === 'issue') return invoice.status === 'draft'
    return ['sent', 'overdue'].includes(invoice.status) && !invoice.journal_entry_id
  }

  const selectableInvoices = filteredInvoices.filter(isBulkSelectable)
  // The selection is the selectable invoices of the current tab, filter and
  // search: a row they hide leaves it (useBulkSelection). Ranges walk the
  // rendered rows only: the list is cut at visibleCount, so rows below the
  // fold are not in range.
  const selection = useBulkSelection(
    selectableInvoices.map((inv) => inv.id),
    {
      rangeIds: visibleRows
        .filter((entry) => isBulkSelectable(entry.row))
        .map((entry) => entry.row.id),
    },
  )
  const { selectedIds, toggle: toggleSelect } = selection
  // A selection made for one action never carries over to the other
  // (adjust-state-during-render: the mode flips with the view or the read).
  const [selectionForCollections, setSelectionForCollections] = useState(collectionsBulk)
  if (selectionForCollections !== collectionsBulk) {
    setSelectionForCollections(collectionsBulk)
    selection.clear()
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
      selection.clear()
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
      icon: PlusIcon,
      description: t('create_invoice_desc'),
      disabled: !canWrite,
      disabledTitle: t('viewer_disabled_tooltip'),
      onSelect: () => openNewInvoice(),
    },
    ...(proformaEnabled
      ? [
          {
            key: 'proforma',
            label: t('create_proforma'),
            icon: DocumentIcon,
            description: t('create_proforma_desc'),
            disabled: !canWrite,
            disabledTitle: t('viewer_disabled_tooltip'),
            onSelect: () => openNewProforma(),
          } satisfies SplitButtonOption,
        ]
      : []),
    ...(recurringEnabled
      ? [
          {
            key: 'aterkommande',
            label: t('create_recurring'),
            icon: ArrowPathRoundedSquareIcon,
            description: t('create_recurring_desc'),
            onSelect: () => router.push('/invoices/recurring'),
          } satisfies SplitButtonOption,
        ]
      : []),
    ...(selfBillingEnabled
      ? [
          {
            key: 'sjalvfaktura',
            label: t('create_self'),
            icon: DocumentArrowUpIcon,
            description: t('create_self_desc'),
            disabled: !canWrite,
            disabledTitle: t('viewer_disabled_tooltip'),
            onSelect: () => openNewSelfBilled(),
          } satisfies SplitButtonOption,
        ]
      : []),
  ]

  // One derivable status chip per row (concept scene 15). Doc-type markers
  // (proforma/följesedel/självfaktura) only appear in views where the type
  // isn't already implied.
  // The row's own status line is shared with the customer card
  // (lib/invoices/status-display.ts invoiceRowStatus); the list adds what
  // only it knows: a collection case and a failed Peppol delivery.
  function statusDescriptor(invoice: Invoice): RowStatusDescriptor {
    const row = invoiceRowStatus(invoice, today)
    const inPaymentFlow = row.kind === 'partially_paid' || row.kind === 'overdue' || row.kind === 'sent' || row.kind === 'unknown'
    if (inPaymentFlow) {
      // An open collection case: where the provider has the invoice outranks
      // the overdue count (chips mark exceptions; an invoice with a case is one).
      const collectionCase = collectionCases.get(invoice.id)
      const collectionKind = collectionCase ? collectionChipKind(collectionCase.stage) : null
      if (collectionCase && collectionKind) {
        const words = providerWords(collectionCase.displayName, locale === 'en' ? 'en' : 'sv')
        return {
          label: capitalizeFirst(tCollections(CHIP_LABEL_KEYS[collectionKind], words)),
          exception: true,
          variant: CHIP_VARIANTS[collectionKind],
        }
      }
      // A refused handover on an invoice still owed: the Att göra row's item.
      if (collectionAttention.failed.has(invoice.id)) {
        return { label: tCollections('chip_failed'), exception: true, variant: 'destructive' }
      }
      // Issued, and the Peppol network did not take it: the likely reason it is
      // unpaid outranks the overdue count.
      if (row.kind !== 'partially_paid' && peppolFailedIds.has(invoice.id)) {
        return { label: t('status_peppol_failed'), exception: true, variant: 'destructive' }
      }
    }
    if (!row.labelKey) return { label: invoice.status }
    const values = row.values && 'date' in row.values ? { date: formatDate(row.values.date) } : row.values
    return { label: t(row.labelKey, values), exception: row.chip !== null, variant: row.chip ?? undefined }
  }

  function rotRutDescriptor(state: NonNullable<RotRutListState>): RowStatusDescriptor {
    const variant = ROT_RUT_EXCEPTION_VARIANT[state]
    return { label: t(ROT_RUT_STATE_LABEL_KEYS[state]), exception: variant !== undefined, variant }
  }

  return (
    <div className="space-y-8">
      {/* Page header (concept scene 15): title + invoice actions */}
      <div className="page-header flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <h1 className="page-header-title font-display text-2xl leading-8 tracking-tight">
          {t(isQuotesList ? 'title_quotes' : 'title')}
        </h1>
        <div className="flex flex-wrap items-center gap-2">
          {reminders.entry === 'status' && <RemindersStatusButton onOpen={reminders.openSheet} />}
          {showRotRutAction && (
            // The ROT/RUT overview (begäran, beslut, utbetalning, nekat
            // belopp) has its own page; the file dialog still opens from
            // ?rot-rut=1 here for existing links and the Att göra rows.
            <Button size="sm"
              type="button"
              variant="outline"
              onClick={() => router.push('/invoices/rot-rut')}
            >
              <DocumentArrowDownIcon className="mr-2 h-4 w-4" />
              {t('rot_rut_payout_action')}
            </Button>
          )}
          {showLateInterestAction && (
            <Button size="sm" type="button" variant="outline" onClick={() => router.push('/invoices/late-payment-interest')}>
              <PercentBadgeIcon className="mr-2 h-4 w-4" />
              {t('late_interest_action')}
            </Button>
          )}
          {isQuotesList ? (
            // One way to make a quote, so a plain button: no modes to remember.
            <Button size="sm"
              type="button"
              onClick={openNewQuote}
              disabled={!canWrite}
              title={!canWrite ? t('viewer_disabled_tooltip') : undefined}
            >
              <DocumentTextIcon className="mr-2 h-4 w-4" />
              {t('create_quote')}
            </Button>
          ) : (
            <SplitButton
              key={uiStateLoaded ? 'loaded' : 'initial'}
              persistKey="invoices"
              initialModeKey={resolveInitialMode(uiState, 'invoices', CREATE_MODES, 'faktura')}
              options={createOptions}
            />
          )}
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
            // Förfallna and Hos inkasso have one door each: the segmented control beside the picker.
            segmentViewActive(activeTab, collectionsShown)
              ? t('status_picker_label')
              : tabCounts[activeTab] > 0
                ? `${t(TAB_LABEL_KEYS[activeTab])} · ${tabCounts[activeTab]}`
                : t(TAB_LABEL_KEYS[activeTab])
          }
          items={(isQuotesList
            ? listTabs
            : statusPickerTabs(visibleInvoiceListTabs(INVOICE_LIST_TABS, companySettings, activeTab as InvoiceListTab), collectionsShown).filter(
                // "Hos inkasso" only once something is there (or it is the view in use).
                (tab) => tab !== 'collections' || inCollectionIds.size > 0 || collectionAttention.all.size > 0 || activeTab === 'collections',
              ).filter(
                // "Kundförlust" likewise only once an invoice is written off.
                (tab) => tab !== 'written_off' || tabCounts.written_off > 0 || activeTab === 'written_off',
              )
          ).map((tab) => ({
            id: tab,
            label: t(TAB_LABEL_KEYS[tab]),
            annotation: tabCounts[tab] > 0 ? String(tabCounts[tab]) : undefined,
          }))}
        />
        {showRotRut && (
          <ContextPicker
            value={rotRutFilter}
            onChange={(id) => updateRotRut(id as RotRutListFilter)}
            ariaLabel={t('rot_rut_filter_aria')}
            triggerLabel={
              rotRutFilter !== 'all' && rotRutCounts[rotRutFilter] > 0
                ? `${t('rot_rut_filter_label')} · ${t(rotRutFilterLabelKey(rotRutFilter))} · ${rotRutCounts[rotRutFilter]}`
                : `${t('rot_rut_filter_label')} · ${t(rotRutFilterLabelKey(rotRutFilter))}`
            }
            items={ROT_RUT_LIST_FILTERS.map((filter) => ({
              id: filter,
              label: t(rotRutFilterLabelKey(filter)),
              annotation:
                filter !== 'all' && rotRutCounts[filter] > 0 ? String(rotRutCounts[filter]) : undefined,
            }))}
          />
        )}
        {/* Förfallna and Hos inkasso as visible views while collections is
            in play (the status picker then leaves them out, so each has one
            door). Pressing the active one again goes back to Alla. */}
        {collectionsShown && (
          <SegmentedControl<'overdue' | 'collections'>
            aria-label={tCollections('views_aria')}
            value={activeTab as 'overdue' | 'collections'}
            onChange={(next) => updateTab(next === activeTab ? 'all' : next)}
            options={[
              { value: 'overdue', label: t(TAB_LABEL_KEYS.overdue), count: tabCounts.overdue },
              { value: 'collections', label: t(TAB_LABEL_KEYS.collections), count: tabCounts.collections },
            ]}
          />
        )}
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
                {groupModes.map((mode) => (
                  <DropdownMenuRadioItem key={mode} value={mode}>
                    {t(GROUP_LABEL_KEYS[mode])}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {/* Coverage boundary (convention 6: one page-domain attn line). Shown
          only when posted AR verifikat predate covers_from, the date from
          which the register is complete: the list is then silently
          incomplete for that period. */}
      {registerCoverage.has_pre_register_invoices && registerCoverage.covers_from && (
        <p className="attn text-[12.5px]">
          {t('coverage_notice', { date: formatDate(registerCoverage.covers_from) })}
        </p>
      )}

      {reminders.offerShown && (
        <RemindersOfferRow count={reminders.offerCount} onOpen={reminders.openSheet} onDismiss={reminders.dismiss} />
      )}

      {/* Bulkbar: appears once anything is selected (supplier-invoices shape). */}
      <BulkSelectionBar
        selection={selection}
        selectableCount={selectableInvoices.length}
        countLabel={t('bulkbar_selected', { count: selectedIds.size })}
        selectAllLabel={t('bulk_select_all', { count: selectableInvoices.length })}
        clearLabel={t('bulk_clear')}
      >
        {collectionsBulk ? (
          <Button size="sm" onClick={() => setShowBulkHandover(true)}>
            {tCollections('bulk_send', { count: selectedIds.size })}
          </Button>
        ) : (
          <Button size="sm" onClick={() => setShowBulkBookConfirm(true)}>
            {bulkMode === 'issue'
              ? t('bulk_book_and_send_action', { count: selectedIds.size })
              : t('bulk_book_action', { count: selectedIds.size })}
          </Button>
        )}
      </BulkSelectionBar>

      {activeTab === 'collections' && !isQuotesList && (
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-1 text-[12.5px] text-muted-foreground">
          <span>
            {capitalizeFirst(
              tCollections(
                'collections_view_heading',
                providerWords(collectionsAvailability?.displayName ?? null, locale === 'en' ? 'en' : 'sv'),
              ),
            )}
          </span>
          <Link href="/invoices/settlements" className={QUIET_LINK_CLASS}>
            {tCollections('settlements_link')}
          </Link>
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
            icon={<DocumentTextIcon className="h-6 w-6" />}
            title={t('no_search_results_title')}
            description={
              <span data-ph-mask="">
                {t(isQuotesList ? 'no_search_results_quotes_description' : 'no_search_results_description', {
                  term: searchTerm,
                })}
              </span>
            }
          />
        ) : invoices.length === 0 && !isQuotesList ? (
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
            icon={isQuotesList ? <DocumentTextIcon className="h-6 w-6" /> : <DocumentTextIcon className="h-6 w-6" />}
            title={t(
              isQuotesList
                ? 'no_quotes_title'
                : activeTab === 'unsent'
                  ? 'no_unsent_title'
                  : 'no_category_title',
            )}
            description={t(
              isQuotesList
                ? 'no_quotes_description'
                : activeTab === 'unsent'
                  ? 'no_unsent_description'
                  : 'no_category_description',
            )}
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
                <SortableTh
                  label={t('th_nr')}
                  direction={sort?.column === 'number' ? sort.direction : null}
                  onSort={() => updateSort('number')}
                />
                <SortableTh
                  label={t('th_customer')}
                  className="w-full"
                  direction={sort?.column === 'customer' ? sort.direction : null}
                  onSort={() => updateSort('customer')}
                />
                <SortableTh
                  label={t(isQuotesList ? 'th_valid_until' : 'th_due')}
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
                {showRotRut && (
                  <th className={cn(TH_CLASS, 'whitespace-nowrap')}>{t('th_rot_rut')}</th>
                )}
                <SortableTh
                  label={t('th_status')}
                  direction={sort?.column === 'status' ? sort.direction : null}
                  onSort={() => updateSort('status')}
                />
              </tr>
            </thead>
            <tbody className="stagger-enter">
              {visibleRows.map(({ row: invoice, groupKey }, index) => {
                const prevKey = index > 0 ? visibleRows[index - 1].groupKey : undefined
                const showHeader = showGroupHeaders && groupKey !== null && groupKey !== prevKey
                const status = statusDescriptor(invoice)
                const rotRutState = showRotRut ? rotRutListStateOf(invoice) : null
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
                  activeTab === 'all' && !isQuotesList
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
                    <tr data-no-stagger>
                      <td
                        colSpan={(showSelection ? 6 : 5) + (showRotRut ? 1 : 0)}
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
                      ROW_TONE_CLASS[invoiceRowTone(invoice, today)],
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
                          <RowSelectCheckbox
                            checked={selectedIds.has(invoice.id)}
                            revealed={selectedIds.size > 0}
                            onClick={(e) => {
                              shiftHeld.current = e.shiftKey
                            }}
                            onCheckedChange={() => toggleSelect(invoice.id, shiftHeld.current)}
                            aria-label={t('bulk_select_row')}
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
                      {docType === 'quote'
                        ? invoice.valid_until
                          ? formatDate(invoice.valid_until)
                          : ''
                        : invoice.due_date && !isCreditNote && invoice.status !== 'draft'
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
                    {showRotRut && (
                      <td className={cn(TD_CLASS, 'whitespace-nowrap')}>
                        {rotRutState && <RowStatus status={rotRutDescriptor(rotRutState)} />}
                      </td>
                    )}
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

      {!isLoading && (
        <ShowMoreFooter
          shown={visibleCount}
          total={flatRows.length}
          onMore={() => setVisibleCount((count) => count + SHOW_MORE_STEP)}
        />
      )}

      {showRotRutPayout && (
        <RotRutPayoutDialog
          open
          canWrite={canWrite}
          initialType={rotRutPayoutType}
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

      {/* "Skicka till inkasso (N)": each ticked invoice with its bank check
          and first step; the ones that need a person are held with why. */}
      {collectionsBulk && collectionsAvailability && showBulkHandover && (
        <BulkHandoverDialog
          open={showBulkHandover}
          onOpenChange={setShowBulkHandover}
          invoices={selectedInvoices.map((inv) => ({
            id: inv.id,
            invoiceNumber: inv.invoice_number,
            customerName: (inv.customer as { name: string } | null)?.name ?? null,
          }))}
          displayName={collectionsAvailability.displayName}
          sandbox={collectionsAvailability.sandbox}
          onDone={() => {
            selection.clear()
            void fetchInvoices()
          }}
        />
      )}

      <TurnOnRemindersSheet {...reminders.sheet} />
    </div>
  )
}
