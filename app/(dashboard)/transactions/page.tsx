'use client'

import { useState, useEffect, useMemo, useRef, useCallback } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { DataList, DataListEmpty } from '@/components/ui/data-list'
import { Skeleton } from '@/components/ui/skeleton'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import { TH_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { Loader2 } from 'lucide-react'
import TransactionStatusBar from '@/components/transactions/TransactionStatusBar'
import BankSyncStatusChip from '@/components/transactions/BankSyncStatusChip'
import { ContextPicker, type ContextPickerItem } from '@/components/common/ContextPicker'
import { FyPicker } from '@/components/common/FyPicker'
import { ALL_YEARS_VALUE } from '@/components/common/FiscalYearSelector'
import { AttnLine } from '@/components/ui/attn-line'
import BankSyncNowButton from '@/components/transactions/BankSyncNowButton'
import BankSyncSinceLastVisit from '@/components/transactions/BankSyncSinceLastVisit'
import TransactionInboxCard from '@/components/transactions/TransactionInboxCard'
import TransactionHistoryList from '@/components/transactions/TransactionHistoryList'
import InboxZeroState from '@/components/transactions/InboxZeroState'
import SkattekontoInboxCard from '@/components/transactions/SkattekontoInboxCard'
import type { BookedDuplicateCandidate } from '@/lib/transactions/booking-duplicate-detection'
import { mapWithConcurrency } from '@/lib/concurrency'

import { DialogLoadingSkeleton } from '@/components/ui/dialog-loading-skeleton'
import { getTemplateById, type BookingTemplate } from '@/lib/bookkeeping/booking-templates'
import { resolveQuickReviewDefaults, type ReviewTemplate } from '@/lib/transactions/quick-review-defaults'
import { isCounterpartyTemplateId, extractCounterpartyId } from '@/lib/bookkeeping/counterparty-templates'
import { isLibraryTemplateId } from '@/lib/bookkeeping/template-library'
import type { ProposalLine } from '@/lib/bookkeeping/proposal-lines'
import type {
  TransactionWithInvoice,
  ViewMode,
  SourceFilter,
  CategorizeHandler,
  PotentialVoucher,
} from '@/components/transactions/transaction-types'
import { SuggestionReviewList } from '@/components/transactions/SuggestionReviewList'
import {
  isSourceFilter,
  readStoredSourceFilter,
  resolveEffectiveSourceFilter,
  writeStoredSourceFilter,
} from '@/components/transactions/source-filter-storage'
import type {
  SkattekontoBatchResult,
  SkattekontoBatchRowResult,
  SkattekontoTransactionWithSuggestion,
  StoredSkattekontoTransaction,
} from '@/types/skatteverket'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { findBankSkvCounterparts } from '@/lib/skatteverket/bank-counterpart'
import { skvStatusNeedsReconnect, type SkvStatusLike } from '@/lib/notices/predicates'
import {
  MATCHABLE_INVOICE_STATUSES,
  MATCHABLE_SUPPLIER_INVOICE_STATUSES,
} from '@/lib/invoices/matchable-statuses'
import { useCompany } from '@/contexts/CompanyContext'
import { useCashAccounts } from '@/lib/reference-data/hooks'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { useRealtimeSupabase } from '@/lib/hooks/use-realtime-supabase'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import type { TransactionCategory, CreateTransactionInput, Invoice, Customer, SupplierInvoice, Supplier, VatTreatment, EntityType, LinePatternEntry, BookingTemplateLibrary } from '@/types'
import type { SuggestedTemplate } from '@/lib/transactions/category-suggestions'
import { isImportedTransaction } from '@/lib/transactions/origin'
import { computeJeUnderlagStatus, type JeUnderlagStatus } from '@/lib/transactions/underlag-status'
import { isWithinBounds, resolvePeriodBounds } from '@/lib/transactions/period-filter'
import type { FiscalPeriod } from '@/types'

function InlineDialogContentLoading() {
  return (
    <div className="space-y-4 py-4" role="status">
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-24 w-full" />
      <Skeleton className="h-10 w-40" />
    </div>
  )
}

const TransactionForm = dynamic(() => import('@/components/transactions/TransactionForm'), { loading: InlineDialogContentLoading })
const BatchCategorySelector = dynamic(() => import('@/components/transactions/BatchCategorySelector'), { loading: DialogLoadingSkeleton })
const InvoiceMatchDialog = dynamic(() => import('@/components/transactions/InvoiceMatchDialog'), { loading: DialogLoadingSkeleton })
const MatchVoucherDialog = dynamic(
  () => import('@/components/transactions/MatchVoucherDialog').then((module) => module.MatchVoucherDialog),
  { loading: DialogLoadingSkeleton },
)
const InvoicePicker = dynamic(() => import('@/components/transactions/InvoicePicker'), { loading: InlineDialogContentLoading })
const SupplierInvoicePicker = dynamic(() => import('@/components/transactions/SupplierInvoicePicker'), { loading: InlineDialogContentLoading })
const MatchAllocationDialog = dynamic(() => import('@/components/transactions/MatchAllocationDialog'), { loading: DialogLoadingSkeleton })
const BulkBookDialog = dynamic(() => import('@/components/transactions/BulkBookDialog'), { loading: DialogLoadingSkeleton })
const TransactionBookingDialog = dynamic(() => import('@/components/transactions/TransactionBookingDialog'), { loading: DialogLoadingSkeleton })
const TransactionAttachDocumentDialog = dynamic(
  () => import('@/components/transactions/TransactionAttachDocumentDialog'),
  { loading: DialogLoadingSkeleton },
)
const QuickReviewDialog = dynamic(() => import('@/components/transactions/QuickReviewDialog'), { loading: DialogLoadingSkeleton })
const EditTransactionTitleDialog = dynamic(
  () => import('@/components/transactions/EditTransactionTitleDialog'),
  { loading: DialogLoadingSkeleton },
)
const MoveTransactionCashAccountDialog = dynamic(
  () => import('@/components/transactions/MoveTransactionCashAccountDialog'),
  { loading: DialogLoadingSkeleton },
)
const SkattekontoMatchDialog = dynamic(
  () => import('@/components/skattekonto/SkattekontoMatchDialog').then((module) => module.SkattekontoMatchDialog),
  { loading: DialogLoadingSkeleton },
)
const SkattekontoBookDialog = dynamic(
  () => import('@/components/skattekonto/SkattekontoBookDialog'),
  { loading: DialogLoadingSkeleton },
)
const DuplicateBookingDialog = dynamic(
  () => import('@/components/transactions/DuplicateBookingDialog'),
  { loading: DialogLoadingSkeleton },
)
const TemplatePicker = dynamic(() => import('@/components/transactions/TemplatePicker'), { loading: InlineDialogContentLoading })

type InvoiceWithCustomer = Invoice & { customer?: Customer }
type SupplierInvoiceWithSupplier = SupplierInvoice & { supplier?: Supplier }

// Page-local fiscal-year scope (FyPicker appends the company id). Deliberately
// NOT the shared report scope (Accounted:fiscal-year:): a year picked on a
// report page must never silently hide pending inbox rows here, and vice versa.
const PERIOD_FILTER_STORAGE_PREFIX = 'Accounted:transactions-fy-scope:v1:'

// Journal-entry ids get interpolated into the supplier-invoice .or() filter
// string in the underlag-badge effect below. They come from journal_entries.id
// (DB-sourced), but this guard keeps the interpolated list UUID-only, matching
// /api/documents/counts.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// A skattekonto row qualifies for bulk booking when the outcome is fully
// deterministic: a rule matched (booking_suggestion), it is not a likely
// duplicate (match_suggestion), it is unbooked, and it has actually happened
// (kommande rows have nothing to book yet).
function isSkvBulkEligible(row: SkattekontoTransactionWithSuggestion): boolean {
  return (
    row.booking_suggestion != null &&
    row.match_suggestion == null &&
    !row.journal_entry_id &&
    row.status !== 'upcoming'
  )
}

function buildInvoiceMap(rows: InvoiceWithCustomer[] | null): Record<string, InvoiceWithCustomer> {
  if (!rows) return {}
  return rows.reduce<Record<string, InvoiceWithCustomer>>((acc, inv) => {
    acc[inv.id] = inv
    return acc
  }, {})
}

function buildSupplierInvoiceMap(
  rows: SupplierInvoiceWithSupplier[] | null,
): Record<string, SupplierInvoiceWithSupplier> {
  if (!rows) return {}
  return rows.reduce<Record<string, SupplierInvoiceWithSupplier>>((acc, inv) => {
    acc[inv.id] = inv
    return acc
  }, {})
}

// Fetch the potential invoice/supplier-invoice matches referenced by a page
// of transactions in one parallel round trip. A single-query PostgREST embed
// on potential_supplier_invoice_id is blocked until that FK exists in the
// prod schema cache (see DECISIONS.md 2026-07-06).
async function fetchPotentialMatches(
  supabase: SupabaseClient,
  rows: {
    potential_invoice_id: string | null
    potential_supplier_invoice_id: string | null
    potential_journal_entry_id?: string | null
  }[],
) {
  const potentialInvoiceIds = Array.from(
    new Set(rows.flatMap((t) => (t.potential_invoice_id ? [t.potential_invoice_id] : []))),
  )
  const potentialSupplierInvoiceIds = Array.from(
    new Set(rows.flatMap((t) => (t.potential_supplier_invoice_id ? [t.potential_supplier_invoice_id] : []))),
  )
  const potentialJournalEntryIds = Array.from(
    new Set(rows.flatMap((t) => (t.potential_journal_entry_id ? [t.potential_journal_entry_id] : []))),
  )

  // Chunked .in() lists (PostgREST .in() URL-length convention, same 150 as
  // the underlag-status effect below): the caller may pass the full pending
  // backlog, not just one page.
  const IN_CLAUSE_CHUNK = 150
  const chunks = <T,>(ids: T[]) => {
    const out: T[][] = []
    for (let i = 0; i < ids.length; i += IN_CLAUSE_CHUNK) out.push(ids.slice(i, i + IN_CLAUSE_CHUNK))
    return out
  }

  // The hint columns are never revisited once written, so an invoice settled
  // by a different transaction leaves a stale pointer behind. Revalidate here:
  // an unmatchable candidate must not reach the row or the match dialog, which
  // would otherwise compare the transaction against a 0 kr remaining balance
  // and call it a partial payment.
  const [invoiceResults, supplierInvoiceResults, voucherResults] = await Promise.all([
    Promise.all(
      chunks(potentialInvoiceIds).map((ids) =>
        supabase
          .from('invoices')
          .select('*, customer:customers(*)')
          .in('id', ids)
          .in('status', [...MATCHABLE_INVOICE_STATUSES])
          .gt('remaining_amount', 0),
      ),
    ),
    Promise.all(
      chunks(potentialSupplierInvoiceIds).map((ids) =>
        supabase
          .from('supplier_invoices')
          .select('*, supplier:suppliers(*)')
          .in('id', ids)
          .in('status', [...MATCHABLE_SUPPLIER_INVOICE_STATUSES])
          .gt('remaining_amount', 0),
      ),
    ),
    // Journal-entry match suggestions (the sweep's 0.75-0.89 band). DB
    // triggers clear the pointer when the entry is consumed or reversed, but
    // the posted-status filter revalidates anyway: a suggestion that no
    // longer resolves to a live verifikat must not reach the review surface.
    Promise.all(
      chunks(potentialJournalEntryIds).map((ids) =>
        supabase
          .from('journal_entries')
          .select('id, voucher_series, voucher_number, entry_date, description')
          .in('id', ids)
          .eq('status', 'posted'),
      ),
    ),
  ])

  // Non-fatal: the transaction list still renders without match hints, but
  // log so a DB failure isn't mistaken for "no potential match".
  for (const r of invoiceResults) {
    if (r.error) console.error('[fetchPotentialMatches] invoices query failed', r.error)
  }
  for (const r of supplierInvoiceResults) {
    if (r.error) console.error('[fetchPotentialMatches] supplier_invoices query failed', r.error)
  }
  for (const r of voucherResults) {
    if (r.error) console.error('[fetchPotentialMatches] journal_entries query failed', r.error)
  }

  const voucherMap: Record<string, PotentialVoucher> = {}
  for (const je of voucherResults.flatMap((r) => (r.data ?? []) as Array<{
    id: string
    voucher_series: string
    voucher_number: number
    entry_date: string
    description: string | null
  }>)) {
    voucherMap[je.id] = {
      journal_entry_id: je.id,
      voucher_series: je.voucher_series,
      voucher_number: je.voucher_number,
      entry_date: je.entry_date,
      description: je.description,
    }
  }

  return {
    invoiceMap: buildInvoiceMap(invoiceResults.flatMap((r) => r.data ?? [])),
    supplierInvoiceMap: buildSupplierInvoiceMap(supplierInvoiceResults.flatMap((r) => r.data ?? [])),
    voucherMap,
  }
}

interface QuickReviewState {
  transaction: TransactionWithInvoice
  category: TransactionCategory
  label: string
  // ReviewTemplate, not BookingTemplate: a learned counterparty template has
  // no catalog entry, so most BookingTemplate fields are genuinely absent.
  template: ReviewTemplate | null
  templateId: string | undefined
  linePattern: LinePatternEntry[] | null
  // Learned counterparty bag; prefills the review dialog's dimension picker.
  defaultDimensions?: Record<string, string> | null
}

export default function TransactionsPage() {
  const { company } = useCompany()
  const companyId = company?.id ?? null
  const searchParams = useSearchParams()
  const t = useTranslations('transactions')
  const [transactions, setTransactions] = useState<TransactionWithInvoice[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [mode, setMode] = useState<ViewMode>('inbox')
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [templateSuggestions, setTemplateSuggestions] = useState<Record<string, SuggestedTemplate[]>>({})
  const [processingId, setProcessingId] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')

  // Batch selection: hover checkboxes + bulkbar (concept), no mode toggle.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBatchSelector, setShowBatchSelector] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)
  // Row expansion (concept foldout): one open row at a time, mirroring the
  // verifikat list.
  const [expandedTxId, setExpandedTxId] = useState<string | null>(null)

  // Invoice match dialog
  const [matchDialogOpen, setMatchDialogOpen] = useState(false)
  const [selectedTransaction, setSelectedTransaction] = useState<TransactionWithInvoice | null>(null)
  const [isConfirmingMatch, setIsConfirmingMatch] = useState(false)

  // Booking dialog (journal entry form)
  const [bookingDialogOpen, setBookingDialogOpen] = useState(false)
  const [bookingDialogTransaction, setBookingDialogTransaction] = useState<TransactionWithInvoice | null>(null)
  const [bookingDialogTemplate, setBookingDialogTemplate] = useState<BookingTemplateLibrary | null>(null)
  // "Andra rader" hand-off: the computed proposal lines from QuickReviewDialog,
  // prefilled into TransactionBookingDialog for per-line editing.
  const [bookingDialogProposalLines, setBookingDialogProposalLines] = useState<ProposalLine[] | null>(null)
  // Account picked from the template picker's "Konton" search results:
  // prefills the counter line when the manual booking dialog opens.
  const [bookingDialogAccount, setBookingDialogAccount] = useState<string | null>(null)

  // Attach-underlag dialog (tx→doc mirror of the Documents view's matcher)
  const [attachDocTx, setAttachDocTx] = useState<TransactionWithInvoice | null>(null)
  // Underlag status per booked journal_entry_id: drives the per-row
  // "Underlag"/"Underlag saknas" badges in history view.
  const [jeUnderlagStatus, setJeUnderlagStatus] = useState<Record<string, JeUnderlagStatus>>({})
  // JE ids already requested (in-flight or done) so the enrichment effect
  // never refetches on unrelated transactions-state changes.
  const requestedJeIdsRef = useRef<{ companyId: string | null; ids: Set<string> }>({
    companyId: null,
    ids: new Set(),
  })

  // Template picker dialog
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
  const [templatePickerTransaction, setTemplatePickerTransaction] = useState<TransactionWithInvoice | null>(null)

  // Invoice picker dialog (manual match)
  const [invoicePickerOpen, setInvoicePickerOpen] = useState(false)
  const [invoicePickerTransaction, setInvoicePickerTransaction] = useState<TransactionWithInvoice | null>(null)
  const [supplierInvoicePickerOpen, setSupplierInvoicePickerOpen] = useState(false)
  const [supplierInvoicePickerTransaction, setSupplierInvoicePickerTransaction] = useState<TransactionWithInvoice | null>(null)
  const [splitMatchOpen, setSplitMatchOpen] = useState(false)
  const [splitMatchTransaction, setSplitMatchTransaction] = useState<TransactionWithInvoice | null>(null)
  // "Matcha mot befintlig verifikation": link a bank tx to an already-booked
  // voucher (salary, Fortnox import, manual entry) with no new bokföring.
  const [matchVoucherTx, setMatchVoucherTx] = useState<TransactionWithInvoice | null>(null)
  const [bulkBookOpen, setBulkBookOpen] = useState(false)
  const [isMatchingSupplierFromPicker, setIsMatchingSupplierFromPicker] = useState(false)
  const [isMatchingFromPicker, setIsMatchingFromPicker] = useState(false)

  // Quick review dialog (suggestion review before booking)
  const [quickReviewOpen, setQuickReviewOpen] = useState(false)
  const [quickReview, setQuickReview] = useState<QuickReviewState | null>(null)

  // Prong B: prompt to match against an open supplier invoice instead of
  // categorizing direct to 2440. Triggered by a 409 TX_CATEGORIZE_SUGGEST_SI_MATCH.
  const [siMatchSuggestion, setSiMatchSuggestion] = useState<{
    transactionId: string
    // Resolved value unused: callers only await completion. runCategorize
    // resolves its outcome object, the counterparty path a journal-entry id.
    retry: () => Promise<unknown>
    candidates: Array<{
      supplier_invoice_id: string
      invoice_number: string
      invoice_date: string
      remaining_amount: number
      currency: string
      supplier_name: string | null
    }>
  } | null>(null)
  const [siMatchProcessing, setSiMatchProcessing] = useState(false)

  // Prong B (customer side): prompt to match against an unpaid customer
  // invoice instead of categorizing direct to 1510 on an inbound bank tx.
  // Triggered by a 409 TX_CATEGORIZE_SUGGEST_CI_MATCH.
  const [ciMatchSuggestion, setCiMatchSuggestion] = useState<{
    transactionId: string
    // Resolved value unused: callers only await completion. runCategorize
    // resolves its outcome object, the counterparty path a journal-entry id.
    retry: () => Promise<unknown>
    candidates: Array<{
      invoice_id: string
      invoice_number: string | null
      invoice_date: string
      remaining_amount: number
      currency: string
      customer_name: string | null
      match_reason: 'ocr_exact' | 'name_amount_fuzzy'
    }>
  } | null>(null)
  const [ciMatchProcessing, setCiMatchProcessing] = useState(false)

  // Booking-time duplicate guard (TRANSACTION_BOOK_POSSIBLE_DUPLICATE): the
  // server found this affärshändelse already booked: either another booked
  // transaction sharing this one's date+amount+bank account, OR an unlinked
  // voucher that already books the amount on the bank account (a paid invoice,
  // a salary payout). Surface the existing verifikat and let the user book
  // anyway: genuinely repeated same-day payments (e.g. identical Swish
  // transfers) are legitimate. "Bokför ändå" retries with force bound to the
  // reviewed candidate via expected_duplicate_journal_entry_id (present on both
  // candidate kinds), which the server re-detects so a stale id can't wave it.
  const [duplicateWarning, setDuplicateWarning] = useState<{
    transactionId: string
    // Resolved value unused: callers only await completion. runCategorize
    // resolves its outcome object, the counterparty path a journal-entry id.
    retry: () => Promise<unknown>
    candidate: BookedDuplicateCandidate
  } | null>(null)
  const [duplicateProcessing, setDuplicateProcessing] = useState(false)

  // Dashboard layout already resolved the effective entity type from settings.
  const entityType = company?.entity_type ?? 'enskild_firma'

  // Pagination
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  // The history view pages through ALL transactions newest-first, while the
  // inbox needs every pending row regardless of age. Both live in the single
  // `transactions` array (so row mutations stay one code path), which means
  // the array holds a contiguous newest-first window PLUS older pending rows
  // merged in. These two track the contiguous window: `pagedCountRef` is the
  // offset for the next history page (state length would overcount the merged
  // extras), and `pagedThroughDate` is the window's oldest date so the history
  // view can hide the sparse older pending rows (null = everything fetched).
  const pagedCountRef = useRef(0)
  const [pagedThroughDate, setPagedThroughDate] = useState<string | null>(null)

  // Monotonic token for list fetches: a response applies only if no newer
  // fetch (scope change, realtime refresh, load-more) started after it.
  // Without it, a slow pre-filter request resolving late would overwrite the
  // active period scope's window and paging state with stale rows.
  const fetchGenerationRef = useRef(0)

  // True uncategorized count from DB (not limited by pagination)
  const [totalUncategorizedCount, setTotalUncategorizedCount] = useState<number | null>(null)

  // Set of transaction IDs that are animating out (just categorized)
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set())

  // Skattekonto rows (unmatched, status='booked'). Loaded if the
  // Skatteverket extension is enabled and connected. 503/401 → silently
  // hidden (extension disabled or user not connected).
  const [skvRows, setSkvRows] = useState<SkattekontoTransactionWithSuggestion[]>([])
  const [skvMatchTarget, setSkvMatchTarget] = useState<StoredSkattekontoTransaction | null>(
    null,
  )
  // Inline single-row booking dialog (replaces the old draft-then-navigate
  // flow that dumped the user in /bookkeeping and lost all list state).
  const [skvBookTarget, setSkvBookTarget] = useState<SkattekontoTransactionWithSuggestion | null>(
    null,
  )
  // SKV bulk selection: deliberately a SEPARATE set from the bank
  // `selectedIds`: every bank batch handler POSTs /api/transactions/* and
  // would 404 on skattekonto ids.
  const [skvSelectedIds, setSkvSelectedIds] = useState<Set<string>>(new Set())
  const [skvBulkConfirmOpen, setSkvBulkConfirmOpen] = useState(false)
  const [skvBulkSubmitting, setSkvBulkSubmitting] = useState(false)
  // True when an SKV connection exists but is dead (needs_reconsent, or
  // expired with no refresh left). Drives the reconnect banner: without it
  // a user whose token died sees an empty skattekonto and has no reason to
  // ever visit the settings panel where the reconnect prompt lives.
  const [skvNeedsReconnect, setSkvNeedsReconnect] = useState(false)

  // The user's WANTED source filter, persisted per company (#1105, per-company
  // since v2). What the page actually filters by is the derived
  // effectiveSourceFilter below, which falls back to 'all' while the wanted
  // source's items are still loading or when the source went stale.
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all')

  useEffect(() => {
    if (!companyId) return
    // A valid ?source= deep link overrides the remembered choice for this
    // visit only: it is applied to state, never written to storage.
    const urlSource = searchParams.get('source')
    setSourceFilter(isSourceFilter(urlSource) ? urlSource : readStoredSourceFilter(companyId))
  }, [companyId, searchParams])

  const handleSourceFilterChange = useCallback(
    (next: SourceFilter) => {
      setSourceFilter(next)
      if (companyId) writeStoredSourceFilter(companyId, next)
    },
    [companyId],
  )

  // Period filter (rakenskapsar). FyPicker owns the persistence under the
  // page-local key. Quarter chips existed briefly (#1545) but were dropped:
  // they crowded the filter row, and on a brutet rakenskapsar they were not
  // momsdeklaration quarters, which made them misleading rather than useful.
  const [fyPeriodId, setFyPeriodId] = useState<string | null>(null)
  const [fyPeriod, setFyPeriod] = useState<FiscalPeriod | null>(null)
  const periodBounds = useMemo(() => resolvePeriodBounds(fyPeriod, null), [fyPeriod])

  const handlePeriodChange = useCallback((periodId: string | null, period?: FiscalPeriod | null) => {
    setFyPeriodId(periodId)
    setFyPeriod(period ?? null)
    // Batch selections may reference rows the new scope hides; every batch
    // action operates on "what you see", so drop them.
    setSelectedIds(new Set())
    setSkvSelectedIds(new Set())
  }, [])

  // Footer "Visa alla" escape hatch: clears the period scope AND its
  // persisted value (FyPicker only writes storage from its own dropdown).
  const clearPeriodFilter = useCallback(() => {
    setFyPeriodId(null)
    setFyPeriod(null)
    setSelectedIds(new Set())
    setSkvSelectedIds(new Set())
    if (companyId) {
      try {
        window.localStorage.setItem(PERIOD_FILTER_STORAGE_PREFIX + companyId, ALL_YEARS_VALUE)
      } catch {
        // localStorage may be unavailable; the in-memory state is cleared.
      }
    }
  }, [companyId])
  // Registered cash accounts (cash_accounts): the account chooser's rows,
  // with PSD2 balances when the bank reports them.
  // Registered, enabled cash accounts for the account chooser: session-cached
  // and seeded by the dashboard layout (lib/reference-data), so the chooser
  // renders populated on the first paint. Bank sync invalidates the entry.
  const { cashAccounts } = useCashAccounts({ enabledOnly: true })

  const { toast } = useToast()
  const { dialogProps: confirmDialogProps, confirm } = useDestructiveConfirm()
  // Bank transaction whose title is being edited (null = dialog closed).
  const [editTitleTarget, setEditTitleTarget] = useState<TransactionWithInvoice | null>(null)
  // Bank transaction being moved to another cash account (null = dialog closed).
  const [moveAccountTarget, setMoveAccountTarget] = useState<TransactionWithInvoice | null>(null)
  const supabase = useRealtimeSupabase()
  const highlightId = searchParams.get('highlight')
  // Tracks the last highlight target we acted on so re-renders don't re-trigger
  // the auto-open every time the user closes the categorize panel.
  const handledHighlightRef = useRef<string | null>(null)
  const refreshTransactionsInFlightRef = useRef(false)
  const refreshTransactionsQueuedRef = useRef(false)

  // "Kör matchning igen" in the review surface.
  const [rerunningMatch, setRerunningMatch] = useState(false)

  // End of the company's completed SIE-import coverage (latest
  // fiscal_year_end). Drives the quiet "från perioden före din migrering"
  // marker on inbox rows: period-based on purpose, it labels which period a
  // row belongs to, it never suggests a sync skip date (that was #917).
  const [sieCoverageEnd, setSieCoverageEnd] = useState<string | null>(null)
  useEffect(() => {
    if (!companyId) {
      setSieCoverageEnd(null)
      return
    }
    let cancelled = false
    ;(async () => {
      const { data } = await supabase
        .from('sie_imports')
        .select('fiscal_year_end')
        .eq('company_id', companyId)
        .eq('status', 'completed')
        .not('fiscal_year_end', 'is', null)
        .order('fiscal_year_end', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (!cancelled) {
        setSieCoverageEnd((data as { fiscal_year_end?: string } | null)?.fiscal_year_end || null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [companyId, supabase])

  // Computed lists. Exiting rows (just booked/ignored/deleted) stay IN this
  // list on purpose: they render for the 350ms exit window with the .row-exit
  // collapse animation instead of popping out the same frame, and the delayed
  // state patch (finishBooking et al.) is what actually drops them. Logic
  // surfaces that must not act on a leaving row (batch select) exclude
  // exitingIds themselves.
  const uncategorizedTransactions = useMemo(
    () => transactions
      // The exitingIds clause pins a leaving row even when a realtime-echo
      // refetch replaces its state with the booked shape mid-window: the
      // animation still finishes instead of being cut to a jump.
      .filter((t) => (t.is_business === null && !t.is_ignored) || exitingIds.has(t.id))
      .sort((a, b) => {
        const aHasMatch = a.potential_invoice || a.potential_supplier_invoice ? 1 : 0
        const bHasMatch = b.potential_invoice || b.potential_supplier_invoice ? 1 : 0
        if (aHasMatch !== bHasMatch) return bHasMatch - aHasMatch
        return b.date.localeCompare(a.date)
      }),
    [exitingIds, transactions],
  )

  // Journal-entry match suggestions awaiting review (the migrator surface).
  // potential_voucher is already revalidated (posted-only) at enrichment time,
  // and DB triggers clear consumed/reversed suggestions, so this list is
  // honest without extra queries.
  const suggestionItems = useMemo(
    () =>
      transactions.filter(
        (t) => t.potential_voucher && !t.journal_entry_id && !t.is_ignored && !exitingIds.has(t.id),
      ),
    [exitingIds, transactions],
  )

  // Merged inbox: bank tx + SKV rows interleaved by date. Source filter
  // narrows to one side. SKV rows always go after bank rows on the same
  // date: bank tx tend to have invoice-match suggestions and we'd rather
  // surface those first.
  type InboxItem =
    | { source: 'bank'; date: string; data: TransactionWithInvoice }
    | { source: 'skatteverket'; date: string; data: SkattekontoTransactionWithSuggestion }

  const skvUnmatched = useMemo(
    () => skvRows.filter((row) => !row.journal_entry_id && !row.is_ignored),
    [skvRows],
  )

  const bankToSkvHints = useMemo(
    () => findBankSkvCounterparts({
      bankRows: uncategorizedTransactions.map((transaction) => ({
        id: transaction.id,
        date: transaction.date,
        amount: transaction.amount,
      })),
      skvRows: skvUnmatched,
    }),
    [skvUnmatched, uncategorizedTransactions],
  )

  // History shows only the contiguous newest-first window: the older pending
  // rows merged in for the inbox would otherwise render as sparse, gap-ridden
  // months below the window and read as missing bookkeeping. Same-date rows at
  // the boundary may slip in; they are real rows of that date, so harmless.
  const historyTransactions = useMemo(
    () =>
      transactions.filter(
        (t) =>
          (!pagedThroughDate || t.date >= pagedThroughDate) &&
          // Server-side scope catches up on refetch; this keeps the view
          // correct in the transition frame after a filter change.
          isWithinBounds(t.date, periodBounds),
      ),
    [transactions, pagedThroughDate, periodBounds],
  )

  // SKV rows shown in the history view, narrowed to the active period. The
  // list component filters by search/source itself but knows nothing about
  // period bounds.
  const skvRowsInScope = useMemo(
    () => skvRows.filter((r) => isWithinBounds(r.transaktionsdatum, periodBounds)),
    [skvRows, periodBounds],
  )

  // Tab badge: DB-true pending count normally; with a period filter active,
  // the pending rows inside the scope (complete, since the pending backlog
  // fetch is unscoped and fully in state).
  const inboxBadgeCount = useMemo(() => {
    if (!periodBounds) return totalUncategorizedCount ?? uncategorizedTransactions.length
    return uncategorizedTransactions.filter((tx) => isWithinBounds(tx.date, periodBounds)).length
  }, [periodBounds, totalUncategorizedCount, uncategorizedTransactions])

  // Pending work the active period filter hides (bank + skattekonto). BFL
  // 5 kap: pending affarshandelser must never disappear silently, so the
  // footer names this count and offers a one-click way back to everything.
  const pendingOutsideCount = useMemo(() => {
    if (!periodBounds) return 0
    const bankOutside = uncategorizedTransactions.filter(
      (tx) => !isWithinBounds(tx.date, periodBounds),
    ).length
    const skvOutside = skvRows.filter(
      (r) =>
        !r.journal_entry_id &&
        !r.is_ignored &&
        !isWithinBounds(r.transaktionsdatum, periodBounds),
    ).length
    return bankOutside + skvOutside
  }, [periodBounds, skvRows, uncategorizedTransactions])

  // Account chooser (concept scene 10): the source picker doubles as a
  // balance readout. The total sums only SEK ledgers (mixing currencies into
  // one figure would be a lie); null hides the annotation entirely.
  const totalSourceBalance = useMemo(() => {
    const sekBalances = cashAccounts.filter((a) => a.currency === 'SEK' && a.balance != null)
    if (sekBalances.length === 0) return null
    return sekBalances.reduce((sum, a) => sum + (a.balance ?? 0), 0)
  }, [cashAccounts])

  // The picker is shared by both view modes (convention 8), so 'bank:other'
  // must surface when EITHER dataset holds unassigned rows: history can hold
  // older null-account rows after every pending row got assigned.
  const hasUnassignedBankRows = useMemo(
    () =>
      uncategorizedTransactions.some((tx) => tx.cash_account_id == null) ||
      historyTransactions.some((tx) => tx.cash_account_id == null),
    [uncategorizedTransactions, historyTransactions],
  )

  const sourceItems = useMemo<ContextPickerItem[]>(() => {
    // Keep the Skatteverket source pickable while reconnect is needed even
    // though the rows fetch fails then (401 -> skvRows []): the reconnect
    // attn line only renders under this source, so dropping the option would
    // hide the reconnect path exactly when it applies.
    const showSkvSource = skvRows.length > 0 || skvNeedsReconnect
    const items: ContextPickerItem[] = [
      {
        id: 'all',
        label: t('source_all_label'),
        annotation: totalSourceBalance != null ? formatCurrency(totalSourceBalance) : undefined,
      },
    ]
    for (const account of cashAccounts) {
      items.push({
        id: `acct:${account.id}`,
        label: `${account.name || t('source_account_fallback')} ${account.ledger_account}`,
        annotation:
          account.balance != null ? formatCurrency(account.balance, account.currency) : undefined,
      })
    }
    if (cashAccounts.length === 0 && showSkvSource) {
      // No registered cash accounts yet: keep the plain bank/skattekonto split.
      items.push({ id: 'bank', label: t('source_bank_label') })
    } else if (cashAccounts.length > 0 && hasUnassignedBankRows) {
      items.push({ id: 'bank:other', label: t('source_bank_other') })
    }
    if (showSkvSource) {
      items.push({ id: 'skatteverket', label: t('source_skatteverket_label') })
    }
    return items
  }, [cashAccounts, hasUnassignedBankRows, skvNeedsReconnect, skvRows.length, t, totalSourceBalance])

  // What the page actually filters by. A narrowed filter whose source is not
  // (yet) among the items, because cash accounts / skv rows / transactions
  // are still loading, or because the source went stale (account disabled,
  // skv rows drained, "övriga" bucket emptied), resolves to 'all' instead of
  // filtering the inbox down to an invisible source. Deriving this (rather
  // than resetting state, as the old guard effect did) removes the mount-time
  // race that wiped the persisted choice before the async sources arrived.
  const effectiveSourceFilter = useMemo(
    () =>
      resolveEffectiveSourceFilter(
        sourceFilter,
        sourceItems.map((item) => item.id),
      ),
    [sourceFilter, sourceItems],
  )

  // Declared after sourceItems/effectiveSourceFilter because the inbox must
  // filter by the EFFECTIVE source, never the raw wanted one.
  const inboxItems = useMemo<InboxItem[]>(() => {
    const items: InboxItem[] = []
    const query = searchTerm.trim().toLowerCase()
    if (effectiveSourceFilter !== 'skatteverket') {
      for (const tx of uncategorizedTransactions) {
        // The refetch already narrows state server-side; this check makes the
        // filter correct immediately on change, before the refetch lands.
        if (!isWithinBounds(tx.date, periodBounds)) continue
        if (
          effectiveSourceFilter.startsWith('acct:') &&
          tx.cash_account_id !== effectiveSourceFilter.slice('acct:'.length)
        ) {
          continue
        }
        if (effectiveSourceFilter === 'bank:other' && tx.cash_account_id != null) continue
        if (
          query &&
          !tx.description?.toLowerCase().includes(query) &&
          !tx.date.includes(query) &&
          !String(tx.amount).includes(query)
        ) {
          continue
        }
        items.push({ source: 'bank', date: tx.date, data: tx })
      }
    }
    if (effectiveSourceFilter === 'all' || effectiveSourceFilter === 'skatteverket') {
      // Inbox only shows SKV rows that need action (no verifikat yet).
      for (const r of skvRows) {
        // Exiting rows stay rendered for the exit animation, even if a
        // refetch already gave them a journal_entry_id (or an ignore) mid-
        // window (see above).
        if ((r.journal_entry_id || r.is_ignored) && !exitingIds.has(r.id)) continue
        // SKV rows live client-side only, so the period filter applies here.
        if (!isWithinBounds(r.transaktionsdatum, periodBounds)) continue
        if (
          query &&
          !r.transaktionstext?.toLowerCase().includes(query) &&
          !r.transaktionsdatum.includes(query) &&
          !String(r.belopp_skatteverket).includes(query)
        ) {
          continue
        }
        items.push({ source: 'skatteverket', date: r.transaktionsdatum, data: r })
      }
    }
    return items.sort((a, b) => {
      if (a.date !== b.date) return b.date.localeCompare(a.date)
      // Same date → bank first so invoice-match cards lead.
      if (a.source !== b.source) return a.source === 'bank' ? -1 : 1
      return 0
    })
  }, [effectiveSourceFilter, exitingIds, periodBounds, searchTerm, skvRows, uncategorizedTransactions])

  // Rows the bulkbar's "Markera alla" can select: the visible bank rows
  // (they feed the /api/transactions/* batch handlers) ...
  const selectableInboxIds = useMemo(
    () =>
      inboxItems
        // Rows mid-exit still render (for the animation) but must not be
        // selectable: they are already booked/deleted server-side.
        .filter((item) => item.source === 'bank' && !exitingIds.has(item.data.id))
        .map((item) => item.data.id),
    [exitingIds, inboxItems],
  )

  // ... plus the visible skattekonto rows whose booking is deterministic
  // (rule matched, no duplicate hint, unbooked, genomförd). These go through
  // the skatteverket extension's bokfor-batch endpoint instead.
  const selectableSkvIds = useMemo(
    () =>
      inboxItems
        .filter(
          (item) =>
            item.source === 'skatteverket' &&
            isSkvBulkEligible(item.data) &&
            !exitingIds.has(item.data.id),
        )
        .map((item) => item.data.id),
    [exitingIds, inboxItems],
  )

  const skvSelectedRows = useMemo(
    () => skvRows.filter((r) => skvSelectedIds.has(r.id)),
    [skvRows, skvSelectedIds],
  )

  // Bulk confirmation summary: selected rows grouped by their deterministic
  // suggestion ("3 × Intäktsränta skattekonto → 8314") with per-group sums.
  // Count-based on purpose: voucher numbers are assigned atomically at
  // commit, so predicting them here would lie under concurrency.
  const skvBulkGroups = useMemo(() => {
    const groups = new Map<
      string,
      { label: string; account: string; count: number; sum: number }
    >()
    for (const row of skvSelectedRows) {
      const suggestion = row.booking_suggestion
      if (!suggestion) continue
      const label = suggestion.label ?? suggestion.account_name ?? row.transaktionstext
      const key = `${suggestion.account}|${label}`
      const group = groups.get(key) ?? {
        label,
        account: suggestion.account,
        count: 0,
        sum: 0,
      }
      group.count += 1
      group.sum = roundOre(group.sum + Number(row.belopp_skatteverket))
      groups.set(key, group)
    }
    return Array.from(groups.values())
  }, [skvSelectedRows])

  const skvBulkTotal = useMemo(
    () => roundOre(skvBulkGroups.reduce((sum, g) => sum + g.sum, 0)),
    [skvBulkGroups],
  )


  const PAGE_SIZE = 200


  // Same sequence-guard pattern as fetchGenerationRef: only the newest
  // skattekonto fetch may write rows. A company switch bumps the sequence so a
  // response started under the previous company can never land its rows in
  // the new company's inbox, and overlapping refreshes resolve last-write-
  // correct instead of last-resolved-wins.
  const skvFetchSeqRef = useRef(0)
  const loadSkvRows = useCallback(async () => {
    const seq = ++skvFetchSeqRef.current
    // Connection health, fetched alongside the rows: any failure (extension
    // disabled, capability gate, not connected) just hides the banner.
    void (async () => {
      try {
        const res = await fetch('/api/extensions/ext/skatteverket/status')
        // Same guard as the rows below: a status response started under the
        // previous company must not set or clear the reconnect banner for
        // the new one.
        if (skvFetchSeqRef.current !== seq) return
        if (!res.ok) {
          setSkvNeedsReconnect(false)
          return
        }
        const s = (await res.json()) as SkvStatusLike
        if (skvFetchSeqRef.current !== seq) return
        // Shared reconnect predicate (lib/notices): the same decision the
        // skattekonto page and the Hem notice make, never a local variant.
        setSkvNeedsReconnect(skvStatusNeedsReconnect(s))
      } catch {
        if (skvFetchSeqRef.current !== seq) return
        setSkvNeedsReconnect(false)
      }
    })()
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/skattekonto/transaktioner')
      if (skvFetchSeqRef.current !== seq) return
      if (!res.ok) {
        setSkvRows([])
        return
      }
      const json = await res.json()
      if (skvFetchSeqRef.current !== seq) return
      const booked = (json.data?.booked ?? []) as SkattekontoTransactionWithSuggestion[]
      // Keep all booked SKV rows in state: inbox view filters to obokförda
      // (journal_entry_id null), history view shows all of them (matched
      // and unmatched) interleaved with bank tx by date.
      setSkvRows(booked)
    } catch {
      if (skvFetchSeqRef.current !== seq) return
      setSkvRows([])
    }
  }, [])

  const fetchTransactions = useCallback(async (
    showLoading = false,
    includeSkvRows = false,
    // Background refreshes (realtime echo) re-fetch the window the user has
    // already paged through instead of resetting to the first PAGE_SIZE rows:
    // an action after "Visa fler" must not collapse the loaded pages and
    // yank the scroll position.
    preserveWindow = false,
  ) => {
    if (!companyId) return
    const generation = ++fetchGenerationRef.current
    const windowSize = preserveWindow
      ? Math.max(pagedCountRef.current, PAGE_SIZE)
      : PAGE_SIZE
    if (showLoading) setIsLoading(true)
    if (includeSkvRows) void loadSkvRows()
    try {
      // Only the history window is narrowed server-side by the period filter.
      // The pending-backlog fetch and the pending count below stay UNSCOPED on
      // purpose (Swedish accounting review, PR #1545): BFL 5 kap requires
      // pending affarshandelser to be booked promptly, so every pending row
      // must stay in state regardless of the filter. The inbox applies the
      // period client-side and the footer surfaces what falls outside it.
      let windowQuery = supabase
        .from('transactions')
        .select('*')
        .eq('company_id', companyId)
      if (periodBounds) {
        windowQuery = windowQuery.gte('date', periodBounds.start).lte('date', periodBounds.end)
      }

      const [{ data: txData, error: txError }, { count: uncatCount }, pendingRows] = await Promise.all([
        // The id tie-breaker keeps offset paging deterministic when many
        // rows share a date; without it .range() pages can skip or repeat
        // same-date rows.
        windowQuery
          .order('date', { ascending: false })
          .order('id', { ascending: true })
          .range(0, windowSize - 1),
        supabase
          .from('transactions')
          .select('*', { count: 'exact', head: true })
          .eq('company_id', companyId)
          .is('is_business', null)
          // Same predicate as lib/worklist countUnbookedTransactions: ignored
          // rows are handled, not pending.
          .eq('is_ignored', false),
        // The inbox is a worklist: it must contain every pending row, even ones
        // older than the newest-first window above. Falls back to null so the
        // page still renders the windowed rows if this fetch dies; the failure
        // is surfaced below, never silently absorbed (an inbox that renders as
        // complete while missing older pending rows would be a lie).
        fetchAllRows<TransactionWithInvoice>(({ from, to }) =>
          supabase
            .from('transactions')
            .select('*')
            .eq('company_id', companyId)
            .is('is_business', null)
            .eq('is_ignored', false)
            .order('date', { ascending: false })
            .order('id', { ascending: true })
            .range(from, to),
        ).catch((error: unknown) => {
          console.error('[transactions] pending backlog fetch failed; inbox may be missing older rows', error)
          return null
        }),
      ])

      // A newer fetch (scope change, refresh) started while this one was in
      // flight: its results own the state now, so this response must not
      // apply. Toasts are skipped too; the newer request reports its own fate.
      if (fetchGenerationRef.current !== generation) return

      if (txError) {
        toast({ title: t('load_failed_title'), description: t('load_failed_description'), variant: 'destructive' })
        return
      }

      if (pendingRows === null) {
        // Partial load: the windowed rows render, but older pending rows are
        // absent. Say so instead of presenting a complete-looking inbox.
        toast({ title: t('load_failed_title'), description: t('load_failed_description'), variant: 'destructive' })
      }

      const rows = txData || []
      const windowIds = new Set(rows.map((r) => r.id))
      const olderPending = (pendingRows ?? []).filter((r) => !windowIds.has(r.id))
      const allRows = [...rows, ...olderPending].sort((a, b) => b.date.localeCompare(a.date))
      const { invoiceMap, supplierInvoiceMap, voucherMap } = await fetchPotentialMatches(supabase, allRows)

      // Re-check after the second await: a scope change during the match
      // enrichment must also discard this response.
      if (fetchGenerationRef.current !== generation) return

      const transactionsWithInvoices: TransactionWithInvoice[] = allRows.map((t) => ({
        ...t,
        potential_invoice: t.potential_invoice_id ? invoiceMap[t.potential_invoice_id] : undefined,
        potential_supplier_invoice: t.potential_supplier_invoice_id
          ? supplierInvoiceMap[t.potential_supplier_invoice_id]
          : undefined,
        potential_voucher: t.potential_journal_entry_id
          ? voucherMap[t.potential_journal_entry_id]
          : undefined,
      }))

      setTransactions(transactionsWithInvoices)
      setTotalUncategorizedCount(uncatCount ?? 0)
      pagedCountRef.current = rows.length
      setPagedThroughDate(rows.length >= windowSize ? rows[rows.length - 1].date : null)
      setHasMore(rows.length >= windowSize)

    } finally {
      // Only the newest request may touch the skeleton: a stale one must not
      // clear what a newer showLoading request just put up. The newest always
      // clears it (even non-showLoading refreshes, whose superseded
      // predecessor may have left it up).
      if (fetchGenerationRef.current === generation) setIsLoading(false)
    }
  }, [companyId, loadSkvRows, periodBounds, supabase, t, toast])

  const refreshTransactions = useCallback(async () => {
    if (!companyId) return
    if (refreshTransactionsInFlightRef.current) {
      refreshTransactionsQueuedRef.current = true
      return
    }

    refreshTransactionsInFlightRef.current = true
    try {
      do {
        refreshTransactionsQueuedRef.current = false
        await fetchTransactions(false, false, true)
      } while (refreshTransactionsQueuedRef.current)
    } finally {
      refreshTransactionsInFlightRef.current = false
      refreshTransactionsQueuedRef.current = false
    }
  }, [companyId, fetchTransactions])

  async function loadMoreTransactions() {
    if (!companyId) return
    // Claims the generation: a scope change mid-request discards this page
    // instead of appending old-scope rows and corrupting the paging offsets.
    const generation = ++fetchGenerationRef.current
    setIsLoadingMore(true)
    // Offset counts only the contiguous newest-first window, not the older
    // pending rows merged into state for the inbox.
    const offset = pagedCountRef.current
    let pageQuery = supabase
      .from('transactions')
      .select('*')
      .eq('company_id', companyId)
    // Same period scope as the initial window fetch: mixed-scope pages would
    // corrupt the offset bookkeeping.
    if (periodBounds) {
      pageQuery = pageQuery.gte('date', periodBounds.start).lte('date', periodBounds.end)
    }
    const { data: txData, error: txError } = await pageQuery
      // Same stable order as the initial window fetch: offset paging over a
      // date-only order can skip or repeat same-date rows between pages.
      .order('date', { ascending: false })
      .order('id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1)

    if (fetchGenerationRef.current !== generation || txError || !txData) {
      setIsLoadingMore(false)
      return
    }

    pagedCountRef.current += txData.length
    setPagedThroughDate(txData.length >= PAGE_SIZE ? txData[txData.length - 1].date : null)
    setHasMore(txData.length >= PAGE_SIZE)

    const { invoiceMap, supplierInvoiceMap, voucherMap } = await fetchPotentialMatches(supabase, txData)

    // Same staleness rule after the enrichment await: the offsets above were
    // written under this generation, but a newer fetch has already reset them.
    if (fetchGenerationRef.current !== generation) {
      setIsLoadingMore(false)
      return
    }

    const newTransactions: TransactionWithInvoice[] = txData.map((t) => ({
      ...t,
      potential_invoice: t.potential_invoice_id ? invoiceMap[t.potential_invoice_id] : undefined,
      potential_supplier_invoice: t.potential_supplier_invoice_id
        ? supplierInvoiceMap[t.potential_supplier_invoice_id]
        : undefined,
      potential_voucher: t.potential_journal_entry_id
        ? voucherMap[t.potential_journal_entry_id]
        : undefined,
    }))

    // The page may overlap pending rows already merged into state: keep the
    // existing row (it may carry local edits) and drop the duplicate.
    setTransactions((prev) => {
      const prevIds = new Set(prev.map((t) => t.id))
      return [...prev, ...newTransactions.filter((t) => !prevIds.has(t.id))]
    })
    setIsLoadingMore(false)
  }

  // Underlag-status enrichment for booked rows. Five RLS-scoped reads per
  // 150-id chunk (PostgREST .in() URL-length convention, see
  // lib/worklist/categories.ts): the JEs' source types, which JEs have a
  // current-version document, which are covered by a supplier invoice's
  // retained document (BFL 5 kap 7 § hänvisning: registration/payment FK or a
  // supplier_invoice_payments row: mirrors the verifikat_without_documents
  // RPC), and which are exempted via journal_entry_no_doc_required.
  // Incremental: only fetches JE ids not yet requested, so
  // loadMoreTransactions pages are covered without refetching.
  // Soft-fails to "no badges" on error.
  useEffect(() => {
    if (!companyId) return
    if (requestedJeIdsRef.current.companyId !== companyId) {
      requestedJeIdsRef.current = { companyId, ids: new Set() }
      setJeUnderlagStatus({})
    }
    const requested = requestedJeIdsRef.current.ids
    const newIds = Array.from(
      new Set(
        transactions
          .map((tx) => tx.journal_entry_id)
          .filter((id): id is string => !!id && !requested.has(id)),
      ),
    )
    if (newIds.length === 0) return
    newIds.forEach((id) => requested.add(id))

    ;(async () => {
      const IN_CLAUSE_CHUNK = 150
      const merged: Record<string, JeUnderlagStatus> = {}
      for (let i = 0; i < newIds.length; i += IN_CLAUSE_CHUNK) {
        const chunk = newIds.slice(i, i + IN_CLAUSE_CHUNK)
        // Only UUIDs reach the interpolated .or() string (the .in() array
        // filters are already injection-safe).
        const chunkInList = `(${chunk.filter((id) => UUID_RE.test(id)).join(',')})`
        const [entriesRes, docsRes, siRefRes, sipRefRes, exemptRes] = await Promise.all([
          supabase
            .from('journal_entries')
            .select('id, source_type')
            // Same posted-only scope as countVerifikatMissingDocument:
            // reversed/corrected entries fall out of the result set and the
            // row renders no badge: a storno'd verifikation must never grow
            // an "Underlag saknas" attach affordance.
            .eq('status', 'posted')
            .in('id', chunk)
            .eq('company_id', companyId),
          supabase
            .from('document_attachments')
            .select('journal_entry_id')
            .in('journal_entry_id', chunk)
            .eq('company_id', companyId)
            .eq('is_current_version', true),
          supabase
            .from('supplier_invoices')
            .select(
              'registration_journal_entry_id, payment_journal_entry_id, document:document_attachments(journal_entry_id)',
            )
            .eq('company_id', companyId)
            .not('document_id', 'is', null)
            .or(
              `registration_journal_entry_id.in.${chunkInList},payment_journal_entry_id.in.${chunkInList}`,
            ),
          supabase
            .from('supplier_invoice_payments')
            .select(
              'journal_entry_id, supplier_invoice:supplier_invoices(document_id, document:document_attachments(journal_entry_id))',
            )
            .eq('company_id', companyId)
            .in('journal_entry_id', chunk),
          supabase
            .from('journal_entry_no_doc_required')
            .select('journal_entry_id')
            .in('journal_entry_id', chunk)
            .eq('company_id', companyId),
        ])
        // Soft-fail: keep the chunks that already succeeded.
        if (entriesRes.error || docsRes.error || siRefRes.error || sipRefRes.error || exemptRes.error) break
        const jeIdsWithDocs = new Set(
          (docsRes.data ?? []).map((d) => d.journal_entry_id as string),
        )
        for (const si of (siRefRes.data ?? []) as unknown as {
          registration_journal_entry_id: string | null
          payment_journal_entry_id: string | null
          document: { journal_entry_id: string | null } | null
        }[]) {
          if (!si.document?.journal_entry_id) continue // unanchored: not underlag
          if (si.registration_journal_entry_id) jeIdsWithDocs.add(si.registration_journal_entry_id)
          if (si.payment_journal_entry_id) jeIdsWithDocs.add(si.payment_journal_entry_id)
        }
        for (const sip of (sipRefRes.data ?? []) as unknown as {
          journal_entry_id: string | null
          supplier_invoice: {
            document_id: string | null
            document: { journal_entry_id: string | null } | null
          } | null
        }[]) {
          if (sip.journal_entry_id && sip.supplier_invoice?.document?.journal_entry_id) {
            jeIdsWithDocs.add(sip.journal_entry_id)
          }
        }
        const exemptIds = new Set(
          (exemptRes.data ?? []).map((e) => e.journal_entry_id as string),
        )
        Object.assign(
          merged,
          computeJeUnderlagStatus(entriesRes.data ?? [], jeIdsWithDocs, exemptIds),
        )
      }
      // The merge is an idempotent keyed write, so it stays valid across
      // unrelated transactions-state changes (booking a row, deletes,
      // load-more); only a company switch invalidates it. No cleanup-based
      // cancellation: that would orphan ids already marked as requested.
      if (requestedJeIdsRef.current.companyId === companyId && Object.keys(merged).length > 0) {
        setJeUnderlagStatus((prev) => ({ ...prev, ...merged }))
      }
    })()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions, companyId])

  async function fetchCategorySuggestions(txIds: string[]) {
    if (txIds.length === 0) return
    try {
      const response = await fetch('/api/transactions/suggest-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_ids: txIds }),
      })
      if (!response.ok) throw new Error('Failed to fetch suggestions')
      const data = await response.json()
      if (data.template_suggestions) {
        setTemplateSuggestions(data.template_suggestions)
      }
    } catch {
      // Non-critical
    }
  }

  // The initial fetch waits for FyPicker to finish restoring the persisted
  // period scope (onReady fires after its restore onChange). Fetching at
  // mount used to race the restore: an unscoped fetch painted the list, the
  // restore re-created fetchTransactions and re-ran this effect with a second
  // skeleton takeover, so every visit flashed list → skeleton → list.
  const [fyReady, setFyReady] = useState(false)
  const handleFyReady = useCallback(() => setFyReady(true), [])
  // Whether anything is on screen, readable from the effect without making
  // row state a dependency (which would refetch on every row patch).
  const hasRowsRef = useRef(false)
  useEffect(() => {
    hasRowsRef.current = transactions.length > 0 || skvRows.length > 0
  }, [transactions, skvRows])
  const lastFetchCompanyRef = useRef<string | null>(null)
  // Subtle "refreshing" cue next to the period chip while a scope change
  // refetches behind the rendered list. Sequence-guarded so overlapping
  // scope changes can't clear the cue early.
  const [isScopeRefreshing, setIsScopeRefreshing] = useState(false)
  const scopeRefreshSeqRef = useRef(0)

  // Fiscal scope must not survive a company switch: periodBounds from the
  // previous company would scope the first fetch for the new one, and a
  // non-null fyPeriodId makes FyPicker skip its persisted-scope restore
  // (it only restores when value === null). Resetting during render (React's
  // adjust-state-on-prop-change pattern) rather than in an effect guarantees
  // FyPicker's restore effect observes the cleared value: its effect captures
  // `value` at commit time, and child effects run before a parent effect
  // could reset it. fyReady = false holds the fetch effect until the new
  // company's restore completes via onReady.
  const [scopeCompanyId, setScopeCompanyId] = useState<string | null>(companyId)
  if (scopeCompanyId !== companyId) {
    setScopeCompanyId(companyId)
    setFyReady(false)
    setFyPeriodId(null)
    setFyPeriod(null)
    // A scope refresh in flight belongs to the old company: invalidate its
    // finally-guard and drop the cue.
    scopeRefreshSeqRef.current++
    setIsScopeRefreshing(false)
    // Data boundary: the previous company's rows must neither render for the
    // new one (the takeover fetch is async; until it resolves the old rows
    // would sit under the new company's header) nor land later from a fetch
    // still in flight. Clearing rows + bumping both fetch sequences closes
    // both holes; the counts and paging state describe the cleared rows, so
    // they reset with them.
    setTransactions([])
    setSkvRows([])
    setTotalUncategorizedCount(null)
    setPagedThroughDate(null)
    setHasMore(false)
    pagedCountRef.current = 0
    fetchGenerationRef.current++
    skvFetchSeqRef.current++
  }

  // Fetch the page whenever the scope changes (mount, company switch, period
  // change). The skeleton takeover is reserved for an empty or foreign list:
  // a period change refetches BEHIND the rendered rows, whose client-side
  // isWithinBounds filters already show the new scope correctly.
  useEffect(() => {
    if (!fyReady) return
    const companySwitched = lastFetchCompanyRef.current !== companyId
    lastFetchCompanyRef.current = companyId
    if (companySwitched || !hasRowsRef.current) {
      void fetchTransactions(true, true)
      return
    }
    const seq = ++scopeRefreshSeqRef.current
    setIsScopeRefreshing(true)
    void fetchTransactions(false, true).finally(() => {
      if (scopeRefreshSeqRef.current === seq) setIsScopeRefreshing(false)
    })
  }, [companyId, fetchTransactions, fyReady])

  useEffect(() => {
    if (!companyId) return

    let cancelled = false

    const refreshFromRealtime = async () => {
      if (cancelled) return
      await refreshTransactions()
    }

    const channel = supabase
      .channel(`transactions:list:${companyId}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'transactions',
          filter: `company_id=eq.${companyId}`,
        },
        () => {
          void refreshFromRealtime()
        },
      )
      .subscribe()

    return () => {
      cancelled = true
      void supabase.removeChannel(channel)
    }
  }, [companyId, refreshTransactions, supabase])

  // Scroll the targeted row into view when arriving via
  // /transactions?highlight=<id>. Callers are inbox "Öppna transaktionen",
  // payment-booking dialog, and supplier-invoice cross-link: all "go look
  // at this row", not "start booking". The legacy auto-open-template-picker
  // behavior was removed in v5: booking happens in the inbox workspace now.
  // Runs once per distinct highlight id so closing/scrolling away doesn't
  // re-trigger it.
  useEffect(() => {
    if (!highlightId) return
    if (handledHighlightRef.current === highlightId) return
    if (transactions.length === 0) return
    const tx = transactions.find((t) => t.id === highlightId)
    if (!tx) return
    handledHighlightRef.current = highlightId

    // A deep link must land on a visible row: when the remembered source
    // filter would hide the highlighted transaction, widen to 'all' in
    // memory only (storage keeps the user's choice for the next visit).
    // Checked against the WANTED filter, not the effective one: transactions
    // can load before cash accounts, when the effective filter is still 'all'
    // but the wanted one would hide the row the moment the accounts arrive.
    // 'all' rather than acct:<id> because it also covers rows with a null
    // cash_account_id.
    const hiddenByFilter =
      sourceFilter === 'skatteverket' ||
      (sourceFilter.startsWith('acct:') &&
        tx.cash_account_id !== sourceFilter.slice('acct:'.length)) ||
      (sourceFilter === 'bank:other' && tx.cash_account_id != null)
    if (hiddenByFilter) setSourceFilter('all')

    // Defer the scroll until React has committed the list to the DOM.
    // Without rAF the data-tx-id node may not exist yet when this fires
    // immediately after fetchTransactions resolves.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-tx-id="${tx.id}"]`)
        if (el && 'scrollIntoView' in el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
      })
    })
  }, [highlightId, sourceFilter, transactions])

  // Auto-fetch suggestions when transactions load
  useEffect(() => {
    const uncatIds = transactions
      .filter((t) => t.is_business === null)
      .map((t) => t.id)
      .slice(0, 50)
    if (uncatIds.length > 0) {
      fetchCategorySuggestions(uncatIds)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transactions.length])

  const handleCategorize: CategorizeHandler = async (id, isBusiness, category, vatTreatment, accountOverride, templateId, inboxItemId, dimensions) => {
    const outcome = await runCategorize({ id, isBusiness, category, vatTreatment, accountOverride, templateId, inboxItemId, dimensions, confirmNoMatch: false })
    return outcome.journalEntryId
  }

  /**
   * The shared tail of a successful booking: exit animation, unbooked-count
   * decrement, the outcome toast with its Ångra action, and the state patch
   * that lands the row in its booked shape.
   *
   * Both booking paths run this. The counterparty-template path used to do
   * only `setExitingIds().add(id)`, so a successful booking gave no
   * confirmation, no undo and no count decrement, and the id was never removed
   * from exitingIds again: an undo would have restored the row's data while
   * leaving it filtered out of the inbox.
   */
  // The one place that calls the storno endpoint (pinned by
  // booking-feedback-parity.test.ts): the per-row Ångra action and the batch
  // "Ångra alla" both route through it.
  const undoCategorize = (id: string) =>
    fetch(`/api/transactions/${id}/uncategorize`, { method: 'POST' })

  // Rows whose booking was undone while finishBooking's 350ms patch was still
  // pending. The per-row Ångra covers this with a closure-local flag, but
  // "Ångra alla" (undoBatchCategorize) cannot reach those closures: without a
  // shared record its undo patch could land first and the timer then re-apply
  // the booked shape, pointing journal_entry_id at a storno-reversed entry.
  // Ids are removed again when a new booking for the row starts, so a
  // re-booked row still gets its delayed patch.
  const undoneIdsRef = useRef<Set<string>>(new Set())

  function finishBooking(args: {
    id: string
    isBusiness: boolean
    category?: TransactionCategory
    journalEntryId?: string | null
    journalEntryCreated?: boolean
    journalEntryError?: string | null
    // Batch rows: keep the exit animation, count decrement and state patch,
    // but leave the narration to the caller's single aggregate toast instead
    // of stacking one toast per row.
    silent?: boolean
  }) {
    const { id, isBusiness, category, journalEntryId, journalEntryCreated, journalEntryError, silent } = args
    // A completed Ångra must win over the delayed patch below. The undo has
    // already storno-reversed the verifikat server-side, so re-applying the
    // booked shape afterwards would show a journal_entry_id that no longer
    // represents a live entry.
    let undone = false
    // A fresh booking supersedes any earlier undo of the same row: without
    // this, a row booked again after an Ångra would skip its delayed patch.
    undoneIdsRef.current.delete(id)

    setExitingIds((prev) => new Set(prev).add(id))
    setTotalUncategorizedCount((prev) => Math.max(0, (prev ?? 1) - 1))

    if (silent) {
      // No per-row toast: fall through to the delayed state patch below.
    } else if (journalEntryCreated) {
      toast({
        title: 'Bokförd',
        action: (
          <ToastAction altText="Ångra kategorisering" onClick={async () => {
            try {
              const undoRes = await undoCategorize(id)
              if (undoRes.ok) {
                undone = true
                undoneIdsRef.current.add(id)
                setTransactions((prev) =>
                  prev.map((t) =>
                    t.id === id
                      ? { ...t, is_business: null, category: null as unknown as TransactionCategory, journal_entry_id: null }
                      : t
                  )
                )
                setTotalUncategorizedCount((prev) => (prev ?? 0) + 1)
                toast({ title: t('undone_title'), description: t('undone_description') })
              } else {
                const errData = await undoRes.json()
                toast({
                  title: 'Kunde inte ångra',
                  description: getErrorMessage(errData, { context: 'transaction', statusCode: undoRes.status }),
                  variant: 'destructive',
                })
              }
            } catch {
              toast({ title: t('undo_failed_title'), description: t('undo_failed_description'), variant: 'destructive' })
            }
          }}>
            Ångra
          </ToastAction>
        ),
      })
    } else if (journalEntryError) {
      toast({ title: 'Delvis bokförd', description: `Verifikation kunde inte skapas: ${journalEntryError}`, variant: 'destructive' })
    } else {
      toast({ title: t('partially_booked_title'), description: t('partially_booked_description') })
    }

    // Update transaction in state after a brief delay for animation. Clearing
    // the id from exitingIds is what makes an Ångra later put the row back in
    // the inbox instead of leaving it invisible.
    setTimeout(() => {
      // Both undo records gate the patch: the closure-local flag (per-row
      // Ångra) and the shared ref ("Ångra alla", which runs outside this
      // closure). The exitingIds/processingId cleanup below always runs.
      if (!undone && !undoneIdsRef.current.has(id)) {
        setTransactions((prev) =>
          prev.map((tx) =>
            tx.id === id
              ? {
                  ...tx,
                  is_business: isBusiness,
                  ...(category ? { category } : {}),
                  ...(journalEntryId ? { journal_entry_id: journalEntryId } : {}),
                }
              : tx
          )
        )
      }
      setExitingIds((prev) => {
        const next = new Set(prev)
        next.delete(id)
        return next
      })
      // Only this row's spinner: the shared helper must not clear another
      // transaction's in-flight state.
      setProcessingId((prev) => (prev === id ? null : prev))
    }, 350)
  }

  async function runCategorize(args: {
    id: string
    isBusiness: boolean
    category?: TransactionCategory
    vatTreatment?: VatTreatment
    accountOverride?: string
    templateId?: string
    inboxItemId?: string
    dimensions?: Record<string, string>
    confirmNoMatch: boolean
    // Set after the user confirms the booking-time duplicate warning. force
    // bypasses the guard; the bypass is bound to the reviewed candidate's
    // voucher (journal_entry_id), present on both a sibling-transaction and a
    // ledger-only voucher candidate.
    force?: boolean
    expectedDuplicateJournalEntryId?: string
    // Batch rows: the caller narrates the outcome once for the whole batch,
    // so the per-row success toast (finishBooking) and the generic per-row
    // failure toast stay quiet. Interactive escalations (match suggestions,
    // duplicate warning, activate-account) keep their dialogs/actions: they
    // are the only way forward for those rows.
    silent?: boolean
    // ok distinguishes "the server accepted the categorization" from "nothing
    // happened". A 2xx with a null journal_entry_id is a real success (e.g. an
    // already-categorized flag flip), so the id alone cannot carry that signal:
    // the batch aggregate would count the row as failed after finishBooking
    // already animated it out of the inbox.
  }): Promise<{ ok: boolean; journalEntryId: string | null }> {
    const { id, isBusiness, category, vatTreatment, accountOverride, templateId, inboxItemId, dimensions, confirmNoMatch, force, expectedDuplicateJournalEntryId, silent } = args
    try {
      setProcessingId(id)
      const response = await fetch(`/api/transactions/${id}/categorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_business: isBusiness,
          category,
          vat_treatment: vatTreatment,
          account_override: accountOverride,
          template_id: templateId,
          inbox_item_id: inboxItemId,
          ...(dimensions && Object.keys(dimensions).length > 0 ? { dimensions } : {}),
          ...(confirmNoMatch ? { confirm_no_match: true } : {}),
          ...(force && expectedDuplicateJournalEntryId
            ? { force: true, expected_duplicate_journal_entry_id: expectedDuplicateJournalEntryId }
            : {}),
        }),
      })

      const result = await response.json()
      if (!response.ok) {
        if (
          result?.error?.code === 'TX_CATEGORIZE_SUGGEST_SI_MATCH' &&
          Array.isArray(result.error.details?.candidates)
        ) {
          // Prong B: invite the user to match the open supplier invoice
          // instead of booking a plain 2440 categorization that would later
          // create a duplicate when they hit "Markera som betald".
          setSiMatchSuggestion({
            transactionId: id,
            retry: () => runCategorize({ ...args, confirmNoMatch: true }),
            candidates: result.error.details.candidates,
          })
          setProcessingId(null)
          return { ok: false, journalEntryId: null }
        }
        if (
          result?.error?.code === 'TX_CATEGORIZE_SUGGEST_CI_MATCH' &&
          Array.isArray(result.error.details?.candidates)
        ) {
          // Prong B (customer side): invite the user to match the unpaid
          // customer invoice instead of booking a plain 1510 categorization
          // that would later create a duplicate.
          setCiMatchSuggestion({
            transactionId: id,
            retry: () => runCategorize({ ...args, confirmNoMatch: true }),
            candidates: result.error.details.candidates,
          })
          setProcessingId(null)
          return { ok: false, journalEntryId: null }
        }
        if (result?.error?.code === 'TX_CATEGORIZE_INVALID_ACCOUNT') {
          // The user picked a library template (or typed an account
          // override) whose account isn't in this company's kontoplan.
          // Mirror the ACCOUNTS_NOT_IN_CHART flow with a one-click
          // "Aktivera och bokför": pull the BAS name if known so the
          // toast carries real context.
          // Validate the BAS account number is a plain 4-digit string before
          // embedding it in any fetch URL/body: the value comes from the
          // server error envelope but defense-in-depth.
          const rawAccountNumber: unknown = result.error.details?.accountNumber
          const accountNumber: string | undefined =
            typeof rawAccountNumber === 'string' && /^\d{4}$/.test(rawAccountNumber)
              ? rawAccountNumber
              : undefined
          let displayName = accountNumber ?? ''
          if (accountNumber) {
            try {
              const lookupRes = await fetch(`/api/bookkeeping/accounts/bas-lookup?numbers=${encodeURIComponent(accountNumber)}`)
              if (lookupRes.ok) {
                const lookup = await lookupRes.json() as { data?: Array<{ account_number: string; account_name: string | null; known?: boolean }> }
                const hit = lookup.data?.find((r) => r.account_number === accountNumber)
                if (hit?.account_name) displayName = `${accountNumber} - ${hit.account_name}`
              }
            } catch { /* fall through to the plain number */ }
          }
          let invalidAccountActivateInFlight = false
          toast({
            title: 'Kontot finns inte i din kontoplan',
            description: accountNumber
              ? `Kontot ${displayName} är inte aktiverat.`
              : 'Kontot är inte aktiverat.',
            variant: 'destructive',
            action: accountNumber ? (
              <ToastAction altText="Aktivera och bokför" onClick={async () => {
                if (invalidAccountActivateInFlight) return
                invalidAccountActivateInFlight = true
                try {
                  const activateRes = await fetch('/api/bookkeeping/accounts/activate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ account_numbers: [accountNumber] }),
                  })
                  if (!activateRes.ok) {
                    const errBody = await activateRes.json().catch(() => null)
                    toast({
                      title: 'Kunde inte aktivera kontot',
                      description: getErrorMessage(errBody, { statusCode: activateRes.status }),
                      variant: 'destructive',
                    })
                    return
                  }
                  const activateBody = await activateRes.json()
                  if (Array.isArray(activateBody.unknown) && activateBody.unknown.length > 0) {
                    toast({
                      title: 'Kontot finns inte i BAS-planen',
                      description: `Lägg till ${accountNumber} manuellt i Kontoplan.`,
                      variant: 'destructive',
                    })
                    return
                  }
                  await runCategorize(args)
                } finally {
                  invalidAccountActivateInFlight = false
                }
              }}>
                Aktivera och bokför
              </ToastAction>
            ) : undefined,
          })
          setProcessingId(null)
          return { ok: false, journalEntryId: null }
        }
        if (result?.error?.code === 'ACCOUNTS_NOT_IN_CHART') {
          // The mapped template/category references one or more accounts
          // that aren't active in this company's kontoplan. Without an
          // inline action the user has to navigate to settings, activate
          // each account, and come back: surface a one-click "Aktivera
          // och bokför" instead.
          const accountNumbers: string[] =
            (Array.isArray(result.error.account_numbers) && result.error.account_numbers) ||
            (Array.isArray(result.error.details?.account_numbers) && result.error.details.account_numbers) ||
            []
          // Synchronous in-flight flag per toast closure: a double-click
          // would otherwise fire two activate+categorize pairs, where the
          // second categorize races the first's verifikation insert.
          let activateInFlight = false
          toast({
            title: 'Kontot finns inte i din kontoplan',
            description: `Bokföringsmallen kräver att följande konton aktiveras: ${accountNumbers.join(', ')}.`,
            variant: 'destructive',
            action: accountNumbers.length > 0 ? (
              <ToastAction altText="Aktivera och bokför" onClick={async () => {
                if (activateInFlight) return
                activateInFlight = true
                try {
                  const activateRes = await fetch('/api/bookkeeping/accounts/activate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ account_numbers: accountNumbers }),
                  })
                  if (!activateRes.ok) {
                    const errBody = await activateRes.json().catch(() => null)
                    toast({
                      title: 'Kunde inte aktivera konton',
                      description: getErrorMessage(errBody, { statusCode: activateRes.status }),
                      variant: 'destructive',
                    })
                    return
                  }
                  const activateBody = await activateRes.json()
                  // unknown[] = numbers not in BAS reference at all. Those
                  // can't be auto-created; tell the user to add them manually.
                  if (Array.isArray(activateBody.unknown) && activateBody.unknown.length > 0) {
                    toast({
                      title: 'Kunde inte hitta alla konton',
                      description: `Lägg till ${activateBody.unknown.join(', ')} manuellt i Kontoplan.`,
                      variant: 'destructive',
                    })
                    return
                  }
                  await runCategorize(args)
                } finally {
                  activateInFlight = false
                }
              }}>
                Aktivera och bokför
              </ToastAction>
            ) : undefined,
          })
          setProcessingId(null)
          return { ok: false, journalEntryId: null }
        }
        if (
          result?.error?.code === 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE' &&
          result.error.details?.candidate
        ) {
          // Booking-time duplicate guard fired. Don't dead-end on a toast that
          // merely says "book anyway" with no way to do so: open a dialog with
          // the already-booked sibling and let the user confirm. "Bokför ändå"
          // re-runs with force bound to this candidate (server re-detects it).
          const candidate = result.error.details.candidate as BookedDuplicateCandidate
          setDuplicateWarning({
            transactionId: id,
            retry: () =>
              runCategorize({
                ...args,
                force: true,
                expectedDuplicateJournalEntryId: candidate.journal_entry_id,
              }),
            candidate,
          })
          setProcessingId(null)
          return { ok: false, journalEntryId: null }
        }
        if (!silent) {
          toast({
            title: 'Kategorisering misslyckades',
            description: getErrorMessage(result, { context: 'transaction', statusCode: response.status }),
            variant: 'destructive',
          })
        }
        setProcessingId(null)
        return { ok: false, journalEntryId: null }
      }

      finishBooking({
        id,
        isBusiness,
        category: result.category,
        journalEntryId: result.journal_entry_id,
        journalEntryCreated: result.journal_entry_created,
        journalEntryError: result.journal_entry_error,
        silent,
      })

      return { ok: true, journalEntryId: result.journal_entry_id || null }
    } catch {
      if (!silent) {
        toast({ title: t('booking_failed_title'), description: t('booking_failed_description'), variant: 'destructive' })
      }
      setProcessingId(null)
      return { ok: false, journalEntryId: null }
    }
  }

  async function handleMatchSuggestedInvoice(transactionId: string, invoiceId: string) {
    setCiMatchProcessing(true)
    try {
      const response = await fetch(`/api/transactions/${transactionId}/match-invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: invoiceId }),
      })
      const result = await response.json()
      if (!response.ok) {
        toast({
          title: 'Matchning misslyckades',
          description: getErrorMessage(result, { context: 'transaction', statusCode: response.status }),
          variant: 'destructive',
        })
        setCiMatchProcessing(false)
        return
      }

      toast({ title: t('customer_invoice_matched_title'), description: t('customer_invoice_matched_description') })
      setCiMatchSuggestion(null)
      setExitingIds((prev) => new Set(prev).add(transactionId))
      setTotalUncategorizedCount((prev) => Math.max(0, (prev ?? 1) - 1))
      setTimeout(() => {
        setTransactions((prev) =>
          prev.map((t) =>
            t.id === transactionId
              ? {
                  ...t,
                  invoice_id: invoiceId,
                  is_business: true,
                  journal_entry_id: result.journal_entry_id ?? t.journal_entry_id,
                }
              : t
          )
        )
        setExitingIds((prev) => {
          const next = new Set(prev)
          next.delete(transactionId)
          return next
        })
      }, 350)
    } catch {
      toast({ title: t('match_failed_title'), description: t('match_failed_description_retry'), variant: 'destructive' })
    } finally {
      setCiMatchProcessing(false)
    }
  }

  async function handleMatchSuggestedSupplierInvoice(transactionId: string, supplierInvoiceId: string) {
    setSiMatchProcessing(true)
    try {
      const response = await fetch(`/api/transactions/${transactionId}/match-supplier-invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ supplier_invoice_id: supplierInvoiceId }),
      })
      const result = await response.json()
      if (!response.ok) {
        toast({
          title: 'Matchning misslyckades',
          description: getErrorMessage(result, { context: 'transaction', statusCode: response.status }),
          variant: 'destructive',
        })
        setSiMatchProcessing(false)
        return
      }

      toast({ title: t('supplier_invoice_matched_title'), description: t('supplier_invoice_matched_description') })
      setSiMatchSuggestion(null)
      setExitingIds((prev) => new Set(prev).add(transactionId))
      setTotalUncategorizedCount((prev) => Math.max(0, (prev ?? 1) - 1))
      setTimeout(() => {
        setTransactions((prev) =>
          prev.map((t) =>
            t.id === transactionId
              ? {
                  ...t,
                  supplier_invoice_id: supplierInvoiceId,
                  is_business: true,
                  journal_entry_id: result.journal_entry_id ?? t.journal_entry_id,
                }
              : t
          )
        )
        setExitingIds((prev) => {
          const next = new Set(prev)
          next.delete(transactionId)
          return next
        })
      }, 350)
    } catch {
      toast({ title: t('match_failed_title'), description: t('match_failed_description_retry'), variant: 'destructive' })
    } finally {
      setSiMatchProcessing(false)
    }
  }

  async function handleIgnoreTransaction(tx: TransactionWithInvoice) {
    // Mirrors BankReconciliationView's ignore flow: Ignorera is fully
    // reversible, but the row vanishes immediately: confirmation before the
    // write plus an Ångra toast gives two recovery affordances. The
    // "Ignorerade transaktioner" card on Rapporter → Bankavstämning is the
    // standing third.
    const ok = await confirm({
      title: 'Ignorera transaktionen?',
      description: `${tx.description}, ${formatCurrency(tx.amount, tx.currency)} (${formatDate(tx.date)}) försvinner från listan utan att bokföras. Använd bara för poster som inte är affärshändelser, t.ex. dubbletter eller överföringar mellan egna konton. Riktiga köp och betalningar ska bokföras. Du kan återställa den under Bankavstämning när som helst.`,
      confirmLabel: 'Ignorera',
      cancelLabel: 'Avbryt',
      variant: 'warning',
    })
    if (!ok) return

    setTemplatePickerOpen(false)
    try {
      const res = await fetch(`/api/transactions/${tx.id}/ignore`, { method: 'POST' })
      const result = await res.json()
      if (!res.ok || result.error) {
        toast({
          title: 'Kunde inte ignorera transaktionen',
          description: typeof result.error === 'string' ? result.error : undefined,
          variant: 'destructive',
        })
        return
      }
      setExitingIds((prev) => new Set(prev).add(tx.id))
      setTotalUncategorizedCount((prev) => Math.max(0, (prev ?? 1) - 1))
      setTimeout(() => {
        setTransactions((prev) =>
          prev.map((t) => (t.id === tx.id ? { ...t, is_ignored: true } : t))
        )
        setExitingIds((prev) => {
          const next = new Set(prev)
          next.delete(tx.id)
          return next
        })
      }, 350)
      toast({
        title: 'Transaktionen ignorerad',
        description: `${tx.description}, ${formatCurrency(tx.amount, tx.currency)}`,
        action: (
          <ToastAction altText="Ångra ignorera" onClick={() => void handleUnignoreTransaction(tx.id)}>
            Ångra
          </ToastAction>
        ),
      })
    } catch {
      toast({ title: 'Kunde inte ignorera transaktionen', variant: 'destructive' })
    }
  }

  async function handleUnignoreTransaction(transactionId: string) {
    try {
      const res = await fetch(`/api/transactions/${transactionId}/ignore`, { method: 'DELETE' })
      const result = await res.json()
      if (!res.ok || result.error) {
        toast({ title: 'Kunde inte återställa transaktionen', variant: 'destructive' })
        return
      }
      setTransactions((prev) =>
        prev.map((t) => (t.id === transactionId ? { ...t, is_ignored: false } : t))
      )
      setTotalUncategorizedCount((prev) => (prev ?? 0) + 1)
    } catch {
      toast({ title: 'Kunde inte återställa transaktionen', variant: 'destructive' })
    }
  }

  async function handleConfirmInvoiceMatch(opts?: {
    force?: boolean
    expected_journal_entry_id?: string
    lines?: Array<{
      account_number: string
      debit_amount: number
      credit_amount: number
      line_description?: string
    }>
  }) {
    if (!selectedTransaction) return
    const isSupplier = !!selectedTransaction.potential_supplier_invoice
    const isCustomer = !!selectedTransaction.potential_invoice
    if (!isSupplier && !isCustomer) return

    setIsConfirmingMatch(true)

    try {
      const url = isSupplier
        ? `/api/transactions/${selectedTransaction.id}/match-supplier-invoice`
        : `/api/transactions/${selectedTransaction.id}/match-invoice`
      const body: Record<string, unknown> = isSupplier
        ? { supplier_invoice_id: selectedTransaction.potential_supplier_invoice!.id }
        : { invoice_id: selectedTransaction.potential_invoice!.id }
      if (!isSupplier && opts?.force) {
        body.force = true
        // Bind the override to the candidate the user saw in the dialog.
        // The server re-detects the candidate and rejects the bypass if
        // the id doesn't match, so an empty value here surfaces as a
        // clean validation error instead of silently widening the guard.
        if (opts.expected_journal_entry_id) {
          body.expected_journal_entry_id = opts.expected_journal_entry_id
        }
      }
      // User-edited journal entry rows from the match dialog. Forwarded
      // verbatim; the server validates balance and posts via
      // createJournalEntry directly. Default routing applies when omitted.
      if (opts?.lines && opts.lines.length >= 2) {
        body.lines = opts.lines
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok) {
        toast({
          title: isSupplier ? 'Leverantörsfakturamatchning misslyckades' : 'Fakturamatchning misslyckades',
          description: getErrorMessage(result, { context: 'transaction' }),
          variant: 'destructive',
        })
        setIsConfirmingMatch(false)
        return
      }

      const label = isSupplier
        ? `Leverantörsfaktura ${selectedTransaction.potential_supplier_invoice!.supplier_invoice_number} markerad som betald`
        : `Faktura ${selectedTransaction.potential_invoice!.invoice_number} markerad som betald`
      toast({ title: isSupplier ? 'Leverantörsfaktura matchad' : 'Faktura matchad', description: label })
      setMatchDialogOpen(false)

      // Mark as exiting for animation
      setExitingIds((prev) => new Set(prev).add(selectedTransaction.id))
      setTimeout(() => {
        setTransactions((prev) =>
          prev.map((t) =>
            t.id === selectedTransaction.id
              ? isSupplier
                ? {
                    ...t,
                    supplier_invoice_id: selectedTransaction.potential_supplier_invoice?.id || null,
                    potential_supplier_invoice: undefined,
                    is_business: true,
                    journal_entry_id: result.journal_entry_id,
                  }
                : {
                    ...t,
                    invoice_id: selectedTransaction.potential_invoice?.id || null,
                    potential_invoice_id: null,
                    potential_invoice: undefined,
                    is_business: true,
                    category: 'income_services' as TransactionCategory,
                    journal_entry_id: result.journal_entry_id,
                  }
              : t
          )
        )
        setExitingIds((prev) => {
          const next = new Set(prev)
          next.delete(selectedTransaction.id)
          return next
        })
        setSelectedTransaction(null)
        setIsConfirmingMatch(false)
      }, 350)
    } catch {
      toast({ title: t('match_failed_title'), description: t('match_failed_transaction'), variant: 'destructive' })
      setIsConfirmingMatch(false)
    }
  }

  async function handleLinkToExistingVoucher(journalEntryId: string) {
    if (!selectedTransaction) return
    const invoiceId = selectedTransaction.potential_invoice?.id ?? null
    setIsConfirmingMatch(true)
    try {
      const response = await fetch(
        `/api/transactions/${selectedTransaction.id}/link-journal-entry`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            journal_entry_id: journalEntryId,
            ...(invoiceId ? { invoice_id: invoiceId } : {}),
          }),
        },
      )
      const result = await response.json()
      if (!response.ok) {
        toast({
          title: 'Kunde inte koppla till befintlig verifikation',
          description: getErrorMessage(result, { context: 'transaction' }),
          variant: 'destructive',
        })
        setIsConfirmingMatch(false)
        return
      }

      const voucherLabel = (result as { voucher_label?: string }).voucher_label ?? ''
      toast({
        title: 'Bankhändelsen kopplad',
        description: voucherLabel
          ? `Kopplad till verifikation ${voucherLabel}. Ingen ny bokföring skapad.`
          : 'Ingen ny bokföring skapad.',
      })
      setMatchDialogOpen(false)

      // Animate out + update local state, same pattern as handleConfirmInvoiceMatch.
      setExitingIds((prev) => new Set(prev).add(selectedTransaction.id))
      setTimeout(() => {
        setTransactions((prev) =>
          prev.map((t) =>
            t.id === selectedTransaction.id
              ? {
                  ...t,
                  invoice_id: invoiceId,
                  potential_invoice_id: null,
                  potential_invoice: undefined,
                  is_business: true,
                  journal_entry_id: journalEntryId,
                }
              : t,
          ),
        )
        setExitingIds((prev) => {
          const next = new Set(prev)
          next.delete(selectedTransaction.id)
          return next
        })
        setSelectedTransaction(null)
        setIsConfirmingMatch(false)
      }, 350)
    } catch {
      toast({
        title: 'Koppling misslyckades',
        description: t('voucher_link_failed_description'),
        variant: 'destructive',
      })
      setIsConfirmingMatch(false)
    }
  }

  function openMatchVoucherDialog(transaction: TransactionWithInvoice) {
    setMatchVoucherTx(transaction)
  }

  // Called by MatchVoucherDialog after /api/reconciliation/bank/link succeeds.
  // The row is now booked (journal_entry_id set, is_business true) so the inbox
  // filter drops it: animate it out the same way as the invoice-link path.
  function handleVoucherLinked(transactionId: string, journalEntryId: string, voucherLabel: string) {
    toast({
      title: 'Bankhändelsen kopplad',
      description: voucherLabel
        ? `Kopplad till verifikation ${voucherLabel}. Ingen ny bokföring skapad.`
        : 'Ingen ny bokföring skapad.',
    })
    setMatchVoucherTx(null)
    setExitingIds((prev) => new Set(prev).add(transactionId))
    setTimeout(() => {
      setTransactions((prev) =>
        prev.map((t) =>
          t.id === transactionId
            ? { ...t, is_business: true, journal_entry_id: journalEntryId }
            : t,
        ),
      )
      setExitingIds((prev) => {
        const next = new Set(prev)
        next.delete(transactionId)
        return next
      })
    }, 350)
  }

  // "Granska migrerad historik": confirm/reject persisted journal-entry match
  // suggestions through the server-side revalidating bulk endpoint. Stale
  // pairs come back as skipped, never as a failed batch: the toast reports
  // both numbers honestly and the refresh re-derives the list from DB truth.
  // Chunked at the schema's 500-id cap (same as BankReconciliationView's
  // apply): a migrator's review list can exceed it, and one unchunked POST
  // would 400 with zero progress on exactly the flagship bulk action.
  const SUGGESTION_CHUNK_SIZE = 500

  const confirmSuggestions = useCallback(
    async (transactionIds: string[]) => {
      let confirmed = 0
      let skipped = 0
      try {
        for (let i = 0; i < transactionIds.length; i += SUGGESTION_CHUNK_SIZE) {
          const chunk = transactionIds.slice(i, i + SUGGESTION_CHUNK_SIZE)
          const response = await fetch('/api/reconciliation/bank/confirm-suggestions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transaction_ids: chunk, action: 'confirm' }),
          })
          const payload = await response.json()
          if (!response.ok) {
            // Report the partial progress alongside the failure: chunks that
            // already committed stay committed.
            toast({
              title: t('review_confirm_failed'),
              description: getErrorMessage(payload, { context: 'transaction' }),
              variant: 'destructive',
            })
            return
          }
          confirmed += (payload.data?.confirmed ?? []).length
          skipped += (payload.data?.skipped ?? []).length
        }
        toast({
          title: t('review_confirm_done_title', { count: confirmed }),
          description:
            skipped > 0
              ? t('review_confirm_done_skipped', { count: skipped })
              : t('review_confirm_done_description'),
        })
      } catch (error) {
        toast({
          title: t('review_confirm_failed'),
          description: getErrorMessage(error, { context: 'transaction' }),
          variant: 'destructive',
        })
      } finally {
        await refreshTransactions()
      }
    },
    [refreshTransactions, t, toast],
  )

  const rejectSuggestions = useCallback(
    async (transactionIds: string[]) => {
      try {
        for (let i = 0; i < transactionIds.length; i += SUGGESTION_CHUNK_SIZE) {
          const chunk = transactionIds.slice(i, i + SUGGESTION_CHUNK_SIZE)
          const response = await fetch('/api/reconciliation/bank/confirm-suggestions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transaction_ids: chunk, action: 'reject' }),
          })
          if (!response.ok) {
            const payload = await response.json()
            toast({
              title: t('review_reject_failed'),
              description: getErrorMessage(payload, { context: 'transaction' }),
              variant: 'destructive',
            })
            return
          }
        }
      } catch (error) {
        toast({
          title: t('review_reject_failed'),
          description: getErrorMessage(error, { context: 'transaction' }),
          variant: 'destructive',
        })
      } finally {
        await refreshTransactions()
      }
    },
    [refreshTransactions, t, toast],
  )

  // "Kör matchning igen": full per-account sweep over all history. New >= 0.9
  // matches auto-link; the review band lands back here as fresh suggestions.
  const rerunMatching = useCallback(async () => {
    setRerunningMatch(true)
    try {
      const response = await fetch('/api/reconciliation/bank/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ all_accounts: true }),
      })
      const payload = await response.json()
      if (!response.ok) {
        toast({
          title: t('review_rerun_failed'),
          description: getErrorMessage(payload, { context: 'transaction' }),
          variant: 'destructive',
        })
        return
      }
      toast({
        title: t('review_rerun_done_title'),
        description: t('review_rerun_done_description', {
          applied: payload.data?.applied ?? 0,
          suggested: payload.data?.suggested ?? 0,
        }),
      })
    } catch (error) {
      toast({
        title: t('review_rerun_failed'),
        description: getErrorMessage(error, { context: 'transaction' }),
        variant: 'destructive',
      })
    } finally {
      setRerunningMatch(false)
      await refreshTransactions()
    }
  }, [refreshTransactions, t, toast])

  async function handleMatchInvoice(transactionId: string, invoiceId: string): Promise<boolean> {
    try {
      const response = await fetch(`/api/transactions/${transactionId}/match-invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: invoiceId }),
      })
      const result = await response.json()
      if (!response.ok) {
        toast({ title: 'Fakturamatchning misslyckades', description: getErrorMessage(result, { context: 'transaction' }), variant: 'destructive' })
        return false
      }

      const transaction = transactions.find((t) => t.id === transactionId)
      const invoiceNumber = transaction?.potential_invoice?.invoice_number || ''

      setTransactions((prev) =>
        prev.map((t) =>
          t.id === transactionId
            ? {
                ...t,
                invoice_id: invoiceId,
                potential_invoice_id: null,
                potential_invoice: undefined,
                is_business: true,
                category: 'income_services' as TransactionCategory,
                journal_entry_id: result.journal_entry_id,
              }
            : t
        )
      )

      toast({ title: 'Faktura matchad', description: `Faktura ${invoiceNumber} markerad som betald` })
      return true
    } catch {
      toast({ title: t('match_failed_title'), description: t('match_failed_with_invoice'), variant: 'destructive' })
      return false
    }
  }

  function handleSelectInvoiceFromPicker(invoice: Invoice & { customer?: Customer }) {
    if (!invoicePickerTransaction) return
    // Don't POST directly from the picker. Route through the confirm dialog
    // so the user sees the JE preview (Debet 1930 / Kredit 1510, or the cash
    // variant) before the booking is created. Same UX as the auto-suggested
    // path. Closes the picker and opens the match dialog with the picked
    // invoice attached as potential_invoice.
    const tx = invoicePickerTransaction
    setInvoicePickerOpen(false)
    setInvoicePickerTransaction(null)
    setSelectedTransaction({ ...tx, potential_invoice: invoice })
    setMatchDialogOpen(true)
  }

  function handleSelectSupplierInvoiceFromPicker(invoice: SupplierInvoice & { supplier?: Supplier }) {
    if (!supplierInvoicePickerTransaction) return
    // Route through the confirm dialog so the supplier-side JE preview
    // (Debet 2440 / Kredit 1930, or kontant-variant) is shown before commit.
    const tx = supplierInvoicePickerTransaction
    setSupplierInvoicePickerOpen(false)
    setSupplierInvoicePickerTransaction(null)
    setSelectedTransaction({ ...tx, potential_supplier_invoice: invoice })
    setMatchDialogOpen(true)
  }

  function openInvoiceMatchPicker(transaction: TransactionWithInvoice) {
    if (transaction.amount >= 0) {
      setInvoicePickerTransaction(transaction)
      setInvoicePickerOpen(true)
    } else {
      setSupplierInvoicePickerTransaction(transaction)
      setSupplierInvoicePickerOpen(true)
    }
  }

  function openSplitMatchDialog(transaction: TransactionWithInvoice) {
    setSplitMatchTransaction(transaction)
    setSplitMatchOpen(true)
  }

  // Selected-tx derivation for bulk-book eligibility.
  // The action bar shows "Bokför i klump" only when ≥2 txs are selected,
  // share the same date, and same direction (all income or all expense):
  // matches the RPC's same-day + same-direction invariants so the user
  // doesn't submit a guaranteed-fail batch.
  const selectedTransactions = useMemo(
    () => transactions.filter((t) => selectedIds.has(t.id)),
    [transactions, selectedIds],
  )
  const bulkBookEligible = useMemo(() => {
    if (selectedTransactions.length < 2) return false
    const first = selectedTransactions[0]!
    return selectedTransactions.every(
      (t) => t.date === first.date && (t.amount > 0) === (first.amount > 0),
    )
  }, [selectedTransactions])

  async function handleBulkBookSuccess() {
    // Animate every selected tx out of the inbox, then refetch and clear
    // the selection state. Mirrors the per-tx match success animation.
    const ids = Array.from(selectedIds)
    setExitingIds((prev) => {
      const next = new Set(prev)
      for (const id of ids) next.add(id)
      return next
    })
    await refreshTransactions()
    setSelectedIds(new Set())
    setTimeout(() => {
      setExitingIds((prev) => {
        const next = new Set(prev)
        for (const id of ids) next.delete(id)
        return next
      })
    }, 350)
  }

  async function handleSplitMatchSuccess() {
    if (!splitMatchTransaction) return
    const txId = splitMatchTransaction.id
    // Mark the tx as exiting to trigger the same removal animation the
    // single-match flow uses, then drop it from the inbox once the refetch
    // confirms it's booked. Mirrors the pattern at the supplier-invoice
    // match success path below.
    setExitingIds((prev) => new Set(prev).add(txId))
    await refreshTransactions()
    setTimeout(() => {
      setExitingIds((prev) => {
        const next = new Set(prev)
        next.delete(txId)
        return next
      })
    }, 350)
  }

  async function handleCreateTransaction(data: CreateTransactionInput) {
    setIsCreating(true)
    try {
      // Create through the server route so the payload is validated server-side
      // (shared CreateTransactionSchema) and the DB CHECK applies: the browser
      // client must never be the only guard on a mutation.
      const response = await fetch('/api/transactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: data.date,
          description: data.description,
          amount: data.amount,
          currency: data.currency,
          category: data.category,
          notes: data.notes,
        }),
      })
      const result = await response.json()
      if (!response.ok) {
        toast({
          title: 'Kunde inte skapa transaktion',
          description: getErrorMessage(result, { context: 'transaction', statusCode: response.status }),
          variant: 'destructive',
        })
        return
      }
      toast({ title: 'Transaktion tillagd', description: `${data.description} har lagts till` })
      setTransactions([result.data, ...transactions])
      setIsDialogOpen(false)
    } catch {
      toast({ title: 'Kunde inte skapa transaktion', description: t('booking_failed_description'), variant: 'destructive' })
    } finally {
      setIsCreating(false)
    }
  }

  async function handleDeleteTransaction(id: string) {
    const transaction = transactions.find((t) => t.id === id)
    if (!transaction) return

    // The DELETE runs as the confirm's action: the dialog stays open with its
    // pending spinner until the operation settles (confirm-then-fetch used to
    // close the dialog synchronously and leave the fetch with no visible
    // state), then the row plays the same exit path as booking.
    await confirm({
      title: 'Ta bort transaktion',
      description: `Är du säker på att du vill ta bort "${transaction.description}"? Åtgärden kan inte ångras.`,
      confirmLabel: 'Ta bort',
      variant: 'destructive',
    }, async () => {
      try {
        // Row-level pending state while the DELETE runs (the card renders a
        // spinner for processingId): covers the exit window after the dialog
        // closes.
        setProcessingId(id)
        const response = await fetch(`/api/transactions/${id}`, { method: 'DELETE' })
        if (!response.ok) {
          const result = await response.json()
          setProcessingId((prev) => (prev === id ? null : prev))
          toast({
            title: 'Kunde inte ta bort',
            description: getErrorMessage(result, { context: 'transaction' }),
            variant: 'destructive',
          })
          return
        }
        // Same exit path as booking/ignore: the row animates out over the
        // 350ms window instead of vanishing with a hard jump, then the delayed
        // filter actually removes it.
        setExitingIds((prev) => new Set(prev).add(id))
        // Drop the row from the batch selection immediately: leaving it there
        // keeps the bulk bar counting (and acting on) a row that no longer
        // exists once the timer removes it.
        setSelectedIds((prev) => {
          if (!prev.has(id)) return prev
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        // The realtime echo is not guaranteed for DELETE on a filtered
        // subscription, so the pending badge must decrement locally.
        if (transaction.is_business === null && !transaction.is_ignored) {
          setTotalUncategorizedCount((prev) => Math.max(0, (prev ?? 1) - 1))
        }
        toast({ title: t('deleted_title'), description: t('deleted_description') })
        setTimeout(() => {
          setTransactions((prev) => prev.filter((t) => t.id !== id))
          setExitingIds((prev) => {
            const next = new Set(prev)
            next.delete(id)
            return next
          })
          setProcessingId((prev) => (prev === id ? null : prev))
        }, 350)
      } catch {
        setProcessingId((prev) => (prev === id ? null : prev))
        toast({
          title: 'Kunde inte ta bort',
          description: t('delete_failed_description'),
          variant: 'destructive',
        })
      }
    })
  }

  function openEditTitleDialog(transaction: TransactionWithInvoice) {
    setEditTitleTarget(transaction)
  }

  function openMoveAccountDialog(transaction: TransactionWithInvoice) {
    setMoveAccountTarget(transaction)
  }

  // Persist a cash-account move via PATCH. Returns true on success so the
  // dialog can close; refetches the list because the account chooser and the
  // per-account scoping key off cash_account_id.
  async function handleMoveCashAccount(accountNumber: string): Promise<boolean> {
    const target = moveAccountTarget
    if (!target) return false
    try {
      const response = await fetch(`/api/transactions/${target.id}/cash-account`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_number: accountNumber }),
      })
      const result = await response.json()
      if (!response.ok) {
        toast({
          title: t('move_account_failed'),
          description: getErrorMessage(result, { context: 'transaction' }),
          variant: 'destructive',
        })
        return false
      }
      const moved = result.data as { cash_account_id: string }
      setTransactions((prev) =>
        prev.map((tx) =>
          tx.id === target.id ? { ...tx, cash_account_id: moved.cash_account_id } : tx,
        ),
      )
      toast({ title: t('move_account_saved') })
      void refreshTransactions()
      return true
    } catch {
      toast({ title: t('move_account_failed'), variant: 'destructive' })
      return false
    }
  }

  // Persist a new title via PATCH. Returns true on success so the dialog can
  // close; updates the local list optimistically (description + edited tag).
  async function handleSaveTitle(description: string): Promise<boolean> {
    const target = editTitleTarget
    if (!target) return false
    try {
      const response = await fetch(`/api/transactions/${target.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      })
      const result = await response.json()
      if (!response.ok) {
        toast({
          title: t('edit_title_failed'),
          description: getErrorMessage(result, { context: 'transaction' }),
          variant: 'destructive',
        })
        return false
      }
      const updated = result.data as { description: string; title_edited_at: string | null }
      setTransactions((prev) =>
        prev.map((tx) =>
          tx.id === target.id
            ? { ...tx, description: updated.description, title_edited_at: updated.title_edited_at }
            : tx,
        ),
      )
      toast({ title: t('edit_title_saved') })
      return true
    } catch {
      toast({ title: t('edit_title_failed'), variant: 'destructive' })
      return false
    }
  }

  function handleSkvBokfor(row: StoredSkattekontoTransaction) {
    // Prefer the enriched row (booking_suggestion) when it's in state:
    // history-view callers only hold the stored shape.
    setSkvBookTarget(skvRows.find((r) => r.id === row.id) ?? row)
  }

  /**
   * Single-row booking succeeded (inline dialog): exit animation, local
   * journal_entry_id patch (no refetch), and one toast linking the verifikat.
   */
  function handleSkvBooked(rowId: string, result: SkattekontoBatchRowResult) {
    setSkvBookTarget(null)
    setSkvSelectedIds((prev) => {
      if (!prev.has(rowId)) return prev
      const next = new Set(prev)
      next.delete(rowId)
      return next
    })
    setExitingIds((prev) => new Set(prev).add(rowId))
    setTimeout(() => {
      setSkvRows((prev) =>
        prev.map((r) =>
          r.id === rowId && result.journal_entry_id
            ? { ...r, journal_entry_id: result.journal_entry_id }
            : r,
        ),
      )
      setExitingIds((prev) => {
        const next = new Set(prev)
        next.delete(rowId)
        return next
      })
    }, 350)

    const voucherLabel =
      result.voucher_series && result.voucher_number != null
        ? formatVoucher({
            voucher_series: result.voucher_series,
            voucher_number: result.voucher_number,
          })
        : null
    toast({
      title: t('skv_booked_title'),
      description: voucherLabel
        ? t('skv_booked_description', { voucher: voucherLabel })
        : undefined,
      action: result.journal_entry_id ? (
        <ToastAction altText={t('skv_booked_show')} asChild>
          <Link href={`/bookkeeping/${result.journal_entry_id}`}>
            {t('skv_booked_show')}
          </Link>
        </ToastAction>
      ) : undefined,
    })
  }

  function toggleSkvSelect(id: string) {
    setSkvSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function handleSkvUnignore(id: string) {
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/skattekonto/transaktioner/${id}/ignore`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_ignored: false }),
        },
      )
      if (!res.ok) {
        toast({ title: t('skv_ignore_undo_failed'), variant: 'destructive' })
        return
      }
      setSkvRows((prev) =>
        prev.map((r) => (r.id === id ? { ...r, is_ignored: false } : r)),
      )
    } catch {
      toast({ title: t('skv_ignore_undo_failed'), variant: 'destructive' })
    }
  }

  /**
   * Ignorera a skattekonto row: hides it from the work list without booking
   * (mirrors handleIgnoreTransaction for bank rows; skattekonto rows are
   * never deleted). Confirm up front + Ångra toast; the standing recovery
   * surface is the "Ignorerade" band on the Skattekonto page.
   */
  async function handleSkvIgnore(row: StoredSkattekontoTransaction) {
    const ok = await confirm(
      {
        title: t('skv_ignore_confirm_title'),
        description: t('skv_ignore_confirm_body', {
          text: row.transaktionstext,
          amount: formatCurrency(Number(row.belopp_skatteverket)),
          date: formatDate(row.transaktionsdatum),
        }),
        confirmLabel: t('skv_ignore_confirm_cta'),
        cancelLabel: t('skv_ignore_confirm_cancel'),
        variant: 'warning',
      },
      async () => {
        const res = await fetch(
          `/api/extensions/ext/skatteverket/skattekonto/transaktioner/${row.id}/ignore`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_ignored: true }),
          },
        )
        if (!res.ok) {
          const json = await res.json().catch(() => ({}))
          toast({
            title: t('skv_ignore_failed'),
            description: getErrorMessage(json, { statusCode: res.status }),
            variant: 'destructive',
          })
          throw new Error('skv ignore failed')
        }
      },
    )
    if (!ok) return

    setSkvSelectedIds((prev) => {
      if (!prev.has(row.id)) return prev
      const next = new Set(prev)
      next.delete(row.id)
      return next
    })
    setExitingIds((prev) => new Set(prev).add(row.id))
    setTimeout(() => {
      setSkvRows((prev) =>
        prev.map((r) => (r.id === row.id ? { ...r, is_ignored: true } : r)),
      )
      setExitingIds((prev) => {
        const next = new Set(prev)
        next.delete(row.id)
        return next
      })
    }, 350)
    toast({
      title: t('skv_ignored_title'),
      action: (
        <ToastAction
          altText={t('skv_ignore_undo')}
          onClick={() => void handleSkvUnignore(row.id)}
        >
          {t('skv_ignore_undo')}
        </ToastAction>
      ),
    })
  }

  /**
   * Bulk "Bokför valda": one confirmed summary → server-side draft+commit
   * per row via bokfor-batch (chunked so batchProgress moves), then ONE
   * aggregate toast and a local state patch with the exit animation.
   */
  async function handleSkvBulkConfirm() {
    // Re-check eligibility at submit time: a refetch may have attached a
    // duplicate hint or booked a row while the selection sat idle.
    const ids = skvSelectedRows.filter(isSkvBulkEligible).map((r) => r.id)
    if (ids.length === 0) {
      setSkvBulkConfirmOpen(false)
      setSkvSelectedIds(new Set())
      return
    }
    setSkvBulkConfirmOpen(false)
    setSkvBulkSubmitting(true)
    setBatchProgress({ done: 0, total: ids.length })

    const results: SkattekontoBatchRowResult[] = []
    const CHUNK = 25
    try {
      for (let i = 0; i < ids.length; i += CHUNK) {
        const chunk = ids.slice(i, i + CHUNK)
        try {
          const res = await fetch(
            '/api/extensions/ext/skatteverket/skattekonto/transaktioner/bokfor-batch',
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ ids: chunk }),
            },
          )
          const json = await res.json()
          if (res.ok) {
            results.push(...(json.data as SkattekontoBatchResult).results)
          } else {
            const message = getErrorMessage(json, { statusCode: res.status })
            for (const id of chunk) {
              results.push({ id, ok: false, error_code: 'UNKNOWN', error_message: message })
            }
          }
        } catch {
          for (const id of chunk) {
            results.push({ id, ok: false, error_code: 'UNKNOWN' })
          }
        }
        setBatchProgress({ done: Math.min(i + CHUNK, ids.length), total: ids.length })
      }
    } finally {
      setBatchProgress(null)
      setSkvBulkSubmitting(false)
    }

    // Rows that got a journal entry (posted, or a kept draft on
    // COMMIT_FAILED) leave the inbox: patch locally instead of refetching.
    const patched = new Map<string, string>()
    for (const r of results) {
      if (r.journal_entry_id) patched.set(r.id, r.journal_entry_id)
    }
    if (patched.size > 0) {
      setExitingIds((prev) => {
        const next = new Set(prev)
        for (const id of patched.keys()) next.add(id)
        return next
      })
      setTimeout(() => {
        setSkvRows((prev) =>
          prev.map((r) =>
            patched.has(r.id) ? { ...r, journal_entry_id: patched.get(r.id)! } : r,
          ),
        )
        setExitingIds((prev) => {
          const next = new Set(prev)
          for (const id of patched.keys()) next.delete(id)
          return next
        })
      }, 350)
    }
    setSkvSelectedIds(new Set())

    const succeeded = results.filter((r) => r.ok).length
    const failures = results.filter((r) => !r.ok)
    if (failures.length === 0) {
      toast({
        title: t('skv_bulk_done_title'),
        description: t('skv_bulk_done_description', { count: succeeded }),
      })
    } else {
      const codeCounts = new Map<string, number>()
      for (const f of failures) {
        const code = f.error_code ?? 'UNKNOWN'
        codeCounts.set(code, (codeCounts.get(code) ?? 0) + 1)
      }
      const codeLabel = (code: string) =>
        code === 'PERIOD_LOCKED'
          ? t('skv_err_period_locked')
          : code === 'NO_COUNTER_ACCOUNT'
            ? t('skv_err_no_counter_account')
            : code === 'ALREADY_BOOKED'
              ? t('skv_err_already_booked')
              : code === 'NOT_SETTLED'
                ? t('skv_err_not_settled')
                : code === 'COMMIT_FAILED'
                  ? t('skv_err_commit_failed')
                  : t('skv_err_other')
      const parts = [t('skv_bulk_partial_ok', { count: succeeded })]
      for (const [code, n] of codeCounts) parts.push(`${n} ${codeLabel(code)}`)
      toast({
        title: t('skv_bulk_partial_title'),
        description: parts.join(', '),
        variant: 'destructive',
      })
    }
  }

  function handleSkvMatched() {
    // After a successful match, drop the row from the inbox: it's now
    // linked to a verifikat. Trigger an exit animation first.
    if (skvMatchTarget) {
      const id = skvMatchTarget.id
      setExitingIds(prev => new Set(prev).add(id))
      setTimeout(() => {
        setSkvRows(prev => prev.filter(r => r.id !== id))
        setExitingIds(prev => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
      }, 350)
    }
  }

  function handleTransactionBooked(
    transactionId: string,
    journalEntryId: string,
    attachedDocumentId?: string | null,
    // True when the duplicate guard's match action LINKED the transaction to
    // an existing voucher instead of creating a new one.
    matched?: boolean,
  ) {
    setExitingIds((prev) => new Set(prev).add(transactionId))
    // The row leaves the unbooked inbox either way (booked, or linked to an
    // existing voucher), so the header count has to follow: every other path
    // that removes a row decrements, this one did not.
    setTotalUncategorizedCount((prev) => Math.max(0, (prev ?? 1) - 1))
    setTimeout(() => {
      setTransactions((prev) =>
        prev.map((t) =>
          t.id === transactionId
            ? {
                ...t,
                is_business: true,
                journal_entry_id: journalEntryId,
                // Existing pin wins: the link route only pins when the tx
                // had none (document_id IS NULL guard).
                document_id: t.document_id ?? attachedDocumentId ?? null,
              }
            : t
        )
      )
      setExitingIds((prev) => {
        const next = new Set(prev)
        next.delete(transactionId)
        return next
      })
    }, 350)
    setBookingDialogOpen(false)
    setBookingDialogTransaction(null)
    setBookingDialogTemplate(null)
    setBookingDialogProposalLines(null)
    if (matched) {
      toast({ title: 'Bankhändelsen kopplad', description: 'Ingen ny bokföring skapad.' })
    } else {
      toast({ title: 'Bokförd' })
    }
  }

  function openAttachDocumentDialog(transaction: TransactionWithInvoice) {
    setAttachDocTx(transaction)
  }

  function handleDocumentAttached(transactionId: string, documentId: string) {
    setTransactions((prev) =>
      prev.map((t) => (t.id === transactionId ? { ...t, document_id: documentId } : t))
    )
    // Booked row: the attach route propagated the doc onto the verifikation,
    // so flip the JE status optimistically too. Read the JE id off the
    // dialog's own subject (attachDocTx), not the transactions snapshot:
    // the list may have changed (load-more, booking) while the dialog was
    // open, and a stale find() would silently skip the badge flip.
    const jeId =
      attachDocTx?.id === transactionId ? attachDocTx.journal_entry_id : null
    if (jeId) {
      setJeUnderlagStatus((prev) => ({ ...prev, [jeId]: 'has' }))
    }
  }

  // Batch mode handlers

  // Bounded pool for the per-row batch requests: parallel enough that a
  // 20-row batch finishes in a few round trips instead of 20 serialized ones,
  // bounded so 100 selected rows never fan out as 100 concurrent requests.
  // The bulkbar counter ticks per completed row.
  const BATCH_CONCURRENCY = 5

  function toggleBatchSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function exitBatchMode() {
    setSelectedIds(new Set())
    setSkvSelectedIds(new Set())
  }

  async function handleBatchDelete() {
    // Only user-created rows can be deleted; imported (bank sync / CSV) rows are
    // ignore-only. Split the selection so we never fire a delete the server
    // would 409, and tell the user how many were skipped. Mirrors the server
    // guard in DELETE /api/transactions/[id].
    const selected = Array.from(selectedIds)
    const ids: string[] = []
    let skippedImported = 0
    for (const id of selected) {
      const tx = transactions.find((t) => t.id === id)
      if (tx && isImportedTransaction(tx)) skippedImported++
      else ids.push(id)
    }

    if (ids.length === 0) {
      toast({
        title: 'Inget att ta bort',
        description: 'De valda transaktionerna är importerade och kan endast ignoreras, inte raderas.',
        variant: 'destructive',
      })
      return
    }

    const ok = await confirm({
      title: `Ta bort ${ids.length} transaktioner?`,
      description:
        skippedImported > 0
          ? `${skippedImported} importerade transaktioner hoppas över (kan endast ignoreras). Åtgärden kan inte ångras.`
          : 'Åtgärden kan inte ångras.',
      confirmLabel: 'Ta bort',
      variant: 'destructive',
    })
    if (!ok) return

    const deletedIds = new Set<string>()
    setBatchProgress({ done: 0, total: ids.length })
    let completed = 0
    const results = await mapWithConcurrency(ids, BATCH_CONCURRENCY, async (id) => {
      let deleted = false
      try {
        const response = await fetch(`/api/transactions/${id}`, { method: 'DELETE' })
        deleted = response.ok
      } catch {
        deleted = false
      }
      completed++
      setBatchProgress({ done: completed, total: ids.length })
      return deleted
    })
    let successes = 0
    const failures: string[] = []
    ids.forEach((id, i) => {
      if (results[i]) {
        successes++
        deletedIds.add(id)
      } else {
        const tx = transactions.find((t) => t.id === id)
        failures.push(tx?.description || id)
      }
    })
    if (deletedIds.size > 0) {
      setTransactions((prev) => prev.filter((t) => !deletedIds.has(t.id)))
    }
    setBatchProgress(null)
    if (failures.length === 0 && skippedImported === 0) {
      toast({ title: 'Klart', description: `${successes} transaktioner borttagna` })
    } else {
      const parts = [`${successes} borttagna`]
      if (failures.length > 0) parts.push(`${failures.length} misslyckades`)
      if (skippedImported > 0) parts.push(`${skippedImported} importerade kunde inte raderas`)
      toast({
        title: 'Delvis klart',
        description: parts.join(', '),
        variant: 'destructive',
      })
    }
    exitBatchMode()
  }

  async function handleBatchIgnore() {
    const ids = Array.from(selectedIds)
    const ok = await confirm({
      title: `Ignorera ${ids.length} transaktioner?`,
      description: 'Transaktionerna försvinner från listan utan att bokföras. Du kan återställa dem under Bankavstämning.',
      confirmLabel: 'Ignorera',
      cancelLabel: 'Avbryt',
      variant: 'warning',
    })
    if (!ok) return

    const ignoredIds = new Set<string>()
    setBatchProgress({ done: 0, total: ids.length })
    let completed = 0
    const results = await mapWithConcurrency(ids, BATCH_CONCURRENCY, async (id) => {
      let ignored = false
      try {
        const res = await fetch(`/api/transactions/${id}/ignore`, { method: 'POST' })
        ignored = res.ok
      } catch {
        ignored = false
      }
      completed++
      setBatchProgress({ done: completed, total: ids.length })
      return ignored
    })
    let successes = 0
    const failures: string[] = []
    ids.forEach((id, i) => {
      if (results[i]) {
        successes++
        ignoredIds.add(id)
      } else {
        const tx = transactions.find((t) => t.id === id)
        failures.push(tx?.description || id)
      }
    })
    if (ignoredIds.size > 0) {
      setExitingIds((prev) => {
        const next = new Set(prev)
        for (const id of ignoredIds) next.add(id)
        return next
      })
      setTotalUncategorizedCount((prev) => Math.max(0, (prev ?? ignoredIds.size) - ignoredIds.size))
      setTimeout(() => {
        setTransactions((prev) =>
          prev.map((t) => (ignoredIds.has(t.id) ? { ...t, is_ignored: true } : t))
        )
        setExitingIds((prev) => {
          const next = new Set(prev)
          for (const id of ignoredIds) next.delete(id)
          return next
        })
      }, 350)
    }
    setBatchProgress(null)
    if (failures.length === 0) {
      toast({
        title: 'Klart',
        description: `${successes} transaktioner ignorerade`,
        action: (
          <ToastAction altText="Öppna Bankavstämning" asChild>
            <Link href="/reconciliation">Avstämning</Link>
          </ToastAction>
        ),
      })
    } else {
      toast({
        title: 'Delvis klart',
        description: `${successes} ignorerade, ${failures.length} misslyckades`,
        variant: 'destructive',
      })
    }
    exitBatchMode()
  }

  async function handleBatchCategorize(category: TransactionCategory, vatTreatment?: VatTreatment) {
    const ids = Array.from(selectedIds)
    setBatchProgress({ done: 0, total: ids.length })
    let completed = 0
    const results = await mapWithConcurrency(ids, BATCH_CONCURRENCY, async (id) => {
      // silent: rows still animate out and decrement the count through
      // finishBooking, but the narration is the single aggregate toast below
      // instead of one "Bokförd" toast per row stacking over the list.
      const outcome = await runCategorize({
        id,
        isBusiness: true,
        category,
        vatTreatment,
        confirmNoMatch: false,
        silent: true,
      })
      completed++
      setBatchProgress({ done: completed, total: ids.length })
      return outcome
    })
    setBatchProgress(null)
    setShowBatchSelector(false)
    // Success is the server's 2xx (outcome.ok), not a non-null journal entry
    // id: a flag-flip booking returns 200 with a null id and must not be
    // narrated as "misslyckades" after finishBooking already animated it out.
    const successCount = results.filter((r) => r.ok).length
    const failedCount = ids.length - successCount
    // One Ångra-alla for the whole batch: it runs the same storno endpoint as
    // the per-row toast's Ångra, which requires a posted journal entry, so
    // only rows that actually got one are undoable. A successful flag-flip
    // row (ok, null id) has no verifikat to reverse.
    const undoableIds = ids.filter((_, i) => results[i].ok && results[i].journalEntryId)
    const undoAllAction =
      undoableIds.length > 0 ? (
        <ToastAction
          altText={t('batch_undo_all_alt')}
          onClick={() => void undoBatchCategorize(undoableIds)}
        >
          {t('batch_undo_all')}
        </ToastAction>
      ) : undefined
    if (failedCount === 0) {
      toast({
        title: t('batch_done_title'),
        description: t('batch_categorize_done_description', { count: successCount }),
        action: undoAllAction,
      })
    } else {
      toast({
        title: t('batch_partial_title'),
        description: t('batch_categorize_partial_description', {
          success: successCount,
          failed: failedCount,
        }),
        variant: 'destructive',
        action: undoAllAction,
      })
    }
    exitBatchMode()
  }

  /**
   * Ångra alla for a batch booking: storno-reverses every booked row through
   * the same single undo endpoint as the per-row Ångra (undoCategorize), with
   * the same bounded pool, then restores the rows into the inbox in one state
   * patch and reports the outcome once.
   */
  async function undoBatchCategorize(ids: string[]) {
    const results = await mapWithConcurrency(ids, BATCH_CONCURRENCY, async (id) => {
      try {
        const res = await undoCategorize(id)
        return res.ok
      } catch {
        return false
      }
    })
    const undoneIds = new Set(ids.filter((_, i) => results[i]))
    // Record the undos BEFORE patching state: any finishBooking timer still
    // pending for these rows must see them as undone, or it would re-apply
    // the booked shape over the restore below.
    for (const undoneId of undoneIds) undoneIdsRef.current.add(undoneId)
    if (undoneIds.size > 0) {
      setTransactions((prev) =>
        prev.map((tx) =>
          undoneIds.has(tx.id)
            ? {
                ...tx,
                is_business: null,
                category: null as unknown as TransactionCategory,
                journal_entry_id: null,
              }
            : tx,
        ),
      )
      setTotalUncategorizedCount((prev) => (prev ?? 0) + undoneIds.size)
    }
    const failed = ids.length - undoneIds.size
    if (failed === 0) {
      toast({
        title: t('undone_title'),
        description: t('batch_undo_done_description', { count: undoneIds.size }),
      })
    } else {
      toast({
        title: t('batch_undo_partial_title'),
        description: t('batch_undo_partial_description', { success: undoneIds.size, failed }),
        variant: 'destructive',
      })
    }
  }

  function openMatchDialog(transaction: TransactionWithInvoice) {
    setSelectedTransaction(transaction)
    setMatchDialogOpen(true)
  }

  function openCategoryDialog(transaction: TransactionWithInvoice) {
    setTemplatePickerTransaction(transaction)
    setTemplatePickerOpen(true)
  }

  function handleTemplateSelected(template: BookingTemplate) {
    setTemplatePickerOpen(false)
    const tx = templatePickerTransaction
    if (!tx) return
    // Library templates aren't validated server-side via template_id; the
    // template's debit/credit + VAT drive the booking through account_override.
    const templateId = isLibraryTemplateId(template.id) ? undefined : template.id
    setQuickReview({ transaction: tx, category: template.fallback_category, label: template.name_sv, template, templateId, linePattern: null })
    setQuickReviewOpen(true)
  }

  function handleOpenTemplateReview(transaction: TransactionWithInvoice, templateId: string) {
    if (isCounterpartyTemplateId(templateId)) {
      const cpSuggestion = templateSuggestions[transaction.id]?.find(ts => ts.template_id === templateId)
      if (!cpSuggestion) {
        // The suggestion list went stale under the open modal (refetch, or the
        // template was deleted in another tab). Say so instead of swallowing
        // the click.
        toast({
          title: t('counterparty_suggestion_gone_title'),
          description: t('counterparty_suggestion_gone_description'),
          variant: 'destructive',
        })
        return
      }
      setQuickReview({
        transaction,
        category: transaction.amount < 0 ? 'expense_other' : 'income_services',
        label: cpSuggestion.name_sv,
        // Carry the learned accounts and VAT: they are what the server books
        // (buildMappingResultFromCounterpartyTemplate) and what the dialog
        // previews. A counterparty template has no catalog entry, so the rest
        // of BookingTemplate genuinely does not exist here.
        template: {
          id: templateId,
          name_sv: cpSuggestion.name_sv,
          debit_account: cpSuggestion.debit_account,
          credit_account: cpSuggestion.credit_account,
          vat_treatment: cpSuggestion.vat_treatment ?? null,
        },
        templateId: undefined,
        linePattern: cpSuggestion.line_pattern ?? null,
        defaultDimensions: cpSuggestion.default_dimensions ?? null,
      })
      setQuickReviewOpen(true)
      return
    }

    const template = getTemplateById(templateId)
    if (!template) return
    setQuickReview({
      transaction,
      category: template.fallback_category,
      label: template.name_sv,
      template,
      templateId: template.id,
      linePattern: null,
    })
    setQuickReviewOpen(true)
  }

  function handleChangeTemplate() {
    setQuickReviewOpen(false)
    if (quickReview?.transaction) {
      setTemplatePickerTransaction(quickReview.transaction)
      setTemplatePickerOpen(true)
    }
  }

  function handleManualBooking() {
    setTemplatePickerOpen(false)
    if (templatePickerTransaction) {
      setBookingDialogTransaction(templatePickerTransaction)
      setBookingDialogTemplate(null)
      setBookingDialogProposalLines(null)
      setBookingDialogAccount(null)
      setBookingDialogOpen(true)
    }
  }

  // "Andra rader" on the proposal view: close the review and reopen the
  // manual booking dialog prefilled with the exact lines the preview showed.
  // The transaction comes from the dialog itself (its enriched mirror), not
  // from quickReview state: an in-dialog SEK-rate backfill lives only on the
  // enriched row, and the booking dialog stamps the settlement leg's FX
  // metadata from that row's exchange_rate.
  function handleEditProposedLines(lines: ProposalLine[], transaction: TransactionWithInvoice) {
    setQuickReviewOpen(false)
    setBookingDialogTransaction(transaction)
    setBookingDialogTemplate(null)
    setBookingDialogAccount(null)
    setBookingDialogProposalLines(lines)
    setBookingDialogOpen(true)
  }

  // Account picked from the template picker's "Konton" search group
  // (issue #1877): same route as "Bokför manuellt", with the picked account
  // prefilled on the counter line of the journal entry form.
  function handlePickAccount(accountNumber: string) {
    if (!templatePickerTransaction) return
    setBookingDialogTransaction(templatePickerTransaction)
    setBookingDialogTemplate(null)
    setBookingDialogProposalLines(null)
    setBookingDialogAccount(accountNumber)
    setTemplatePickerOpen(false)
    setBookingDialogOpen(true)
  }

  // Complex (multi-leg or otherwise non-convertible) library template picked
  // from the transaction modal: route into the manual booking dialog with
  // the template pre-applied against the transaction's amount.
  function handlePickLibraryTemplate(raw: BookingTemplateLibrary) {
    if (!templatePickerTransaction) return
    setBookingDialogTransaction(templatePickerTransaction)
    setBookingDialogTemplate(raw)
    setBookingDialogProposalLines(null)
    setBookingDialogAccount(null)
    setTemplatePickerOpen(false)
    setBookingDialogOpen(true)
  }

  async function handleQuickReviewConfirm(
    id: string,
    category: TransactionCategory,
    vatTreatment: VatTreatment | undefined,
    accountOverride: string | undefined,
    templateId?: string,
    dimensions?: Record<string, string>
  ): Promise<string | null> {
    let journalEntryId: string | null
    if (!templateId && quickReview?.template?.id && isCounterpartyTemplateId(quickReview.template.id)) {
      const cpTemplateId = extractCounterpartyId(quickReview.template.id)
      const cpCategorize = async (
        // Set after the user confirmed the duplicate warning: force is bound
        // to the reviewed candidate's voucher, same contract as runCategorize.
        forceOpts?: { expectedDuplicateJournalEntryId: string },
      ): Promise<{ ok: boolean; journalEntryId: string | null; result: { error?: { code?: string; account_numbers?: string[]; details?: { account_numbers?: string[]; candidate?: BookedDuplicateCandidate } }; journal_entry_id?: string | null; journal_entry_created?: boolean; journal_entry_error?: string | null; category?: TransactionCategory }; status: number }> => {
        const r = await fetch(`/api/transactions/${id}/categorize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            is_business: true,
            counterparty_template_id: cpTemplateId,
            ...(dimensions && Object.keys(dimensions).length > 0 ? { dimensions } : {}),
            ...(forceOpts
              ? { force: true, expected_duplicate_journal_entry_id: forceOpts.expectedDuplicateJournalEntryId }
              : {}),
          }),
        })
        const b = await r.json()
        return { ok: r.ok, status: r.status, result: b, journalEntryId: b?.journal_entry_id || null }
      }
      const { ok: cpOk, status: cpStatus, result, journalEntryId: cpJeId } = await cpCategorize()
      if (!cpOk) {
        if (result?.error?.code === 'ACCOUNTS_NOT_IN_CHART') {
          const accountNumbers: string[] =
            (Array.isArray(result.error.account_numbers) && result.error.account_numbers) ||
            (Array.isArray(result.error.details?.account_numbers) && result.error.details?.account_numbers) ||
            []
          // Synchronous in-flight flag per toast closure: see same pattern
          // in runCategorize. Double-click on the counterparty-template
          // retry would race the second cpCategorize against the first's
          // verifikation insert.
          let activateInFlight = false
          toast({
            title: 'Kontot finns inte i din kontoplan',
            description: `Motpartsmallen kräver att följande konton aktiveras: ${accountNumbers.join(', ')}.`,
            variant: 'destructive',
            action: accountNumbers.length > 0 ? (
              <ToastAction altText="Aktivera och bokför" onClick={async () => {
                if (activateInFlight) return
                activateInFlight = true
                try {
                  const activateRes = await fetch('/api/bookkeeping/accounts/activate', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ account_numbers: accountNumbers }),
                  })
                  if (!activateRes.ok) {
                    const errBody = await activateRes.json().catch(() => null)
                    toast({ title: 'Kunde inte aktivera konton', description: getErrorMessage(errBody, { statusCode: activateRes.status }), variant: 'destructive' })
                    return
                  }
                  const activateBody = await activateRes.json()
                  if (Array.isArray(activateBody.unknown) && activateBody.unknown.length > 0) {
                    toast({ title: 'Kunde inte hitta alla konton', description: `Lägg till ${activateBody.unknown.join(', ')} manuellt under Inställningar → Kontoplan.`, variant: 'destructive' })
                    return
                  }
                  const retry = await cpCategorize()
                  // Gate on retry.ok alone: a 200 with null journal_entry_id
                  // is allowed by the declared type (e.g. already-categorized
                  // flag flip), and showing "Kategorisering misslyckades"
                  // after the server returned success is misleading. The state
                  // update conditionally writes the journal_entry_id when it's
                  // actually present.
                  if (retry.ok) {
                    finishBooking({
                      id,
                      isBusiness: true,
                      category: retry.result?.category,
                      journalEntryId: retry.journalEntryId,
                      journalEntryCreated: retry.result?.journal_entry_created,
                      journalEntryError: retry.result?.journal_entry_error,
                    })
                  } else {
                    toast({ title: 'Kategorisering misslyckades', description: getErrorMessage(retry.result, { context: 'transaction', statusCode: retry.status }), variant: 'destructive' })
                  }
                } finally {
                  activateInFlight = false
                }
              }}>
                Aktivera och bokför
              </ToastAction>
            ) : undefined,
          })
        } else if (
          result?.error?.code === 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE' &&
          result.error.details?.candidate
        ) {
          // Booking-feedback parity with runCategorize: route the duplicate
          // guard into the dialog (match / ignore / book anyway) instead of
          // dead-ending it in a destructive toast that offers no way forward.
          const candidate = result.error.details.candidate
          setDuplicateWarning({
            transactionId: id,
            retry: async () => {
              const retry = await cpCategorize({
                expectedDuplicateJournalEntryId: candidate.journal_entry_id,
              })
              if (retry.ok) {
                finishBooking({
                  id,
                  isBusiness: true,
                  category: retry.result?.category,
                  journalEntryId: retry.journalEntryId,
                  journalEntryCreated: retry.result?.journal_entry_created,
                  journalEntryError: retry.result?.journal_entry_error,
                })
                return retry.journalEntryId
              }
              toast({ title: 'Kategorisering misslyckades', description: getErrorMessage(retry.result, { context: 'transaction', statusCode: retry.status }), variant: 'destructive' })
              return null
            },
            candidate,
          })
        } else {
          toast({ title: 'Kategorisering misslyckades', description: getErrorMessage(result, { context: 'transaction', statusCode: cpStatus }), variant: 'destructive' })
        }
        // Close the review dialog on hard errors: the toast (with action if
        // ACCOUNTS_NOT_IN_CHART) carries the message and the recovery path.
        // The duplicate branch closes it too: the duplicate dialog takes over.
        setQuickReviewOpen(false)
        setQuickReview(null)
        return null
      }
      finishBooking({
        id,
        isBusiness: true,
        category: result?.category,
        journalEntryId: cpJeId,
        journalEntryCreated: result?.journal_entry_created,
        journalEntryError: result?.journal_entry_error,
      })
      journalEntryId = cpJeId
    } else {
      journalEntryId = await handleCategorize(id, true, category, vatTreatment, accountOverride, templateId, undefined, dimensions)
    }
    // Always close: whether the server created a verifikation, returned a
    // structured 4xx (ACCOUNTS_NOT_IN_CHART, INVALID_MAPPING, …), or hit a
    // partial-success path. The toast from runCategorize already communicates
    // the outcome; keeping the dialog open serves no purpose.
    setQuickReviewOpen(false)
    setQuickReview(null)
    return journalEntryId
  }

  // Library and counterparty templates (no templateId) seed the review form
  // from their own accounts; everything else falls back to the category
  // defaults. Never undefined: see resolveQuickReviewDefaults.
  const quickReviewDefaults = resolveQuickReviewDefaults(
    quickReview?.template,
    quickReview?.templateId,
    quickReview?.category,
  )

  return (
    <div className="space-y-8">
      {/* Page header (concept scene 10): title + Importera split button */}
      <TransactionStatusBar onOpenCreateDialog={() => setIsDialogOpen(true)} />


      {skvNeedsReconnect && effectiveSourceFilter === 'skatteverket' ? (
        // Only when the user is actually looking at skattekonto rows: as a
        // permanent page-wide line it read as noise (feedback 2026-08-14).
        // The skattekonto page keeps its own reconnect line.
        <AttnLine action={{ label: t('skv_reconnect_cta'), href: '/settings/tax' }}>
          {t('skv_reconnect_body')}
        </AttnLine>
      ) : suggestionItems.length > 0 && mode !== 'review' ? (
        // Migrated-history review nudge. Max one attn line per page
        // (convention 6): the SKV reconnect line wins when both apply.
        <AttnLine
          action={{ label: t('review_attn_cta'), onClick: () => setMode('review') }}
        >
          {t('review_attn_body', { count: suggestionItems.length })}
        </AttnLine>
      ) : null}

      {/* Toolbar (concept order): [Att bokföra/Alla-seg] [sök] [Välj flera]
          ... [source ContextPicker far right] */}
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          value={mode}
          onChange={setMode}
          options={[
            { value: 'inbox', label: t('mode_inbox'), count: inboxBadgeCount },
            { value: 'history', label: t('mode_all') },
            // Review tab exists only while suggestions do (or while the user is
            // standing in it after emptying the list): a permanent third tab
            // would advertise a migrator surface most companies never need.
            ...(suggestionItems.length > 0 || mode === 'review'
              ? [{ value: 'review' as const, label: t('mode_review'), count: suggestionItems.length }]
              : []),
          ]}
        />
        <ToolbarSearch
          placeholder="Sök transaktioner…"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
        {/* Far-right context group, shared by both view modes: period scope
            (rakenskapsar chip) and the account chooser (concept scene 10).
            Approved deviation from convention 8's single chip: booking is
            period work, so the period scope earns the second chip (user
            request 2026-08-12). The Q1-Q4 chips that briefly rendered here
            (#1545) were removed: they crowded the row into a second line,
            and on a brutet rakenskapsar they were not momsdeklaration
            quarters, so they misled more than they scoped. */}
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {/* Quiet cue that a scope change is reconciling behind the rendered
              list (the list itself never swaps to a skeleton for it). */}
          {isScopeRefreshing && (
            <Loader2
              className="h-3.5 w-3.5 animate-spin text-muted-foreground"
              aria-label={t('refreshing')}
            />
          )}
          <FyPicker
            value={fyPeriodId}
            onChange={handlePeriodChange}
            onReady={handleFyReady}
            storageKeyPrefix={PERIOD_FILTER_STORAGE_PREFIX}
          />
          {sourceItems.length > 1 && (
            <ContextPicker
              value={effectiveSourceFilter}
              onChange={(id) => handleSourceFilterChange(id as SourceFilter)}
              triggerLabel={(() => {
                const active =
                  sourceItems.find((item) => item.id === effectiveSourceFilter) ?? sourceItems[0]
                return active.annotation ? `${active.label} · ${active.annotation}` : active.label
              })()}
              items={sourceItems}
            />
          )}
        </div>
      </div>

      {/* Content based on mode */}
      {isLoading ? (
        <DataList className="stagger-enter">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3">
              <Skeleton className="h-5 w-5" />
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-48" />
                <Skeleton className="h-3 w-24" />
              </div>
              <Skeleton className="h-5 w-20" />
            </div>
          ))}
        </DataList>
      ) : mode === 'review' ? (
        <SuggestionReviewList
          items={suggestionItems}
          onConfirm={confirmSuggestions}
          onReject={rejectSuggestions}
          onOpenMatchVoucher={openMatchVoucherDialog}
          onRerunMatching={rerunMatching}
          rerunning={rerunningMatch}
        />
      ) : mode === 'inbox' ? (
        inboxItems.length === 0 ? (
          searchTerm || effectiveSourceFilter !== 'all' || periodBounds ? (
            <DataListEmpty
              title="Inga träffar"
              description={
                searchTerm
                  ? t('no_search_results')
                  : effectiveSourceFilter !== 'all'
                    ? t('source_empty')
                    : t('period_empty')
              }
            />
          ) : (
            <InboxZeroState
              hasTransactions={transactions.length > 0 || skvRows.length > 0}
              onCreateTransaction={() => setIsDialogOpen(true)}
            />
          )
        ) : (
          <div>
            {/* Bulkbar (concept): hidden until at least one transaction is
                selected via the hover checkboxes, then it pops in with the
                count and the batch actions. */}
            {(selectedIds.size > 0 || skvSelectedIds.size > 0) && (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-border px-1 py-2.5 text-[12.5px] animate-fade-in">
                {batchProgress ? (
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    {t('batch_progress', { done: batchProgress.done, total: batchProgress.total })}
                  </span>
                ) : (
                  <>
                    <span className="whitespace-nowrap">
                      <strong className="font-semibold tabular-nums">
                        {selectedIds.size + skvSelectedIds.size}
                      </strong>{' '}
                      {t('bulkbar_selected', { count: selectedIds.size + skvSelectedIds.size })}
                    </span>
                    {selectedIds.size > 0 && (
                      <>
                        <Button size="sm" onClick={() => setShowBatchSelector(true)}>
                          {t('batch_book')}
                        </Button>
                        {/* Bulk-book (samlingsverifikation): only when ≥2 selected
                            on the same date + same direction. Disabled state
                            explains why via title. */}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setBulkBookOpen(true)}
                          disabled={!bulkBookEligible}
                          title={!bulkBookEligible ? t('batch_bulk_book_hint') : undefined}
                        >
                          {t('batch_bulk_book')}
                        </Button>
                        <button type="button" className={QUIET_LINK_CLASS} onClick={handleBatchIgnore}>
                          {t('batch_ignore')}
                        </button>
                        <button
                          type="button"
                          className={cn(QUIET_LINK_CLASS, 'hover:text-destructive')}
                          onClick={handleBatchDelete}
                        >
                          {t('batch_delete')}
                        </button>
                      </>
                    )}
                    {/* SKV rows book through the skatteverket extension: one
                        summary confirmation, then draft+commit per row. */}
                    {skvSelectedIds.size > 0 && (
                      <Button size="sm" onClick={() => setSkvBulkConfirmOpen(true)}>
                        {t('batch_skv_book', { count: skvSelectedIds.size })}
                      </Button>
                    )}
                    {(selectedIds.size < selectableInboxIds.length ||
                      skvSelectedIds.size < selectableSkvIds.length) && (
                      <button
                        type="button"
                        className={QUIET_LINK_CLASS}
                        onClick={() => {
                          setSelectedIds(new Set(selectableInboxIds))
                          setSkvSelectedIds(new Set(selectableSkvIds))
                        }}
                      >
                        {t('batch_select_all', {
                          count: selectableInboxIds.length + selectableSkvIds.length,
                        })}
                      </button>
                    )}
                    <button type="button" className={QUIET_LINK_CLASS} onClick={exitBatchMode}>
                      {t('batch_clear')}
                    </button>
                  </>
                )}
              </div>
            )}

            {/* Negative margin + matching padding: lets the hover-revealed
                checkbox/chevron hang into the page margins without being
                clipped by the overflow container, while the columns stay
                flush with the page edges. */}
            <div className="-mx-5 overflow-x-auto px-5 md:-mx-8 md:px-8">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={cn(TH_CLASS, 'w-0 !p-0')} aria-hidden="true"></th>
                    <th className={cn(TH_CLASS, '!pl-0')}>{t('th_date')}</th>
                    <th className={cn(TH_CLASS, 'w-full')}>{t('th_description')}</th>
                    <th className={cn(TH_CLASS, 'text-right')}>{t('th_amount')}</th>
                    <th className={cn(TH_CLASS, 'text-right !pr-0')}>{t('th_status')}</th>
                  </tr>
                </thead>
                <tbody className="stagger-enter">
                  {inboxItems.map(item =>
                    item.source === 'bank' ? (
                      <TransactionInboxCard
                        key={`bank-${item.data.id}`}
                        transaction={item.data}
                        skvCounterpartDate={bankToSkvHints.get(item.data.id)}
                        isExiting={exitingIds.has(item.data.id)}
                        processingId={processingId}
                        isSelected={selectedIds.has(item.data.id)}
                        isExpanded={expandedTxId === item.data.id}
                        onToggleExpand={(id) =>
                          setExpandedTxId((prev) => (prev === id ? null : id))
                        }
                        entityType={entityType}
                        onCategorize={handleCategorize}
                        onOpenMatchDialog={openMatchDialog}
                        onOpenMatchInvoicePicker={openInvoiceMatchPicker}
                        onOpenSplitMatch={openSplitMatchDialog}
                        onOpenMatchVoucher={openMatchVoucherDialog}
                        onOpenAttachDocument={openAttachDocumentDialog}
                        onOpenCategoryDialog={openCategoryDialog}
                        onDelete={handleDeleteTransaction}
                        onIgnore={handleIgnoreTransaction}
                        onEditTitle={openEditTitleDialog}
                        onMoveCashAccount={openMoveAccountDialog}
                        cashAccounts={cashAccounts}
                        onToggleSelect={toggleBatchSelect}
                        preMigrationCutoff={sieCoverageEnd}
                      />
                    ) : (
                      <SkattekontoInboxCard
                        key={`skv-${item.data.id}`}
                        row={item.data}
                        matchSuggestion={item.data.match_suggestion}
                        bookingSuggestion={item.data.booking_suggestion}
                        isExiting={exitingIds.has(item.data.id)}
                        processing={skvBulkSubmitting}
                        selectable={isSkvBulkEligible(item.data)}
                        isSelected={skvSelectedIds.has(item.data.id)}
                        onToggleSelect={toggleSkvSelect}
                        onBokfor={handleSkvBokfor}
                        onMatch={r => setSkvMatchTarget(r)}
                        onIgnore={handleSkvIgnore}
                      />
                    ),
                  )}
                </tbody>
              </table>
            </div>
            {/* Bridge to the bulk-match flow: a backlog of unbooked bank rows
                is usually a migration/import whose counterpart vouchers
                already exist, and the only match affordance here is per-row.
                Static text + count (no probe): the reconciliation preview is
                the honest source of how many actually match. Sits below the
                list so the rows themselves stay first, and yields to the
                review-suggestions attn at the top of the page (max one ochre
                sentence per page): when the sweep has already persisted
                suggestions, "Granska förslagen" is the more precise
                destination for the same backlog. */}
            {selectableInboxIds.length >= 5 && suggestionItems.length === 0 && (
              <AttnLine
                className="px-1 pt-3"
                action={{
                  label: t('recon_attn_action'),
                  href: '/reconciliation?autorun=1',
                }}
              >
                {t('recon_attn', { count: selectableInboxIds.length })}
              </AttnLine>
            )}
          </div>
        )
      ) : (
        <TransactionHistoryList
          transactions={historyTransactions}
          skvRows={skvRowsInScope}
          exitingIds={exitingIds}
          searchTerm={searchTerm}
          sourceFilter={effectiveSourceFilter}
          jeUnderlagStatus={jeUnderlagStatus}
          onOpenMatchDialog={openMatchDialog}
          onOpenCategoryDialog={openCategoryDialog}
          onOpenAttachDocument={openAttachDocumentDialog}
          onOpenMatchVoucher={openMatchVoucherDialog}
          onDelete={handleDeleteTransaction}
          onSkvBokfor={handleSkvBokfor}
          onSkvMatch={r => setSkvMatchTarget(r)}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          onLoadMore={loadMoreTransactions}
        />
      )}

      {/* Footer status line (concept): honest counter from the visible
          rows + bank sync status/actions + the Bankavstämning path (the
          ignore flows point users there). */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1 text-xs text-muted-foreground">
        {mode === 'inbox' && (
          <span className="tabular-nums">{t('footer_to_handle', { count: inboxItems.length })}</span>
        )}
        {mode === 'inbox' && pendingOutsideCount > 0 && (
          <span className="tabular-nums">
            {t('period_pending_outside', { count: pendingOutsideCount })}{' '}
            <button type="button" className={QUIET_LINK_CLASS} onClick={clearPeriodFilter}>
              {t('period_show_all')}
            </button>
          </span>
        )}
        <BankSyncStatusChip />
        <BankSyncNowButton />
        <BankSyncSinceLastVisit />
        <Link
          href="/reconciliation"
          className="ml-auto transition-colors duration-150 hover:text-foreground"
        >
          Bankavstämning →
        </Link>
      </div>

      {/* Dialogs */}
      {showBatchSelector && (
        <BatchCategorySelector
          open
          onOpenChange={setShowBatchSelector}
          selectedCount={selectedIds.size}
          onSelectCategory={handleBatchCategorize}
          progress={batchProgress}
        />
      )}

      {matchDialogOpen && (
        <InvoiceMatchDialog
          open
          onOpenChange={setMatchDialogOpen}
          transaction={selectedTransaction}
          isConfirming={isConfirmingMatch}
          onConfirm={handleConfirmInvoiceMatch}
          onLinkToExisting={handleLinkToExistingVoucher}
        />
      )}

      {matchVoucherTx && (
        <MatchVoucherDialog
          open
          onOpenChange={(o) => { if (!o) setMatchVoucherTx(null) }}
          transaction={matchVoucherTx}
          onLinked={handleVoucherLinked}
        />
      )}

      {splitMatchOpen && (
        <MatchAllocationDialog
          open
          onOpenChange={(o) => {
            setSplitMatchOpen(o)
            if (!o) setSplitMatchTransaction(null)
          }}
          transaction={splitMatchTransaction}
          onSuccess={handleSplitMatchSuccess}
        />
      )}

      {bulkBookOpen && (
        <BulkBookDialog
          open
          onOpenChange={setBulkBookOpen}
          transactions={selectedTransactions}
          onSuccess={handleBulkBookSuccess}
        />
      )}

      {bookingDialogOpen && (
        <TransactionBookingDialog
          open
          onOpenChange={(o) => {
            setBookingDialogOpen(o)
            if (!o) {
              setBookingDialogTemplate(null)
              setBookingDialogProposalLines(null)
              setBookingDialogAccount(null)
            }
          }}
          transaction={bookingDialogTransaction}
          preselectedTemplate={bookingDialogTemplate}
          proposalLines={bookingDialogProposalLines}
          preselectedAccount={bookingDialogAccount}
          onBooked={handleTransactionBooked}
        />
      )}

      {attachDocTx && (
        <TransactionAttachDocumentDialog
          open
          onOpenChange={(o) => {
            if (!o) setAttachDocTx(null)
          }}
          transaction={attachDocTx}
          onAttached={handleDocumentAttached}
        />
      )}

      {templatePickerOpen && <Dialog open onOpenChange={setTemplatePickerOpen}>
        <DialogContent className="max-w-lg max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Bokför transaktion</DialogTitle>
          </DialogHeader>
          {templatePickerTransaction && (
            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="truncate text-muted-foreground">{templatePickerTransaction.description}</span>
              <span className="font-medium tabular-nums flex-shrink-0">
                {templatePickerTransaction.amount > 0 ? '+' : ''}{formatCurrency(templatePickerTransaction.amount, templatePickerTransaction.currency)}
              </span>
            </div>
          )}
          {/* Alternate paths as quiet links (concept vact): the templates are
              the main content, not three stacked buttons. */}
          <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
            <button type="button" className={QUIET_LINK_CLASS} onClick={handleManualBooking}>
              Bokför manuellt
            </button>
            {templatePickerTransaction && templatePickerTransaction.amount > 0 && (
              <button
                type="button"
                className={QUIET_LINK_CLASS}
                onClick={() => {
                  const tx = templatePickerTransaction
                  setTemplatePickerOpen(false)
                  setInvoicePickerTransaction(tx)
                  setInvoicePickerOpen(true)
                }}
              >
                Matcha med faktura
              </button>
            )}
            {templatePickerTransaction && (
              <button
                type="button"
                className={QUIET_LINK_CLASS}
                onClick={() => void handleIgnoreTransaction(templatePickerTransaction)}
              >
                Ignorera transaktionen
              </button>
            )}
          </div>
          <TemplatePicker
            direction={templatePickerTransaction && templatePickerTransaction.amount < 0 ? 'expense' : 'income'}
            entityType={entityType as EntityType}
            suggestedTemplates={templatePickerTransaction ? templateSuggestions[templatePickerTransaction.id] : undefined}
            onSelect={handleTemplateSelected}
            onSelectCounterparty={(templateId) => {
              if (!templatePickerTransaction) return
              setTemplatePickerOpen(false)
              handleOpenTemplateReview(templatePickerTransaction, templateId)
            }}
            onPickLibraryTemplate={handlePickLibraryTemplate}
            onSelectAccount={handlePickAccount}
          />
        </DialogContent>
      </Dialog>}

      {invoicePickerOpen && <Dialog
        open
        onOpenChange={(open) => {
          if (isMatchingFromPicker) return
          setInvoicePickerOpen(open)
          if (!open) setInvoicePickerTransaction(null)
        }}
      >
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('dialog_match_invoice')}</DialogTitle>
          </DialogHeader>
          {invoicePickerTransaction && (
            <>
              <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                <span className="truncate text-muted-foreground">{invoicePickerTransaction.description}</span>
                <span className="font-medium tabular-nums flex-shrink-0 ml-3 text-success">
                  +{formatCurrency(invoicePickerTransaction.amount, invoicePickerTransaction.currency)}
                </span>
              </div>
              <InvoicePicker
                transaction={invoicePickerTransaction}
                onSelect={handleSelectInvoiceFromPicker}
                isProcessing={isMatchingFromPicker}
              />
            </>
          )}
        </DialogContent>
      </Dialog>}

      {supplierInvoicePickerOpen && <Dialog
        open
        onOpenChange={(open) => {
          if (isMatchingSupplierFromPicker) return
          setSupplierInvoicePickerOpen(open)
          if (!open) setSupplierInvoicePickerTransaction(null)
        }}
      >
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Matcha med leverantörsfaktura</DialogTitle>
          </DialogHeader>
          {supplierInvoicePickerTransaction && (
            <>
              <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
                <span className="truncate text-muted-foreground">{supplierInvoicePickerTransaction.description}</span>
                <span className="font-medium tabular-nums flex-shrink-0 ml-3">
                  {formatCurrency(supplierInvoicePickerTransaction.amount, supplierInvoicePickerTransaction.currency)}
                </span>
              </div>
              <SupplierInvoicePicker
                transaction={supplierInvoicePickerTransaction}
                onSelect={handleSelectSupplierInvoiceFromPicker}
                isProcessing={isMatchingSupplierFromPicker}
              />
            </>
          )}
        </DialogContent>
      </Dialog>}

      {quickReviewOpen && (
        <QuickReviewDialog
          key={quickReview?.transaction.id ?? '' + String(quickReview?.category) + String(quickReview?.templateId) + String(quickReview?.template?.id)}
          open
          onOpenChange={setQuickReviewOpen}
          transaction={quickReview?.transaction ?? null}
          category={quickReview?.category ?? null}
          categoryLabel={quickReview?.label ?? ''}
          defaultAccount={quickReviewDefaults.account}
          defaultVat={quickReviewDefaults.vat}
          entityType={entityType as EntityType}
          template={quickReview?.template ?? null}
          templateId={quickReview?.templateId}
          counterpartyLinePattern={quickReview?.linePattern ?? null}
          counterpartyDefaultDimensions={quickReview?.defaultDimensions ?? null}
          onConfirm={handleQuickReviewConfirm}
          onChangeTemplate={handleChangeTemplate}
          onEditLines={handleEditProposedLines}
        />
      )}

      {isDialogOpen && <Dialog open onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('dialog_add_transaction')}</DialogTitle>
          </DialogHeader>
          <TransactionForm onSubmit={handleCreateTransaction} isLoading={isCreating} />
        </DialogContent>
      </Dialog>}

      <DestructiveConfirmDialog {...confirmDialogProps} />

      {editTitleTarget && (
        <EditTransactionTitleDialog
          open
          onOpenChange={(v) => {
            if (!v) setEditTitleTarget(null)
          }}
          currentTitle={editTitleTarget.description ?? ''}
          originalTitle={editTitleTarget.original_description ?? null}
          onSave={handleSaveTitle}
        />
      )}

      {moveAccountTarget && (
        <MoveTransactionCashAccountDialog
          open
          onOpenChange={(v) => {
            if (!v) setMoveAccountTarget(null)
          }}
          cashAccounts={cashAccounts}
          currentCashAccountId={moveAccountTarget.cash_account_id}
          currency={moveAccountTarget.currency}
          onMove={handleMoveCashAccount}
        />
      )}

      {skvMatchTarget && (
        <SkattekontoMatchDialog
          row={skvMatchTarget}
          open
          onClose={() => setSkvMatchTarget(null)}
          onMatched={handleSkvMatched}
        />
      )}

      {skvBookTarget && (
        <SkattekontoBookDialog
          row={skvBookTarget}
          open
          onOpenChange={(o) => {
            if (!o) setSkvBookTarget(null)
          }}
          onBooked={handleSkvBooked}
          onMatch={() => {
            setSkvMatchTarget(skvBookTarget)
            setSkvBookTarget(null)
          }}
        />
      )}

      {/* SKV bulk booking: one summary confirmation for the whole selection,
          grouped by deterministic suggestion. Count-based: voucher numbers
          are assigned atomically at commit. */}
      {skvBulkConfirmOpen && (
        <ConfirmationDialog
          open
          onOpenChange={setSkvBulkConfirmOpen}
          title={t('skv_bulk_title', { count: skvSelectedIds.size })}
          isSubmitting={skvBulkSubmitting}
          confirmLabel={t('skv_bulk_confirm')}
          warningText={t('skv_bulk_warning', { count: skvSelectedIds.size })}
          onConfirm={handleSkvBulkConfirm}
        >
          <div className="space-y-2 py-2 text-sm">
            {skvBulkGroups.map((group) => (
              <div
                key={`${group.account}|${group.label}`}
                className="flex items-baseline justify-between gap-4"
              >
                <span className="min-w-0 truncate">
                  {t('skv_bulk_group', {
                    count: group.count,
                    label: group.label,
                    account: group.account,
                  })}
                </span>
                <span className={cn('shrink-0 tabular-nums', group.sum > 0 && 'text-success')}>
                  {group.sum > 0 ? '+' : ''}
                  {formatCurrency(group.sum)}
                </span>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-4 border-t border-border pt-2 font-medium">
              <span>{t('skv_bulk_total', { count: skvSelectedIds.size })}</span>
              <span className="tabular-nums">
                {skvBulkTotal > 0 ? '+' : ''}
                {formatCurrency(skvBulkTotal)}
              </span>
            </div>
          </div>
        </ConfirmationDialog>
      )}

      {/* Prong B: match-against-supplier-invoice suggestion */}
      {siMatchSuggestion && <Dialog
        open
        onOpenChange={(open) => {
          if (!open) setSiMatchSuggestion(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('dialog_match_supplier_invoice')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Det finns en öppen leverantörsfaktura med samma belopp från samma leverantör. Matcha mot
              fakturan istället för att bokföra direkt på leverantörsskuldskontot, annars skapas en
              dubblerad verifikation som måste stornas (BFL 5 kap 5 §).
            </p>
            <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
              {siMatchSuggestion?.candidates.map((c) => (
                <div key={c.supplier_invoice_id} className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium">
                      {c.supplier_name || 'Leverantör'} · {c.invoice_number}
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {formatDate(c.invoice_date)} · kvar {formatCurrency(c.remaining_amount, c.currency)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => handleMatchSuggestedSupplierInvoice(siMatchSuggestion.transactionId, c.supplier_invoice_id)}
                    disabled={siMatchProcessing}
                  >
                    Matcha
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setSiMatchSuggestion(null)}>
                Avbryt
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  const retry = siMatchSuggestion?.retry
                  setSiMatchSuggestion(null)
                  if (retry) await retry()
                }}
                disabled={siMatchProcessing}
              >
                Bokför på leverantörsskulder ändå
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>}

      {/* Prong B (customer side): match-against-customer-invoice suggestion */}
      {ciMatchSuggestion && <Dialog
        open
        onOpenChange={(open) => {
          if (!open) setCiMatchSuggestion(null)
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('dialog_match_customer_invoice')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Det finns en obetald kundfaktura med samma belopp från samma kund. Matcha mot fakturan
              istället för att bokföra direkt mot kundfordringskontot, annars skapas en dubblerad
              verifikation som måste stornas (BFL 5 kap 5 §).
            </p>
            <div className="space-y-2 rounded-lg border bg-muted/30 p-3">
              {ciMatchSuggestion?.candidates.map((c) => (
                <div key={c.invoice_id} className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {c.customer_name || 'Kund'} · {c.invoice_number ?? '-'}
                      </span>
                      {c.match_reason === 'ocr_exact' && (
                        <Badge variant="success">{t('badge_exact_ocr')}</Badge>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {formatDate(c.invoice_date)} · kvar {formatCurrency(c.remaining_amount, c.currency)}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    onClick={() => handleMatchSuggestedInvoice(ciMatchSuggestion.transactionId, c.invoice_id)}
                    disabled={ciMatchProcessing}
                  >
                    Matcha
                  </Button>
                </div>
              ))}
            </div>
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Button variant="outline" onClick={() => setCiMatchSuggestion(null)}>
                Avbryt
              </Button>
              <Button
                variant="outline"
                onClick={async () => {
                  const retry = ciMatchSuggestion?.retry
                  setCiMatchSuggestion(null)
                  if (retry) await retry()
                }}
                disabled={ciMatchProcessing}
              >
                Bokför på kundfordringar ändå
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>}

      {duplicateWarning && <DuplicateBookingDialog
        candidate={duplicateWarning.candidate}
        processing={duplicateProcessing}
        onCancel={() => setDuplicateWarning(null)}
        // Ledger-only candidate (transaction_id null, e.g. a verifikat from an
        // SIE import): the primary action links the bank line to the existing
        // voucher instead of double-booking it. Success refreshes the same
        // state a MatchVoucherDialog link does.
        matchTransaction={
          transactions.find((tx) => tx.id === duplicateWarning.transactionId) ?? {
            id: duplicateWarning.transactionId,
          }
        }
        onMatched={(transactionId, journalEntryId, voucherLabel) => {
          setDuplicateWarning(null)
          handleVoucherLinked(transactionId, journalEntryId, voucherLabel)
        }}
        // Sibling candidate resolved as a duplicate import: the dialog already
        // ran POST /ignore; this is the same success tail as
        // handleIgnoreTransaction (which additionally owns a pre-confirm the
        // dialog context replaces).
        onIgnored={(transactionId) => {
          setDuplicateWarning(null)
          const ignoredTx = transactions.find((t) => t.id === transactionId)
          setExitingIds((prev) => new Set(prev).add(transactionId))
          setTotalUncategorizedCount((prev) => Math.max(0, (prev ?? 1) - 1))
          setTimeout(() => {
            setTransactions((prev) =>
              prev.map((t) => (t.id === transactionId ? { ...t, is_ignored: true } : t))
            )
            setExitingIds((prev) => {
              const next = new Set(prev)
              next.delete(transactionId)
              return next
            })
          }, 350)
          toast({
            title: 'Transaktionen ignorerad',
            description: ignoredTx
              ? `${ignoredTx.description}, ${formatCurrency(ignoredTx.amount, ignoredTx.currency)}`
              : undefined,
            action: (
              <ToastAction altText="Ångra ignorera" onClick={() => void handleUnignoreTransaction(transactionId)}>
                Ångra
              </ToastAction>
            ),
          })
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
      />}

    </div>
  )
}
