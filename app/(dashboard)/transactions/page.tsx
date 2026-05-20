'use client'

import { useState, useEffect, useRef } from 'react'
import { AnimatePresence } from 'framer-motion'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useToast } from '@/components/ui/use-toast'
import { ToastAction } from '@/components/ui/toast'
import { DestructiveConfirmDialog, useDestructiveConfirm } from '@/components/ui/destructive-confirm-dialog'
import { Landmark, X } from 'lucide-react'
import TransactionForm from '@/components/transactions/TransactionForm'
import BatchCategorySelector from '@/components/transactions/BatchCategorySelector'
import TransactionStatusBar from '@/components/transactions/TransactionStatusBar'
import TransactionInboxCard from '@/components/transactions/TransactionInboxCard'
import TransactionHistoryList from '@/components/transactions/TransactionHistoryList'
import InboxZeroState from '@/components/transactions/InboxZeroState'
import SkattekontoInboxCard from '@/components/transactions/SkattekontoInboxCard'
import { SkattekontoMatchDialog } from '@/components/skattekonto/SkattekontoMatchDialog'
import InvoiceMatchDialog from '@/components/transactions/InvoiceMatchDialog'
import InvoicePicker from '@/components/transactions/InvoicePicker'
import TransactionBookingDialog from '@/components/transactions/TransactionBookingDialog'
import QuickReviewDialog from '@/components/transactions/QuickReviewDialog'

