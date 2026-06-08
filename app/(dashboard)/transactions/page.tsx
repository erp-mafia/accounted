'use client'

import { useState, useEffect, useMemo, useRef } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { DataList, DataListHeader, DataListEmpty } from '@/components/ui/data-list'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/dropdown-menu'
import { ChevronDown, Layers, Search, Trash2, X } from 'lucide-react'
import TransactionForm from '@/components/transactions/TransactionForm'
import BatchCategorySelector from '@/components/transactions/BatchCategorySelector'
import TransactionStatusBar from '@/components/transactions/TransactionStatusBar'
import BankSyncStatusChip from '@/components/transactions/BankSyncStatusChip'
import BankSyncNowButton from '@/components/transactions/BankSyncNowButton'
import BankSyncSinceLastVisit from '@/components/transactions/BankSyncSinceLastVisit'
import TransactionInboxCard from '@/components/transactions/TransactionInboxCard'
import TransactionHistoryList from '@/components/transactions/TransactionHistoryList'
import InboxZeroState from '@/components/transactions/InboxZeroState'
import SkattekontoInboxCard from '@/components/transactions/SkattekontoInboxCard'
import { SkattekontoMatchDialog } from '@/components/skattekonto/SkattekontoMatchDialog'
import InvoiceMatchDialog from '@/components/transactions/InvoiceMatchDialog'
import { MatchVoucherDialog } from '@/components/transactions/MatchVoucherDialog'
import InvoicePicker from '@/components/transactions/InvoicePicker'
import SupplierInvoicePicker from '@/components/transactions/SupplierInvoicePicker'
import MatchAllocationDialog from '@/components/transactions/MatchAllocationDialog'
import BulkBookDialog from '@/components/transactions/BulkBookDialog'
import TransactionBookingDialog from '@/components/transactions/TransactionBookingDialog'
import QuickReviewDialog from '@/components/transactions/QuickReviewDialog'
import EditTransactionTitleDialog from '@/components/transactions/EditTransactionTitleDialog'

import TemplatePicker from '@/components/transactions/TemplatePicker'
import { getDefaultAccountForCategory, getDefaultVatTreatmentForCategory } from '@/lib/bookkeeping/category-mapping'
import { getTemplateById, type BookingTemplate } from '@/lib/bookkeeping/booking-templates'
import { isCounterpartyTemplateId, extractCounterpartyId } from '@/lib/bookkeeping/counterparty-templates'
import { isLibraryTemplateId } from '@/lib/bookkeeping/template-library'
import type { TransactionWithInvoice, ViewMode, CategorizeHandler } from '@/components/transactions/transaction-types'
import type {
  SkattekontoTransactionWithSuggestion,
  StoredSkattekontoTransaction,
} from '@/types/skatteverket'
import { findBankSkvCounterparts } from '@/lib/skatteverket/bank-counterpart'
import { useCompany } from '@/contexts/CompanyContext'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate } from '@/lib/utils'
import type { TransactionCategory, CreateTransactionInput, Invoice, Customer, SupplierInvoice, Supplier, VatTreatment, EntityType, LinePatternEntry, BookingTemplateLibrary } from '@/types'
import type { SuggestedTemplate } from '@/lib/transactions/category-suggestions'

type InvoiceWithCustomer = Invoice & { customer?: Customer }
type SupplierInvoiceWithSupplier = SupplierInvoice & { supplier?: Supplier }

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

interface QuickReviewState {
  transaction: TransactionWithInvoice
  category: TransactionCategory
  label: string
  template: BookingTemplate | null
  templateId: string | undefined
  linePattern: LinePatternEntry[] | null
}

