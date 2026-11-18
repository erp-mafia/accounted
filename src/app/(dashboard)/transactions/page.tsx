'use client'

import { UUID_RE } from '@/lib/invariants/uuid'
import { useState, useEffect, useMemo, useRef, useCallback, type ComponentProps } from 'react'
import type { SupabaseDataClient } from '@/lib/supabase/data-client'
import dynamic from 'next/dynamic'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { useTranslations, useLocale } from 'next-intl'
import { Button } from '@/components/ui/button'
import { FLOATING_BULK_BAR_CLASS } from '@/components/ui/floating-bulk-bar'
import { PAGE_BOTTOM_BAR_PROPS } from '@/components/ui/fab-clearance'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogVeil, useDashShellInert } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { ConfirmationDialog } from '@/components/ui/confirmation-dialog'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { ToolbarSearch, TOOLBAR_SEARCH_END_CLASS } from '@/components/ui/toolbar-search'
import { CreateDrawer } from '@/components/ui/create-drawer'
import { OpenOnParam } from '@/components/ui/open-on-param'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { TH_CLASS, QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import { AdjustmentsHorizontalIcon, CheckIcon, CreditCardIcon, SpinnerIcon } from '@/components/icons'
import { useUiState } from '@/lib/hooks/use-ui-state'
import { persistUiState } from '@/lib/ui-state/client'
import { TX_COLUMNS, resolveTxColumns, type TxColumnId } from '@/lib/transactions/columns-v2'
import {
  SKATTEKONTO_ACCOUNT_DEFAULT,
  isSkattekontoLedgerAccount,
  type SkattekontoLedgerAccount,
} from '@/lib/skatteverket/skattekonto-account'
import { CategoryPopover } from '@/components/transactions/CategoryPopover'
import { cashAccountKontoLabel, cashAccountLogoUrl } from '@/lib/cash-accounts/labels'
import type { RowProposal } from '@/components/transactions/TransactionInboxCard'
import { underlagForReview, type CarriedUnderlag, type ReviewUnderlag } from '@/components/transactions/review-underlag'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import TransactionStatusBar from '@/components/transactions/TransactionStatusBar'
import BankSyncStatusChip from '@/components/transactions/BankSyncStatusChip'
import { ContextPicker, type ContextPickerItem } from '@/components/common/ContextPicker'
import { useFiscalScope } from '@/components/providers/FiscalScopeProvider'
import { AttnLine } from '@/components/ui/attn-line'
import { useBankLedgerSuggestionNotice } from '@/components/transactions/BankLedgerSuggestionNotice'
import TransactionInboxCard from '@/components/transactions/TransactionInboxCard'
import TransactionHistoryList from '@/components/transactions/TransactionHistoryList'
import InboxZeroState from '@/components/transactions/InboxZeroState'
import SkattekontoInboxCard from '@/components/transactions/SkattekontoInboxCard'
import { useSkattekontoLedgerProposalCount } from '@/components/skattekonto/use-ledger-proposal-count'
import type { BookedDuplicateCandidate } from '@/lib/transactions/booking-duplicate-detection'
import type { VoucherWarning } from '@/lib/bookkeeping/voucher-plausibility'
import { mapWithConcurrency } from '@/lib/concurrency'
import {
  foldDeferredRetries,
  foldFiledVatRetries,
  runDeferredDuplicateRetries,
  tallyBatchOutcomes,
  type BatchCategorizeOutcome,
  type DeferredDuplicateBooking,
} from '@/lib/transactions/batch-duplicates'
import type { BatchDuplicateRow } from '@/components/transactions/BatchDuplicateDialog'
import type { ConfirmOpts, MatchAlreadyBooked } from '@/components/transactions/InvoiceMatchDialog'

import { DialogLoadingSkeleton } from '@/components/ui/dialog-loading-skeleton'
import type { BookingTemplate } from '@/lib/bookkeeping/booking-templates'
import { categorizeBodyFor, proposalFromTemplate, proposalHue, type BookingProposal } from '@/lib/bookkeeping/proposal'
import { supplierInvoiceReference } from '@/lib/bookkeeping/supplier-invoice-description'
import { useProposalWhy } from '@/components/transactions/proposal-why'
import type { ProposalLine } from '@/lib/bookkeeping/proposal-lines'
import type {
  TransactionWithInvoice,
  ViewMode,
  HistoryFilter,
  SourceFilter,
  CategorizeHandler,
  PotentialVoucher,
  PotentialRotRutPayout,
  PotentialRotRutPayoutRequest,
} from '@/components/transactions/transaction-types'
import type { BatchAllocationPrefill } from '@/lib/transactions/parts-read'
import { readGiroCounterparty, type GiroCounterparty, type GiroRegister } from '@/lib/transactions/giro-counterparty'
import { loadGiroRegister } from '@/lib/transactions/giro-register'
import { loadOpenRotRutPayoutRequests } from '@/lib/invoices/open-rot-rut-payout-requests'
import { matchTransactionsToRotRutPayoutSets } from '@/lib/invoices/rot-rut-payout-set-matching'
import {
  groupExpenseClaimsByPerson,
  matchTransactionsToExpensePayouts,
} from '@/lib/expenses/expense-payout-candidates'
import { listExpenseClaimsAwaitingPayout } from '@/lib/salary/expense-claim-payout-state'
import type { ExpensePayoutDue } from '@/lib/worklist/types'
import type { SalaryRunPayout } from '@/lib/transactions/salary-run-payouts'
import { SuggestionReviewList } from '@/components/transactions/SuggestionReviewList'
import {
  isSourceFilter,
  readStoredSourceFilter,
  resolveEffectiveSourceFilter,
  writeStoredSourceFilter,
} from '@/components/transactions/source-filter-storage'
import {
  readStoredViewMode,
  resolveInitialViewMode,
  writeStoredViewMode,
} from '@/components/transactions/view-mode-storage'
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
} from '@/lib/bookkeeping/matchable-statuses'
import { useAssistantReadsAvailable, useCompany } from '@/contexts/CompanyContext'
import { useCashAccounts } from '@/lib/reference-data/hooks'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { collectPages } from '@/lib/lists/collect-pages'
import { useRealtimeSupabase } from '@/lib/hooks/use-realtime-supabase'
import { refreshWorklistBadges } from '@/lib/hooks/use-worklist-badges'
import { subscribeAsUser } from '@/lib/supabase/realtime-subscribe'
import { useBulkSelection } from '@/lib/hooks/use-bulk-selection'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { resolveDetachErrorMessage } from '@/components/transactions/detach-underlag'
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import type { TransactionCategory, CreateTransactionInput, Invoice, Customer, SupplierInvoice, Supplier, VatTreatment, EntityType, BookingTemplateLibrary } from '@/types'
import type { ReverseChargeKind } from '@/lib/bookkeeping/vat-entries'
import { mutate as globalMutate } from 'swr'
import { rowProposal, type SuggestedTemplate } from '@/lib/transactions/category-suggestions'
import { readIsFresh, type AssistantRead } from '@/lib/agent/categorize/read-shape'
import { reviewRequired, type DirectBookingSettings } from '@/lib/transactions/direct-booking'
import { activationFor, isPersonChoice, rememberReviewChoice, reviewChoiceFor, type ReviewChoice, type ReviewChoices } from '@/lib/transactions/review-choice'

/**
 * Tell the drawer and the review to re-read a row's underlag. They read it
 * through SWR on this key, so an attach or a detach elsewhere on the page
 * has to say so or the receipt only appears on the next revalidation.
 */
function revalidateUnderlag(transactionId: string): Promise<unknown> {
  return globalMutate(`/api/transactions/${transactionId}/underlag`)
}

/** Rows warmed per pass, taken from the top of the list only: a screenful, never the backlog. */
const ASSISTANT_WARM_LIMIT = 8
const ASSISTANT_WARM_WINDOW = 30
import { isImportedTransaction } from '@/lib/transactions/origin'
import { computeJeUnderlagStatus, type JeUnderlagStatus } from '@/lib/transactions/underlag-status'
import { getInvoiceReferencesForJournalEntries } from '@/lib/core/bookkeeping/journal-entry-references'
import { withLivePointer } from '@/lib/transactions/is-booked'
import { isWithinBounds, resolvePeriodBounds } from '@/lib/transactions/period-filter'
import { bankRowInSource, countInboxScope, skattekontoInSource } from '@/lib/transactions/inbox-scope'

// Every list fetch embeds the junction so a row split over several verifikat
// (journal_entry_id NULL, #1553) renders as booked with its verifikat instead
// of "Ej bokförd" (crm#48). The nested journal_entry gives the row a label per
// link (V200, V201); see getLinkedJournalEntryIds.
// parts_count: how many parts the row's Bankgirot split has (the inbox row's
// "N delbetalningar"); the parts themselves load in the drawer.
const TRANSACTION_LIST_SELECT =
  '*, transaction_voucher_links(journal_entry_id, role, journal_entry:journal_entries(voucher_series, voucher_number)), parts_count:bank_transaction_parts(count)'
// The window's rows can be booked: is_booked tells a stale pointer from a live
// one (withLivePointer). The pending backlog never is, and it can be thousands.
const TRANSACTION_WINDOW_SELECT = `${TRANSACTION_LIST_SELECT}, is_booked`

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
const RotRutPayoutMatchDialog = dynamic(() => import('@/components/transactions/RotRutPayoutMatchDialog'), { loading: DialogLoadingSkeleton })
const ExpensePayoutMatchDialog = dynamic(() => import('@/components/transactions/ExpensePayoutMatchDialog'), { loading: DialogLoadingSkeleton })
const ExpenseClaimPickerDialog = dynamic(() => import('@/components/transactions/ExpenseClaimPickerDialog'), { loading: DialogLoadingSkeleton })
const MatchVoucherDialog = dynamic(
  () => import('@/components/transactions/MatchVoucherDialog').then((module) => module.MatchVoucherDialog),
  { loading: DialogLoadingSkeleton },
)
const InvoicePicker = dynamic(() => import('@/components/transactions/InvoicePicker'), { loading: InlineDialogContentLoading })
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
const SkattekontoLinkProposalsDialog = dynamic(
  () =>
    import('@/components/skattekonto/SkattekontoLinkProposalsDialog').then(
      (module) => module.SkattekontoLinkProposalsDialog,
    ),
  { loading: DialogLoadingSkeleton },
)
const DuplicateBookingDialog = dynamic(
  () => import('@/components/transactions/DuplicateBookingDialog'),
  { loading: DialogLoadingSkeleton },
)
// The confirm step of a booking-time warning (the typed verifikat's dialog):
// here for a bank row whose category booking changes the underlag for a
// momsdeklaration already filed.
const VoucherWarningsDialog = dynamic(
  () => import('@/components/bookkeeping/VoucherWarningsDialog'),
  { loading: DialogLoadingSkeleton },
)
const BatchDuplicateDialog = dynamic(
  () => import('@/components/transactions/BatchDuplicateDialog'),
  { loading: DialogLoadingSkeleton },
)
// The bank row's picker: its Konton search also finds the BAS accounts the
// company has not added yet (crm#1101).
const TemplatePicker = dynamic(
  () => import('@/components/transactions/TemplatePicker').then((m) => m.BankRowTemplatePicker),
  { loading: InlineDialogContentLoading },
)

type InvoiceWithCustomer = Invoice & { customer?: Customer }
type SupplierInvoiceWithSupplier = SupplierInvoice & { supplier?: Supplier }

// Journal-entry ids get interpolated into the supplier-invoice .or() filter
// string in the underlag-badge effect below. They come from journal_entries.id
// (DB-sourced), but this guard keeps the interpolated list UUID-only, matching
// /api/documents/counts.

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

/**
 * Every unbooked skattekonto row in the inbox can be selected: bulk Ignorera
 * applies to all of them, and bulk Bokför re-filters the selection through
 * isSkvBulkEligible at both the button and submit time. Before #2127 only
 * rows with a deterministic suggestion got a checkbox, so a migration
 * backlog on the skattekonto (pre-first-fiscal-year rows, already-booked
 * history) could only be ignored one row at a time.
 */