import TemplatePicker from '@/components/transactions/TemplatePicker'
import { EXPENSE_CATEGORIES, INCOME_CATEGORIES } from '@/components/transactions/transaction-types'
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
import { cn, formatCurrency, formatDate } from '@/lib/utils'
import type { TransactionCategory, CreateTransactionInput, Invoice, Customer, SupplierInvoice, Supplier, VatTreatment, EntityType, LinePatternEntry } from '@/types'
import type { SuggestedCategory, SuggestedTemplate } from '@/lib/transactions/category-suggestions'

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
  const [transactions, setTransactions] = useState<TransactionWithInvoice[]>([])
  const [isLoading, setIsLoading] = useState(true)
  const [mode, setMode] = useState<ViewMode>('inbox')
  const [isDialogOpen, setIsDialogOpen] = useState(false)
  const [isCreating, setIsCreating] = useState(false)
  const [categorySuggestions, setCategorySuggestions] = useState<Record<string, SuggestedCategory[]>>({})
  const [templateSuggestions, setTemplateSuggestions] = useState<Record<string, SuggestedTemplate[]>>({})
  const [isLoadingSuggestions, setIsLoadingSuggestions] = useState(false)
  const [processingId, setProcessingId] = useState<string | null>(null)

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

  // Template picker dialog
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false)
  const [templatePickerTransaction, setTemplatePickerTransaction] = useState<TransactionWithInvoice | null>(null)

  // Invoice picker dialog (manual match)
  const [invoicePickerOpen, setInvoicePickerOpen] = useState(false)
  const [invoicePickerTransaction, setInvoicePickerTransaction] = useState<TransactionWithInvoice | null>(null)
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
  const { dialogProps: deleteDialogProps, confirm: confirmDelete } = useDestructiveConfirm()
  const supabase = createClient()
  const searchParams = useSearchParams()
  const highlightId = searchParams.get('highlight')
  // Tracks the last highlight target we acted on so re-renders don't re-trigger
  // the auto-open every time the user closes the categorize panel.
  const handledHighlightRef = useRef<string | null>(null)

  // Computed lists
  const uncategorizedTransactions = transactions
    .filter((t) => t.is_business === null && !exitingIds.has(t.id))
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
    if (sourceFilter !== 'skatteverket') {
      for (const t of uncategorizedTransactions) {
        items.push({ source: 'bank', date: t.date, data: t })
      }
    }
    if (sourceFilter !== 'bank') {
      // Inbox only shows SKV rows that need action (no verifikat yet).
      for (const r of skvRows) {
        if (r.journal_entry_id) continue
        if (exitingIds.has(r.id)) continue
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
        .is('is_business', null),
    ])

    if (txError) {
      toast({ title: 'Kunde inte ladda transaktioner', description: 'Kontrollera din anslutning och försök igen.', variant: 'destructive' })
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
    setIsLoadingSuggestions(true)
    try {
      const response = await fetch('/api/transactions/suggest-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ transaction_ids: txIds }),
      })
      if (!response.ok) throw new Error('Failed to fetch suggestions')
      const data = await response.json()
      if (data.suggestions) {
        setCategorySuggestions(data.suggestions)
      }
      if (data.template_suggestions) {
        setTemplateSuggestions(data.template_suggestions)
      }
    } catch {
      // Non-critical
    }
    setIsLoadingSuggestions(false)
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

      if (entityRes?.entity_type) {
        setEntityType(entityRes.entity_type)
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
                  toast({ title: 'Ångrad', description: 'Kategorisering har ångrats' })
                } else {
                  const errData = await undoRes.json()
                  toast({
                    title: 'Kunde inte ångra',
                    description: getErrorMessage(errData, { context: 'transaction', statusCode: undoRes.status }),
                    variant: 'destructive',
                  })
                }
              } catch {
                toast({ title: 'Kunde inte ångra', description: 'Kategoriseringen kunde inte ångras. Försök igen.', variant: 'destructive' })
              }
            }}>
              Ångra
            </ToastAction>
          ),
        })
      } else if (result.journal_entry_error) {
        toast({ title: 'Delvis bokförd', description: `Verifikation kunde inte skapas: ${result.journal_entry_error}`, variant: 'destructive' })
      } else {
        toast({ title: 'Delvis bokförd', description: 'Transaktion uppdaterad men verifikation kunde inte skapas' })
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
      toast({ title: 'Bokföring misslyckades', description: 'Transaktionen kunde inte bokföras. Försök igen.', variant: 'destructive' })
      setProcessingId(null)
      return null
    }
  }

  async function handleMarkPrivate(id: string) {
    await handleCategorize(id, false, 'private')
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

      toast({ title: 'Kundfaktura matchad', description: 'Fakturan markerades som betald' })
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
      toast({ title: 'Matchning misslyckades', description: 'Försök igen.', variant: 'destructive' })
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

      toast({ title: 'Leverantörsfaktura matchad', description: 'Fakturan markerades som betald' })
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
      toast({ title: 'Matchning misslyckades', description: 'Försök igen.', variant: 'destructive' })
    } finally {
      setSiMatchProcessing(false)
    }
  }

  async function handleConfirmInvoiceMatch() {
    if (!selectedTransaction) return
    const isSupplier = !!selectedTransaction.potential_supplier_invoice
    const isCustomer = !!selectedTransaction.potential_invoice
    if (!isSupplier && !isCustomer) return

    setIsConfirmingMatch(true)

    try {
      const url = isSupplier
        ? `/api/transactions/${selectedTransaction.id}/match-supplier-invoice`
        : `/api/transactions/${selectedTransaction.id}/match-invoice`
      const body = isSupplier
        ? { supplier_invoice_id: selectedTransaction.potential_supplier_invoice!.id }
        : { invoice_id: selectedTransaction.potential_invoice!.id }

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
      toast({ title: 'Matchning misslyckades', description: 'Transaktionen kunde inte matchas. Försök igen.', variant: 'destructive' })
      setIsConfirmingMatch(false)
    }
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
      toast({ title: 'Matchning misslyckades', description: 'Transaktionen kunde inte matchas med fakturan. Försök igen.', variant: 'destructive' })
      return false
    }
  }

  async function handleSelectInvoiceFromPicker(invoice: Invoice & { customer?: Customer }) {
    if (!invoicePickerTransaction) return
    const tx = invoicePickerTransaction
    setIsMatchingFromPicker(true)
    try {
      const response = await fetch(`/api/transactions/${tx.id}/match-invoice`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoice_id: invoice.id }),
      })
      const result = await response.json()
      if (!response.ok) {
        toast({
          title: 'Fakturamatchning misslyckades',
          description: getErrorMessage(result, { context: 'transaction' }),
          variant: 'destructive',
        })
        setIsMatchingFromPicker(false)
        return
      }

      toast({
        title: 'Faktura matchad',
        description: `Faktura ${invoice.invoice_number ?? ''} markerad som betald`,
      })

      setInvoicePickerOpen(false)
      setInvoicePickerTransaction(null)
      setExitingIds((prev) => new Set(prev).add(tx.id))
      setTotalUncategorizedCount((prev) => Math.max(0, (prev ?? 1) - 1))
      setTimeout(() => {
        setTransactions((prev) =>
          prev.map((t) =>
            t.id === tx.id
              ? {
                  ...t,
                  invoice_id: invoice.id,
                  potential_invoice_id: null,
                  potential_invoice: undefined,
                  is_business: true,
                  category: (result.category ?? 'income_services') as TransactionCategory,
                  journal_entry_id: result.journal_entry_id,
                }
              : t
          )
        )
        setExitingIds((prev) => {
          const next = new Set(prev)
          next.delete(tx.id)
          return next
        })
        setIsMatchingFromPicker(false)
      }, 350)
    } catch {
      toast({
        title: 'Matchning misslyckades',
        description: 'Transaktionen kunde inte matchas med fakturan. Försök igen.',
        variant: 'destructive',
      })
      setIsMatchingFromPicker(false)
    }
  }

  async function handleCreateTransaction(data: CreateTransactionInput) {
    setIsCreating(true)
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      toast({ title: 'Inloggning krävs', description: 'Du måste vara inloggad för att lägga till transaktioner.', variant: 'destructive' })
      setIsCreating(false)
      return
    }

    const { data: transaction, error } = await supabase
      .from('transactions')
      .insert({
        company_id: company!.id,
        user_id: user.id,
        date: data.date,
        description: data.description,
        amount: data.amount,
        currency: data.currency,
        category: data.category || 'uncategorized',
        is_business: null,
        notes: data.notes,
      })
      .select()
      .single()

    if (error) {
      toast({ title: 'Kunde inte skapa transaktion', description: error.message, variant: 'destructive' })
    } else {
      toast({ title: 'Transaktion tillagd', description: `${data.description} har lagts till` })
      setTransactions([transaction, ...transactions])
      setIsDialogOpen(false)
    }
    setIsCreating(false)
  }

  async function handleDeleteTransaction(id: string) {
    const transaction = transactions.find((t) => t.id === id)
    if (!transaction) return

    const ok = await confirmDelete({
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
      toast({ title: 'Borttagen', description: 'Transaktionen har tagits bort' })
    } catch {
      toast({
        title: 'Kunde inte ta bort',
        description: 'Transaktionen kunde inte tas bort. Försök igen.',
        variant: 'destructive',
      })
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
        description: 'Granska och bokför verifikatet i Bokföring.',
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

  async function handleBatchMarkPrivate() {
    const ids = Array.from(selectedIds)
    setBatchProgress({ done: 0, total: ids.length })
    for (let i = 0; i < ids.length; i++) {
      await handleCategorize(ids[i], false, 'private')
      setBatchProgress({ done: i + 1, total: ids.length })
    }
    setBatchProgress(null)
    toast({ title: 'Klart', description: `${ids.length} transaktioner markerade som privat` })
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

  function handleOpenQuickReview(transaction: TransactionWithInvoice, suggestion: SuggestedCategory) {
    const allCategories = [...EXPENSE_CATEGORIES, ...INCOME_CATEGORIES]
    const label = allCategories.find((c) => c.value === suggestion.category)?.label || suggestion.label
    setQuickReview({ transaction, category: suggestion.category, label, template: null, templateId: undefined, linePattern: null })
    setQuickReviewOpen(true)
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
      setBookingDialogOpen(true)
    }
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
      const response = await fetch(`/api/transactions/${id}/categorize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          is_business: true,
          counterparty_template_id: cpTemplateId,
        }),
      })
      const result = await response.json()
      if (!response.ok) {
        toast({ title: 'Kategorisering misslyckades', description: getErrorMessage(result, { context: 'transaction' }), variant: 'destructive' })
        return null
      }
      setExitingIds((prev) => new Set(prev).add(id))
      journalEntryId = result.journal_entry_id || null
    } else {
      journalEntryId = await handleCategorize(id, true, category, vatTreatment, accountOverride, templateId)
    }
    if (journalEntryId) {
      setQuickReviewOpen(false)
      setQuickReview(null)
    }
    return journalEntryId
  }

  return (
    <div className="space-y-6">
      {/* Status bar with mode toggle */}
      <TransactionStatusBar
        uncategorizedCount={totalUncategorizedCount ?? uncategorizedTransactions.length}
        invoiceMatchCount={transactionsWithMatches.length}
        mode={mode}
        onModeChange={setMode}
        onOpenCreateDialog={() => setIsDialogOpen(true)}
        isBatchMode={isBatchMode}
        onToggleBatchMode={() => (isBatchMode ? exitBatchMode() : setIsBatchMode(true))}
      />

      {/* Content based on mode */}
      {isLoading ? (
        <div className="space-y-3">
          {[1, 2, 3].map((i) => (
            <Card key={i} className="animate-pulse">
              <CardContent className="py-4">
                <div className="flex items-center justify-between">
                  <div className="space-y-2">
                    <div className="h-5 bg-muted rounded w-48" />
                    <div className="h-4 bg-muted rounded w-24" />
                  </div>
                  <div className="h-6 bg-muted rounded w-20" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      ) : mode === 'inbox' ? (
        inboxItems.length === 0 ? (
          <InboxZeroState
            hasTransactions={transactions.length > 0 || skvRows.length > 0}
            onCreateTransaction={() => setIsDialogOpen(true)}
          />
        ) : (
          <div className="space-y-3">
            {/* Source filter — only render when both sources have content
                to filter between, otherwise it'd be a no-op chip row. */}
            {skvUnmatched.length > 0 && uncategorizedTransactions.length > 0 && (
              <div className="flex items-center gap-2 text-xs">
                <span className="text-muted-foreground">Källa:</span>
                <button
                  onClick={() => setSourceFilter('all')}
                  className={cn(
                    'rounded-full border px-3 py-1 transition-colors',
                    sourceFilter === 'all'
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  Alla ({uncategorizedTransactions.length + skvUnmatched.length})
                </button>
                <button
                  onClick={() => setSourceFilter('bank')}
                  className={cn(
                    'rounded-full border px-3 py-1 transition-colors',
                    sourceFilter === 'bank'
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  Bank ({uncategorizedTransactions.length})
                </button>
                <button
                  onClick={() => setSourceFilter('skatteverket')}
                  className={cn(
                    'flex items-center gap-1 rounded-full border px-3 py-1 transition-colors',
                    sourceFilter === 'skatteverket'
                      ? 'border-foreground bg-foreground text-background'
                      : 'border-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Landmark className="h-3 w-3" />
                  Skatteverket ({skvUnmatched.length})
                </button>
              </div>
            )}
            <AnimatePresence mode="popLayout">
              {inboxItems.map(item =>
                item.source === 'bank' ? (
                  <TransactionInboxCard
                    key={`bank-${item.data.id}`}
                    transaction={item.data}
                    suggestions={categorySuggestions[item.data.id]}
                    templateSuggestions={templateSuggestions[item.data.id]}
                    skvCounterpartDate={bankToSkvHints.get(item.data.id)}
                    processingId={processingId}
                    isBatchMode={isBatchMode}
                    isSelected={selectedIds.has(item.data.id)}
                    entityType={entityType}
                    onCategorize={handleCategorize}
                    onMarkPrivate={handleMarkPrivate}
                    onOpenMatchDialog={openMatchDialog}
                    onOpenCategoryDialog={openCategoryDialog}
                    onDelete={handleDeleteTransaction}
                    onOpenQuickReview={handleOpenQuickReview}
                    onOpenTemplateReview={handleOpenTemplateReview}
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
          </div>
        )
      ) : (
        <TransactionHistoryList
          transactions={transactions}
          skvRows={skvRows}
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
              <Button variant="outline" size="sm" onClick={handleBatchMarkPrivate}>
                Markera som privat
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
      />

      <TransactionBookingDialog
        open={bookingDialogOpen}
        onOpenChange={setBookingDialogOpen}
        transaction={bookingDialogTransaction}
        onBooked={handleTransactionBooked}
      />

      <Dialog open={templatePickerOpen} onOpenChange={setTemplatePickerOpen}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Välj mall</DialogTitle>
          </DialogHeader>
          {templatePickerTransaction && (
            <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-sm">
              <span className="truncate text-muted-foreground">{templatePickerTransaction.description}</span>
              <span className="font-medium tabular-nums flex-shrink-0 ml-3">
                {templatePickerTransaction.amount > 0 ? '+' : ''}{formatCurrency(templatePickerTransaction.amount, templatePickerTransaction.currency)}
              </span>
            </div>
          )}
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
          />
          <div className="pt-2 border-t space-y-1">
            {templatePickerTransaction && templatePickerTransaction.amount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="w-full text-muted-foreground"
                onClick={() => {
                  const tx = templatePickerTransaction
                  setTemplatePickerOpen(false)
                  setInvoicePickerTransaction(tx)
                  setInvoicePickerOpen(true)
                }}
              >
                Matcha med faktura...
              </Button>
            )}
            <Button variant="ghost" size="sm" className="w-full text-muted-foreground" onClick={handleManualBooking}>
              Ange konton manuellt...
            </Button>
          </div>
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
            <DialogTitle>Matcha med faktura</DialogTitle>
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
            <DialogTitle>Lägg till transaktion</DialogTitle>
          </DialogHeader>
          <TransactionForm onSubmit={handleCreateTransaction} isLoading={isCreating} />
        </DialogContent>
      </Dialog>

      <DestructiveConfirmDialog {...deleteDialogProps} />

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
            <DialogTitle>Matcha mot leverantörsfaktura?</DialogTitle>
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
            <DialogTitle>Matcha mot kundfaktura?</DialogTitle>
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
                        <Badge variant="success">Exakt OCR-träff</Badge>
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