export default function TransactionsPage() {
  const { company } = useCompany()
  const t = useTranslations('transactions')
  const [transactions, setTransactions] = useState<TransactionWithInvoice[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [mode, setMode] = useState<ViewMode>('inbox')
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [templateSuggestions, setTemplateSuggestions] = useState<Record<string, SuggestedTemplate[]>>({})
  const [processingId, setProcessingId] = useState<string | null>(null)
  const [searchTerm, setSearchTerm] = useState('')

  // Batch mode
  const [isBatchMode, setIsBatchMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [showBatchSelector, setShowBatchSelector] = useState(false)
  const [batchProgress, setBatchProgress] = useState<{ done: number; total: number } | null>(null)

  // Invoice match dialog
  const [matchDialogOpen, setMatchDialogOpen] = useState(false)
  const [selectedTransaction, setSelectedTransaction] = useState<TransactionWithInvoice | null>(null)
  const [isConfirmingMatch, setIsConfirmingMatch] = useState(false)

  // Booking dialog (journal entry form)
  const [bookingDialogOpen, setBookingDialogOpen] = useState(false)
  const [bookingDialogTransaction, setBookingDialogTransaction] = useState<TransactionWithInvoice | null>(null)
  const [bookingDialogTemplate, setBookingDialogTemplate] = useState<BookingTemplateLibrary | null>(null)

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
  // "Matcha mot befintlig verifikation" — link a bank tx to an already-booked
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
    retry: () => Promise<string | null>
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
    retry: () => Promise<string | null>
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

  // Entity type for tooltip context
  const [entityType, setEntityType] = useState<string>('enskild_firma')

  // Pagination
  const [hasMore, setHasMore] = useState(false)
  const [isLoadingMore, setIsLoadingMore] = useState(false)

  // True uncategorized count from DB (not limited by pagination)
  const [totalUncategorizedCount, setTotalUncategorizedCount] = useState<number | null>(null)

  // Set of transaction IDs that are animating out (just categorized)
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set())

  // Skattekonto rows (unmatched, status='booked'). Loaded if the
  // Skatteverket extension is enabled and connected. 503/401 → silently
  // hidden (extension disabled or user not connected).
  const [skvRows, setSkvRows] = useState<SkattekontoTransactionWithSuggestion[]>([])
  const [skvProcessingId, setSkvProcessingId] = useState<string | null>(null)
  const [skvMatchTarget, setSkvMatchTarget] = useState<StoredSkattekontoTransaction | null>(
    null,
  )

  // Source filter for the merged inbox. Defaults to 'all' so users see
  // both sources unless they want to narrow down.
  const [sourceFilter, setSourceFilter] = useState<'all' | 'bank' | 'skatteverket'>('all')

  const { toast } = useToast()
  const { dialogProps: confirmDialogProps, confirm } = useDestructiveConfirm()
  // Bank transaction whose title is being edited (null = dialog closed).
  const [editTitleTarget, setEditTitleTarget] = useState<TransactionWithInvoice | null>(null)
  const supabase = createClient()
  const searchParams = useSearchParams()
  const highlightId = searchParams.get('highlight')
  // Tracks the last highlight target we acted on so re-renders don't re-trigger
  // the auto-open every time the user closes the categorize panel.
  const handledHighlightRef = useRef<string | null>(null)

  // Computed lists
  const uncategorizedTransactions = transactions
    .filter((t) => t.is_business === null && !t.is_ignored && !exitingIds.has(t.id))
    .sort((a, b) => {
      const aHasMatch = a.potential_invoice || a.potential_supplier_invoice ? 1 : 0
      const bHasMatch = b.potential_invoice || b.potential_supplier_invoice ? 1 : 0
      if (aHasMatch !== bHasMatch) return bHasMatch - aHasMatch
      return b.date.localeCompare(a.date)
    })

  // Merged inbox: bank tx + SKV rows interleaved by date. Source filter
  // narrows to one side. SKV rows always go after bank rows on the same
  // date — bank tx tend to have invoice-match suggestions and we'd rather
  // surface those first.
  type InboxItem =
    | { source: 'bank'; date: string; data: TransactionWithInvoice }
    | { source: 'skatteverket'; date: string; data: SkattekontoTransactionWithSuggestion }

  const skvUnmatched = skvRows.filter(r => !r.journal_entry_id)

  const bankToSkvHints = findBankSkvCounterparts({
    bankRows: uncategorizedTransactions.map(t => ({ id: t.id, date: t.date, amount: t.amount })),
    skvRows: skvUnmatched,
  })

  const inboxItems: InboxItem[] = (() => {
    const items: InboxItem[] = []
    const query = searchTerm.trim().toLowerCase()
    if (sourceFilter !== 'skatteverket') {
      for (const tx of uncategorizedTransactions) {
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
    if (sourceFilter !== 'bank') {
      // Inbox only shows SKV rows that need action (no verifikat yet).
      for (const r of skvRows) {
        if (r.journal_entry_id) continue
        if (exitingIds.has(r.id)) continue
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
  })()
  const transactionsWithMatches = transactions.filter(
    (t) =>
      (t.potential_invoice && !t.invoice_id) ||
      (t.potential_supplier_invoice && !t.supplier_invoice_id),
  )

  const PAGE_SIZE = 200

  async function fetchTransactions() {
    if (!company) return
    setIsLoading(true)
    const [{ data: txData, error: txError }, { count: uncatCount }] = await Promise.all([
      supabase
        .from('transactions')
        .select('*')
        .eq('company_id', company.id)
        .order('date', { ascending: false })
        .limit(PAGE_SIZE),
      supabase
        .from('transactions')
        .select('*', { count: 'exact', head: true })
        .eq('company_id', company.id)
        .is('is_business', null)
        // Same predicate as lib/worklist countUnbookedTransactions — ignored
        // rows are handled, not pending.
        .eq('is_ignored', false),
    ])

    if (txError) {
      toast({ title: t('load_failed_title'), description: t('load_failed_description'), variant: 'destructive' })
      setIsLoading(false)
      return
    }

    const rows = txData || []
    const potentialInvoiceIds = rows
      .filter((t) => t.potential_invoice_id)
      .map((t) => t.potential_invoice_id)
    const potentialSupplierInvoiceIds = rows
      .filter((t) => t.potential_supplier_invoice_id)
      .map((t) => t.potential_supplier_invoice_id)

    const [invoiceResult, supplierInvoiceResult] = await Promise.all([
      potentialInvoiceIds.length > 0
        ? supabase.from('invoices').select('*, customer:customers(*)').in('id', potentialInvoiceIds)
        : Promise.resolve({ data: null }),
      potentialSupplierInvoiceIds.length > 0
        ? supabase.from('supplier_invoices').select('*, supplier:suppliers(*)').in('id', potentialSupplierInvoiceIds)
        : Promise.resolve({ data: null }),
    ])

    const invoiceMap = buildInvoiceMap(invoiceResult.data)
    const supplierInvoiceMap = buildSupplierInvoiceMap(supplierInvoiceResult.data)

    const transactionsWithInvoices: TransactionWithInvoice[] = rows.map((t) => ({
      ...t,
      potential_invoice: t.potential_invoice_id ? invoiceMap[t.potential_invoice_id] : undefined,
      potential_supplier_invoice: t.potential_supplier_invoice_id
        ? supplierInvoiceMap[t.potential_supplier_invoice_id]
        : undefined,
    }))

    setTransactions(transactionsWithInvoices)
    setTotalUncategorizedCount(uncatCount ?? 0)
    setHasMore(rows.length >= PAGE_SIZE)
    setIsLoading(false)

    // Fire-and-forget: load SKV rows in parallel with the rest of the
    // page. We don't block on this — if the extension is disabled or the
    // user isn't connected the response is 503/401 and we just leave the
    // SKV section empty.
    void loadSkvRows()
  }

  async function loadSkvRows() {
    try {
      const res = await fetch('/api/extensions/ext/skatteverket/skattekonto/transaktioner')
      if (!res.ok) {
        setSkvRows([])
        return
      }
      const json = await res.json()
      const booked = (json.data?.booked ?? []) as SkattekontoTransactionWithSuggestion[]
      // Keep all booked SKV rows in state — inbox view filters to obokförda
      // (journal_entry_id null), history view shows all of them (matched
      // and unmatched) interleaved with bank tx by date.
      setSkvRows(booked)
    } catch {
      setSkvRows([])
    }
  }

  async function loadMoreTransactions() {
    if (!company) return
    setIsLoadingMore(true)
    const offset = transactions.length
    const { data: txData, error: txError } = await supabase
      .from('transactions')
      .select('*')
      .eq('company_id', company.id)
      .order('date', { ascending: false })
      .range(offset, offset + PAGE_SIZE - 1)

    if (txError || !txData) {
      setIsLoadingMore(false)
      return
    }

    setHasMore(txData.length >= PAGE_SIZE)

    const potentialInvoiceIds = txData
      .filter((t) => t.potential_invoice_id)
      .map((t) => t.potential_invoice_id)
    const potentialSupplierInvoiceIds = txData
      .filter((t) => t.potential_supplier_invoice_id)
      .map((t) => t.potential_supplier_invoice_id)

    const [invoiceResult, supplierInvoiceResult] = await Promise.all([
      potentialInvoiceIds.length > 0
        ? supabase.from('invoices').select('*, customer:customers(*)').in('id', potentialInvoiceIds)
        : Promise.resolve({ data: null }),
      potentialSupplierInvoiceIds.length > 0
        ? supabase.from('supplier_invoices').select('*, supplier:suppliers(*)').in('id', potentialSupplierInvoiceIds)
        : Promise.resolve({ data: null }),
    ])

    const invoiceMap = buildInvoiceMap(invoiceResult.data)
    const supplierInvoiceMap = buildSupplierInvoiceMap(supplierInvoiceResult.data)

    const newTransactions: TransactionWithInvoice[] = txData.map((t) => ({
      ...t,
      potential_invoice: t.potential_invoice_id ? invoiceMap[t.potential_invoice_id] : undefined,
      potential_supplier_invoice: t.potential_supplier_invoice_id
        ? supplierInvoiceMap[t.potential_supplier_invoice_id]
        : undefined,
    }))

    setTransactions((prev) => [...prev, ...newTransactions])
    setIsLoadingMore(false)
  }

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

  // Fetch transactions and entity type in parallel on mount, then suggestions
  useEffect(() => {
    let cancelled = false

    async function loadAll() {
      // Fetch transactions and entity type in parallel
      const [, entityRes] = await Promise.all([
        fetchTransactions(),
        fetch('/api/settings').then(r => r.json()).catch(() => null),
      ])

      if (cancelled) return

      if (entityRes?.data?.entity_type) {
        setEntityType(entityRes.data.entity_type)
      }
    }

    loadAll()

    return () => { cancelled = true }
  }, [])

  // Scroll the targeted row into view when arriving via
  // /transactions?highlight=<id>. Callers are inbox "Öppna transaktionen",
  // payment-booking dialog, and supplier-invoice cross-link — all "go look
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
  }, [highlightId, transactions])

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

  const handleCategorize: CategorizeHandler = async (id, isBusiness, category, vatTreatment, accountOverride, templateId, inboxItemId) => {
    return runCategorize({ id, isBusiness, category, vatTreatment, accountOverride, templateId, inboxItemId, confirmNoMatch: false })
  }

  async function runCategorize(args: {
    id: string
    isBusiness: boolean
    category?: TransactionCategory
    vatTreatment?: VatTreatment
    accountOverride?: string
    templateId?: string
    inboxItemId?: string
    confirmNoMatch: boolean
  }): Promise<string | null> {
    const { id, isBusiness, category, vatTreatment, accountOverride, templateId, inboxItemId, confirmNoMatch } = args
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
          ...(confirmNoMatch ? { confirm_no_match: true } : {}),
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
          return null
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
          return null
        }
        if (result?.error?.code === 'TX_CATEGORIZE_INVALID_ACCOUNT') {
          // The user picked a library template (or typed an account
          // override) whose account isn't in this company's kontoplan.
          // Mirror the ACCOUNTS_NOT_IN_CHART flow with a one-click
          // "Aktivera och bokför" — pull the BAS name if known so the
          // toast carries real context.
          // Validate the BAS account number is a plain 4-digit string before
          // embedding it in any fetch URL/body — the value comes from the
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
                if (hit?.account_name) displayName = `${accountNumber} — ${hit.account_name}`
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
                      description: `Lägg till ${accountNumber} manuellt under Inställningar → Kontoplan.`,
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
          return null
        }
        if (result?.error?.code === 'ACCOUNTS_NOT_IN_CHART') {
          // The mapped template/category references one or more accounts
          // that aren't active in this company's kontoplan. Without an
          // inline action the user has to navigate to settings, activate
          // each account, and come back — surface a one-click "Aktivera
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
                      description: `Lägg till ${activateBody.unknown.join(', ')} manuellt under Inställningar → Kontoplan.`,
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
          return null
        }
        toast({
          title: 'Kategorisering misslyckades',
          description: getErrorMessage(result, { context: 'transaction', statusCode: response.status }),
          variant: 'destructive',
        })
        setProcessingId(null)
        return null
      }

      // Mark as exiting for animation, then update state
      setExitingIds((prev) => new Set(prev).add(id))
      setTotalUncategorizedCount((prev) => Math.max(0, (prev ?? 1) - 1))

      if (result.journal_entry_created) {
        toast({
          title: 'Bokförd',
          action: (
            <ToastAction altText="Ångra kategorisering" onClick={async () => {
              try {
                const undoRes = await fetch(`/api/transactions/${id}/uncategorize`, { method: 'POST' })
                if (undoRes.ok) {
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
      } else if (result.journal_entry_error) {
        toast({ title: 'Delvis bokförd', description: `Verifikation kunde inte skapas: ${result.journal_entry_error}`, variant: 'destructive' })
      } else {
        toast({ title: t('partially_booked_title'), description: t('partially_booked_description') })
      }

      // Update transaction in state after a brief delay for animation
      setExitingIds((prev) => new Set(prev).add(id))
      setTimeout(() => {
        setTransactions((prev) =>
          prev.map((t) =>
            t.id === id
              ? { ...t, is_business: isBusiness, category: result.category, journal_entry_id: result.journal_entry_id }
              : t
          )
        )
        setExitingIds((prev) => {
          const next = new Set(prev)
          next.delete(id)
          return next
        })
        setProcessingId(null)
      }, 350)

      return result.journal_entry_id || null
    } catch {
      toast({ title: t('booking_failed_title'), description: t('booking_failed_description'), variant: 'destructive' })
      setProcessingId(null)
      return null
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
    // reversible, but the row vanishes immediately — confirmation before the
    // write plus an Ångra toast gives two recovery affordances. The
    // "Ignorerade transaktioner" card on Rapporter → Bankavstämning is the
    // standing third.
    const ok = await confirm({
      title: 'Ignorera transaktionen?',
      description: `${tx.description} — ${formatCurrency(tx.amount, tx.currency)} (${formatDate(tx.date)}) försvinner från listan utan att bokföras. Använd bara för poster som inte är affärshändelser, t.ex. dubbletter eller överföringar mellan egna konton — riktiga köp och betalningar ska bokföras. Du kan återställa den under Bankavstämning när som helst.`,
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
        description: `${tx.description} — ${formatCurrency(tx.amount, tx.currency)}`,
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
  // filter drops it — animate it out the same way as the invoice-link path.
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
  // share the same date, and same direction (all income or all expense) —
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
    await fetchTransactions()
    setSelectedIds(new Set())
    setIsBatchMode(false)
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
    await fetchTransactions()
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
      // (shared CreateTransactionSchema) and the DB CHECK applies — the browser
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

    const ok = await confirm({
      title: 'Ta bort transaktion',
      description: `Är du säker på att du vill ta bort "${transaction.description}"? Åtgärden kan inte ångras.`,
      confirmLabel: 'Ta bort',
      variant: 'destructive',
    })
    if (!ok) return

    try {
      const response = await fetch(`/api/transactions/${id}`, { method: 'DELETE' })
      if (!response.ok) {
        const result = await response.json()
        toast({
          title: 'Kunde inte ta bort',
          description: getErrorMessage(result, { context: 'transaction' }),
          variant: 'destructive',
        })
        return
      }
      setTransactions((prev) => prev.filter((t) => t.id !== id))
      toast({ title: t('deleted_title'), description: t('deleted_description') })
    } catch {
      toast({
        title: 'Kunde inte ta bort',
        description: t('delete_failed_description'),
        variant: 'destructive',
      })
    }
  }

  function openEditTitleDialog(transaction: TransactionWithInvoice) {
    setEditTitleTarget(transaction)
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

  async function handleSkvBokfor(row: StoredSkattekontoTransaction) {
    setSkvProcessingId(row.id)
    try {
      const res = await fetch(
        `/api/extensions/ext/skatteverket/skattekonto/transaktioner/${row.id}/bokfor`,
        { method: 'POST' },
      )
      const json = await res.json()
      if (!res.ok) {
        throw new Error(json.error || 'Bokföring misslyckades')
      }
      toast({
        title: 'Utkast skapat',
        description: t('review_in_bookkeeping_description'),
      })
      window.location.href = `/bookkeeping/${json.data.entry.id}`
    } catch (err) {
      toast({
        title: 'Kunde inte bokföra',
        description: err instanceof Error ? err.message : undefined,
        variant: 'destructive',
      })
    } finally {
      setSkvProcessingId(null)
    }
  }

  function handleSkvMatched() {
    // After a successful match, drop the row from the inbox — it's now
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

  function handleTransactionBooked(transactionId: string, journalEntryId: string) {
    setExitingIds((prev) => new Set(prev).add(transactionId))
    setTimeout(() => {
      setTransactions((prev) =>
        prev.map((t) =>
          t.id === transactionId
            ? { ...t, is_business: true, journal_entry_id: journalEntryId }
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
    toast({ title: 'Bokförd' })
  }

  // Batch mode handlers
  function toggleBatchSelect(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function exitBatchMode() {
    setIsBatchMode(false)
    setSelectedIds(new Set())
  }

  async function handleBatchDelete() {
    const ids = Array.from(selectedIds)
    const ok = await confirm({
      title: `Ta bort ${ids.length} transaktioner?`,
      description: 'Åtgärden kan inte ångras.',
      confirmLabel: 'Ta bort',
      variant: 'destructive',
    })
    if (!ok) return

    setBatchProgress({ done: 0, total: ids.length })
    let successes = 0
    const failures: string[] = []
    for (let i = 0; i < ids.length; i++) {
      try {
        const response = await fetch(`/api/transactions/${ids[i]}`, { method: 'DELETE' })
        if (response.ok) {
          successes++
        } else {
          const tx = transactions.find((t) => t.id === ids[i])
          failures.push(tx?.description || ids[i])
        }
      } catch {
        failures.push(ids[i])
      }
      setBatchProgress({ done: i + 1, total: ids.length })
    }
    if (successes > 0) {
      setTransactions((prev) => prev.filter((t) => !selectedIds.has(t.id) || failures.includes(t.description)))
    }
    setBatchProgress(null)
    if (failures.length === 0) {
      toast({ title: 'Klart', description: `${successes} transaktioner borttagna` })
    } else {
      toast({
        title: 'Delvis klart',
        description: `${successes} borttagna, ${failures.length} misslyckades`,
        variant: 'destructive',
      })
    }
    exitBatchMode()
  }

  async function handleBatchCategorize(category: TransactionCategory, vatTreatment?: VatTreatment) {
    const ids = Array.from(selectedIds)
    setBatchProgress({ done: 0, total: ids.length })
    let successes = 0
    const failures: string[] = []
    for (let i = 0; i < ids.length; i++) {
      const result = await handleCategorize(ids[i], true, category, vatTreatment)
      if (result) {
        successes++
      } else {
        const tx = transactions.find((t) => t.id === ids[i])
        failures.push(tx?.description || ids[i])
      }
      setBatchProgress({ done: i + 1, total: ids.length })
    }
    setBatchProgress(null)
    setShowBatchSelector(false)
    if (failures.length === 0) {
      toast({ title: 'Klart', description: `${successes} transaktioner bokförda` })
    } else {
      toast({
        title: 'Delvis klart',
        description: `${successes} lyckades, ${failures.length} misslyckades: ${failures.slice(0, 3).join(', ')}${failures.length > 3 ? '...' : ''}`,
        variant: 'destructive',
      })
    }
    exitBatchMode()
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
      if (!cpSuggestion) return
      setQuickReview({
        transaction,
        category: transaction.amount < 0 ? 'expense_other' : 'income_services',
        label: cpSuggestion.name_sv,
        template: { id: templateId, name_sv: cpSuggestion.name_sv } as BookingTemplate,
        templateId: undefined,
        linePattern: cpSuggestion.line_pattern ?? null,
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
      setBookingDialogOpen(true)
    }
  }

  // Complex (multi-leg or otherwise non-convertible) library template picked
  // from the transaction modal — route into the manual booking dialog with
  // the template pre-applied against the transaction's amount.
  function handlePickLibraryTemplate(raw: BookingTemplateLibrary) {
    if (!templatePickerTransaction) return
    setBookingDialogTransaction(templatePickerTransaction)
    setBookingDialogTemplate(raw)
    setTemplatePickerOpen(false)
    setBookingDialogOpen(true)
  }

  async function handleQuickReviewConfirm(
    id: string,
    category: TransactionCategory,
    vatTreatment: VatTreatment | undefined,
    accountOverride: string | undefined,
    templateId?: string
  ): Promise<string | null> {
    let journalEntryId: string | null
    if (!templateId && quickReview?.template?.id && isCounterpartyTemplateId(quickReview.template.id)) {
      const cpTemplateId = extractCounterpartyId(quickReview.template.id)
      const cpCategorize = async (): Promise<{ ok: boolean; journalEntryId: string | null; result: { error?: { code?: string; account_numbers?: string[]; details?: { account_numbers?: string[] } }; journal_entry_id?: string | null }; status: number }> => {
        const r = await fetch(`/api/transactions/${id}/categorize`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ is_business: true, counterparty_template_id: cpTemplateId }),
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
          // Synchronous in-flight flag per toast closure — see same pattern
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
                    setExitingIds((prev) => new Set(prev).add(id))
                    setTransactions((prev) =>
                      prev.map((t) =>
                        t.id === id
                          ? { ...t, is_business: true, ...(retry.journalEntryId ? { journal_entry_id: retry.journalEntryId } : {}) }
                          : t
                      )
                    )
                    toast({ title: 'Bokförd' })
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
        } else {
          toast({ title: 'Kategorisering misslyckades', description: getErrorMessage(result, { context: 'transaction', statusCode: cpStatus }), variant: 'destructive' })
        }
        // Close the review dialog on hard errors — the toast (with action if
        // ACCOUNTS_NOT_IN_CHART) carries the message and the recovery path.
        setQuickReviewOpen(false)
        setQuickReview(null)
        return null
      }
      setExitingIds((prev) => new Set(prev).add(id))
      journalEntryId = cpJeId
    } else {
      journalEntryId = await handleCategorize(id, true, category, vatTreatment, accountOverride, templateId)
    }
    // Always close — whether the server created a verifikation, returned a
    // structured 4xx (ACCOUNTS_NOT_IN_CHART, INVALID_MAPPING, …), or hit a
    // partial-success path. The toast from runCategorize already communicates
    // the outcome; keeping the dialog open serves no purpose.
    setQuickReviewOpen(false)
    setQuickReview(null)
    return journalEntryId
  }

  return (
    <div className="space-y-6">
      {/* Status bar */}
      <TransactionStatusBar
        uncategorizedCount={totalUncategorizedCount ?? uncategorizedTransactions.length}
        invoiceMatchCount={transactionsWithMatches.length}
        mode={mode}
        onOpenCreateDialog={() => setIsDialogOpen(true)}
        isBatchMode={isBatchMode}
        onToggleBatchMode={() => (isBatchMode ? exitBatchMode() : setIsBatchMode(true))}
      />

      <div className="flex flex-wrap items-center gap-2">
        <BankSyncStatusChip />
        <BankSyncNowButton />
      </div>
      <BankSyncSinceLastVisit />

      {/* Search + view dropdown */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Sök transaktioner…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            className="h-9 pl-10"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-9 gap-1.5 px-3 text-sm">
              {mode === 'inbox'
                ? `Att bokföra${(totalUncategorizedCount ?? uncategorizedTransactions.length) > 0 ? ` (${totalUncategorizedCount ?? uncategorizedTransactions.length})` : ''}`
                : 'Alla transaktioner'}
              <ChevronDown className="h-3.5 w-3.5 opacity-50" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[14rem]">
            <DropdownMenuRadioGroup value={mode} onValueChange={(v) => setMode(v as typeof mode)}>
              <DropdownMenuRadioItem value="inbox">
                {`Att bokföra${(totalUncategorizedCount ?? uncategorizedTransactions.length) > 0 ? ` (${totalUncategorizedCount ?? uncategorizedTransactions.length})` : ''}`}
              </DropdownMenuRadioItem>
              <DropdownMenuRadioItem value="history">Alla transaktioner</DropdownMenuRadioItem>
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Content based on mode */}
      {isLoading ? (
        <DataList>
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex items-center gap-3 px-4 py-3 animate-pulse">
              <div className="h-5 w-5 rounded bg-muted" />
              <div className="flex-1 space-y-2">
                <div className="h-4 w-48 rounded bg-muted" />
                <div className="h-3 w-24 rounded bg-muted" />
              </div>
              <div className="h-5 w-20 rounded bg-muted" />
            </div>
          ))}
        </DataList>
      ) : mode === 'inbox' ? (
        inboxItems.length === 0 && !searchTerm ? (
          <InboxZeroState
            hasTransactions={transactions.length > 0 || skvRows.length > 0}
            onCreateTransaction={() => setIsDialogOpen(true)}
          />
        ) : (
          <DataList>
            {skvUnmatched.length > 0 && uncategorizedTransactions.length > 0 && (
              <DataListHeader>
                <span className="text-xs uppercase tracking-wider text-muted-foreground">
                  {t('source_label')}
                </span>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="outline" size="sm" className="h-7 gap-1.5 px-2 text-xs">
                      {sourceFilter === 'all'
                        ? t('source_all', { count: uncategorizedTransactions.length + skvUnmatched.length })
                        : sourceFilter === 'bank'
                          ? t('source_bank', { count: uncategorizedTransactions.length })
                          : t('source_skatteverket', { count: skvUnmatched.length })}
                      <ChevronDown className="h-3 w-3 opacity-50" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="start" className="min-w-[12rem]">
                    <DropdownMenuRadioGroup
                      value={sourceFilter}
                      onValueChange={(v) => setSourceFilter(v as typeof sourceFilter)}
                    >
                      <DropdownMenuRadioItem value="all">
                        {t('source_all', { count: uncategorizedTransactions.length + skvUnmatched.length })}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="bank">
                        {t('source_bank', { count: uncategorizedTransactions.length })}
                      </DropdownMenuRadioItem>
                      <DropdownMenuRadioItem value="skatteverket">
                        {t('source_skatteverket', { count: skvUnmatched.length })}
                      </DropdownMenuRadioItem>
                    </DropdownMenuRadioGroup>
                  </DropdownMenuContent>
                </DropdownMenu>
              </DataListHeader>
            )}
            {inboxItems.length === 0 && searchTerm ? (
              <DataListEmpty
                title="Inga träffar"
                description={t('no_search_results')}
              />
            ) : null}
            <AnimatePresence mode="popLayout">
              {inboxItems.map(item =>
                item.source === 'bank' ? (
                  <TransactionInboxCard
                    key={`bank-${item.data.id}`}
                    transaction={item.data}
                    skvCounterpartDate={bankToSkvHints.get(item.data.id)}
                    processingId={processingId}
                    isBatchMode={isBatchMode}
                    isSelected={selectedIds.has(item.data.id)}
                    entityType={entityType}
                    onCategorize={handleCategorize}
                    onOpenMatchDialog={openMatchDialog}
                    onOpenMatchInvoicePicker={openInvoiceMatchPicker}
                    onOpenSplitMatch={openSplitMatchDialog}
                    onOpenMatchVoucher={openMatchVoucherDialog}
                    onOpenCategoryDialog={openCategoryDialog}
                    onDelete={handleDeleteTransaction}
                    onEditTitle={openEditTitleDialog}
                    onToggleSelect={toggleBatchSelect}
                  />
                ) : (
                  <SkattekontoInboxCard
                    key={`skv-${item.data.id}`}
                    row={item.data}
                    matchSuggestion={item.data.match_suggestion}
                    processing={skvProcessingId === item.data.id}
                    onBokfor={handleSkvBokfor}
                    onMatch={r => setSkvMatchTarget(r)}
                  />
                ),
              )}
            </AnimatePresence>
          </DataList>
        )
      ) : (
        <TransactionHistoryList
          transactions={transactions}
          skvRows={skvRows}
          searchTerm={searchTerm}
          onOpenMatchDialog={openMatchDialog}
          onOpenCategoryDialog={openCategoryDialog}
          onDelete={handleDeleteTransaction}
          onSkvBokfor={handleSkvBokfor}
          onSkvMatch={r => setSkvMatchTarget(r)}
          hasMore={hasMore}
          isLoadingMore={isLoadingMore}
          onLoadMore={loadMoreTransactions}
        />
      )}

      {/* Batch mode floating action bar */}
      {isBatchMode && selectedIds.size > 0 && (
        <div className="fixed bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 z-40 flex items-center gap-3 bg-background border rounded-xl shadow-lg px-4 py-3">
          {batchProgress ? (
            <>
              <Badge variant="secondary">
                {batchProgress.done}/{batchProgress.total}
              </Badge>
              <p className="text-sm text-muted-foreground">
                Bokför {batchProgress.done} av {batchProgress.total}...
              </p>
            </>
          ) : (
            <>
              <Badge variant="secondary">{selectedIds.size} valda</Badge>
              <Button variant="ghost" size="sm" onClick={() => setSelectedIds(new Set())}>
                <X className="mr-1 h-3 w-3" />
                Avmarkera
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleBatchDelete}
                className="text-destructive hover:text-destructive"
              >
                <Trash2 className="mr-1 h-3 w-3" />
                Ta bort
              </Button>
              {/* Bulk-book (samlingsverifikation) — only when ≥2 selected on
                  the same date + same direction. Disabled state explains why
                  via title. */}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setBulkBookOpen(true)}
                disabled={!bulkBookEligible}
                title={
                  !bulkBookEligible
                    ? 'Välj minst två transaktioner från samma datum och samma riktning'
                    : 'Skapa en samlingsverifikation för de valda transaktionerna'
                }
              >
                <Layers className="mr-1 h-3 w-3" />
                Bokför i klump
              </Button>
              <Button size="sm" onClick={() => setShowBatchSelector(true)}>
                Bokför
              </Button>
            </>
          )}
        </div>
      )}

      {/* Dialogs */}
      <BatchCategorySelector
        open={showBatchSelector}
        onOpenChange={setShowBatchSelector}
        selectedCount={selectedIds.size}
        onSelectCategory={handleBatchCategorize}
        progress={batchProgress}
      />

      <InvoiceMatchDialog
        open={matchDialogOpen}
        onOpenChange={setMatchDialogOpen}
        transaction={selectedTransaction}
        isConfirming={isConfirmingMatch}
        onConfirm={handleConfirmInvoiceMatch}
        onLinkToExisting={handleLinkToExistingVoucher}
      />

      <MatchVoucherDialog
        open={matchVoucherTx !== null}
        onOpenChange={(o) => { if (!o) setMatchVoucherTx(null) }}
        transaction={matchVoucherTx}
        onLinked={handleVoucherLinked}
      />

      <MatchAllocationDialog
        open={splitMatchOpen}
        onOpenChange={(o) => {
          setSplitMatchOpen(o)
          if (!o) setSplitMatchTransaction(null)
        }}
        transaction={splitMatchTransaction}
        onSuccess={handleSplitMatchSuccess}
      />

      <BulkBookDialog
        open={bulkBookOpen}
        onOpenChange={setBulkBookOpen}
        transactions={selectedTransactions}
        onSuccess={handleBulkBookSuccess}
      />

      <TransactionBookingDialog
        open={bookingDialogOpen}
        onOpenChange={(o) => {
          setBookingDialogOpen(o)
          if (!o) setBookingDialogTemplate(null)
        }}
        transaction={bookingDialogTransaction}
        preselectedTemplate={bookingDialogTemplate}
        onBooked={handleTransactionBooked}
      />

      <Dialog open={templatePickerOpen} onOpenChange={setTemplatePickerOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Bokför transaktion</DialogTitle>
          </DialogHeader>
          {templatePickerTransaction && (
            <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
              <span className="truncate text-muted-foreground">{templatePickerTransaction.description}</span>
              <span className="font-medium tabular-nums flex-shrink-0 ml-3">
                {templatePickerTransaction.amount > 0 ? '+' : ''}{formatCurrency(templatePickerTransaction.amount, templatePickerTransaction.currency)}
              </span>
            </div>
          )}
          <div className="space-y-1">
            <Button
              variant="outline"
              size="sm"
              className="w-full justify-start"
              onClick={handleManualBooking}
            >
              Bokför manuellt…
            </Button>
            {templatePickerTransaction && templatePickerTransaction.amount > 0 && (
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-start"
                onClick={() => {
                  const tx = templatePickerTransaction
                  setTemplatePickerOpen(false)
                  setInvoicePickerTransaction(tx)
                  setInvoicePickerOpen(true)
                }}
              >
                Matcha med faktura…
              </Button>
            )}
            {templatePickerTransaction && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full justify-start text-muted-foreground"
                onClick={() => void handleIgnoreTransaction(templatePickerTransaction)}
              >
                Ignorera transaktionen…
              </Button>
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
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={invoicePickerOpen}
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
      </Dialog>

      <Dialog
        open={supplierInvoicePickerOpen}
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
      </Dialog>

      <QuickReviewDialog
        key={quickReview?.transaction.id ?? '' + String(quickReview?.category) + String(quickReview?.templateId) + String(quickReview?.template?.id)}
        open={quickReviewOpen}
        onOpenChange={setQuickReviewOpen}
        transaction={quickReview?.transaction ?? null}
        category={quickReview?.category ?? null}
        categoryLabel={quickReview?.label ?? ''}
        defaultAccount={
          // For library templates (no templateId but a template object), use the
          // template's debit account as the default; otherwise fall back to the
          // category's default account.
          !quickReview?.templateId && quickReview?.template
            ? quickReview.template.debit_account
            : quickReview?.category ? getDefaultAccountForCategory(quickReview.category) : ''
        }
        defaultVat={
          !quickReview?.templateId && quickReview?.template
            ? (quickReview.template.vat_treatment ?? 'none')
            : quickReview?.category ? (getDefaultVatTreatmentForCategory(quickReview.category) ?? 'none') : 'none'
        }
        entityType={entityType as EntityType}
        template={quickReview?.template ?? null}
        templateId={quickReview?.templateId}
        counterpartyLinePattern={quickReview?.linePattern ?? null}
        onConfirm={handleQuickReviewConfirm}
        onChangeTemplate={handleChangeTemplate}
      />

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('dialog_add_transaction')}</DialogTitle>
          </DialogHeader>
          <TransactionForm onSubmit={handleCreateTransaction} isLoading={isCreating} />
        </DialogContent>
      </Dialog>

      <DestructiveConfirmDialog {...confirmDialogProps} />

      <EditTransactionTitleDialog
        open={editTitleTarget !== null}
        onOpenChange={(v) => {
          if (!v) setEditTitleTarget(null)
        }}
        currentTitle={editTitleTarget?.description ?? ''}
        originalTitle={editTitleTarget?.original_description ?? null}
        onSave={handleSaveTitle}
      />

      <SkattekontoMatchDialog
        row={skvMatchTarget}
        open={!!skvMatchTarget}
        onClose={() => setSkvMatchTarget(null)}
        onMatched={handleSkvMatched}
      />

      {/* Prong B: match-against-supplier-invoice suggestion */}
      <Dialog
        open={siMatchSuggestion !== null}
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
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
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
      </Dialog>

      {/* Prong B (customer side): match-against-customer-invoice suggestion */}
      <Dialog
        open={ciMatchSuggestion !== null}
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
            <div className="space-y-2 rounded-md border bg-muted/30 p-3">
              {ciMatchSuggestion?.candidates.map((c) => (
                <div key={c.invoice_id} className="flex items-center justify-between gap-3 text-sm">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {c.customer_name || 'Kund'} · {c.invoice_number ?? '—'}
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
      </Dialog>

    </div>
  )
}