function isSkvSelectable(row: SkattekontoTransactionWithSuggestion): boolean {
  return !row.journal_entry_id && !row.is_ignored
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

// Pair unbooked outflows with the person whose utlägg they repay in full
// (lib/expenses/expense-payout-candidates). Read-time: the claims that wait
// for a payout are the candidate pool (a claim on a salary run is not one),
// so this is one small query and nothing for the companies without any.
// Non-fatal like fetchPotentialMatches.
async function fetchExpensePayoutMatches(
  supabase: SupabaseDataClient,
  companyId: string | null,
  rows: { id: string; amount: number; currency: string | null; is_business: boolean | null; journal_entry_id: string | null }[],
): Promise<{ byTransaction: Map<string, ExpensePayoutDue>; people: ExpensePayoutDue[] }> {
  const out = new Map<string, ExpensePayoutDue>()
  if (!companyId || rows.length === 0) return { byTransaction: out, people: [] }
  let claimRows: Parameters<typeof groupExpenseClaimsByPerson>[0]
  try {
    claimRows = await listExpenseClaimsAwaitingPayout(supabase, companyId)
  } catch (error) {
    console.error('[fetchExpensePayoutMatches] expense_claims query failed', error)
    return { byTransaction: out, people: [] }
  }
  const people = groupExpenseClaimsByPerson(claimRows)
  for (const [txId, m] of matchTransactionsToExpensePayouts(rows, people)) out.set(txId, m.person)
  return { byTransaction: out, people }
}

// Fetch the potential invoice/supplier-invoice matches referenced by a page
// of transactions in one parallel round trip. A single-query PostgREST embed
// on potential_supplier_invoice_id is blocked until that FK exists in the
// prod schema cache (see DECISIONS.md archive 2026-07-06).
async function fetchPotentialMatches(
  supabase: SupabaseDataClient,
  companyId: string | null,
  rows: {
    id: string
    amount: number
    currency: string | null
    description?: string | null
    merchant_name?: string | null
    is_business: boolean | null
    journal_entry_id: string | null
    potential_invoice_id: string | null
    potential_supplier_invoice_id: string | null
    potential_rot_rut_payout_request_id?: string | null
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
  const [invoiceResults, supplierInvoiceResults, voucherResults, rotRutResult] = await Promise.all([
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
    // Open ROT/RUT begäran (Skatteverkets utbetalning): the company's whole
    // open pool, not the hinted ids. It serves both the persisted 1:1 hint
    // (revalidated: a request settled by another row must not reach the
    // dialog) and the read-time covering set for a row Skatteverket paid
    // together with other beslut (#2239). Items ride along so the dialog can
    // list the covered invoices. A handful of rows per company.
    companyId
      ? loadOpenRotRutPayoutRequests(supabase, companyId)
      : Promise.resolve({ requests: [], error: null }),
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
  if (rotRutResult.error) {
    console.error('[fetchPotentialMatches] rot_rut_payout_requests query failed', rotRutResult.error)
  }

  const rotRutRequests: PotentialRotRutPayoutRequest[] = rotRutResult.requests
  const rotRutById = new Map(rotRutRequests.map((req) => [req.id, req] as const))
  // Per row: the persisted 1:1 hint when its begäran is still open, else the
  // exact covering set over the open pool (several begäran in one transfer).
  const rotRutByTransaction = new Map<string, PotentialRotRutPayout>()
  for (const row of rows) {
    const hinted = row.potential_rot_rut_payout_request_id
      ? rotRutById.get(row.potential_rot_rut_payout_request_id)
      : undefined
    if (hinted) rotRutByTransaction.set(row.id, { requests: [hinted] })
  }
  for (const [txId, match] of matchTransactionsToRotRutPayoutSets(rows, rotRutRequests)) {
    rotRutByTransaction.set(txId, { requests: match.requests })
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
    rotRutByTransaction,
  }
}

interface QuickReviewState {
  transaction: TransactionWithInvoice
  /** What will be booked and why: one object whoever proposed it (lib/bookkeeping/proposal.ts). */
  proposal: BookingProposal
  /** The person chose it from the picker, as opposed to the row's recommendation. */
  picked: boolean
  /** Underlag attached in the review that "Byt" closed, carried into this one. */
  underlag: ReviewUnderlag | null
}

export default function TransactionsPage() {
  const { company } = useCompany()
  const companyId = company?.id ?? null
  const canAskAssistant = useAssistantReadsAvailable()
  const searchParams = useSearchParams()
  const t = useTranslations('transactions')
  const errorLocale = useLocale() as ErrorLocale
  const whyFor = useProposalWhy()
  // Kategori and Konto columns plus per-user column visibility
  // (ui_state.tx_columns), UI v2 PR 4.
  const tSkvCard = useTranslations('tx_skattekonto_card')
  const { uiState } = useUiState()
  const [hiddenColumns, setHiddenColumns] = useState<string[] | null>(null)
  const txColumns = useMemo(
    () => resolveTxColumns({ hidden: hiddenColumns ?? uiState?.tx_columns?.hidden }),
    [hiddenColumns, uiState?.tx_columns?.hidden],
  )
  const setColumnsHidden = (next: string[]) => {
    setHiddenColumns(next)
    persistUiState({ tx_columns: { hidden: next } })
  }
  const toggleColumn = (id: TxColumnId) => {
    const current = hiddenColumns ?? uiState?.tx_columns?.hidden ?? []
    setColumnsHidden(current.includes(id) ? current.filter((c) => c !== id) : [...current, id])
  }
  const tDetach = useTranslations('tx_detach')
  const tCommon = useTranslations('common')
  const { canWrite } = useCanWrite()
  const [transactions, setTransactions] = useState<TransactionWithInvoice[]>([])
  const [isLoading, setIsLoading] = useState(true)
  // The last list fetch failed (failed) or loaded only the window, without the
  // older pending rows (partial). Said in the page, never in a toast: with no
  // rows on screen in place of the list, with rows as one line above them.
  const [loadFailure, setLoadFailure] = useState<'failed' | 'partial' | null>(null)
  const [mode, setMode] = useState<ViewMode>('inbox')
  // The view is remembered per company (view-mode-storage.ts) and applied
  // once per company and per ?view= link, after mount: reading localStorage
  // in the initial state would differ from the server render. Only the tabs
  // write the choice; the highlight widening, the review nudge and the
  // "show ignored" toast change the view in memory only.
  const appliedViewKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!companyId) return
    const urlView = searchParams.get('view')
    const key = `${companyId}|${urlView ?? ''}`
    if (appliedViewKeyRef.current === key) return
    appliedViewKeyRef.current = key
    setMode(
      resolveInitialViewMode({
        urlView,
        hasHighlight: Boolean(searchParams.get('highlight')),
        stored: readStoredViewMode(companyId),
      }),
    )
  }, [companyId, searchParams])
  const handleModeChange = useCallback(
    (next: ViewMode) => {
      setMode(next)
      if (companyId) writeStoredViewMode(companyId, next)
    },
    [companyId],
  )
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>('all')
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [templateSuggestions, setTemplateSuggestions] = useState<Record<string, SuggestedTemplate[]>>({})
  // The rows a booked salary run already pays out, with the run's verifikat,
  // read with the proposals (crm#1685): the row is matched to it, never booked.
  const [salaryPayouts, setSalaryPayouts] = useState<Record<string, SalaryRunPayout>>({})
  const salaryPayoutFor = (tx: TransactionWithInvoice): SalaryRunPayout | undefined =>
    tx.journal_entry_id ? undefined : salaryPayouts[tx.id]
  // The company's one-click switch, read with the proposals. Until it has
  // arrived no row books without its review.
  const [directBooking, setDirectBooking] = useState<DirectBookingSettings | null>(null)
  // The assistant's reads for the loaded rows, so the review opens with one
  // instead of fetching it. A ref, not state: only the review reads them, and
  // it reads at open time, so a landing read has nothing to re-render.
  const assistantReadsRef = useRef<Record<string, AssistantRead>>({})
  // Rows already sent to the assistant this session (per company), so a
  // landing read never re-triggers the sweep below.
  const warmedReadsRef = useRef<{ companyId: string | null; ids: Set<string> }>({ companyId: null, ids: new Set() })
  const [processingId, setProcessingId] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')

  // Batch selection: hover checkboxes + bulkbar (concept), no mode toggle.
  // The selections themselves are bankSelection and skvSelection below.
  const [showBatchSelector, setShowBatchSelector] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)
  // Row expansion (concept foldout): one open row at a time, mirroring the
  // verifikat list.
  const [expandedTxId, setExpandedTxId] = useState<string | null>(null)

  // Invoice match dialog
  const [matchDialogOpen, setMatchDialogOpen] = useState(false)
  const [selectedTransaction, setSelectedTransaction] = useState<TransactionWithInvoice | null>(null)
  const [isConfirmingMatch, setIsConfirmingMatch] = useState(false)
  // The match refused a booked row (MATCH_SI_TX_ALREADY_BOOKED,
  // MATCH_INVOICE_TX_ALREADY_BOOKED): the dialog's soft block, for the row it
  // was refused for.
  const [matchAlreadyBooked, setMatchAlreadyBooked] = useState<(MatchAlreadyBooked & { transactionId: string }) | null>(null)
  // ROT/RUT payout confirm (Skatteverkets utbetalning for an open begäran):
  // its own dialog, same selectedTransaction / isConfirmingMatch plumbing.
  const [rotRutMatchDialogOpen, setRotRutMatchDialogOpen] = useState(false)
  // Utlägg repayment confirm (a transfer covering one person's registered
  // claims): own dialog, same selectedTransaction / isConfirmingMatch plumbing.
  const [expensePayoutDialogOpen, setExpensePayoutDialogOpen] = useState(false)
  // Manual "Matcha mot utlägg" for an outflow the exact-amount pairing missed.
  // Offered only while the company has open claims (set by the list fetch).
  const [matchExpenseTx, setMatchExpenseTx] = useState<TransactionWithInvoice | null>(null)
  const [hasOpenExpenseClaims, setHasOpenExpenseClaims] = useState(false)

  // Booking dialog (journal entry form)
  const [bookingDialogOpen, setBookingDialogOpen] = useState(false)
  const [bookingDialogTransaction, setBookingDialogTransaction] = useState<TransactionWithInvoice | null>(null)
  const [bookingDialogTemplate, setBookingDialogTemplate] = useState<BookingTemplateLibrary | null>(null)
  // "Andra rader" hand-off: the computed proposal lines from QuickReviewDialog,
  // prefilled into TransactionBookingDialog for per-line editing.
  const [bookingDialogProposalLines, setBookingDialogProposalLines] = useState<ProposalLine[] | null>(null)
  // Radtext for the business lines when the review hands its proposal over.
  const [bookingDialogLineDescription, setBookingDialogLineDescription] = useState<string | null>(null)
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
  // The element the picker opens beside (chip or Bokför button); null = the dialog.
  const [templatePickerAnchor, setTemplatePickerAnchor] = useState<HTMLElement | null>(null)
  // The underlag "Byt" took from the review it closed, for the review this
  // picker opens on the same row (review-underlag.ts underlagForReview).
  const [templatePickerUnderlag, setTemplatePickerUnderlag] = useState<CarriedUnderlag | null>(null)
  // The picker renders non-modal (agent sheet stays usable); hand-restore
  // page modality while it is open. See useDashShellInert in ui/dialog.tsx.
  useDashShellInert(templatePickerOpen)

  // Invoice picker dialog (manual match)
  const [invoicePickerOpen, setInvoicePickerOpen] = useState(false)
  const [invoicePickerTransaction, setInvoicePickerTransaction] = useState<TransactionWithInvoice | null>(null)
  const [supplierInvoicePickerOpen, setSupplierInvoicePickerOpen] = useState(false)
  const [supplierInvoicePickerTransaction, setSupplierInvoicePickerTransaction] = useState<TransactionWithInvoice | null>(null)
  const [splitMatchOpen, setSplitMatchOpen] = useState(false)
  const [splitMatchTransaction, setSplitMatchTransaction] = useState<TransactionWithInvoice | null>(null)
  // The allocations the row's Bankgirot split suggests, when the drawer's
  // "Matcha N fakturor" opened the dialog; null from the plain split item.
  const [splitMatchPrefill, setSplitMatchPrefill] = useState<BatchAllocationPrefill[] | null>(null)
  // "Matcha mot befintlig verifikation": link a bank tx to an already-booked
  // voucher (salary, Fortnox import, manual entry) with no new bokföring.
  const [matchVoucherTx, setMatchVoucherTx] = useState<TransactionWithInvoice | null>(null)
  const [bulkBookOpen, setBulkBookOpen] = useState(false)

  // Quick review dialog (suggestion review before booking)
  const [quickReviewOpen, setQuickReviewOpen] = useState(false)
  const [quickReview, setQuickReview] = useState<QuickReviewState | null>(null)
  // The bookings people set in the review, by row: an account or moms they
  // changed, a template they picked. Closing the review used to forget it
  // and the row came back with the machine's proposal (PostHog 170). Kept
  // for the visit only (lib/transactions/review-choice.ts): nothing is stored.
  const [reviewChoices, setReviewChoices] = useState<ReviewChoices>({})
  const handleReviewProposalChange = useCallback((transactionId: string, held: ReviewChoice) => {
    setReviewChoices((prev) => rememberReviewChoice(prev, transactionId, held))
  }, [])

  // Prong B: prompt to match against an open supplier invoice instead of
  // categorizing direct to 2440. Triggered by a 409 TX_CATEGORIZE_SUGGEST_SI_MATCH.
  const [siMatchSuggestion, setSiMatchSuggestion] = useState<{
    transactionId: string
    // Resolved value unused: callers only await completion. runCategorize
    // resolves its outcome object, the counterparty path a journal-entry id.
    retry: () => Promise<unknown>
    candidates: Array<{
      supplier_invoice_id: string
      invoice_number: string | null
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
  // TX_CATEGORIZE_VAT_PERIOD_FILED: the row is dated in a filed momsperiod and
  // its booking changes the underlag for that declaration. The person reads
  // the warning and books anyway (retry sends confirm_filed_vat_period) or
  // leaves the row. A row of a selection is not asked here: the batch names
  // the reason once for the rows it holds back.
  const [filedVatConfirm, setFiledVatConfirm] = useState<{
    warnings: VoucherWarning[]
    retry: () => Promise<unknown>
  } | null>(null)
  const [filedVatProcessing, setFiledVatProcessing] = useState(false)
  // The same question for a selection, asked once after the pool settles
  // (as the duplicate guard does, #2488): each held row parks its retry.
  const batchFiledVatRef = useRef<Array<{ transactionId: string; warning: VoucherWarning; retry: () => Promise<BatchCategorizeOutcome> }>>([])
  const batchFiledVatAnswerRef = useRef<((confirmed: boolean) => void) | null>(null)
  const [batchFiledVatAsk, setBatchFiledVatAsk] = useState<{ warnings: VoucherWarning[]; count: number } | null>(null)

  // The same guard, asked once for a whole batch (#2488). The slot above holds
  // ONE answer, so N rows booking in parallel wrote it N times: only the last
  // writer's dialog rendered and every other flagged row landed in the batch's
  // "misslyckades" count with nothing said about why. A batch row therefore
  // parks its candidate and its force-bound retry in this ref instead of
  // opening a dialog, and handleBatchCategorize asks once when the pool has
  // settled. A ref, not state: the collector is written from inside the
  // concurrent pool and read straight after it, and a re-render per flagged
  // row would only reshuffle the list under the running batch.
  const batchDuplicatesRef = useRef<DeferredDuplicateBooking[]>([])
  const [batchDuplicateRows, setBatchDuplicateRows] = useState<BatchDuplicateRow[] | null>(null)
  // Resolves when the user answers the batch dialog, so the batch tail can
  // await the answer and narrate the whole thing in one toast.
  const batchDuplicateAnswerRef = useRef<((confirmed: boolean) => void) | null>(null)

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

  // Set of transaction IDs that are animating out (just categorized)
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set())

  // Skattekonto rows (unmatched, status='booked'). Loaded if the
  // Skatteverket extension is enabled and connected. 503/401 → silently
  // hidden (extension disabled or user not connected).
  const [skvRows, setSkvRows] = useState<SkattekontoTransactionWithSuggestion[]>([])
  // The company's skattekonto account (1630, or 2012 for an enskild firma that
  // runs it there), as the rows' list route reports it.
  const [skvAccount, setSkvAccount] = useState<SkattekontoLedgerAccount>(SKATTEKONTO_ACCOUNT_DEFAULT)
  const [skvMatchTarget, setSkvMatchTarget] = useState<StoredSkattekontoTransaction | null>(
    null,
  )
  // Inline single-row booking dialog (replaces the old draft-then-navigate
  // flow that dumped the user in /bookkeeping and lost all list state).
  const [skvBookTarget, setSkvBookTarget] = useState<SkattekontoTransactionWithSuggestion | null>(
    null,
  )
  // SKV bulk selection (skvSelection below): deliberately a SEPARATE set
  // from the bank `selectedIds`: every bank batch handler POSTs
  // /api/transactions/* and would 404 on skattekonto ids.
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

  // Period scope (räkenskapsår): the app-wide year beside the company name
  // (Stil v3), visible on every page, so a year chosen elsewhere never hides
  // pending rows here unseen; the footer still names rows outside it. Rows
  // the scope hides leave both batch selections when it renders
  // (useBulkSelection): every batch action operates on "what you see".
  // Quarter chips existed briefly (#1545) but were dropped: on a brutet
  // räkenskapsår they were not momsdeklaration quarters.
  const fiscalScope = useFiscalScope()
  // Footer "Visa alla": this visit lists every year, without moving the
  // app-wide year. A new year chosen in the sidebar ends it.
  const [showAllYears, setShowAllYears] = useState(false)
  const [seenYear, setSeenYear] = useState<string | null | undefined>(undefined)
  if (fiscalScope.ready && seenYear !== fiscalScope.periodId) {
    setSeenYear(fiscalScope.periodId)
    if (seenYear !== undefined) setShowAllYears(false)
  }
  const fyPeriod = showAllYears ? null : fiscalScope.period
  const periodBounds = useMemo(() => resolvePeriodBounds(fyPeriod, null), [fyPeriod])
  const clearPeriodFilter = useCallback(() => setShowAllYears(true), [])
  // Registered cash accounts (cash_accounts): the account chooser's rows,
  // with PSD2 balances when the bank reports them.
  // Registered, enabled cash accounts for the account chooser: session-cached
  // and seeded by the dashboard layout (lib/reference-data), so the chooser
  // renders populated on the first paint. Bank sync invalidates the entry.
  const { cashAccounts } = useCashAccounts({ enabledOnly: true })
  // v2 column texts. Konto = the account's bank plus its last digits (or its
  // ledger account), from lib/cash-accounts/labels.ts: the connection's bank,
  // never the payee columns an invoice prints. Kategori = the match hint the
  // row already carries, or null so the cell prompts "Välj kategori".
  const accountLabelFor = (tx: TransactionWithInvoice): string | null => {
    const acct = tx.cash_account_id ? cashAccounts.find((a) => a.id === tx.cash_account_id) : undefined
    return acct ? cashAccountKontoLabel(acct) : null
  }
  // The brand mark next to the Konto text (bank, Stripe, Skatteverket).
  const accountLogoFor = (tx: TransactionWithInvoice): string | null => {
    const acct = tx.cash_account_id ? cashAccounts.find((a) => a.id === tx.cash_account_id) : undefined
    return acct ? cashAccountLogoUrl(acct) : null
  }
  // The top suggestion (counterparty template, then keyword/MCC)
  // stands in the Kategori cell so the person sees what Bokför will do
  // before clicking anything. Suggestions arrive with the list
  // (fetchCategorySuggestions), so nothing is computed on click.
  // The booking the person set in the review, while it stands, comes before
  // every proposal: the row wears it and Bokför opens the review on it.
  const rowProposalFor = (tx: TransactionWithInvoice): SuggestedTemplate | undefined =>
    reviewChoiceFor(reviewChoices, tx) ?? rowProposal(templateSuggestions[tx.id])
  const proposalFor = (tx: TransactionWithInvoice): RowProposal | null => {
    if (tx.journal_entry_id || tx.is_business !== null) return null
    const s = rowProposalFor(tx)
    if (!s) return null
    return { label: s.name_sv, hue: proposalHue(s), confidence: s.confidence, why: whyFor(s), own: isPersonChoice(s) }
  }
  const categoryLabelFor = (tx: TransactionWithInvoice): string | null => {
    if (tx.potential_invoice && !tx.invoice_id)
      return t('cat_hint_invoice', { number: tx.potential_invoice.invoice_number ?? '' })
    if (tx.potential_supplier_invoice) return t('cat_hint_supplier_invoice')
    if (tx.potential_rot_rut_payout) return t('cat_hint_rot_rut')
    if (tx.potential_expense_payout) return t('cat_hint_expense')
    const salaryPayout = salaryPayoutFor(tx)
    if (salaryPayout) return t('cat_hint_salary_run', { period: salaryPayout.period })
    if (tx.potential_voucher) return t('cat_hint_voucher')
    return null
  }

  const { toast } = useToast()
  const { dialogProps: confirmDialogProps, confirm } = useDestructiveConfirm()
  // Bank transaction whose title is being edited (null = dialog closed).
  const [editTitleTarget, setEditTitleTarget] = useState<TransactionWithInvoice | null>(null)
  // Bank transaction being moved to another cash account (null = dialog closed).
  const [moveAccountTarget, setMoveAccountTarget] = useState<TransactionWithInvoice | null>(null)
  const supabase = useRealtimeSupabase()
  // A company with no bank row in any year meets the start card, not the
  // period line: "Välj Alla räkenskapsår" names rows that do not exist. Asked
  // only when the year's list comes back empty.
  const [noRowsInAnyYear, setNoRowsInAnyYear] = useState(false)
  const yearListEmpty = !isLoading && !!periodBounds && transactions.length === 0 && skvRows.length === 0
  useEffect(() => {
    if (!companyId || !yearListEmpty) return
    let cancelled = false
    void supabase
      .from('transactions')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .then(({ count, error }) => {
        if (!cancelled && !error) setNoRowsInAnyYear(count === 0)
      })
    return () => {
      cancelled = true
    }
  }, [companyId, supabase, yearListEmpty])
  // Whose giro number a row that names nobody shows (crm#1204): the company's
  // own bankgiro, or the one supplier card carrying it. Read once per company;
  // nothing is shown until the register is in, so a row never flips from
  // "likely" to "yours".
  const [giroLoaded, setGiroLoaded] = useState<{ companyId: string; register: GiroRegister } | null>(null)
  useEffect(() => {
    if (!companyId) return
    let live = true
    void loadGiroRegister(supabase, companyId).then((register) => {
      if (live) setGiroLoaded({ companyId, register })
    })
    return () => {
      live = false
    }
  }, [companyId, supabase])
  const giroRegister = giroLoaded && giroLoaded.companyId === companyId ? giroLoaded.register : null
  const giroCounterpartyFor = useCallback(
    (tx: TransactionWithInvoice): GiroCounterparty | null => (giroRegister ? readGiroCounterparty(tx, giroRegister) : null),
    [giroRegister],
  )
  const highlightId = searchParams.get('highlight')
  // ?open=match beside ?highlight: also open the row's suggested match (Att
  // göra sends a match that needs a decision here, e.g. an overpayment).
  const openMatchOnHighlight = searchParams.get('open') === 'match'
  // Tracks the last highlight target we acted on so re-renders don't re-trigger
  // the auto-open every time the user closes the categorize panel.
  const handledHighlightRef = useRef<string | null>(null)
  const refreshTransactionsInFlightRef = useRef(false)
  const refreshTransactionsQueuedRef = useRef(false)

  // "Kör matchning igen" in the review surface.
  const [rerunningMatch, setRerunningMatch] = useState(false)

  // Open rows that carry the quiet "från perioden före din migrering" marker:
  // dated inside the imported bokföring's coverage AND explained by it (an
  // unlinked voucher set of the same amount within a week, see
  // GET /api/transactions/migration-coverage). Date alone marked rows the old
  // system never booked as "most likely already imported" (crm#1239). It
  // never suggests a sync skip date (that was #917).
  //
  // Asked again only when rows ARRIVE (first load, a sync, a company switch):
  // a booked or ignored row just leaves the inbox and needs no new answer. A
  // generation counter, not an effect cleanup, discards a stale answer, so a
  // booking mid-request (the count drops) does not cancel the in-flight one.
  const [preMigrationIds, setPreMigrationIds] = useState<ReadonlySet<string>>(() => new Set())
  const pendingRowCount = useMemo(
    () => transactions.reduce((n, t) => (t.is_business === null && !t.is_ignored ? n + 1 : n), 0),
    [transactions],
  )
  const preMigrationAskedRef = useRef<{ companyId: string | null; count: number }>({ companyId: null, count: 0 })
  const preMigrationGenerationRef = useRef(0)
  useEffect(() => {
    const asked = preMigrationAskedRef.current
    const sameCompany = asked.companyId === companyId
    preMigrationAskedRef.current = { companyId, count: pendingRowCount }
    if (!sameCompany) {
      preMigrationGenerationRef.current++
      setPreMigrationIds(new Set())
    }
    if (!companyId || pendingRowCount === 0 || (sameCompany && pendingRowCount <= asked.count)) return
    const generation = ++preMigrationGenerationRef.current
    ;(async () => {
      try {
        const response = await fetch('/api/transactions/migration-coverage')
        if (!response.ok) return
        const payload = (await response.json()) as { data?: { explained_ids?: string[] } }
        if (generation === preMigrationGenerationRef.current) {
          setPreMigrationIds(new Set(payload.data?.explained_ids ?? []))
        }
      } catch {
        // Advisory: without an answer no row carries the marker, the same as
        // a row the ledger does not explain. The booking doors keep their guard.
      }
    })()
  }, [companyId, pendingRowCount])

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
        const aHasMatch = a.potential_invoice || a.potential_supplier_invoice || a.potential_rot_rut_payout || a.potential_expense_payout ? 1 : 0
        const bHasMatch = b.potential_invoice || b.potential_supplier_invoice || b.potential_rot_rut_payout || b.potential_expense_payout ? 1 : 0
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
  // Booking, matching or ignoring a skattekonto row here changes the nav
  // badge, which counts these rows too; skattekonto has no realtime channel,
  // so the reloaded list moves it. The first count is the page load itself.
  const skvUnmatchedCountRef = useRef<number | null>(null)
  useEffect(() => {
    const previous = skvUnmatchedCountRef.current
    skvUnmatchedCountRef.current = skvUnmatched.length
    if (previous !== null && previous !== skvUnmatched.length) refreshWorklistBadges()
  }, [skvUnmatched.length])

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
  // Under Ignorerade every ignored row in state shows, window or not: that
  // list is sparse by nature and reads as nothing missing.
  const historyTransactions = useMemo(
    () =>
      transactions.filter(
        (t) =>
          (!pagedThroughDate ||
            t.date >= pagedThroughDate ||
            (historyFilter === 'ignored' && t.is_ignored)) &&
          // Server-side scope catches up on refetch; this keeps the view
          // correct in the transition frame after a filter change.
          isWithinBounds(t.date, periodBounds),
      ),
    [transactions, pagedThroughDate, periodBounds, historyFilter],
  )

  // SKV rows shown in the history view, narrowed to the active period. The
  // list component filters by search/source itself but knows nothing about
  // period bounds.
  const skvRowsInScope = useMemo(
    () => skvRows.filter((r) => isWithinBounds(r.transaktionsdatum, periodBounds)),
    [skvRows, periodBounds],
  )

  // Account chooser (concept scene 10): the source picker doubles as a
  // balance readout. The total sums only SEK ledgers (mixing currencies into
  // one figure would be a lie); null hides the annotation entirely. A company
  // card's balance is a debt, not cash: "Alla konton" never nets it against
  // the bank (the card keeps its own figure in the picker).
  const totalSourceBalance = useMemo(() => {
    const sekBalances = cashAccounts.filter(
      (a) => a.currency === 'SEK' && a.balance != null && (a.kind ?? 'bank') === 'bank',
    )
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

  // The company card the source picker narrows to, if it is one.
  const emptyCardSource = useMemo(
    () => cashAccounts.find((a) => a.kind === 'card' && `acct:${a.id}` === effectiveSourceFilter) ?? null,
    [cashAccounts, effectiveSourceFilter],
  )

  // Skattekonto rows a verifikat already holds (imported history, PH 171):
  // one line with the one action that links them all, instead of a cover
  // answer per row. Read only while open skattekonto rows are in view; the
  // count reloads as the open rows change.
  const [skvLinkAllOpen, setSkvLinkAllOpen] = useState(false)
  const { count: skvLedgerProposals, refresh: refreshSkvLedgerProposals } =
    useSkattekontoLedgerProposalCount(
      skvUnmatched.length > 0 && skattekontoInSource(effectiveSourceFilter),
      skvUnmatched.length,
    )

  // Every pending row (bank + skattekonto) in exactly one bucket: shown by
  // the active source and period (the tab badge), hidden by the source, or
  // outside the period. The badge reads the same source predicate as the
  // list below (lib/transactions/inbox-scope), so it counts what the list
  // shows: before, it counted bank rows only, from a separate DB head count
  // that ignored the source picker (crm#1056, crm#1043). BFL 5 kap: pending
  // affarshandelser must never disappear silently, so the footer names each
  // hidden count with a one-click way back.
  const inboxScope = useMemo(
    () =>
      countInboxScope({
        bankRows: uncategorizedTransactions,
        skattekontoRows: skvUnmatched,
        source: effectiveSourceFilter,
        period: periodBounds,
        leaving: exitingIds,
      }),
    [effectiveSourceFilter, exitingIds, periodBounds, skvUnmatched, uncategorizedTransactions],
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
        if (!bankRowInSource(tx.cash_account_id, effectiveSourceFilter)) continue
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
    if (skattekontoInSource(effectiveSourceFilter)) {
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

  // ... plus the visible unbooked skattekonto rows. Ignorera applies to all
  // of them; Bokför only to the deterministic subset (rule matched, no
  // duplicate hint, genomförd), which goes through the skatteverket
  // extension's bokfor-batch endpoint instead.
  const selectableSkvIds = useMemo(
    () =>
      inboxItems
        .filter(
          (item) =>
            item.source === 'skatteverket' &&
            isSkvSelectable(item.data) &&
            !exitingIds.has(item.data.id),
        )
        .map((item) => item.data.id),
    [exitingIds, inboxItems],
  )

  // Shift-click ranges run per selection set: bank rows and skattekonto rows
  // are interleaved in one table but are booked through different endpoints,
  // so each range walks only its own selectable ids in rendered order.
  // Each selection holds only its own selectable rows of the current view:
  // a search, source, period or exit animation that hides a ticked row drops
  // it, so the bar never counts or acts on a row the user cannot see.
  const bankSelection = useBulkSelection(selectableInboxIds)
  const skvSelection = useBulkSelection(selectableSkvIds)
  const selectedIds = bankSelection.selectedIds
  const skvSelectedIds = skvSelection.selectedIds

  const skvSelectedRows = useMemo(
    () => skvRows.filter((r) => skvSelectedIds.has(r.id)),
    [skvRows, skvSelectedIds],
  )

  // The subset of the selection that bulk Bokför can take: the button, the
  // confirmation summary and the submit all read this one list.
  const skvBookableSelectedRows = useMemo(
    () => skvSelectedRows.filter(isSkvBulkEligible),
    [skvSelectedRows],
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
    for (const row of skvBookableSelectedRows) {
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
  }, [skvBookableSelectedRows])

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
      if (isSkattekontoLedgerAccount(json.data?.skattekonto_account)) setSkvAccount(json.data.skattekonto_account)
      // Keep all booked SKV rows in state: inbox view filters to obokförda
      // (journal_entry_id null), history view shows all of them (matched
      // and unmatched) interleaved with bank tx by date.
      setSkvRows(booked)
    } catch {
      if (skvFetchSeqRef.current !== seq) return
      setSkvRows([])
    }
  }, [])

  // Rows were linked from the skattekonto cover answer or the line above.
  const handleSkvLinked = useCallback(() => {
    void loadSkvRows()
    refreshSkvLedgerProposals()
  }, [loadSkvRows, refreshSkvLedgerProposals])

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
      const windowPage = async (offset: number, limit: number) => {
        let windowQuery = supabase
          .from('transactions')
          .select(TRANSACTION_WINDOW_SELECT)
          .eq('company_id', companyId)
        if (periodBounds) {
          windowQuery = windowQuery.gte('date', periodBounds.start).lte('date', periodBounds.end)
        }
        // The id tie-breaker keeps offset paging deterministic when many
        // rows share a date; without it .range() pages can skip or repeat
        // same-date rows.
        const { data, error } = await windowQuery
          .order('date', { ascending: false })
          .order('id', { ascending: true })
          .range(offset, offset + limit - 1)
        if (error) throw error
        return { data: ((data ?? []) as TransactionWithInvoice[]).map(withLivePointer) }
      }

      const [{ data: txData, error: txError }, pendingRows, ignoredRows] = await Promise.all([
        // A refresh after "Visa fler" reloads the whole window the user paged
        // through. One request is cut at 1,000 rows, which shrank a larger
        // window and hid the button although older rows remained, so the
        // window is collected in chunks.
        collectPages(windowPage, { want: windowSize }).then(
          ({ data }) => ({ data, error: null }),
          (error: unknown) => ({ data: null, error }),
        ),
        // The inbox is a worklist: it must contain every pending row, even ones
        // older than the newest-first window above. Falls back to null so the
        // page still renders the windowed rows if this fetch dies; the failure
        // is surfaced below, never silently absorbed (an inbox that renders as
        // complete while missing older pending rows would be a lie).
        fetchAllRows<TransactionWithInvoice>(({ from, to }) =>
          supabase
            .from('transactions')
            .select(TRANSACTION_LIST_SELECT)
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
        // Alla → Ignorerade promises every ignored row of the period, the
        // place the ignore texts send users to restore one (crm#1612), so
        // they all load, not only those inside the window. They are few.
        fetchAllRows<TransactionWithInvoice>(({ from, to }) => {
          let ignoredQuery = supabase
            .from('transactions')
            .select(TRANSACTION_WINDOW_SELECT)
            .eq('company_id', companyId)
            .eq('is_ignored', true)
          if (periodBounds) {
            ignoredQuery = ignoredQuery.gte('date', periodBounds.start).lte('date', periodBounds.end)
          }
          return ignoredQuery
            .order('date', { ascending: false })
            .order('id', { ascending: true })
            .range(from, to)
        }).then(
          (rows) => rows.map(withLivePointer),
          (error: unknown) => {
            console.error('[transactions] ignored rows fetch failed; Ignorerade may be missing older rows', error)
            return null
          },
        ),
      ])

      // A newer fetch (scope change, refresh) started while this one was in
      // flight: its results own the state now, so this response must not
      // apply. Its failure state is skipped too; the newer request reports
      // its own fate.
      if (fetchGenerationRef.current !== generation) return

      if (txError) {
        setLoadFailure('failed')
        return
      }

      // Partial load: the windowed rows render, but older pending (or
      // ignored) rows are absent. Say so instead of presenting a
      // complete-looking list.
      setLoadFailure(pendingRows === null || ignoredRows === null ? 'partial' : null)

      const rows = txData || []
      const windowIds = new Set(rows.map((r) => r.id))
      const olderPending = (pendingRows ?? []).filter((r) => !windowIds.has(r.id))
      // Never pending (the backlog excludes ignored rows), so no overlap there.
      const olderIgnored = (ignoredRows ?? []).filter((r) => !windowIds.has(r.id))
      const allRows = [...rows, ...olderPending, ...olderIgnored].sort((a, b) => b.date.localeCompare(a.date))
      const [{ invoiceMap, supplierInvoiceMap, voucherMap, rotRutByTransaction }, expensePayouts] = await Promise.all([
        fetchPotentialMatches(supabase, companyId, allRows),
        fetchExpensePayoutMatches(supabase, companyId, allRows),
      ])
      const expensePayoutMap = expensePayouts.byTransaction

      // Re-check after the second await: a scope change during the match
      // enrichment must also discard this response.
      if (fetchGenerationRef.current !== generation) return
      setHasOpenExpenseClaims(expensePayouts.people.length > 0)

      const transactionsWithInvoices: TransactionWithInvoice[] = allRows.map((t) => ({
        ...t,
        potential_expense_payout: expensePayoutMap.get(t.id),
        potential_invoice: t.potential_invoice_id ? invoiceMap[t.potential_invoice_id] : undefined,
        potential_supplier_invoice: t.potential_supplier_invoice_id
          ? supplierInvoiceMap[t.potential_supplier_invoice_id]
          : undefined,
        potential_rot_rut_payout: rotRutByTransaction.get(t.id),
        potential_voucher: t.potential_journal_entry_id
          ? voucherMap[t.potential_journal_entry_id]
          : undefined,
      }))

      setTransactions(transactionsWithInvoices)
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
  }, [companyId, loadSkvRows, periodBounds, supabase])

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
      .select(TRANSACTION_WINDOW_SELECT)
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
    const pageRows = (txData as TransactionWithInvoice[]).map(withLivePointer)

    const [{ invoiceMap, supplierInvoiceMap, voucherMap, rotRutByTransaction }, expensePayouts] = await Promise.all([
      fetchPotentialMatches(supabase, companyId, pageRows),
      fetchExpensePayoutMatches(supabase, companyId, pageRows),
    ])
    const expensePayoutMap = expensePayouts.byTransaction

    // Same staleness rule after the enrichment await: the offsets above were
    // written under this generation, but a newer fetch has already reset them.
    if (fetchGenerationRef.current !== generation) {
      setIsLoadingMore(false)
      return
    }

    const newTransactions: TransactionWithInvoice[] = pageRows.map((t) => ({
      ...t,
      potential_expense_payout: expensePayoutMap.get(t.id),
      potential_invoice: t.potential_invoice_id ? invoiceMap[t.potential_invoice_id] : undefined,
      potential_supplier_invoice: t.potential_supplier_invoice_id
        ? supplierInvoiceMap[t.potential_supplier_invoice_id]
        : undefined,
      potential_rot_rut_payout: rotRutByTransaction.get(t.id),
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
  // RPC), and which are exempted via journal_entry_no_doc_required; then the
  // customer-invoice hänvisning (getInvoiceReferencesForJournalEntries, #2298).
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
        // Customer invoices pointing at the JE (registration link or payment
        // row) back it under BFL 5 kap 7 §. On a failed lookup this chunk's
        // verdict is UNKNOWN: without the references, 'missing' would be a
        // false warning and 'has' a false pass, so the chunk gets no badges
        // (the same degrade the reads above use) while the remaining chunks
        // still get theirs.
        let invoiceRefs: Map<string, string[]>
        try {
          invoiceRefs = await getInvoiceReferencesForJournalEntries(supabase, companyId, chunk)
        } catch {
          continue
        }
        for (const journalEntryId of invoiceRefs.keys()) jeIdsWithDocs.add(journalEntryId)
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

  /**
   * Read the rows the person can see before they open one.
   *
   * The ten-minute cron reads the newest transactions fleet-wide; this covers
   * what is on screen right now (an older row, or one whose receipt arrived
   * after its read). Sequential and capped, so a long list is never a burst
   * of model calls, and it stops on the first refusal: an installation with
   * no AI backend answers 503 once and is then left alone.
   */
  // The rows worth reading ahead: the top of the list, unbooked, without a
  // fresh read. A string key, so a refetch that lands the same rows does not
  // start the sweep again.
  const warmKey = useMemo(() => {
    const warmed = warmedReadsRef.current.companyId === companyId ? warmedReadsRef.current.ids : new Set<string>()
    return transactions
      .slice(0, ASSISTANT_WARM_WINDOW)
      .filter(
        (tx) =>
          tx.is_business === null &&
          !tx.journal_entry_id &&
          !tx.is_ignored &&
          !warmed.has(tx.id) &&
          !(assistantReadsRef.current[tx.id] && readIsFresh(assistantReadsRef.current[tx.id], tx)),
      )
      .slice(0, ASSISTANT_WARM_LIMIT)
      .map((tx) => tx.id)
      .join(',')
  }, [companyId, transactions])

  useEffect(() => {
    if (!companyId || !warmKey || !canAskAssistant) return
    if (warmedReadsRef.current.companyId !== companyId) {
      warmedReadsRef.current = { companyId, ids: new Set() }
      assistantReadsRef.current = {}
    }
    const warmed = warmedReadsRef.current.ids
    const pending = warmKey.split(',').map((id) => transactions.find((tx) => tx.id === id)).filter((tx): tx is TransactionWithInvoice => !!tx)

    // The sweep is background work: it waits for the browser to be idle and
    // the tab to be visible, so it never competes with the list's own paint.
    let cancelled = false
    const run = async () => {
      for (const tx of pending) {
        if (cancelled || document.visibilityState !== 'visible') return
        warmed.add(tx.id)
        try {
          const res = await fetch('/api/agent/categorize', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ transaction_id: tx.id }),
          })
          if (!res.ok) return
          const body = (await res.json()) as { data?: AssistantRead }
          if (cancelled || !body.data) return
          assistantReadsRef.current[tx.id] = body.data
        } catch {
          return
        }
      }
    }
    const idle = typeof window.requestIdleCallback === 'function'
      ? window.requestIdleCallback(() => void run(), { timeout: 2000 })
      : window.setTimeout(() => void run(), 1000)
    return () => {
      cancelled = true
      if (typeof window.cancelIdleCallback === 'function') window.cancelIdleCallback(idle as number)
      else window.clearTimeout(idle as number)
    }
    // The key already encodes the rows; re-running on the list's identity
    // would walk the backlog on every realtime echo.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [companyId, warmKey, canAskAssistant])

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
      if (data.salary_payouts) setSalaryPayouts(data.salary_payouts as Record<string, SalaryRunPayout>)
      if (data.direct_booking) setDirectBooking(data.direct_booking as DirectBookingSettings)
      if (data.assistant_reads) Object.assign(assistantReadsRef.current, data.assistant_reads)
    } catch {
      // Non-critical
    }
  }

  // The initial fetch waits for the app-wide year to restore. Fetching at
  // mount used to race the restore: an unscoped fetch painted the list, the
  // restore re-created fetchTransactions and re-ran this effect with a second
  // skeleton takeover, so every visit flashed list → skeleton → list.
  const fyReady = fiscalScope.ready
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

  // Page state must not survive a company switch (React's
  // adjust-state-on-prop-change pattern). The app-wide year resets itself:
  // fiscalScope.ready is false until the new company's year is restored,
  // which holds the fetch effect below.
  const [scopeCompanyId, setScopeCompanyId] = useState<string | null>(companyId)
  if (scopeCompanyId !== companyId) {
    setScopeCompanyId(companyId)
    setShowAllYears(false)
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
      // The nav badge has no channel of its own any more: this one, live
      // while the user looks at the inbox, moves it.
      refreshWorklistBadges()
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
    const stopJoin = subscribeAsUser(supabase, channel)

    return () => {
      cancelled = true
      stopJoin()
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
    if (transactions.length === 0 && skvRows.length === 0) return
    const tx = transactions.find((t) => t.id === highlightId)
    // A verifikat's "Visa transaktion" can also point at a skattekonto row.
    const skvRow = tx ? null : skvRows.find((r) => r.id === highlightId)
    if (!tx && !skvRow) return
    handledHighlightRef.current = highlightId

    // The inbox never renders a row that is already booked or ignored, and a
    // link from a verifikat lands on exactly such a row: widen to the history
    // view, in memory only, so the deep link has something to scroll to.
    const outsideInbox = tx
      ? tx.is_business !== null || tx.is_ignored
      : Boolean(skvRow?.journal_entry_id || skvRow?.is_ignored)
    if (outsideInbox && mode === 'inbox') setMode('history')
    // The history chip must show it too: an ignored row lives under
    // Ignorerade, which also reaches past the loaded window (crm#1612).
    if (outsideInbox) setHistoryFilter(tx?.is_ignored ? 'ignored' : 'all')

    // A deep link must land on a visible row: when the remembered source
    // filter would hide the highlighted transaction, widen to 'all' in
    // memory only (storage keeps the user's choice for the next visit).
    // Checked against the WANTED filter, not the effective one: transactions
    // can load before cash accounts, when the effective filter is still 'all'
    // but the wanted one would hide the row the moment the accounts arrive.
    // 'all' rather than acct:<id> because it also covers rows with a null
    // cash_account_id.
    // Skattekonto rows belong to no cash account, so any bank-side
    // narrowing hides them.
    const hiddenByFilter = tx
      ? sourceFilter === 'skatteverket' ||
        (sourceFilter.startsWith('acct:') &&
          tx.cash_account_id !== sourceFilter.slice('acct:'.length)) ||
        (sourceFilter === 'bank:other' && tx.cash_account_id != null)
      : sourceFilter !== 'all' && sourceFilter !== 'skatteverket'
    if (hiddenByFilter) setSourceFilter('all')

    // Defer the scroll until React has committed the list to the DOM.
    // Without rAF the data-tx-id node may not exist yet when this fires
    // immediately after fetchTransactions resolves.
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = document.querySelector(`[data-tx-id="${highlightId}"]`)
        if (el && 'scrollIntoView' in el) {
          el.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }
      })
    })

    if (openMatchOnHighlight && tx?.potential_invoice) {
      setSelectedTransaction(tx)
      setMatchDialogOpen(true)
    }
  }, [highlightId, mode, openMatchOnHighlight, skvRows, sourceFilter, transactions])

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

  const handleCategorize: CategorizeHandler = async (id, isBusiness, category, vatTreatment, accountOverride, templateId, inboxItemId, dimensions, vatAmount) => {
    const outcome = await runCategorize({ id, isBusiness, category, vatTreatment, accountOverride, templateId, inboxItemId, dimensions, vatAmount, confirmNoMatch: false })
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
    /** What was booked and why, for a booking that skipped the review. */
    narration?: string
  }) {
    const { id, isBusiness, category, journalEntryId, journalEntryCreated, journalEntryError, silent, narration } = args
    // A completed Ångra must win over the delayed patch below. The undo has
    // already storno-reversed the verifikat server-side, so re-applying the
    // booked shape afterwards would show a journal_entry_id that no longer
    // represents a live entry.
    let undone = false
    // A fresh booking supersedes any earlier undo of the same row: without
    // this, a row booked again after an Ångra would skip its delayed patch.
    undoneIdsRef.current.delete(id)

    setExitingIds((prev) => new Set(prev).add(id))

    if (silent) {
      // No per-row toast: fall through to the delayed state patch below.
    } else if (journalEntryCreated) {
      toast({
        title: 'Bokförd',
        description: narration,
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
    /** The basis box of a reverse charge the proposal names (ruta 21 or 22): sent as reverse_charge_kind. */
    reverseChargeKind?: ReverseChargeKind
    accountOverride?: string
    templateId?: string
    /** A learned counterpart rule: the server books its stored lines. */
    counterpartyTemplateId?: string
    /** The suggestion the booking started from, recorded in suggestion_log. */
    proposalId?: string
    /** false: the row's one click; true: booked from Granska bokföring. Sent as review_shown. */
    reviewShown?: boolean
    /** Bokför valda: no booking's review seen, so a booking a block matches is refused (in_bulk). */
    inBulk?: boolean
    /** The server sent a one click to its review (TX_CATEGORIZE_REVIEW_REQUIRED): open it instead of a failure toast. */
    onReviewRequired?: () => void
    inboxItemId?: string
    dimensions?: Record<string, string>
    /** The underlag's moms (transaction currency): sent as vat_amount. */
    vatAmount?: number
    confirmNoMatch: boolean
    /** The person's word that the VAT on the underlag is foreign VAT charged in error: sent as confirm_foreign_seller_vat (crm#1765). */
    confirmForeignSellerVat?: boolean
    /** The person's answer to the filed-momsperiod warning: sent as confirm_filed_vat_period. */
    confirmFiledVatPeriod?: boolean
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
    /** What was booked and why, shown on the Bokförd toast of a booking that skipped the review. */
    narration?: string
    // ok distinguishes "the server accepted the categorization" from "nothing
    // happened". A 2xx with a null journal_entry_id is a real success (e.g. an
    // already-categorized flag flip), so the id alone cannot carry that signal:
    // the batch aggregate would count the row as failed after finishBooking
    // already animated it out of the inbox. deferredDuplicate is the third
    // state: a silent row the duplicate guard flagged, parked for the batch's
    // single confirmation and therefore neither booked nor failed.
  }): Promise<BatchCategorizeOutcome> {
    const { id, isBusiness, category, vatTreatment, reverseChargeKind, accountOverride, templateId, counterpartyTemplateId, proposalId, reviewShown, inBulk, onReviewRequired, inboxItemId, dimensions, vatAmount, confirmNoMatch, confirmForeignSellerVat, confirmFiledVatPeriod, force, expectedDuplicateJournalEntryId, silent, narration } = args
    try {
      setProcessingId(id)
      const response = await fetch(`/api/transactions/${id}/categorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_business: isBusiness,
          category,
          vat_treatment: vatTreatment,
          ...(reverseChargeKind ? { reverse_charge_kind: reverseChargeKind } : {}),
          account_override: accountOverride,
          template_id: templateId,
          ...(counterpartyTemplateId ? { counterparty_template_id: counterpartyTemplateId } : {}),
          ...(proposalId ? { proposal_id: proposalId } : {}),
          ...(reviewShown !== undefined ? { review_shown: reviewShown } : {}),
          ...(inBulk ? { in_bulk: true } : {}),
          inbox_item_id: inboxItemId,
          ...(dimensions && Object.keys(dimensions).length > 0 ? { dimensions } : {}),
          ...(vatAmount != null ? { vat_amount: vatAmount } : {}),
          ...(confirmNoMatch ? { confirm_no_match: true } : {}),
          ...(confirmForeignSellerVat ? { confirm_foreign_seller_vat: true } : {}),
          ...(confirmFiledVatPeriod ? { confirm_filed_vat_period: true } : {}),
          ...(force && expectedDuplicateJournalEntryId
            ? { force: true, expected_duplicate_journal_entry_id: expectedDuplicateJournalEntryId }
            : {}),
        }),
      })

      const result = await response.json()
      if (!response.ok) {
        if (result?.error?.code === 'TX_CATEGORIZE_REVIEW_REQUIRED' && onReviewRequired) {
          // The company or the rule asks for a review the page did not know
          // of yet (a setting changed in another tab): nothing was booked,
          // so the review opens on the same proposal.
          setProcessingId(null)
          onReviewRequired()
          return { ok: false, journalEntryId: null }
        }
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
          const retry = () =>
            runCategorize({
              ...args,
              force: true,
              expectedDuplicateJournalEntryId: candidate.journal_entry_id,
            })
          if (silent) {
            // A batch row: park it. One modal slot cannot answer N parallel
            // questions, and the rows that lost the race were counted as
            // failures with no explanation (#2488). handleBatchCategorize asks
            // once, with every candidate listed, after the pool settles.
            batchDuplicatesRef.current.push({ transactionId: id, candidate, retry })
            setProcessingId(null)
            return { ok: false, journalEntryId: null, deferredDuplicate: true }
          }
          setDuplicateWarning({ transactionId: id, retry, candidate })
          setProcessingId(null)
          return { ok: false, journalEntryId: null }
        }
        if (
          result?.error?.code === 'TX_CATEGORIZE_VAT_PERIOD_FILED' &&
          Array.isArray(result.error.details?.warnings) &&
          result.error.details.warnings.length > 0
        ) {
          // Nothing was booked. The dialog shows the warning (the period and
          // its filing date); "Bokför ändå" sends the same booking again with
          // the confirmation, and the server asks its question once more.
          const warnings = result.error.details.warnings as VoucherWarning[]
          const retry = () => runCategorize({ ...args, confirmFiledVatPeriod: true })
          if (silent) {
            // A batch row: park it, and handleBatchCategorize asks once for
            // every held row after the pool settles.
            batchFiledVatRef.current.push({ transactionId: id, warning: warnings[0], retry })
            setProcessingId(null)
            return { ok: false, journalEntryId: null, heldForFiledVat: true }
          }
          setFiledVatConfirm({ warnings, retry })
          setProcessingId(null)
          return { ok: false, journalEntryId: null }
        }
        if (
          !silent &&
          result?.error?.code === 'TX_CATEGORIZE_REVERSE_CHARGE_SELLER_VAT' &&
          result.error.details?.reason === 'not_confirmed'
        ) {
          // crm#1765: the underlag shows the seller's VAT. Foreign VAT charged
          // in error still books as reverse charge, on the whole amount paid,
          // once the person says that is what it is; a Swedish seller's VAT
          // (reason seller_vat_swedish) keeps the plain refusal below.
          toast({
            title: t('rc_seller_vat_title'),
            description: t('rc_seller_vat_description'),
            action: (
              <ToastAction
                altText={t('rc_seller_vat_confirm_action')}
                onClick={() => void runCategorize({ ...args, confirmForeignSellerVat: true })}
              >
                {t('rc_seller_vat_confirm_action')}
              </ToastAction>
            ),
          })
          setProcessingId(null)
          return { ok: false, journalEntryId: null }
        }
        if (result?.error?.code === 'TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED') {
          // Issue #1661: a private marking is a real booking (eget uttag /
          // insättning), so a locked period refuses it. The row being cleared
          // is usually no affärshändelse at all: offer Ignorera (no verifikat,
          // allowed in a locked period) on the toast. Interactive escalation,
          // so it shows for batch rows too: it is the only way forward.
          const lockedTx = transactions.find((t) => t.id === id)
          toast({
            title: t('private_locked_title'),
            description: getErrorMessage(result, { context: 'transaction', statusCode: response.status }),
            variant: 'destructive',
            action: lockedTx ? (
              <ToastAction
                altText={t('private_locked_ignore_action')}
                onClick={() => void handleIgnoreTransaction(lockedTx)}
              >
                {t('private_locked_ignore_action')}
              </ToastAction>
            ) : undefined,
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
        // The batch toast names why its failed rows were refused (for #206):
        // a silent row has no toast of its own to say it.
        return {
          ok: false,
          journalEntryId: null,
          failureReason: getErrorMessage(result, { context: 'transaction', statusCode: response.status, locale: errorLocale }),
        }
      }

      finishBooking({
        id,
        isBusiness,
        category: result.category,
        journalEntryId: result.journal_entry_id,
        journalEntryCreated: result.journal_entry_created,
        journalEntryError: result.journal_entry_error,
        silent,
        narration,
      })

      return { ok: true, journalEntryId: result.journal_entry_id || null }
    } catch {
      if (!silent) {
        toast({ title: t('booking_failed_title'), description: t('booking_failed_description'), variant: 'destructive' })
      }
      setProcessingId(null)
      return { ok: false, journalEntryId: null, failureReason: t('booking_failed_description') }
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
    // write plus an Ångra toast gives two recovery affordances. Alla →
    // Ignorerade on this page (Återställ per row) is the standing third, and
    // the account's Ignorerade band under Konton a fourth (crm#1612).
    const ok = await confirm({
      title: 'Ignorera transaktionen?',
      description: `${tx.description}, ${formatCurrency(tx.amount, tx.currency)} (${formatDate(tx.date)}) försvinner från listan utan att bokföras. Använd bara för poster som inte är affärshändelser, t.ex. dubbletter eller överföringar mellan egna konton. Riktiga köp och betalningar ska bokföras. Du kan återställa den när som helst under Alla → Ignorerade.`,
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
          description: result.error ? getErrorMessage(result, { locale: errorLocale }) : undefined,
          variant: 'destructive',
        })
        return
      }
      setExitingIds((prev) => new Set(prev).add(tx.id))
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
    } catch {
      toast({ title: 'Kunde inte återställa transaktionen', variant: 'destructive' })
    }
  }

  async function handleConfirmInvoiceMatch(opts?: ConfirmOpts) {
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
      if (opts?.force) {
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
      // Where a customer's excess goes, with the excess the dialog showed:
      // the route books exactly that or refuses (crm#1045).
      if (!isSupplier && opts?.overpayment_account && opts.overpayment_amount !== undefined) {
        body.overpayment_account = opts.overpayment_account
        body.overpayment_amount = opts.overpayment_amount
      }
      // The payment provider's fee on 6570, with the fee the dialog showed
      // (crm#1364): booked exactly or refused, like the overpayment.
      if (!isSupplier && opts?.fee_account && opts.fee_amount !== undefined) {
        body.fee_account = opts.fee_account
        body.fee_amount = opts.fee_amount
      }
      // Reverse the row's own categorization and match: only from the soft
      // block's button, after the refusal named the verifikat.
      if (isSupplier && opts?.storno_existing) {
        body.storno_existing = true
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const result = await response.json()
      if (!response.ok) {
        // A booked row is not a failure to toast: the dialog says which
        // verifikat books it, and how the row opens again.
        const refusal = (result as { error?: { code?: unknown; details?: { journal_entry_id?: unknown; voucher?: unknown; storno_allowed?: unknown } } })?.error
        if (refusal?.code === (isSupplier ? 'MATCH_SI_TX_ALREADY_BOOKED' : 'MATCH_INVOICE_TX_ALREADY_BOOKED')) {
          setMatchAlreadyBooked({
            transactionId: selectedTransaction.id,
            journalEntryId: typeof refusal.details?.journal_entry_id === 'string' ? refusal.details.journal_entry_id : null,
            voucher: typeof refusal.details?.voucher === 'string' ? refusal.details.voucher : null,
            stornoAllowed: refusal.details?.storno_allowed === true,
            message: getErrorMessage(result, { locale: errorLocale }),
          })
          setIsConfirmingMatch(false)
          return
        }
        toast({
          title: isSupplier ? 'Leverantörsfakturamatchning misslyckades' : 'Fakturamatchning misslyckades',
          description: getErrorMessage(result, { context: 'transaction' }),
          variant: 'destructive',
        })
        setIsConfirmingMatch(false)
        return
      }

      const label = isSupplier
        ? `Leverantörsfaktura ${supplierInvoiceReference(
            selectedTransaction.potential_supplier_invoice!.supplier_invoice_number,
            selectedTransaction.potential_supplier_invoice!.arrival_number,
          )} markerad som betald`
        : `Faktura ${selectedTransaction.potential_invoice!.invoice_number} markerad som betald`
      toast({ title: isSupplier ? 'Leverantörsfaktura matchad' : 'Faktura matchad', description: label })
      setMatchDialogOpen(false)
      setMatchAlreadyBooked(null)

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
                    category: (result.category ?? t.category) as TransactionCategory,
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

  async function handleConfirmExpensePayoutMatch() {
    if (!selectedTransaction?.potential_expense_payout) return
    const person = selectedTransaction.potential_expense_payout
    setIsConfirmingMatch(true)
    try {
      const response = await fetch(
        `/api/transactions/${selectedTransaction.id}/match-expense-payout`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ claim_ids: person.claim_ids }),
        },
      )
      const result = await response.json()
      if (!response.ok) {
        toast({
          title: t('expense_payout_match_failed_title'),
          description: getErrorMessage(result, { context: 'transaction' }),
          variant: 'destructive',
        })
        setIsConfirmingMatch(false)
        return
      }

      toast({
        title: t('expense_payout_matched_title'),
        description: t('expense_payout_matched_description', { name: person.claimant_name }),
      })
      setExpensePayoutDialogOpen(false)
      applyExpensePayoutBooked(selectedTransaction.id, result.journal_entry_id, person.key)
    } catch (error) {
      toast({
        title: t('expense_payout_match_failed_title'),
        description: getErrorMessage(error, { context: 'transaction' }),
        variant: 'destructive',
      })
    } finally {
      setIsConfirmingMatch(false)
    }
  }

  // After a transfer booked one person's utlägg (one-click or via the
  // picker): the row leaves the inbox and every other row that suggested the
  // same person drops its suggestion, since that person is now paid.
  function applyExpensePayoutBooked(transactionId: string, journalEntryId: string, personKey: string) {
    setExitingIds((prev) => new Set(prev).add(transactionId))
    setTimeout(() => {
      setTransactions((prev) =>
        prev.map((tx) => {
          if (tx.id === transactionId) {
            return {
              ...tx,
              potential_expense_payout: undefined,
              is_business: true,
              category: 'expense_other' as TransactionCategory,
              journal_entry_id: journalEntryId,
            }
          }
          if (tx.potential_expense_payout?.key === personKey) {
            return { ...tx, potential_expense_payout: undefined }
          }
          return tx
        }),
      )
      setExitingIds((prev) => {
        const next = new Set(prev)
        next.delete(transactionId)
        return next
      })
      setSelectedTransaction(null)
    }, 350)
  }

  function handleExpenseClaimsPicked(transactionId: string, journalEntryId: string, personKey: string) {
    const person = matchExpenseTx?.potential_expense_payout
    toast({
      title: t('expense_payout_matched_title'),
      description: person
        ? t('expense_payout_matched_description', { name: person.claimant_name })
        : undefined,
    })
    setMatchExpenseTx(null)
    applyExpensePayoutBooked(transactionId, journalEntryId, personKey)
  }

  async function handleConfirmRotRutPayoutMatch() {
    if (!selectedTransaction?.potential_rot_rut_payout) return
    const { requests } = selectedTransaction.potential_rot_rut_payout
    if (requests.length === 0) return
    setIsConfirmingMatch(true)
    try {
      // One begäran or a bundle Skatteverket paid together: the route books
      // one voucher either way and takes the ids as request_ids.
      const response = await fetch(
        `/api/transactions/${selectedTransaction.id}/match-rot-rut-payout`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ request_ids: requests.map((request) => request.id) }),
        },
      )
      const result = await response.json()
      if (!response.ok) {
        toast({
          title: t('rot_rut_payout_match_failed_title'),
          description: getErrorMessage(result, { context: 'transaction' }),
          variant: 'destructive',
        })
        setIsConfirmingMatch(false)
        return
      }

      toast({
        title: t('rot_rut_payout_matched_title'),
        description:
          requests.length === 1
            ? t('rot_rut_payout_matched_description', { name: requests[0].name })
            : t('rot_rut_payout_matched_set_description', {
                count: requests.length,
                names: requests.map((request) => request.name).join(', '),
              }),
      })
      setRotRutMatchDialogOpen(false)

      setExitingIds((prev) => new Set(prev).add(selectedTransaction.id))
      setTimeout(() => {
        setTransactions((prev) =>
          prev.map((tx) =>
            tx.id === selectedTransaction.id
              ? {
                  ...tx,
                  potential_rot_rut_payout_request_id: null,
                  potential_rot_rut_payout: undefined,
                  is_business: true,
                  category: 'income_other' as TransactionCategory,
                  journal_entry_id: result.journal_entry_id,
                }
              : tx,
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

  // A bank account that books on another 19xx ledger account than the books
  // say (crm#1066): one sentence with the button that changes it, or null.
  // Read after the first render; applying it relinks, so the list is refetched.
  const ledgerSuggestionNotice = useBankLedgerSuggestionNotice({ onApplied: refreshTransactions })

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

  function handleSelectRotRutPayoutFromPicker(requests: PotentialRotRutPayoutRequest[]) {
    if (!invoicePickerTransaction || requests.length === 0) return
    // Same handoff as the invoice pick: close the picker, hang the begäran
    // (one, or the bundle the user ticked) on the row and open the ROT/RUT
    // confirm dialog so the user sees the 19xx / 1513 entry before it is
    // booked. The dialog refuses a bundle whose sum is off the row.
    const tx = invoicePickerTransaction
    setInvoicePickerOpen(false)
    setInvoicePickerTransaction(null)
    setSelectedTransaction({ ...tx, potential_rot_rut_payout: { requests } })
    setRotRutMatchDialogOpen(true)
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

  // Several invoices ticked in either picker (PH 192): close it and open the
  // batch allocation with them, where the samlingsverifikat is confirmed.
  function handleSelectSeveralFromPicker(allocations: BatchAllocationPrefill[]) {
    const tx = invoicePickerTransaction ?? supplierInvoicePickerTransaction
    if (!tx || allocations.length === 0) return
    setInvoicePickerOpen(false)
    setInvoicePickerTransaction(null)
    setSupplierInvoicePickerOpen(false)
    setSupplierInvoicePickerTransaction(null)
    openSplitMatchDialog(tx, allocations)
  }

  // The row pays more than the one invoice in the match dialog: carry that
  // invoice into the batch allocation, where the other ones are added.
  function handleSplitFromMatchDialog() {
    const tx = selectedTransaction
    if (!tx) return
    const prefill: BatchAllocationPrefill[] = []
    if (tx.amount > 0 && tx.potential_invoice) {
      const invoice = tx.potential_invoice
      prefill.push({
        kind: 'customer_invoice',
        invoice_id: invoice.id,
        amount: roundOre(Number(invoice.remaining_amount ?? invoice.total)),
      })
    } else if (tx.amount < 0 && tx.potential_supplier_invoice) {
      const invoice = tx.potential_supplier_invoice
      prefill.push({
        kind: 'supplier_invoice',
        supplier_invoice_id: invoice.id,
        amount: roundOre(Number(invoice.remaining_amount ?? invoice.total)),
      })
    }
    setMatchDialogOpen(false)
    openSplitMatchDialog(tx, prefill)
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

  function openSplitMatchDialog(transaction: TransactionWithInvoice, prefill?: BatchAllocationPrefill[]) {
    setSplitMatchTransaction(transaction)
    setSplitMatchPrefill(prefill ?? null)
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
    bankSelection.clear()
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
        bankSelection.deselect([id])
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
    skvSelection.deselect([rowId])
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

  function toggleSkvSelect(id: string, extend?: boolean) {
    skvSelection.toggle(id, extend)
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

    skvSelection.deselect([row.id])
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
    const ids = skvBookableSelectedRows.map((r) => r.id)
    if (ids.length === 0) {
      setSkvBulkConfirmOpen(false)
      skvSelection.clear()
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
    skvSelection.clear()

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
                  : code === 'LEDGER_TWIN_EXISTS'
                    ? t('skv_err_ledger_twin')
                    : code === 'LEDGER_COVER_EXISTS'
                      ? t('skv_err_ledger_cover')
                      : code === 'LEDGER_DIRECT_EXISTS'
                        ? t('skv_err_ledger_direct')
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
    setBookingDialogLineDescription(null)
    if (matched) {
      toast({ title: 'Bankhändelsen kopplad', description: 'Ingen ny bokföring skapad.' })
    } else {
      toast({ title: 'Bokförd' })
    }
  }

  function openAttachDocumentDialog(transaction: TransactionWithInvoice) {
    setAttachDocTx(transaction)
  }

  // The booking dialogs pin a document to the row the moment it is attached
  // there, and take it off on its x (crm#1101): the list follows, so the
  // row shows its underlag and the next open starts with it. The dialogs
  // revalidate the underlag read and tell the inbox card themselves.
  function handleUnderlagChanged(transactionId: string, documentId: string | null) {
    setTransactions((prev) =>
      prev.map((t) => (t.id === transactionId ? { ...t, document_id: documentId } : t))
    )
  }

  function handleDocumentAttached(transactionId: string, documentId: string) {
    setTransactions((prev) =>
      prev.map((t) => (t.id === transactionId ? { ...t, document_id: documentId } : t))
    )
    // The drawer and the review read the underlag through SWR; without this
    // the receipt only appeared there on the next revalidation.
    void revalidateUnderlag(transactionId)
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

  /**
   * "Ta bort underlag" (#2132): confirm, then DELETE attach-document. On
   * success the pin is cleared in the list, in the attach dialog's own row
   * snapshot, and in the inbox card's optimistic override. A 409 (doc already
   * on a verifikation, or the row changed under us) shows the route's Swedish
   * message verbatim; other failures map through get-error-message.
   */
  async function handleDetachDocument(tx: TransactionWithInvoice) {
    // Same idiom as Ignorera: the pin is reversible (re-attach), but the
    // indicator vanishes immediately, so confirm before the write.
    const ok = await confirm({
      title: tDetach('confirm_title'),
      description: tDetach('confirm_body', {
        description: tx.description,
        amount: formatCurrency(tx.amount, tx.currency),
      }),
      confirmLabel: tDetach('confirm_label'),
      cancelLabel: tDetach('cancel_label'),
      variant: 'warning',
    })
    if (!ok) return

    try {
      const res = await fetch(`/api/transactions/${tx.id}/attach-document`, { method: 'DELETE' })
      const result: unknown = await res.json().catch(() => null)
      const errorBody = (result as { error?: unknown } | null)?.error
      if (!res.ok || errorBody) {
        // 409 = the doc already became räkenskapsinformation: the route's
        // Swedish message says so and names the storno path; keep it verbatim.
        toast({
          title: tDetach('toast_failed'),
          description: resolveDetachErrorMessage(res.status, result),
          variant: 'destructive',
        })
        return
      }
      setTransactions((prev) =>
        prev.map((row) => (row.id === tx.id ? { ...row, document_id: null } : row))
      )
      void revalidateUnderlag(tx.id)
      // The attach dialog renders its "already attached" hint off its own
      // snapshot of the row, not the list.
      setAttachDocTx((prev) => (prev?.id === tx.id ? { ...prev, document_id: null } : prev))
      // Drop the inbox card's optimistic "attached" override (set by the
      // upload path through the matching -linked event).
      window.dispatchEvent(
        new CustomEvent('Accounted:transaction-document-unlinked', {
          detail: { transaction_id: tx.id },
        })
      )
      toast({ title: tDetach('toast_done') })
    } catch {
      toast({ title: tDetach('toast_failed'), variant: 'destructive' })
    }
  }

  // Batch mode handlers

  // Bounded pool for the per-row batch requests: parallel enough that a
  // 20-row batch finishes in a few round trips instead of 20 serialized ones,
  // bounded so 100 selected rows never fan out as 100 concurrent requests.
  // The bulkbar counter ticks per completed row.
  const BATCH_CONCURRENCY = 5

  function toggleBatchSelect(id: string, extend?: boolean) {
    bankSelection.toggle(id, extend)
  }

  function exitBatchMode() {
    bankSelection.clear()
    skvSelection.clear()
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
    const bankIds = Array.from(selectedIds)
    // The selection can outlive a refetch: only rows that are still
    // ignorable go to the server (a booked skattekonto row would 409).
    const skvIgnorable = skvSelectedRows.filter(isSkvSelectable)
    const skvIds = skvIgnorable.map((r) => r.id)
    const total = bankIds.length + skvIds.length
    if (total === 0) return
    // Rows with a booking suggestion and no duplicate hint look like
    // affärshändelser that should be booked (BFL 5 kap.), not ignored. The
    // ignore stays allowed (a migrated backlog is exactly such rows, already
    // in the imported books), but the dialog says how many of them there
    // are so the choice is informed, not accidental.
    const skvLikelyBusiness = skvIgnorable.filter(
      (r) => r.booking_suggestion != null && r.match_suggestion == null,
    ).length
    const body =
      bankIds.length > 0 && skvIds.length > 0
        ? t('batch_ignore_confirm_body_mixed')
        : skvIds.length > 0
          ? t('batch_ignore_confirm_body_skv')
          : t('batch_ignore_confirm_body_bank')
    const ok = await confirm({
      title: t('batch_ignore_confirm_title', { count: total }),
      description:
        skvLikelyBusiness > 0
          ? `${body} ${t('batch_ignore_confirm_skv_suggested', { count: skvLikelyBusiness })}`
          : body,
      confirmLabel: t('batch_ignore_confirm_cta'),
      cancelLabel: t('batch_ignore_confirm_cancel'),
      variant: 'warning',
    })
    if (!ok) return

    setBatchProgress({ done: 0, total })
    let completed = 0
    const tick = () => {
      completed++
      setBatchProgress({ done: completed, total })
    }
    const bankResults = await mapWithConcurrency(bankIds, BATCH_CONCURRENCY, async (id) => {
      let ignored = false
      try {
        const res = await fetch(`/api/transactions/${id}/ignore`, { method: 'POST' })
        ignored = res.ok
      } catch {
        ignored = false
      }
      tick()
      return ignored
    })
    // Same endpoint as the per-row Ignorera on SkattekontoInboxCard; there is
    // no batch variant, and 5-wide concurrency keeps this snappy for the
    // migration-sized backlogs it exists for.
    const skvResults = await mapWithConcurrency(skvIds, BATCH_CONCURRENCY, async (id) => {
      let ignored = false
      try {
        const res = await fetch(
          `/api/extensions/ext/skatteverket/skattekonto/transaktioner/${id}/ignore`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ is_ignored: true }),
          },
        )
        ignored = res.ok
      } catch {
        ignored = false
      }
      tick()
      return ignored
    })
    const ignoredBank = new Set(bankIds.filter((_, i) => bankResults[i]))
    const ignoredSkv = new Set(skvIds.filter((_, i) => skvResults[i]))
    const successes = ignoredBank.size + ignoredSkv.size
    const failed = total - successes

    if (successes > 0) {
      setExitingIds((prev) => {
        const next = new Set(prev)
        for (const id of ignoredBank) next.add(id)
        for (const id of ignoredSkv) next.add(id)
        return next
      })
      setTimeout(() => {
        if (ignoredBank.size > 0) {
          setTransactions((prev) =>
            prev.map((t) => (ignoredBank.has(t.id) ? { ...t, is_ignored: true } : t))
          )
        }
        if (ignoredSkv.size > 0) {
          setSkvRows((prev) =>
            prev.map((r) => (ignoredSkv.has(r.id) ? { ...r, is_ignored: true } : r))
          )
        }
        setExitingIds((prev) => {
          const next = new Set(prev)
          for (const id of ignoredBank) next.delete(id)
          for (const id of ignoredSkv) next.delete(id)
          return next
        })
      }, 350)
    }
    setBatchProgress(null)
    if (failed === 0) {
      // Restore lives where the rows now live: Alla → Ignorerade on this page
      // for bank rows, the Skattekonto page for skattekonto rows.
      toast({
        title: t('batch_done_title'),
        description: t('batch_ignore_done_description', { count: successes }),
        action:
          ignoredBank.size > 0 ? (
            <ToastAction
              altText={t('batch_ignore_show_ignored_alt')}
              onClick={() => {
                setHistoryFilter('ignored')
                setMode('history')
              }}
            >
              {t('batch_ignore_show_ignored')}
            </ToastAction>
          ) : (
            <ToastAction altText={t('batch_ignore_open_skattekonto_alt')} asChild>
              <Link href="/skattekonto">{t('batch_ignore_open_skattekonto')}</Link>
            </ToastAction>
          ),
      })
    } else {
      toast({
        title: t('batch_partial_title'),
        description: t('batch_ignore_partial_description', { success: successes, failed }),
        variant: 'destructive',
      })
    }
    exitBatchMode()
  }

  /**
   * Show the parked duplicate candidates and resolve with the user's answer,
   * so the batch tail can await it and still narrate the outcome once.
   */
  function askBatchDuplicates(deferred: DeferredDuplicateBooking[]): Promise<boolean> {
    const rows: BatchDuplicateRow[] = deferred.map((item) => {
      const tx = transactions.find((t) => t.id === item.transactionId)
      return {
        transactionId: item.transactionId,
        date: tx?.date ?? null,
        description: tx?.description ?? null,
        amount: tx?.amount ?? null,
        currency: tx?.currency ?? null,
        candidate: item.candidate,
      }
    })
    return new Promise<boolean>((resolve) => {
      batchDuplicateAnswerRef.current = resolve
      setBatchDuplicateRows(rows)
    })
  }

  function answerBatchDuplicates(confirmed: boolean) {
    setBatchDuplicateRows(null)
    const resolve = batchDuplicateAnswerRef.current
    batchDuplicateAnswerRef.current = null
    resolve?.(confirmed)
  }

  /**
   * Show the filed-momsperiod warning for the rows a batch held back, each
   * distinct warning once, and resolve with the person's answer.
   */
  function askBatchFiledVat(held: Array<{ warning: VoucherWarning }>): Promise<boolean> {
    const distinct = new Map<string, VoucherWarning>()
    for (const { warning } of held) if (!distinct.has(warning.message_sv)) distinct.set(warning.message_sv, warning)
    return new Promise<boolean>((resolve) => {
      batchFiledVatAnswerRef.current = resolve
      setBatchFiledVatAsk({ warnings: [...distinct.values()], count: held.length })
    })
  }

  function answerBatchFiledVat(confirmed: boolean) {
    setBatchFiledVatAsk(null)
    const resolve = batchFiledVatAnswerRef.current
    batchFiledVatAnswerRef.current = null
    resolve?.(confirmed)
  }

  async function handleBatchCategorize(category: TransactionCategory, vatTreatment?: VatTreatment, reverseChargeKind?: ReverseChargeKind) {
    const ids = Array.from(selectedIds)
    // Fresh collector per batch: rows the guard flags park here instead of
    // fighting over the single-row modal slot.
    batchDuplicatesRef.current = []
    batchFiledVatRef.current = []
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
        // The box the person named for the selection (BatchCategorySelector).
        reverseChargeKind,
        confirmNoMatch: false,
        silent: true,
        inBulk: true,
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
    // Rows the duplicate guard flagged are neither: they are held back for the
    // one confirmation below.
    let tally = tallyBatchOutcomes(ids, results)
    const deferred = batchDuplicatesRef.current
    batchDuplicatesRef.current = []
    if (deferred.length > 0 && (await askBatchDuplicates(deferred))) {
      // "Bokför alla ändå": replay every parked retry through the same bounded
      // pool. Each carries its own force binding to the candidate the user just
      // reviewed, so the server re-detects and a stale id cannot wave the guard
      // away. The retry pass replaces the held-back count, never adds to it.
      setBatchProgress({ done: 0, total: deferred.length })
      const retried = await runDeferredDuplicateRetries(
        deferred,
        BATCH_CONCURRENCY,
        (done, total) => setBatchProgress({ done, total }),
      )
      setBatchProgress(null)
      tally = foldDeferredRetries(tally, retried)
    }
    // The rows dated in a filed momsperiod whose booking changes the underlag
    // for that declaration, a confirmed duplicate among them: one question,
    // then every parked retry with its confirmation.
    const heldFiledVat = batchFiledVatRef.current
    batchFiledVatRef.current = []
    if (heldFiledVat.length > 0 && (await askBatchFiledVat(heldFiledVat))) {
      setBatchProgress({ done: 0, total: heldFiledVat.length })
      const retried = await runDeferredDuplicateRetries(
        heldFiledVat,
        BATCH_CONCURRENCY,
        (done, total) => setBatchProgress({ done, total }),
      )
      setBatchProgress(null)
      tally = foldFiledVatRetries(tally, retried)
    }
    // One Ångra-alla for the whole batch: it runs the same storno endpoint as
    // the per-row toast's Ångra, which requires a posted journal entry, so
    // only rows that actually got one are undoable. A successful flag-flip
    // row (ok, null id) has no verifikat to reverse.
    const undoableIds = tally.undoableIds
    const undoAllAction =
      undoableIds.length > 0 ? (
        <ToastAction
          altText={t('batch_undo_all_alt')}
          onClick={() => void undoBatchCategorize(undoableIds)}
        >
          {t('batch_undo_all')}
        </ToastAction>
      ) : undefined
    if (tally.failedCount === 0 && tally.deferredCount === 0 && tally.filedVatHeldCount === 0) {
      toast({
        title: t('batch_done_title'),
        description: t('batch_categorize_done_description', { count: tally.successCount }),
        action: undoAllAction,
      })
    } else {
      // Held-back rows are the user's own choice, not a failure: they get a
      // sentence of their own and only a real failure turns the toast
      // destructive.
      const booked =
        tally.failedCount > 0
          ? t('batch_categorize_partial_description', {
              success: tally.successCount,
              failed: tally.failedCount,
            })
          : t('batch_categorize_done_description', { count: tally.successCount })
      // Why the failed rows were refused, one sentence per reason with its
      // row count (for #206): "2 misslyckades" alone left nothing to act on.
      const details = [
        ...tally.failureReasons.map((group) =>
          t('batch_categorize_failed_reason', { count: group.count, reason: group.reason }),
        ),
        ...(tally.deferredCount > 0
          ? [t('batch_categorize_duplicates_held_back', { count: tally.deferredCount })]
          : []),
        ...(tally.filedVatHeldCount > 0
          ? [t('batch_categorize_filed_vat_held_back', { count: tally.filedVatHeldCount })]
          : []),
      ]
      toast({
        title: t('batch_partial_title'),
        description: details.length > 0 ? `${booked}. ${details.join(' ')}` : booked,
        ...(tally.failedCount > 0 ? { variant: 'destructive' as const } : {}),
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
    // An invoice hint wins when both are present (mirrors the inbox card's
    // label precedence); the ROT/RUT payout has its own confirm dialog.
    if (
      !transaction.potential_invoice &&
      !transaction.potential_supplier_invoice &&
      transaction.potential_rot_rut_payout
    ) {
      setRotRutMatchDialogOpen(true)
      return
    }
    if (
      !transaction.potential_invoice &&
      !transaction.potential_supplier_invoice &&
      transaction.potential_expense_payout
    ) {
      setExpensePayoutDialogOpen(true)
      return
    }
    setMatchDialogOpen(true)
  }

  function openCategoryDialog(transaction: TransactionWithInvoice, anchor?: HTMLElement) {
    setTemplatePickerTransaction(transaction)
    setTemplatePickerAnchor(anchor ?? null)
    // Opened from the row, not by "Byt": no review's underlag to carry.
    setTemplatePickerUnderlag(null)
    setTemplatePickerOpen(true)
  }

  // The one door into the review: a proposal, and whether the person picked it.
  // Opened from the picker "Byt" opened, it gets the underlag the closed
  // review held; every other way in starts without one.
  function openReview(transaction: TransactionWithInvoice, proposal: BookingProposal, picked: boolean) {
    const underlag = underlagForReview(templatePickerUnderlag, {
      transactionId: transaction.id,
      fromPicker: templatePickerOpen,
    })
    setTemplatePickerOpen(false)
    setTemplatePickerUnderlag(null)
    setQuickReview({ transaction, proposal, picked, underlag })
    setQuickReviewOpen(true)
  }

  function handleTemplateSelected(template: BookingTemplate, txOverride?: TransactionWithInvoice) {
    const tx = txOverride ?? templatePickerTransaction
    if (!tx) return
    openReview(tx, proposalFromTemplate(template, 'manual'), true)
  }

  // Bokför on a row that carries a proposal goes straight to the
  // review with that template set; no picker in between.
  function bookProposal(transaction: TransactionWithInvoice) {
    const s = rowProposalFor(transaction)
    if (!s) return openCategoryDialog(transaction)
    // A decision the company already made (a rule, a settled counterpart, a
    // sure read of a receipt) books from the row; Ångra sits on the toast.
    // The company's switch and the rule's own say come first
    // (lib/transactions/direct-booking.ts), and the server judges it again.
    if (directBooking && !reviewRequired(s, directBooking)) return void bookDirect(transaction, s)
    openReview(transaction, s, false)
  }

  // Book a proposal exactly as it would be shown: one body for every kind
  // (lib/bookkeeping/proposal.ts), one call, the same toasts and undo.
  async function bookProposalNow(
    transaction: TransactionWithInvoice,
    proposal: BookingProposal,
    extras: {
      dimensions?: Record<string, string>
      vatAmount?: number
      narration?: string
      reviewShown: boolean
      onReviewRequired?: () => void
    },
  ): Promise<{ ok: boolean; journalEntryId: string | null }> {
    const body = categorizeBodyFor(proposal, { dimensions: extras.dimensions, vatAmount: extras.vatAmount })
    return runCategorize({
      id: transaction.id,
      isBusiness: true,
      category: body.category,
      vatTreatment: body.vat_treatment,
      reverseChargeKind: body.reverse_charge_kind,
      accountOverride: body.account_override,
      templateId: body.template_id,
      counterpartyTemplateId: body.counterparty_template_id,
      proposalId: body.proposal_id,
      reviewShown: extras.reviewShown,
      onReviewRequired: extras.onReviewRequired,
      dimensions: body.dimensions,
      vatAmount: body.vat_amount,
      confirmNoMatch: false,
      narration: extras.narration,
    })
  }

  async function bookDirect(transaction: TransactionWithInvoice, s: BookingProposal) {
    await bookProposalNow(transaction, s, {
      dimensions: s.default_dimensions ?? undefined,
      narration: `${s.name_sv} · ${whyFor(s)}`,
      reviewShown: false,
      onReviewRequired: () => openReview(transaction, s, false),
    })
  }

  // A counterpart picked in the picker: the same proposal the row carries.
  function handleOpenTemplateReview(transaction: TransactionWithInvoice, templateId: string) {
    const proposal = templateSuggestions[transaction.id]?.find((ts) => ts.template_id === templateId)
    if (!proposal) {
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
    openReview(transaction, proposal, true)
  }

  // "Byt": the review closes for the picker and hands over the underlag
  // attached in it, so the review the pick opens still has it (PostHog PH 118).
  function handleChangeTemplate(underlag: ReviewUnderlag | null) {
    setQuickReviewOpen(false)
    if (quickReview?.transaction) {
      setTemplatePickerTransaction(quickReview.transaction)
      setTemplatePickerUnderlag(underlag ? { ...underlag, transactionId: quickReview.transaction.id } : null)
      setTemplatePickerOpen(true)
    }
  }

  function handleManualBooking() {
    setTemplatePickerOpen(false)
    if (templatePickerTransaction) {
      setBookingDialogTransaction(templatePickerTransaction)
      setBookingDialogTemplate(null)
      setBookingDialogProposalLines(null)
    setBookingDialogLineDescription(null)
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
    // The review's own words for what this is: the edit view opens with the
    // business line already saying it, instead of an empty Radtext.
    setBookingDialogLineDescription(quickReview?.proposal.name_sv ?? null)
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
    setBookingDialogLineDescription(null)
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
    setBookingDialogLineDescription(null)
    setBookingDialogAccount(null)
    setTemplatePickerOpen(false)
    setBookingDialogOpen(true)
  }

  async function handleQuickReviewConfirm(
    id: string,
    proposal: BookingProposal,
    extras: { dimensions?: Record<string, string>; vatAmount?: number },
  ): Promise<string | null> {
    const tx = quickReview?.transaction
    const { journalEntryId } = tx && tx.id === id
      ? await bookProposalNow(tx, proposal, { ...extras, reviewShown: true })
      : { journalEntryId: null }
    // Always close: whether the server created a verifikation, returned a
    // structured 4xx (ACCOUNTS_NOT_IN_CHART, INVALID_MAPPING, …), or hit a
    // partial-success path. The toast from runCategorize already communicates
    // the outcome; keeping the dialog open serves no purpose.
    setQuickReviewOpen(false)
    setQuickReview(null)
    return journalEntryId
  }

  const templatePickerProps: ComponentProps<typeof TemplatePicker> = {
    direction: templatePickerTransaction && templatePickerTransaction.amount < 0 ? 'expense' : 'income',
    entityType: entityType as EntityType,
    suggestedTemplates: templatePickerTransaction ? templateSuggestions[templatePickerTransaction.id] : undefined,
    onSelect: handleTemplateSelected,
    onSelectCounterparty: (templateId: string) => {
              if (!templatePickerTransaction) return
              setTemplatePickerOpen(false)
              handleOpenTemplateReview(templatePickerTransaction, templateId)
    },
    onPickLibraryTemplate: handlePickLibraryTemplate,
    onSelectAccount: handlePickAccount,
  }
  const templatePickerSalaryPayout = templatePickerTransaction ? salaryPayoutFor(templatePickerTransaction) : undefined
  // "Matcha mot befintlig verifikation" on a row a salary run pays out opens
  // with the run's verifikat picked, whichever door opened it.
  const matchVoucherSalaryPayout = matchVoucherTx ? salaryPayoutFor(matchVoucherTx) : undefined
  // Alternate paths as quiet links (concept vact): the templates are the
  // main content, not three stacked buttons.
  const templatePickerLinks = (
    <>
            {/* A booked salary run pays this row out (crm#1685): matched to
                the run's verifikat, never booked a second time. */}
            {templatePickerTransaction && templatePickerSalaryPayout && (
              <button
                type="button"
                className={QUIET_LINK_CLASS}
                onClick={() => {
                  const tx = templatePickerTransaction
                  setTemplatePickerOpen(false)
                  openMatchVoucherDialog(tx)
                }}
              >
                {t('dialog_match_salary_run', { period: templatePickerSalaryPayout.period })}
              </button>
            )}
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
            {/* The outgoing twin (PH 192): the supplier picker, where one
                payment for several supplier invoices is ticked. */}
            {templatePickerTransaction && templatePickerTransaction.amount < 0 && (
              <button
                type="button"
                className={QUIET_LINK_CLASS}
                onClick={() => {
                  const tx = templatePickerTransaction
                  setTemplatePickerOpen(false)
                  setSupplierInvoicePickerTransaction(tx)
                  setSupplierInvoicePickerOpen(true)
                }}
              >
                {t('dialog_pick_supplier_invoice')}
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
    </>
  )

  return (
    <div className="space-y-8">
      {/* Page header (concept scene 10): title + Importera split button */}
      <TransactionStatusBar onOpenCreateDialog={() => setIsDialogOpen(true)} />


      {loadFailure && transactions.length > 0 ? (
        // The list could not refresh (or loaded without its older pending
        // rows) while rows are on screen: the rows stay, this line says so,
        // and it takes the place of any softer line (one per page).
        <AttnLine action={{ label: tCommon('retry'), onClick: () => void fetchTransactions(false, true) }}>
          {loadFailure === 'partial' ? t('load_partial') : tCommon('refresh_failed')}
        </AttnLine>
      ) : skvNeedsReconnect && sourceFilter === 'skatteverket' ? (
        // Only while the person is looking at Skatteverket's rows. The dead
        // connection has its own channel on the Skattekonto page and the
        // Konton row (lib/notices predicate), so a line on every visit to the
        // bank list was noise (founder feedback 2026-09-09). The line still
        // renders only while the connection is actually broken.
        <AttnLine action={{ label: t('skv_reconnect_cta'), href: '/settings/skatteverket' }}>
          {t('skv_reconnect_body')}
        </AttnLine>
      ) : ledgerSuggestionNotice ? (
        // The mapping is the cause of the backlog the lines below describe:
        // until the bank account books on the ledger account the imported
        // verifikat use, neither the review list nor the bulk match can find
        // them. So this line wins over both.
        ledgerSuggestionNotice
      ) : (skvLedgerProposals ?? 0) > 0 && skattekontoInSource(effectiveSourceFilter) ? (
        <AttnLine action={{ label: t('skv_ledger_attn_cta'), onClick: () => setSkvLinkAllOpen(true) }}>
          {t('skv_ledger_attn_body', { count: skvLedgerProposals ?? 0, skattekonto: skvAccount })}
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

      {/* Toolbar: [Att bokföra/Alla-seg] [source ContextPicker] ... [sök] */}
      <div className="flex flex-wrap items-center gap-2">
        <SegmentedControl
          value={mode}
          onChange={handleModeChange}
          options={[
            { value: 'inbox', label: t('mode_inbox'), count: inboxScope.inScope },
            { value: 'history', label: t('mode_all') },
            // Review tab exists only while suggestions do (or while the user is
            // standing in it after emptying the list): a permanent third tab
            // would advertise a migrator surface most companies never need.
            ...(suggestionItems.length > 0 || mode === 'review'
              ? [{ value: 'review' as const, label: t('mode_review'), count: suggestionItems.length }]
              : []),
          ]}
        />
        {/* V7 toolbar order: view segments, then the source filter, then the
            search at the right end (one width on every list). */}
        {sourceItems.length > 1 && (
          <ContextPicker
            value={effectiveSourceFilter}
            onChange={(id) => handleSourceFilterChange(id as SourceFilter)}
            triggerLabel={(() => {
              const active =
                sourceItems.find((item) => item.id === effectiveSourceFilter) ?? sourceItems[0]
              // The annotation is a balance: a colon, not a middle dot,
              // which reads as a minus sign in front of an amount on a
              // small screen (PostHog PH 119).
              return active.annotation ? `${active.label}: ${active.annotation}` : active.label
            })()}
            items={sourceItems}
          />
        )}
        {/* Quiet cue that a scope change is reconciling behind the rendered
            list (the list itself never swaps to a skeleton for it). */}
        {isScopeRefreshing && (
          <SpinnerIcon
            className="h-3.5 w-3.5 animate-spin text-muted-foreground"
            aria-label={t('refreshing')}
          />
        )}
        <ToolbarSearch
          containerClassName={TOOLBAR_SEARCH_END_CLASS}
          placeholder="Sök transaktioner…"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      {/* Content based on mode */}
      {isLoading ? (
        // Same shape as loading.tsx and the list it resolves into: borderless
        // one-line 44px rows, not a boxed card with two-line rows.
        <LateReveal>
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex h-11 items-center justify-between gap-4 border-b-hairline">
              <Skeleton className="h-3.5 w-48" />
              <div className="flex items-center gap-6">
                <Skeleton className="h-3.5 w-20" />
                <Skeleton className="h-3.5 w-16" />
              </div>
            </div>
          ))}
        </LateReveal>
      ) : loadFailure && transactions.length === 0 ? (
        <LoadError title={t('load_failed_title')} onRetry={() => void fetchTransactions(true, true)} />
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
          emptyCardSource && !searchTerm ? (
            // A company card with nothing to book: its rows come from the
            // card statement, so the way forward is importing the next one.
            <EmptyState
              icon={CreditCardIcon}
              title={t('card_empty_title')}
              description={t('card_empty_description')}
              actionLabel={t('card_empty_action')}
              actionHref={`/import?mode=bank&account=${emptyCardSource.id}`}
            />
          ) : searchTerm ? (
            // No hits: one muted line in the list, not a block.
            <div className="flex flex-wrap items-center gap-x-3 py-3 text-[13px] text-muted-foreground">
              <span>{t('no_search_results')}</span>
              <Button variant="link" onClick={() => setSearchTerm('')}>
                {tCommon('clear_search')}
              </Button>
            </div>
          ) : effectiveSourceFilter !== 'all' || (periodBounds && !(noRowsInAnyYear && yearListEmpty)) ? (
            <p className="py-3 text-[13px] text-muted-foreground">
              {effectiveSourceFilter !== 'all' ? t('source_empty') : t('period_empty')}
            </p>
          ) : (
            <InboxZeroState hasTransactions={transactions.length > 0 || skvRows.length > 0} />
          )
        ) : (
          <div>
            {/* Bulkbar (concept): hidden until at least one transaction is
                selected via the hover checkboxes, then it pops in with the
                count and the batch actions. */}
            {/* batchProgress keeps it up while a run animates its booked rows
                out of the selection, so the counter stays to the end. */}
            {(selectedIds.size > 0 || skvSelectedIds.size > 0 || batchProgress) && (
              <div
                {...PAGE_BOTTOM_BAR_PROPS}
                className={FLOATING_BULK_BAR_CLASS}
              >
                {batchProgress ? (
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <SpinnerIcon className="h-3.5 w-3.5 animate-spin" />
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
                        <Button onClick={() => setShowBatchSelector(true)} disabled={!canWrite}>
                          {t('batch_book')}
                        </Button>
                        {/* Bulk-book (samlingsverifikation): only when ≥2 selected
                            on the same date + same direction. Disabled state
                            explains why via title. */}
                        <Button
                          variant="outline"
                          onClick={() => setBulkBookOpen(true)}
                          disabled={!canWrite || !bulkBookEligible}
                          title={!bulkBookEligible ? t('batch_bulk_book_hint') : undefined}
                        >
                          {t('batch_bulk_book')}
                        </Button>
                        <button
                          type="button"
                          className={cn(QUIET_LINK_CLASS, 'hover:text-destructive')}
                          onClick={handleBatchDelete}
                          disabled={!canWrite}
                        >
                          {t('batch_delete')}
                        </button>
                      </>
                    )}
                    {/* SKV rows book through the skatteverket extension: one
                        summary confirmation, then draft+commit per row. Only
                        the deterministic subset of the selection is bookable;
                        the rest is still ignorable below. */}
                    {skvBookableSelectedRows.length > 0 && (
                      <Button onClick={() => setSkvBulkConfirmOpen(true)} disabled={!canWrite}>
                        {t('batch_skv_book', { count: skvBookableSelectedRows.length })}
                      </Button>
                    )}
                    {/* Ignorera spans both selections (bank + skattekonto):
                        one confirmation, one progress counter, one toast. */}
                    <button type="button" className={QUIET_LINK_CLASS} onClick={handleBatchIgnore} disabled={!canWrite}>
                      {t('batch_ignore')}
                    </button>
                    {(selectedIds.size < selectableInboxIds.length ||
                      skvSelectedIds.size < selectableSkvIds.length) && (
                      <button
                        type="button"
                        className={QUIET_LINK_CLASS}
                        onClick={() => {
                          bankSelection.selectAll()
                          skvSelection.selectAll()
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

            {/* Negative margin + matching padding: the scroll container runs
                to the panel edges while the columns keep the page padding. */}
            <div className="overflow-x-auto -mx-4 px-2 md:-mx-6 md:px-4">
              <table className="w-full border-collapse text-[13px]">
                <thead>
                  <tr>
                    <th className={cn(TH_CLASS, 'w-7 !pl-0 !pr-2')} aria-hidden="true"></th>
                    {txColumns.has('date') && (
                      <th className={cn(TH_CLASS, '!pl-0')}>{t('th_date')}</th>
                    )}
                    <th className={cn(TH_CLASS, 'w-full')}>{t('th_description')}</th>
                    {txColumns.has('category') && <th className={TH_CLASS}>{t('th_category')}</th>}
                    {txColumns.has('account') && <th className={TH_CLASS}>{t('th_account')}</th>}
                    {txColumns.has('amount') && (
                      <th className={cn(TH_CLASS, 'text-right')}>{t('th_amount')}</th>
                    )}
                    <th className={cn(TH_CLASS, 'text-right !pr-0')}>
                      {t('th_status')}
                      {/* Column visibility, persisted per user. It lives on the
                          table it changes, above the rows' own menus, not in the
                          page toolbar: 2 of 945 page users touched it in 14 days,
                          and Alla and Granska förslag have no optional columns. */}
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="-my-2 ml-2 mr-2 align-middle text-muted-foreground hover:text-foreground"
                            aria-label={t('columns_button')}
                            title={t('columns_button')}
                          >
                            <AdjustmentsHorizontalIcon className="h-4 w-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="min-w-[12rem]">
                          {TX_COLUMNS.filter((c) => c.optional).map((c) => (
                            <DropdownMenuItem
                              key={c.id}
                              onSelect={(e) => e.preventDefault()}
                              onClick={() => toggleColumn(c.id)}
                            >
                              <CheckIcon className={cn('h-4 w-4', txColumns.has(c.id) ? 'opacity-100' : 'opacity-0')} />
                              {t(c.labelKey)}
                            </DropdownMenuItem>
                          ))}
                          <DropdownMenuItem onClick={() => setColumnsHidden([])}>{t('columns_reset')}</DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </th>
                  </tr>
                </thead>
                {/* data-ph-mask: session replay masks every text node under it in one
                    lookup instead of walking up from each cell. */}
                <tbody className="stagger-enter" data-ph-mask="">
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
                        onOpenMatchExpense={hasOpenExpenseClaims ? setMatchExpenseTx : undefined}
                        onOpenAttachDocument={openAttachDocumentDialog}
                        onDetachDocument={handleDetachDocument}
                        onOpenCategoryDialog={openCategoryDialog}
                        onDelete={handleDeleteTransaction}
                        onIgnore={handleIgnoreTransaction}
                        onEditTitle={openEditTitleDialog}
                        onMoveCashAccount={openMoveAccountDialog}
                        cashAccounts={cashAccounts}
                        onToggleSelect={toggleBatchSelect}
                        preMigration={preMigrationIds.has(item.data.id)}
                        columns={txColumns}
                        accountLabel={accountLabelFor(item.data)}
                        categoryLabel={categoryLabelFor(item.data)}
                        accountLogo={accountLogoFor(item.data)}
                        proposal={proposalFor(item.data)}
                        onBookProposal={bookProposal}
                        salaryRunPeriod={salaryPayoutFor(item.data)?.period ?? null}
                        giroCounterparty={giroCounterpartyFor(item.data)}
                      />
                    ) : (
                      <SkattekontoInboxCard
                        key={`skv-${item.data.id}`}
                        row={item.data}
                        matchSuggestion={item.data.match_suggestion}
                        bookingSuggestion={item.data.booking_suggestion}
                        isExiting={exitingIds.has(item.data.id)}
                        processing={skvBulkSubmitting}
                        selectable={isSkvSelectable(item.data)}
                        isSelected={skvSelectedIds.has(item.data.id)}
                        onToggleSelect={toggleSkvSelect}
                        onBokfor={handleSkvBokfor}
                        onMatch={r => setSkvMatchTarget(r)}
                        onIgnore={handleSkvIgnore}
                        columns={txColumns}
                        accountLabel={tSkvCard('account_label', { account: skvAccount })}
                      />
                    ),
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )
      ) : (
        <TransactionHistoryList
          transactions={historyTransactions}
          skvRows={skvRowsInScope}
          exitingIds={exitingIds}
          searchTerm={searchTerm}
          onClearSearch={() => setSearchTerm('')}
          sourceFilter={effectiveSourceFilter}
          filter={historyFilter}
          onFilterChange={setHistoryFilter}
          onUnignore={(id) => void handleUnignoreTransaction(id)}
          jeUnderlagStatus={jeUnderlagStatus}
          onOpenMatchDialog={openMatchDialog}
          onOpenCategoryDialog={openCategoryDialog}
          onOpenAttachDocument={openAttachDocumentDialog}
          onDetachDocument={handleDetachDocument}
          onOpenMatchVoucher={openMatchVoucherDialog}
          onDelete={handleDeleteTransaction}
          onSkvBokfor={handleSkvBokfor}
          onSkvMatch={r => setSkvMatchTarget(r)}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          onLoadMore={loadMoreTransactions}
          giroCounterpartyFor={giroCounterpartyFor}
        />
      )}

      {/* Footer status line (concept): what the current scope hides, the
          bank sync status (silent while healthy) and the way to Konton, where
          each bank account is reconciled. The count of rows to handle
          lives on the segment chip and the sync action in the header split
          button, so neither repeats here. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-1 text-xs text-muted-foreground">
        {mode === 'inbox' && inboxScope.outsidePeriod > 0 && (
          <span className="tabular-nums">
            {t('period_pending_outside', { count: inboxScope.outsidePeriod })}{' '}
            <button type="button" className={QUIET_LINK_CLASS} onClick={clearPeriodFilter}>
              {t('period_show_all')}
            </button>
          </span>
        )}
        {mode === 'inbox' && inboxScope.hiddenBySource > 0 && (
          <span className="tabular-nums">
            {t('source_pending_hidden', { count: inboxScope.hiddenBySource })}{' '}
            <button
              type="button"
              className={QUIET_LINK_CLASS}
              onClick={() => handleSourceFilterChange('all')}
            >
              {t('source_show_all')}
            </button>
          </span>
        )}
        <BankSyncStatusChip />
        <Link
          href="/accounts"
          className="ml-auto transition-colors duration-150 hover:text-foreground"
        >
          {t('footer_accounts_link')}
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
          onOpenChange={(open) => {
            setMatchDialogOpen(open)
            if (!open) setMatchAlreadyBooked(null)
          }}
          transaction={selectedTransaction}
          isConfirming={isConfirmingMatch}
          onConfirm={handleConfirmInvoiceMatch}
          onLinkToExisting={handleLinkToExistingVoucher}
          onSplitAcrossInvoices={handleSplitFromMatchDialog}
          alreadyBooked={matchAlreadyBooked && matchAlreadyBooked.transactionId === selectedTransaction?.id ? matchAlreadyBooked : null}
        />
      )}

      {rotRutMatchDialogOpen && (
        <RotRutPayoutMatchDialog
          open
          onOpenChange={setRotRutMatchDialogOpen}
          transaction={selectedTransaction}
          isConfirming={isConfirmingMatch}
          onConfirm={handleConfirmRotRutPayoutMatch}
        />
      )}

      {expensePayoutDialogOpen && (
        <ExpensePayoutMatchDialog
          open
          onOpenChange={setExpensePayoutDialogOpen}
          transaction={selectedTransaction}
          isConfirming={isConfirmingMatch}
          onConfirm={handleConfirmExpensePayoutMatch}
        />
      )}

      {matchExpenseTx && (
        <ExpenseClaimPickerDialog
          open
          onOpenChange={(o) => { if (!o) setMatchExpenseTx(null) }}
          transaction={matchExpenseTx}
          onMatched={handleExpenseClaimsPicked}
        />
      )}

      {matchVoucherTx && (
        <MatchVoucherDialog
          open
          onOpenChange={(o) => { if (!o) setMatchVoucherTx(null) }}
          transaction={matchVoucherTx}
          onLinked={handleVoucherLinked}
          preferredJournalEntryId={matchVoucherSalaryPayout?.journal_entry_id ?? null}
          preferredNote={
            matchVoucherSalaryPayout ? t('salary_run_payout_note', { period: matchVoucherSalaryPayout.period }) : null
          }
        />
      )}

      {splitMatchOpen && (
        <MatchAllocationDialog
          open
          onOpenChange={(o) => {
            setSplitMatchOpen(o)
            if (!o) {
              setSplitMatchTransaction(null)
              setSplitMatchPrefill(null)
            }
          }}
          transaction={splitMatchTransaction}
          initialAllocations={splitMatchPrefill}
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
    setBookingDialogLineDescription(null)
              setBookingDialogAccount(null)
            }
          }}
          transaction={bookingDialogTransaction}
          preselectedTemplate={bookingDialogTemplate}
          proposalLines={bookingDialogProposalLines}
          proposalLineDescription={bookingDialogLineDescription}
          preselectedAccount={bookingDialogAccount}
          onBooked={handleTransactionBooked}
          onUnderlagChange={handleUnderlagChanged}
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
          onDetach={handleDetachDocument}
        />
      )}

      {/* Non-modal so the agent sheet and its trigger stay usable while
          picking (useDashShellInert above hand-restores page modality).
          Esc and veil-click still close: the picker holds no user input.
          Clicks in the assistant don't dismiss: data-agent-ui counts as
          inside (see DialogContent). */}
      {/* The picker's props, shared by the anchored popover and the dialog
          (opened without an anchor). */}
      {templatePickerOpen && templatePickerAnchor && (
        <CategoryPopover anchor={templatePickerAnchor} onClose={() => setTemplatePickerOpen(false)}>
          <div className="flex min-w-0 items-center justify-between gap-3 border-b-hairline px-3 py-2 text-xs">
            {templatePickerTransaction && (
              <>
                <span className="min-w-0 truncate" title={templatePickerTransaction.description} data-ph-mask>{templatePickerTransaction.description}</span>
                <span className="shrink-0 font-medium tabular-nums" data-ph-mask>
                  {templatePickerTransaction.amount > 0 ? '+' : ''}{formatCurrency(templatePickerTransaction.amount, templatePickerTransaction.currency)}
                </span>
              </>
            )}
          </div>
          <div className="flex min-h-0 flex-col overflow-hidden">
            <TemplatePicker {...templatePickerProps} dense />
          </div>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t-hairline bg-background px-3 py-2">
            {templatePickerLinks}
          </div>
        </CategoryPopover>
      )}
      {templatePickerOpen && !templatePickerAnchor && <Dialog open onOpenChange={setTemplatePickerOpen} modal={false}>
        <DialogVeil />
        {/* Width capped at the space left of a docked sheet (--agent-sheet-w
            is docked-only) so the picker never clips off-screen left on
            narrow desktops; sheet closed = the old max-w-lg. */}
        <DialogContent className="max-w-[min(32rem,calc(100vw-var(--agent-sheet-w,0px)))]">
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
            {templatePickerLinks}
          </div>
          <TemplatePicker {...templatePickerProps} />
        </DialogContent>
      </Dialog>}

      {invoicePickerOpen && <Dialog
        open
        onOpenChange={(open) => {
          setInvoicePickerOpen(open)
          if (!open) setInvoicePickerTransaction(null)
        }}
      >
        <DialogContent size="form">
          <DialogHeader>
            <DialogTitle>{t('dialog_match_invoice')}</DialogTitle>
          </DialogHeader>
          {invoicePickerTransaction && (
            <>
              <div className="flex items-center justify-between rounded-lg px-3 py-2 text-sm bg-control shadow-raised">
                <span className="truncate text-muted-foreground">{invoicePickerTransaction.description}</span>
                <span className="font-medium tabular-nums flex-shrink-0 ml-3 text-success">
                  +{formatCurrency(invoicePickerTransaction.amount, invoicePickerTransaction.currency)}
                </span>
              </div>
              <InvoicePicker
                transaction={invoicePickerTransaction}
                onSelect={handleSelectInvoiceFromPicker}
                onSelectSeveral={handleSelectSeveralFromPicker}
                onSelectRotRutPayout={handleSelectRotRutPayoutFromPicker}
              />
            </>
          )}
        </DialogContent>
      </Dialog>}

      {supplierInvoicePickerOpen && <Dialog
        open
        onOpenChange={(open) => {
          setSupplierInvoicePickerOpen(open)
          if (!open) setSupplierInvoicePickerTransaction(null)
        }}
      >
        <DialogContent size="form">
          <DialogHeader>
            <DialogTitle>{t('dialog_pick_supplier_invoice')}</DialogTitle>
          </DialogHeader>
          {supplierInvoicePickerTransaction && (
            <>
              <div className="flex items-center justify-between rounded-lg px-3 py-2 text-sm bg-control shadow-raised">
                <span className="truncate text-muted-foreground">{supplierInvoicePickerTransaction.description}</span>
                <span className="font-medium tabular-nums flex-shrink-0 ml-3">
                  {formatCurrency(supplierInvoicePickerTransaction.amount, supplierInvoicePickerTransaction.currency)}
                </span>
              </div>
              <InvoicePicker
                kind="supplier"
                transaction={supplierInvoicePickerTransaction}
                onSelect={handleSelectSupplierInvoiceFromPicker}
                onSelectSeveral={handleSelectSeveralFromPicker}
              />
            </>
          )}
        </DialogContent>
      </Dialog>}

      {quickReviewOpen && (
        <QuickReviewDialog
          // One key per shape of review, not per row, so a review reopened
          // on another booking (the assistant's pick) starts from it.
          key={quickReview ? `${quickReview.transaction.id}:${quickReview.proposal.template_id}:${quickReview.proposal.booking.kind}` : 'none'}
          open
          onOpenChange={setQuickReviewOpen}
          transaction={quickReview?.transaction ?? null}
          proposal={quickReview!.proposal}
          picked={quickReview?.picked ?? false}
          entityType={entityType as EntityType}
          onConfirm={handleQuickReviewConfirm}
          onChangeTemplate={handleChangeTemplate}
          carriedUnderlag={quickReview?.underlag ?? null}
          assistantRead={quickReview ? (assistantReadsRef.current[quickReview.transaction.id] ?? null) : null}
          onEditLines={handleEditProposedLines}
          onUnderlagChange={handleUnderlagChanged}
          onProposalChange={handleReviewProposalChange}
          activateOnBooking={quickReview ? activationFor(reviewChoices, quickReview.transaction.id, quickReview.proposal) : null}
        />
      )}

      {/* ?new opens the drawer: the Pengar area's create button links here. */}
      {/* A viewer cannot create: the top bar's button is locked for them, and the
          ?new link (the area sidebar's create row) opens nothing either. */}
      <OpenOnParam
        param="new"
        onOpen={() => {
          if (canWrite) setIsDialogOpen(true)
        }}
      />
      {/* A manual transaction is created in a drawer over the list (V7
          creation forms); the title is the create button's label. */}
      {isDialogOpen && (
        <CreateDrawer
          open
          onOpenChange={setIsDialogOpen}
          title={t('action_new_transaction')}
          formId="create-transaction-form"
          submitLabel={t('create_submit')}
          submitting={isCreating}
        >
          <TransactionForm onSubmit={handleCreateTransaction} isLoading={isCreating} formId="create-transaction-form" />
        </CreateDrawer>
      )}

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
          skattekontoAccount={skvAccount}
        />
      )}

      {skvBookTarget && (
        <SkattekontoBookDialog
          row={skvBookTarget}
          skattekontoAccount={skvAccount}
          open
          onOpenChange={(o) => {
            if (!o) setSkvBookTarget(null)
          }}
          onBooked={handleSkvBooked}
          onMatch={() => {
            setSkvMatchTarget(skvBookTarget)
            setSkvBookTarget(null)
          }}
          onLinked={handleSkvLinked}
        />
      )}

      {skvLinkAllOpen && (
        <SkattekontoLinkProposalsDialog
          open
          onOpenChange={(o) => {
            if (!o) setSkvLinkAllOpen(false)
          }}
          onLinked={handleSkvLinked}
          skattekontoAccount={skvAccount}
        />
      )}

      {/* SKV bulk booking: one summary confirmation for the whole selection,
          grouped by deterministic suggestion. Count-based: voucher numbers
          are assigned atomically at commit. */}
      {skvBulkConfirmOpen && (
        <ConfirmationDialog
          open
          onOpenChange={setSkvBulkConfirmOpen}
          title={t('skv_bulk_title', { count: skvBookableSelectedRows.length })}
          isSubmitting={skvBulkSubmitting}
          confirmLabel={t('skv_bulk_confirm')}
          warningText={t('skv_bulk_warning', { count: skvBookableSelectedRows.length })}
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
            <div className="flex items-baseline justify-between gap-4 border-t-hairline pt-2 font-medium">
              <span>{t('skv_bulk_total', { count: skvBookableSelectedRows.length })}</span>
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
            <DialogTitle>{t('dialog_pick_supplier_invoice')}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <p className="text-sm text-muted-foreground">
              Det finns en öppen leverantörsfaktura med samma belopp från samma leverantör. Matcha mot
              fakturan istället för att bokföra direkt på leverantörsskuldskontot, annars skapas en
              dubblerad verifikation som måste stornas (BFL 5 kap 5 §).
            </p>
            <div className="space-y-2 rounded-lg p-3 bg-control shadow-raised">
              {siMatchSuggestion?.candidates.map((c) => (
                <div key={c.supplier_invoice_id} className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="font-medium">
                      {c.supplier_name || 'Leverantör'}
                      {c.invoice_number ? ` · ${c.invoice_number}` : null}
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {formatDate(c.invoice_date)} · kvar {formatCurrency(c.remaining_amount, c.currency)}
                    </div>
                  </div>
                  <Button
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
            <div className="space-y-2 rounded-lg p-3 bg-control shadow-raised">
              {ciMatchSuggestion?.candidates.map((c) => (
                <div key={c.invoice_id} className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {c.customer_name || 'Kund'} · {c.invoice_number ?? '-'}
                      </span>
                      {c.match_reason === 'ocr_exact' && (
                        <span className="text-xs text-muted-foreground">{t('badge_exact_ocr')}</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground tabular-nums">
                      {formatDate(c.invoice_date)} · kvar {formatCurrency(c.remaining_amount, c.currency)}
                    </div>
                  </div>
                  <Button
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

      {filedVatConfirm && <VoucherWarningsDialog
        warnings={filedVatConfirm.warnings}
        processing={filedVatProcessing}
        cancelLabel={tCommon('cancel')}
        onCancel={() => setFiledVatConfirm(null)}
        onConfirm={async () => {
          const retry = filedVatConfirm.retry
          setFiledVatProcessing(true)
          try {
            await retry()
          } finally {
            setFiledVatProcessing(false)
            setFiledVatConfirm(null)
          }
        }}
      />}

      {batchFiledVatAsk && <VoucherWarningsDialog
        warnings={batchFiledVatAsk.warnings}
        processing={false}
        intro={t('batch_filed_vat_intro', { count: batchFiledVatAsk.count })}
        cancelLabel={tCommon('cancel')}
        onCancel={() => answerBatchFiledVat(false)}
        onConfirm={() => answerBatchFiledVat(true)}
      />}

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

      {/* The batch answer to the same guard: one dialog for every flagged row
          in the selection, instead of N dialogs fighting over one slot. Both
          answers resolve the promise handleBatchCategorize is awaiting, so the
          batch reports its outcome once either way. */}
      {batchDuplicateRows && <BatchDuplicateDialog
        rows={batchDuplicateRows}
        onCancel={() => answerBatchDuplicates(false)}
        onBookAll={() => answerBatchDuplicates(true)}
      />}

    </div>
  )
}
