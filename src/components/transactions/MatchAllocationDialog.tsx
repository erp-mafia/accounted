'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatCurrency, formatDate, cn, isValidExchangeRate, chunk } from '@/lib/utils'
import {
  CheckIcon,
  ChevronDownIcon,
  ClipboardDocumentIcon,
  DocumentArrowUpIcon,
  ExclamationTriangleIcon,
  LinkIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  SpinnerIcon,
  XMarkIcon,
} from '@/components/icons'
import type { Invoice, Customer, SupplierInvoice, Supplier } from '@/types'
import {
  PASTE_OPEN_INVOICES_MAX,
  PICKER_LIMIT,
  loadInvoicesForPaste,
  loadOpenInvoicesForMatch,
  type PasteLookupInvoice,
} from '@/lib/invoices/open-invoice-search'
import {
  MAX_PASTED_REFERENCES,
  beslutFileToPaste,
  parseInvoicePaste,
  planInvoicePaste,
  type InvoicePasteResult,
  type ParsedInvoicePaste,
  type PasteSkip,
  type PasteSkipReason,
} from '@/lib/invoices/invoice-number-paste'
import { beslutFileIsForCompany, readBeslutFile } from '@/lib/invoices/rot-rut-beslut-file'
import { useAccounts, useCompanySettings } from '@/lib/reference-data/hooks'
import { ID_READ_CHUNK, MAX_BANK_ROW_SPLIT } from '@/lib/reconciliation/limits'
import type { TransactionWithInvoice } from './transaction-types'
import type { BatchAllocationPrefill } from '@/lib/transactions/parts-read'
import { parseAmountInput, formatAmountInput, roundOre, sumOre, ORE_ROUNDING_SETTLEMENT_MAX } from '@/lib/money'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { VoucherLinesTable } from '@/components/bookkeeping/VoucherLinesTable'
import { voucherLineViews, type PostingLineLike } from '@/lib/bookkeeping/voucher-line-view'
import { PAYMENT_FEE_ACCOUNT } from '@/lib/bookkeeping/payment-fee'
import {
  MAX_PAYOUT_FEES,
  PAYOUT_FEE_DESCRIPTION_MAX,
  isPayoutFeeAccount,
  payoutBankAmount,
  payoutFeesWithinInvoices,
} from '@/lib/bookkeeping/payout-fee-lines'

/** Pause after the last keystroke before the search goes to the database. */
const SEARCH_DEBOUNCE_MS = 250

/**
 * Picked invoices shown as rows above the search results. Past this many
 * they fold into one summary line (count and sum, expandable): after a paste
 * of hundreds, every search result would otherwise sit below all of them.
 */
const PICKED_INLINE_MAX = 10

/** Why a pasted number was not picked, as the reason line beside it says. */
const PASTE_REASON_KEYS: Record<PasteSkipReason, string> = {
  not_found: 'paste_reason_not_found',
  already_paid: 'paste_reason_already_paid',
  not_open: 'paste_reason_not_open',
  ambiguous: 'paste_reason_ambiguous',
  other_currency: 'paste_reason_other_currency',
  amount_above_remaining: 'paste_reason_amount_above_remaining',
  same_invoice: 'paste_reason_same_invoice',
  conflicting_amounts: 'paste_reason_conflicting_amounts',
  unreadable: 'paste_reason_unreadable',
  refused: 'paste_reason_refused',
  no_invoice_number: 'paste_reason_no_invoice_number',
}

/**
 * What the dialog reads of the bank row. Att göra opens it from a worklist
 * suggestion (lib/worklist SuggestedMatch with allocations), which carries
 * these and nothing more.
 */
export type AllocationTransaction = Pick<TransactionWithInvoice, 'id' | 'amount' | 'date' | 'description'> & {
  currency: string
}

interface MatchAllocationDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transaction: AllocationTransaction | null
  /**
   * Allocations to start from (the row's Bankgirot split, one per suggested
   * part): picked with their amounts as soon as the candidates load, an
   * invoice past the newest PICKER_LIMIT fetched by id. Null starts empty.
   */
  initialAllocations?: BatchAllocationPrefill[] | null
  onSuccess: () => void
}

/**
 * Direction-aware allocation candidate. The dialog normalizes customer and
 * supplier invoices to the same shape so the row renderer + tally math stay
 * a single code path. The `kind` discriminator drives the underlying API
 * payload at submit time.
 *
 * `remaining` is in the invoice's own `currency` (USD, EUR, etc.).
 * `exchangeRate` is the invoice's SEK-per-foreign-unit at invoicing time:
 * used to compute the default SEK amount for cross-currency rows so the
 * user doesn't have to mental-math the FX (PR #607).
 */
interface AllocationCandidate {
  kind: 'customer_invoice' | 'supplier_invoice'
  id: string
  label: string
  counterpartyName: string
  remaining: number
  total: number
  currency: string
  exchangeRate: number | null
  dueDate: string
  /** Invoice date: an invoice issued AFTER the bank row cannot normally be what it paid. */
  invoiceDate: string | null
}

/**
 * Mirror of ExplainingVoucherSet (lib/invoices/duplicate-payment-detection.ts):
 * the posted, unlinked vouchers whose bank legs add up exactly to this row.
 * Served by GET /api/transactions/[id]/duplicate-payment-check and by the
 * BATCH_TX_POSSIBLE_DUPLICATE refusal of POST match-batch.
 */
interface ExplainingVoucher {
  journal_entry_id: string
  voucher_label: string
  entry_date: string
  description: string | null
  source_type: string | null
  amount: number
  bank_account_number: string
}

interface ExplainingSet {
  vouchers: ExplainingVoucher[]
  total: number
  bank_account_number: string
  same_date: boolean
}

function readExplainingSet(value: unknown): ExplainingSet | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Partial<ExplainingSet>
  if (!Array.isArray(v.vouchers) || v.vouchers.length === 0) return null
  return {
    vouchers: v.vouchers,
    total: Number(v.total ?? 0),
    bank_account_number: v.bank_account_number ?? v.vouchers[0].bank_account_number,
    same_date: v.same_date === true,
  }
}

type AllocationDraft = {
  /** Kept with the draft: a later search must not drop a row already picked. */
  candidate: AllocationCandidate
  amount: string
}

/** A fee row as typed: the payment service's fee on the row (lib/bookkeeping/payout-fee-lines.ts). */
type FeeDraft = {
  key: number
  account: string
  amount: string
  description: string
}

/** The voucher preview of a split with fee rows: the route's dry run of `body`, or why it refused. */
type VoucherPreview = { body: string } & (
  | { state: 'ready'; lines: PostingLineLike[] }
  | { state: 'failed'; message: string }
)

/** Pause after the last edit before the voucher preview is asked for. */
const PREVIEW_DEBOUNCE_MS = 300

type CustomerInvoiceRow = Invoice & { customer?: Customer | null }
type SupplierInvoiceRow = SupplierInvoice & { supplier?: Supplier | null }

function parseAmount(s: string): number {
  return parseAmountInput(s) ?? 0
}

/**
 * What an invoice owes in the bank row's currency: its remaining, or the
 * booked SEK of a foreign invoice with a usable rate (the dialog's own
 * default); null when there is no rate to say it with.
 */
function owedInRowCurrency(candidate: AllocationCandidate, rowCurrency: string): number | null {
  if (candidate.currency === rowCurrency) return roundOre(candidate.remaining)
  return isValidExchangeRate(candidate.exchangeRate) ? roundOre(candidate.remaining * candidate.exchangeRate) : null
}

/** A pasted invoice as a dialog row: the same shape a click adds. */
function pasteCandidate(kind: AllocationCandidate['kind'], invoice: PasteLookupInvoice, unknownName: string): AllocationCandidate {
  return {
    kind,
    id: invoice.id,
    label: invoice.label,
    counterpartyName: invoice.counterpartyName ?? unknownName,
    remaining: invoice.remaining,
    total: invoice.total,
    currency: invoice.currency ?? 'SEK',
    exchangeRate: invoice.exchangeRate,
    dueDate: invoice.dueDate,
    invoiceDate: invoice.invoiceDate,
  }
}

export default function MatchAllocationDialog({
  open,
  onOpenChange,
  transaction,
  initialAllocations = null,
  onSuccess,
}: MatchAllocationDialogProps) {
  const { toast } = useToast()
  const { company } = useCompany()
  const supabase = useMemo(() => createClient(), [])
  const t = useTranslations('tx_match_allocation')
  const tPicker = useTranslations('tx_invoice_picker')

  const kind: 'customer_invoice' | 'supplier_invoice' = useMemo(() => {
    // Strict > 0 (was >= 0): a zero-amount tx would otherwise load customer
    // candidates and the RPC would reject with BATCH_TX_ZERO_AMOUNT after
    // the user has already filled in allocations. PR #603 review fix.
    return transaction && transaction.amount > 0 ? 'customer_invoice' : 'supplier_invoice'
  }, [transaction])

  const [candidates, setCandidates] = useState<AllocationCandidate[]>([])
  const [capped, setCapped] = useState(false)
  const [loading, setLoading] = useState(true)
  const [isSearching, setIsSearching] = useState(false)
  const [search, setSearch] = useState('')
  // The term the database was asked for, trailing the input by a short pause.
  const [appliedSearch, setAppliedSearch] = useState('')
  const [drafts, setDrafts] = useState<Record<string, AllocationDraft>>({})
  const [submitting, setSubmitting] = useState(false)
  // Already-explained guard: the vouchers that already book this row, if any.
  // Set from the pre-flight on open, or from the route's 409 on submit. The
  // user either links the row to them (no new voucher) or acknowledges the
  // set, which is what lets the confirm through with force=true.
  const [explaining, setExplaining] = useState<ExplainingSet | null>(null)
  const [explainingAcknowledged, setExplainingAcknowledged] = useState(false)
  const [linking, setLinking] = useState(false)
  // Paste a list of invoice numbers (#75): hundreds picked in one go.
  const [pasteOpen, setPasteOpen] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [pasting, setPasting] = useState(false)
  const [pasteResult, setPasteResult] = useState<(InvoicePasteResult<PasteLookupInvoice> & { capped: boolean }) | null>(null)
  const [pickedExpanded, setPickedExpanded] = useState(false)
  // Skatteverket's beslutsfil feeds the same picking as a paste; its utförare
  // is checked against the company's org number.
  const beslutInputRef = useRef<HTMLInputElement>(null)
  const { settings: companySettings, isLoading: settingsLoading } = useCompanySettings()
  // Fee rows (issue #131): a payout net of the provider's fee, or a payment
  // the bank charged a fee on top of. Class 6 accounts of the active chart.
  const [fees, setFees] = useState<FeeDraft[]>([])
  const feeKey = useRef(0)
  const [voucherPreview, setVoucherPreview] = useState<VoucherPreview | null>(null)
  const { accounts, isLoading: accountsLoading } = useAccounts()
  const feeAccounts = useMemo(() => accounts.filter((a) => isPayoutFeeAccount(a.account_number)), [accounts])

  useEffect(() => {
    const handle = setTimeout(() => setAppliedSearch(search.trim()), SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [search])

  const customerCandidate = useCallback(
    (r: CustomerInvoiceRow): AllocationCandidate => ({
      kind: 'customer_invoice',
      id: r.id,
      label: r.invoice_number ?? r.id.slice(0, 8),
      counterpartyName: r.customer?.name ?? t('unknown_customer'),
      remaining: Number(r.remaining_amount ?? r.total ?? 0),
      total: Number(r.total ?? 0),
      currency: r.currency,
      exchangeRate: r.exchange_rate != null ? Number(r.exchange_rate) : null,
      dueDate: r.due_date,
      invoiceDate: r.invoice_date ?? null,
    }),
    [t],
  )
  const supplierCandidate = useCallback(
    (r: SupplierInvoiceRow): AllocationCandidate => ({
      kind: 'supplier_invoice',
      id: r.id,
      label: r.supplier_invoice_number ?? `LF-${r.arrival_number}`,
      counterpartyName: r.supplier?.name ?? t('unknown_supplier'),
      remaining: Number(r.remaining_amount ?? r.total ?? 0),
      total: Number(r.total ?? 0),
      currency: r.currency,
      exchangeRate: r.exchange_rate != null ? Number(r.exchange_rate) : null,
      dueDate: r.due_date,
      invoiceDate: r.invoice_date ?? null,
    }),
    [t],
  )

  // The prefilled allocations are applied once per opening, after the first
  // (unsearched) load: a later search must not re-pick what the person removed.
  const prefillApplied = useRef(false)

  useEffect(() => {
    if (!open || !transaction || !company) return
    const companyId = company.id
    let cancelled = false

    async function load() {
      if (appliedSearch) setIsSearching(true)
      else setLoading(true)
      try {
        // The same loader as the invoice picker: the statuses the batch RPC
        // accepts, the search in the database (so an older open invoice past
        // the newest PICKER_LIMIT is found), and the status-leak guard.
        let loaded: AllocationCandidate[]
        let full: boolean
        if (kind === 'customer_invoice') {
          const result = await loadOpenInvoicesForMatch<CustomerInvoiceRow>(supabase, companyId, 'customer', appliedSearch)
          loaded = result.rows.map(customerCandidate)
          full = result.capped
        } else {
          const result = await loadOpenInvoicesForMatch<SupplierInvoiceRow>(supabase, companyId, 'supplier', appliedSearch)
          loaded = result.rows.map(supplierCandidate)
          full = result.capped
        }
        // The split's suggested invoices of this direction: picked with the
        // part amounts. One past the newest PICKER_LIMIT is read by id so
        // the prefill never silently drops a part.
        const prefill =
          !prefillApplied.current && !appliedSearch
            ? (initialAllocations ?? []).filter((a) => a.kind === kind)
            : []
        if (prefill.length > 0) {
          const idOf = (a: BatchAllocationPrefill) => (a.kind === 'customer_invoice' ? a.invoice_id : a.supplier_invoice_id)
          const known = new Set(loaded.map((c) => c.id))
          const missingIds = prefill.map(idOf).filter((id) => !known.has(id))
          // In slices: ids travel in the query string, and a prefill of
          // hundreds in one read is answered with 414 (#2395).
          for (const slice of chunk(missingIds, ID_READ_CHUNK)) {
            if (kind === 'customer_invoice') {
              const { data } = await supabase
                .from('invoices')
                .select('*, customer:customers(*)')
                .eq('company_id', companyId)
                .in('id', slice)
              loaded = [...loaded, ...((data ?? []) as CustomerInvoiceRow[]).map(customerCandidate)]
            } else {
              const { data } = await supabase
                .from('supplier_invoices')
                .select('*, supplier:suppliers(*)')
                .eq('company_id', companyId)
                .in('id', slice)
              loaded = [...loaded, ...((data ?? []) as SupplierInvoiceRow[]).map(supplierCandidate)]
            }
          }
          if (cancelled) return
          const byId = new Map(loaded.map((c) => [c.id, c]))
          const picked: Record<string, AllocationDraft> = {}
          for (const allocation of prefill) {
            const candidate = byId.get(idOf(allocation))
            if (candidate) picked[candidate.id] = { candidate, amount: formatAmountInput(allocation.amount) }
          }
          prefillApplied.current = true
          setDrafts((prev) => ({ ...picked, ...prev }))
        }
        if (cancelled) return
        setCapped(full)
        setCandidates(loaded)
      } catch {
        if (cancelled) return
        setCandidates([])
        setCapped(false)
      } finally {
        if (!cancelled) {
          setLoading(false)
          setIsSearching(false)
        }
      }
    }
    load()
    return () => {
      cancelled = true
    }
  }, [open, transaction, company, kind, supabase, appliedSearch, initialAllocations, customerCandidate, supplierCandidate])

  // Pre-flight: does the ledger already explain this row? Same detector the
  // route refuses with, so the panel shows before a doomed submit. Fail-open:
  // a failed pre-flight only means the route's own check does the refusing.
  useEffect(() => {
    if (!open || !transaction) return
    let cancelled = false
    async function check() {
      try {
        const res = await fetch(`/api/transactions/${transaction!.id}/duplicate-payment-check`)
        if (!res.ok) return
        const json = (await res.json()) as { candidate_set?: unknown }
        if (!cancelled) setExplaining(readExplainingSet(json.candidate_set))
      } catch {
        // Pre-flight is advisory; the POST guard still runs.
      }
    }
    void check()
    return () => {
      cancelled = true
    }
  }, [open, transaction])

  // Reset state every time the dialog re-opens for a new tx.
  useEffect(() => {
    if (!open) {
      setDrafts({})
      setSearch('')
      setAppliedSearch('')
      setExplaining(null)
      setExplainingAcknowledged(false)
      setPasteOpen(false)
      setPasteText('')
      setPasteResult(null)
      setPickedExpanded(false)
      setFees([])
      setVoucherPreview(null)
      prefillApplied.current = false
    }
  }, [open])

  const txAmountAbs = transaction ? Math.abs(transaction.amount) : 0
  const txCurrency = transaction?.currency ?? 'SEK'
  // The explaining set is stated in SEK and the 1:N link slices are stated in
  // the row's currency, so the one-click link is only offered for kronor rows;
  // a foreign row is pointed to the reconciliation view instead.
  const explainingLinkable = !!explaining && txCurrency === 'SEK'
  const explainingBlocks = !!explaining && !explainingAcknowledged
  const explainingLabels = explaining ? explaining.vouchers.map((v) => v.voucher_label).join(' + ') : ''

  // Each draft's `amount` is the allocation in TRANSACTION currency (SEK
  // for a Swedish bank import). For cross-currency invoices the FX
  // rounding lives inside per-row FX diff lines (Dr 7960 / Cr 3960): NOT
  // in the tolerance. So the sum must equal tx_abs exactly: anything
  // unallocated would leave the bank line on 1930 short of the actual
  // bank receipt and break reconciliation. (PR #607 round-1 review.)
  const allocated = useMemo(() => {
    return Object.values(drafts).reduce((sum, d) => sum + parseAmount(d.amount), 0)
  }, [drafts])

  // The fee rows: a customer's payout is the invoices less the fees, a
  // supplier payment the invoices plus the fees. The tally below compares
  // that net with the row.
  const feeTotal = useMemo(() => sumOre(fees.map((f) => parseAmount(f.amount))), [fees])
  const settled = payoutBankAmount(kind, allocated, feeTotal)
  const feeAccountOk = (account: string) =>
    isPayoutFeeAccount(account) && (accountsLoading || feeAccounts.some((a) => a.account_number === account))
  const feesValid =
    fees.every((f) => feeAccountOk(f.account) && parseAmount(f.amount) > 0) &&
    (fees.length === 0 || payoutFeesWithinInvoices(allocated, feeTotal))

  // "Lägg till avgiftsrad": the gap a fee would close, a krona or more (under
  // that it is öresavrundning). Customer: every picked invoice paid in full,
  // less the row and the fees already there. Supplier: the row less the
  // invoices and the fees.
  const owedTotal = useMemo(
    () =>
      sumOre(
        Object.values(drafts).map((d) => owedInRowCurrency(d.candidate, txCurrency) ?? parseAmount(d.amount)),
      ),
    [drafts, txCurrency],
  )
  const feeGap =
    kind === 'customer_invoice'
      ? roundOre(owedTotal - feeTotal - txAmountAbs)
      : roundOre(txAmountAbs - allocated - feeTotal)
  const offerFee =
    Object.keys(drafts).length > 0 &&
    fees.length < MAX_PAYOUT_FEES &&
    feeGap >= ORE_ROUNDING_SETTLEMENT_MAX &&
    feeGap < (kind === 'customer_invoice' ? owedTotal : allocated)

  function addFeeRow() {
    if (!offerFee) return
    if (kind === 'customer_invoice') {
      // The fee is the gap only once every invoice is allocated what it owed.
      setDrafts((prev) => {
        const next: Record<string, AllocationDraft> = {}
        for (const [id, draft] of Object.entries(prev)) {
          const owed = owedInRowCurrency(draft.candidate, txCurrency)
          next[id] = owed === null ? draft : { ...draft, amount: formatAmountInput(owed) }
        }
        return next
      })
    }
    setFees((prev) => [
      ...prev,
      { key: feeKey.current++, account: PAYMENT_FEE_ACCOUNT, amount: formatAmountInput(feeGap), description: '' },
    ])
  }

  function updateFee(key: number, patch: Partial<Omit<FeeDraft, 'key'>>) {
    setFees((prev) => prev.map((f) => (f.key === key ? { ...f, ...patch } : f)))
  }

  function removeFee(key: number) {
    setFees((prev) => prev.filter((f) => f.key !== key))
  }

  const leftover = roundOre(txAmountAbs - settled)
  // 0.005 SEK matches the RPC's BATCH_AMOUNT_EXCEEDS_TX guard so the
  // "balanced ✓" indicator never lies to the user about what the server
  // will accept.
  const TOLERANCE = 0.005
  const overshoot = leftover < -TOLERANCE
  const balanced =
    Math.abs(leftover) < TOLERANCE && Object.keys(drafts).length > 0
  const undershoot = leftover > TOLERANCE

  // One bank row settles at most MAX_BANK_ROW_SPLIT invoices (the route
  // refuses more with a 400): say so here and hold the confirm instead.
  const pickedCount = Object.keys(drafts).length
  const overLimit = pickedCount > MAX_BANK_ROW_SPLIT
  const collapsePicked = pickedCount > PICKED_INLINE_MAX

  // Picked rows first (they stay whatever the search says), then the rows the
  // search returned, oldest due date first. Past PICKED_INLINE_MAX the picked
  // rows fold into the summary line and show only when it is expanded.
  const filteredCandidates = useMemo(() => {
    const picked = Object.values(drafts)
      .map((d) => d.candidate)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    const pickedIds = new Set(picked.map((c) => c.id))
    const rest = candidates
      .filter((c) => !pickedIds.has(c.id))
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    return collapsePicked && !pickedExpanded ? rest : [...picked, ...rest]
  }, [candidates, drafts, collapsePicked, pickedExpanded])

  function addAllocation(candidate: AllocationCandidate) {
    setDrafts((prev) => {
      if (prev[candidate.id]) return prev
      const remainingTxBudget = Math.max(0, roundOre(txAmountAbs - allocated))
      const sameCurrency = candidate.currency === txCurrency

      // Same-currency: partial allowed, default to min(remaining, budget).
      // Cross-currency: full-payment-only, default to booked SEK (rate
      // sanity-checked). NOT capped to remainingTxBudget: the cross-
      // currency RPC guard requires the amount to be within ±10% of
      // booked_sek, so capping a USD invoice's default at the leftover
      // budget would silently trigger BATCH_FX_DEVIATION_TOO_LARGE on
      // submit. Instead, let the row default to the right amount and
      // the user re-balances the other rows to fit. PR #607 review fix.
      let defaultAmount: number
      if (sameCurrency) {
        defaultAmount = Math.min(candidate.remaining, remainingTxBudget)
      } else if (isValidExchangeRate(candidate.exchangeRate)) {
        defaultAmount = roundOre(candidate.remaining * candidate.exchangeRate)
      } else {
        // No (or out-of-range) FX rate. Leave the amount blank rather
        // than guessing a misleading default; the user must enter the
        // SEK amount the bank converted to manually. Blocked from
        // confirm via the per-row warning below.
        defaultAmount = 0
      }

      return {
        ...prev,
        [candidate.id]: {
          candidate,
          amount: defaultAmount > 0 ? formatAmountInput(defaultAmount) : '',
        },
      }
    })
  }

  function removeAllocation(candidateId: string) {
    setDrafts((prev) => {
      const next = { ...prev }
      delete next[candidateId]
      return next
    })
  }

  function setDraftAmount(candidateId: string, amount: string) {
    setDrafts((prev) => {
      const draft = prev[candidateId]
      if (!draft) return prev
      return { ...prev, [candidateId]: { ...draft, amount } }
    })
  }

  /**
   * Resolve references against the company's invoices of the row's direction
   * and pick what they name, at the reference's amount or else what each
   * invoice owes (lib/invoices/invoice-number-paste). Every reference not
   * picked is listed with its reason. A paste and a beslutsfil both end here.
   */
  async function pickReferences(parsed: ParsedInvoicePaste) {
    if (!company || !transaction) return
    setPasting(true)
    try {
      const pasteKind = kind === 'customer_invoice' ? 'customer' : 'supplier'
      const { invoices, capped: openCapped } = await loadInvoicesForPaste(supabase, company.id, pasteKind, parsed.references)
      const result = planInvoicePaste(parsed, invoices, { kind: pasteKind, currency: txCurrency })
      const unknownName = kind === 'customer_invoice' ? t('unknown_customer') : t('unknown_supplier')
      setDrafts((prev) => {
        const next = { ...prev }
        for (const pick of result.picks) {
          next[pick.invoice.id] = {
            candidate: pasteCandidate(kind, pick.invoice, unknownName),
            amount: formatAmountInput(pick.amount),
          }
        }
        return next
      })
      setPasteResult({ ...result, capped: openCapped })
      setPasteOpen(false)
      setPickedExpanded(false)
    } catch (err) {
      toast({
        title: t('paste_failed'),
        description: getErrorMessage(err, { context: kind === 'customer_invoice' ? 'invoice' : 'supplier_invoice' }),
        variant: 'destructive',
      })
    } finally {
      setPasting(false)
    }
  }

  function handleApplyPaste() {
    const parsed = parseInvoicePaste(pasteText)
    if (parsed.references.length === 0 && parsed.unreadable.length === 0 && parsed.conflicting.length === 0) return
    void pickReferences(parsed)
  }

  /**
   * Skatteverket's beslutsfil, on the customer side: the invoices it names at
   * the approved amounts (beslutFileToPaste). Read here in the browser, so
   * the personnummer in it are never sent; a file for another utförare is
   * refused, as the beslut import refuses it.
   */
  async function handleBeslutFile(file: File) {
    if (!company) return
    const beslut = readBeslutFile(await file.text().catch(() => ''))
    if (!beslut) {
      toast({ title: t('paste_beslut_invalid'), variant: 'destructive' })
      return
    }
    if (!beslutFileIsForCompany(beslut, companySettings?.org_number ?? null)) {
      toast({ title: t('paste_beslut_wrong_company'), variant: 'destructive' })
      return
    }
    await pickReferences(beslutFileToPaste(beslut))
  }

  /**
   * The reason beside one number; ambiguous and same_invoice say how many and
   * which, an ärende without an invoice number what Skatteverket approved.
   */
  function pasteReasonLabel(skip: PasteSkip): string {
    if (skip.reason === 'ambiguous') return t('paste_reason_ambiguous_row', { count: skip.count ?? 0 })
    if (skip.reason === 'same_invoice') return t('paste_reason_same_invoice_row', { earlier: skip.earlier ?? '' })
    if (skip.reason === 'no_invoice_number') {
      return t('paste_reason_no_invoice_number_row', { amount: formatCurrency(skip.amount ?? 0, 'SEK') })
    }
    return t(PASTE_REASON_KEYS[skip.reason])
  }

  // The request the confirm sends and the voucher preview dry-runs.
  const requestBody = useMemo(() => {
    const allocations = Object.values(drafts)
      .map((d) => {
        const cand = d.candidate
        const amount = parseAmount(d.amount)
        if (amount <= 0) return null
        return cand.kind === 'customer_invoice'
          ? { kind: 'customer_invoice' as const, invoice_id: cand.id, amount }
          : { kind: 'supplier_invoice' as const, supplier_invoice_id: cand.id, amount }
      })
      .filter((a): a is NonNullable<typeof a> => a !== null)
    if (allocations.length === 0) return null
    return {
      allocations,
      ...(fees.length > 0
        ? {
            fees: fees.map((f) => ({
              account: f.account,
              amount: parseAmount(f.amount),
              ...(f.description.trim() ? { description: f.description.trim() } : {}),
            })),
          }
        : {}),
      // Acknowledged set: echo its ids so the route can verify that what
      // the user overrode is what it still detects.
      ...(explaining && explainingAcknowledged
        ? {
            force: true,
            expected_journal_entry_ids: explaining.vouchers.map((v) => v.journal_entry_id),
          }
        : {}),
    }
  }, [drafts, fees, explaining, explainingAcknowledged])

  // Fee rows: the verifikat the confirm would post, from the route's dry run
  // (the bank leg on the row's own account), once the row balances.
  const previewBody =
    transaction && requestBody && fees.length > 0 && balanced && feesValid && !overLimit && !explainingBlocks
      ? JSON.stringify(requestBody)
      : null
  const transactionId = transaction?.id
  useEffect(() => {
    if (!previewBody || !transactionId) return
    let cancelled = false
    const context = kind === 'customer_invoice' ? 'invoice' : 'supplier_invoice'
    const handle = setTimeout(async () => {
      try {
        const res = await fetch(`/api/transactions/${transactionId}/match-batch?dry_run=true`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: previewBody,
        })
        const json = await res.json().catch(() => null)
        if (cancelled) return
        const lines = (json as { data?: { expected_lines?: PostingLineLike[] } } | null)?.data?.expected_lines
        setVoucherPreview(
          res.ok && lines
            ? { body: previewBody, state: 'ready', lines }
            : { body: previewBody, state: 'failed', message: getErrorMessage(json, { context, statusCode: res.status }) },
        )
      } catch (err) {
        if (!cancelled) setVoucherPreview({ body: previewBody, state: 'failed', message: getErrorMessage(err, { context }) })
      }
    }, PREVIEW_DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(handle)
    }
  }, [previewBody, transactionId, kind])
  const shownPreview = previewBody && voucherPreview?.body === previewBody ? voucherPreview : null

  async function handleConfirm() {
    if (!transaction) return
    // PR #607 round-1 review: require balanced. Undershoot is no longer
    // allowed because it leaves the bank line short of tx_abs and breaks
    // reconciliation.
    if (!balanced || overshoot || overLimit) return
    // A fee row the route would refuse (account, amount, fees as large as
    // the invoices) holds the confirm too, as its disabled state says.
    if (!feesValid) return

    setSubmitting(true)
    try {
      if (!requestBody) {
        toast({
          title: t('error_no_allocations_title'),
          description: t('error_no_allocations_description'),
          variant: 'destructive',
        })
        setSubmitting(false)
        return
      }
      const allocations = requestBody.allocations

      const response = await fetch(`/api/transactions/${transaction.id}/match-batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody),
      })

      if (!response.ok) {
        const body = await response.json().catch(() => null)
        const code = (body as { error?: { code?: string; details?: unknown } } | null)?.error?.code
        if (code === 'BATCH_TX_POSSIBLE_DUPLICATE') {
          // The pre-flight missed it (or the set changed since): show the
          // vouchers instead of an error toast and let the user decide.
          const set = readExplainingSet(
            (body as { error?: { details?: unknown } }).error?.details,
          )
          if (set) {
            setExplaining(set)
            setExplainingAcknowledged(false)
            return
          }
        }
        toast({
          title: t('error_submit_title'),
          description: getErrorMessage(body, {
            context: kind === 'customer_invoice' ? 'invoice' : 'supplier_invoice',
            statusCode: response.status,
          }),
          variant: 'destructive',
        })
        return
      }

      toast({
        title: t('success_title'),
        description: t('success_description', { count: allocations.length }),
        variant: 'success',
      })
      onSuccess()
      onOpenChange(false)
    } catch (err) {
      toast({
        title: t('error_submit_title'),
        description: getErrorMessage(err, {
          context: kind === 'customer_invoice' ? 'invoice' : 'supplier_invoice',
        }),
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  /**
   * Link the row to the vouchers that already book it. One voucher goes
   * through the 1:1 link, several through the 1:N split
   * (linkTransactionToVouchers): slices carry the row's sign and each
   * voucher's SEK bank leg, which the engine checks against the voucher's
   * line and against the row total. No new verifikat is created.
   */
  async function handleLinkToExplaining() {
    if (!transaction || !explaining || !explainingLinkable) return
    setLinking(true)
    try {
      const sign = transaction.amount > 0 ? 1 : -1
      const body =
        explaining.vouchers.length === 1
          ? {
              transaction_id: transaction.id,
              journal_entry_id: explaining.vouchers[0].journal_entry_id,
              account_number: explaining.bank_account_number,
            }
          : {
              transaction_id: transaction.id,
              account_number: explaining.bank_account_number,
              allocations: explaining.vouchers.map((v) => ({
                journal_entry_id: v.journal_entry_id,
                amount: roundOre(sign * v.amount),
              })),
            }
      const res = await fetch('/api/reconciliation/bank/link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const json = await res.json().catch(() => null)
      if (!res.ok || (json as { error?: unknown } | null)?.error) {
        toast({
          title: t('already_booked_link_failed'),
          description: getErrorMessage(json, { context: 'transaction', statusCode: res.status }),
          variant: 'destructive',
        })
        return
      }
      toast({
        title: t('already_booked_link_success_title'),
        description: t('already_booked_link_success_description', { labels: explainingLabels }),
        variant: 'success',
      })
      onSuccess()
      onOpenChange(false)
    } catch (err) {
      toast({
        title: t('already_booked_link_failed'),
        description: getErrorMessage(err, { context: 'transaction' }),
        variant: 'destructive',
      })
    } finally {
      setLinking(false)
    }
  }

  if (!transaction) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[640px]">
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          <DialogDescription>
            {kind === 'customer_invoice' ? t('description_customer') : t('description_supplier')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Transaction summary */}
          <div className="rounded-lg border bg-card p-3">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">
              {t('transaction_label')}
            </p>
            <p className="mt-1 text-sm font-medium">{transaction.description}</p>
            <div className="mt-1 flex items-center justify-between text-sm">
              <span className="tabular-nums text-muted-foreground">
                {formatDate(transaction.date)}
              </span>
              <span
                className={cn(
                  'font-medium tabular-nums',
                  transaction.amount > 0 && 'text-success',
                )}
              >
                {transaction.amount > 0 ? '+' : ''}
                {formatCurrency(transaction.amount, transaction.currency)}
              </span>
            </div>
          </div>

          {/* Already-explained guard: the ledger already books this row.
              Shown first, before any invoice can be picked: the mistake this
              prevents is picking the next period's identical invoices for a
              row whose payment was already booked by hand. */}
          {explaining && (
            <div
              className={cn(
                'rounded-lg border p-4 space-y-3',
                explainingAcknowledged ? 'border-border bg-muted/20' : 'border-attn/40 bg-muted/30',
              )}
              data-testid="already-booked-panel"
              role="status"
              aria-live="polite"
            >
              <div className="flex items-start gap-2">
                <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0 mt-0.5 text-attn" />
                <div className="min-w-0 flex-1 space-y-1 text-sm">
                  <p className="font-medium text-attn">
                    {explainingAcknowledged
                      ? t('already_booked_acknowledged_title')
                      : t('already_booked_title')}
                  </p>
                  {!explainingAcknowledged && (
                    <p className="text-muted-foreground">
                      {t(
                        transaction.amount > 0 ? 'already_booked_body_in' : 'already_booked_body_out',
                        {
                          amount: formatCurrency(explaining.total, 'SEK'),
                          count: explaining.vouchers.length,
                        },
                      )}
                    </p>
                  )}
                </div>
              </div>
              {!explainingAcknowledged && (
                <ul className="space-y-1.5">
                  {explaining.vouchers.map((v) => (
                    <li
                      key={v.journal_entry_id}
                      className="flex items-center justify-between gap-3 rounded-sm border bg-card px-3 py-2 text-sm"
                    >
                      <div className="min-w-0 space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-medium tabular-nums">{v.voucher_label}</span>
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {formatDate(v.entry_date)}
                          </span>
                        </div>
                        {v.description && (
                          <p className="truncate text-xs text-muted-foreground">{v.description}</p>
                        )}
                      </div>
                      <span className="shrink-0 font-medium tabular-nums">
                        {formatCurrency(v.amount, 'SEK')}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              {!explainingAcknowledged && (
                <div className="flex flex-col gap-2 sm:flex-row">
                  {explainingLinkable ? (
                    <Button
                      type="button"
                      size="sm"
                      onClick={handleLinkToExplaining}
                      disabled={submitting}
                      loading={linking}
                      className="sm:flex-1"
                    >
                      {!linking && <LinkIcon className="mr-2 h-4 w-4" />}
                      {t('already_booked_link', { labels: explainingLabels })}
                    </Button>
                  ) : (
                    <p className="text-xs text-muted-foreground sm:flex-1">
                      {t('already_booked_foreign_hint', { currency: txCurrency })}
                    </p>
                  )}
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setExplainingAcknowledged(true)}
                    disabled={linking || submitting}
                    className="text-muted-foreground"
                  >
                    {t('already_booked_book_anyway')}
                  </Button>
                </div>
              )}
              {explainingAcknowledged && (
                <p className="text-xs text-muted-foreground">
                  {t('already_booked_acknowledged_note', { labels: explainingLabels })}
                </p>
              )}
            </div>
          )}

          {/* Search, and the paste box for a list of invoice numbers (#75) */}
          <div className="flex items-center gap-2">
            <div className="relative flex-1">
              {isSearching ? (
                <SpinnerIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
              ) : (
                <MagnifyingGlassIcon className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              )}
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('search_placeholder')}
                className="pl-9"
              />
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => setPasteOpen((v) => !v)}
              aria-expanded={pasteOpen}
              aria-controls="match-allocation-paste"
            >
              <ClipboardDocumentIcon className="mr-2 h-4 w-4" />
              {t('paste_toggle')}
            </Button>
          </div>

          {pasteOpen && (
            <div id="match-allocation-paste" className="space-y-2 rounded-lg border p-3">
              <label htmlFor="match-allocation-paste-text" className="text-sm font-medium">
                {t('paste_label')}
              </label>
              <Textarea
                id="match-allocation-paste-text"
                value={pasteText}
                onChange={(e) => setPasteText(e.target.value)}
                placeholder={t('paste_placeholder')}
                className="min-h-[120px] font-mono text-[13px]"
                spellCheck={false}
              />
              <p className="text-xs text-muted-foreground">
                {kind === 'customer_invoice' ? t('paste_hint_customer') : t('paste_hint_supplier')}
              </p>
              <div className="flex flex-wrap items-center gap-2">
                {kind === 'customer_invoice' && (
                  <>
                    <input
                      ref={beslutInputRef}
                      type="file"
                      accept=".json,application/json"
                      className="hidden"
                      onChange={(event) => {
                        const file = event.target.files?.[0]
                        event.target.value = ''
                        if (file) void handleBeslutFile(file)
                      }}
                    />
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => beslutInputRef.current?.click()}
                      disabled={pasting || submitting || settingsLoading}
                      title={t('paste_beslut_help')}
                    >
                      <DocumentArrowUpIcon className="mr-2 h-4 w-4" />
                      {t('paste_beslut_file')}
                    </Button>
                  </>
                )}
                <div className="ml-auto flex gap-2">
                  <Button type="button" size="sm" variant="ghost" onClick={() => setPasteOpen(false)} disabled={pasting}>
                    {t('cancel')}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    onClick={handleApplyPaste}
                    loading={pasting}
                    disabled={!pasteText.trim() || submitting}
                  >
                    {t('paste_apply')}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {pasteResult && (
            <div className="space-y-2 rounded-lg border p-3 text-sm" role="status" aria-live="polite">
              <div className="flex items-start justify-between gap-3">
                <p className="tabular-nums">
                  {t('paste_result_picked', {
                    count: pasteResult.picks.length,
                    amount: formatCurrency(pasteResult.pickedTotal, txCurrency),
                  })}
                </p>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  onClick={() => setPasteResult(null)}
                  aria-label={t('paste_close')}
                >
                  <XMarkIcon className="h-4 w-4" />
                </Button>
              </div>
              {pasteResult.skipped.length > 0 && (
                <>
                  <p className="text-xs text-attn tabular-nums">
                    {t('paste_result_skipped', { count: pasteResult.skipped.length })}{' '}
                    {(Object.keys(PASTE_REASON_KEYS) as PasteSkipReason[])
                      .filter((reason) => pasteResult.counts[reason] > 0)
                      .map((reason) =>
                        t('paste_reason_count', {
                          reason: t(PASTE_REASON_KEYS[reason]),
                          count: pasteResult.counts[reason],
                        }),
                      )
                      .join(' · ')}
                  </p>
                  <ul className="max-h-40 space-y-1 overflow-y-auto">
                    {pasteResult.skipped.map((skip, i) => (
                      <li key={`${skip.reason}-${skip.text}-${i}`} className="flex items-center justify-between gap-3 text-xs">
                        <span className="min-w-0 truncate font-mono tabular-nums">{skip.text}</span>
                        <span className="shrink-0 text-muted-foreground">{pasteReasonLabel(skip)}</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {pasteResult.truncated && (
                <p className="text-xs text-attn">{t('paste_truncated', { max: MAX_PASTED_REFERENCES })}</p>
              )}
              {pasteResult.capped && (
                <p className="text-xs text-attn">{t('paste_capped', { max: PASTE_OPEN_INVOICES_MAX })}</p>
              )}
            </div>
          )}

          {/* Hundreds of picks fold into one line, expandable */}
          {collapsePicked && (
            <div className="flex items-center justify-between gap-3 rounded-lg border border-foreground bg-card px-3 py-2 text-sm">
              <button
                type="button"
                onClick={() => setPickedExpanded((v) => !v)}
                aria-expanded={pickedExpanded}
                className="flex min-w-0 items-center gap-2 rounded-sm text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronDownIcon
                  className={cn('h-4 w-4 shrink-0 transition-transform duration-150', !pickedExpanded && '-rotate-90')}
                />
                <span className="truncate tabular-nums">
                  {t('picked_summary', { count: pickedCount, amount: formatCurrency(allocated, txCurrency) })}
                </span>
              </button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setDrafts({})} className="text-muted-foreground">
                {t('picked_clear')}
              </Button>
            </div>
          )}

          {/* Candidate list */}
          {loading ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-16 w-full" />
            </div>
          ) : filteredCandidates.length === 0 && collapsePicked ? null : filteredCandidates.length === 0 ? (
            <div className="rounded-lg border border-dashed bg-muted/30 p-6 text-center">
              <p className="text-sm font-medium">{t('empty_title')}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t('empty_description')}</p>
            </div>
          ) : (
            <ul className="space-y-2 max-h-[320px] overflow-y-auto">
              {filteredCandidates.map((c) => {
                const draft = drafts[c.id]
                const isSelected = !!draft
                return (
                  <li
                    key={c.id}
                    className={cn(
                      'rounded-lg border bg-card p-3 transition-colors',
                      isSelected ? 'border-foreground' : 'border-border',
                    )}
                  >
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium tabular-nums">{c.label}</span>
                          {isSelected && (
                            <Badge variant="secondary" className="gap-1">
                              <CheckIcon className="h-3 w-3" />
                              {t('selected_badge')}
                            </Badge>
                          )}
                        </div>
                        <p className="truncate text-xs text-muted-foreground">
                          {c.counterpartyName}
                        </p>
                        <p className="text-xs text-muted-foreground tabular-nums">
                          {t('remaining_label', {
                            amount: formatCurrency(c.remaining, c.currency),
                          })}
                        </p>
                        {/* Money that arrived before the invoice existed rarely
                            paid it: the next period's identical invoice is the
                            classic wrong pick when the real one is already
                            settled. A hint, not a block: prepayments exist. */}
                        {c.invoiceDate && c.invoiceDate > transaction.date && (
                          <Badge variant="warning" className="gap-1">
                            <ExclamationTriangleIcon className="h-3 w-3" />
                            {t('invoiced_after_payment_badge', { date: formatDate(c.invoiceDate) })}
                          </Badge>
                        )}
                      </div>
                      {isSelected ? (
                        <div className="flex flex-col items-end gap-1">
                          <div className="flex items-center gap-2">
                            <Input
                              type="text"
                              inputMode="decimal"
                              value={draft.amount}
                              onChange={(e) => setDraftAmount(c.id, e.target.value)}
                              className="h-9 w-28 font-mono text-right tabular-nums"
                              aria-label={t('amount_input_aria', { label: c.label })}
                            />
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              onClick={() => removeAllocation(c.id)}
                              aria-label={t('remove_aria', { label: c.label })}
                            >
                              <XMarkIcon className="h-4 w-4" />
                            </Button>
                          </div>
                          {/* FX hint: appears only for cross-currency rows
                              so the user can see what their tx-currency
                              input translates to in invoice currency.
                              When the rate is missing or out of range, we
                              warn instead of silently defaulting to a
                              misleading number. PR #607 round-1 review. */}
                          {c.currency !== txCurrency && (
                            isValidExchangeRate(c.exchangeRate) ? (
                              <p className="text-[11px] tabular-nums text-muted-foreground">
                                ≈ {formatCurrency(parseAmount(draft.amount) / c.exchangeRate, c.currency)}
                              </p>
                            ) : (
                              <p className="text-[11px] tabular-nums text-attn">
                                {t('fx_rate_missing_warning', { currency: c.currency })}
                              </p>
                            )
                          )}
                        </div>
                      ) : (
                        <Button
                          type="button"
                          size="sm"
                          variant="outline"
                          onClick={() => addAllocation(c)}
                        >
                          <PlusIcon className="mr-1 h-3.5 w-3.5" />
                          {t('add_button')}
                        </Button>
                      )}
                    </div>
                  </li>
                )
              })}
              {capped && (
                <li className="py-2 text-center text-xs text-muted-foreground">
                  {appliedSearch
                    ? tPicker('capped_search_hint', { limit: PICKER_LIMIT })
                    : tPicker('capped_hint', { limit: PICKER_LIMIT })}
                </li>
              )}
            </ul>
          )}

          {/* Fee rows (issue #131): the payment service's fee on the row,
              booked without VAT on a class 6 account. Offered once the
              invoices and the row are a krona or more apart in the fee's
              direction, prefilled with that gap. */}
          {(offerFee || fees.length > 0) && (
            <div className="space-y-3 rounded-lg border p-3" data-testid="fee-rows">
              {fees.length > 0 && (
                <>
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                    {t('fees_label')}
                  </p>
                  <ul className="space-y-2">
                    {fees.map((fee, index) => {
                      const n = index + 1
                      const accountId = `match-allocation-fee-account-${fee.key}`
                      const accountInvalid = fee.account.length >= 4 && !feeAccountOk(fee.account)
                      return (
                        <li key={fee.key} className="space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <div className="min-w-0 flex-1 sm:w-32 sm:flex-none">
                              <label htmlFor={accountId} className="sr-only">
                                {t('fee_account_aria', { n })}
                              </label>
                              <AccountCombobox
                                id={accountId}
                                value={fee.account}
                                accounts={feeAccounts}
                                onChange={(value) => updateFee(fee.key, { account: value.trim() })}
                                placeholder={PAYMENT_FEE_ACCOUNT}
                                className="h-9"
                              />
                            </div>
                            <Input
                              value={fee.description}
                              onChange={(e) => updateFee(fee.key, { description: e.target.value })}
                              placeholder={t('fee_description_placeholder')}
                              maxLength={PAYOUT_FEE_DESCRIPTION_MAX}
                              aria-label={t('fee_description_aria', { n })}
                              className="order-last h-9 basis-full sm:order-none sm:basis-0 sm:flex-1"
                            />
                            <Input
                              type="text"
                              inputMode="decimal"
                              value={fee.amount}
                              onChange={(e) => updateFee(fee.key, { amount: e.target.value })}
                              aria-label={t('fee_amount_aria', { n })}
                              className="h-9 w-28 font-mono text-right tabular-nums"
                            />
                            <Button
                              type="button"
                              size="icon"
                              variant="ghost"
                              onClick={() => removeFee(fee.key)}
                              aria-label={t('fee_remove_aria', { n })}
                            >
                              <XMarkIcon className="h-4 w-4" />
                            </Button>
                          </div>
                          {accountInvalid && <p className="text-xs text-destructive">{t('fee_account_invalid')}</p>}
                        </li>
                      )
                    })}
                  </ul>
                  {!payoutFeesWithinInvoices(allocated, feeTotal) && (
                    <p className="text-xs text-destructive">{t('fee_too_large')}</p>
                  )}
                  <p className="text-xs text-muted-foreground">{t('fee_vat_note')}</p>
                </>
              )}
              {offerFee && (
                <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                  <p className="tabular-nums text-muted-foreground">
                    {t(kind === 'customer_invoice' ? 'fee_offer_customer' : 'fee_offer_supplier', {
                      amount: formatCurrency(feeGap, txCurrency),
                    })}
                  </p>
                  <Button type="button" size="sm" variant="outline" onClick={addFeeRow} className="shrink-0">
                    <PlusIcon className="mr-1 h-3.5 w-3.5" />
                    {t('fee_add')}
                  </Button>
                </div>
              )}
            </div>
          )}

          {/* Tally */}
          <div className="space-y-2 border-t pt-3">
            {fees.length > 0 && (
              <>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t('invoices_label')}</span>
                  <span className="font-mono tabular-nums">{formatCurrency(allocated, transaction.currency)}</span>
                </div>
                <div className="flex items-center justify-between text-sm">
                  <span className="text-muted-foreground">{t('fees_label')}</span>
                  <span className="font-mono tabular-nums">
                    {kind === 'customer_invoice' ? '' : '+'}
                    {formatCurrency(kind === 'customer_invoice' ? -feeTotal : feeTotal, transaction.currency)}
                  </span>
                </div>
              </>
            )}
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">
                {fees.length > 0 ? t('net_label') : t('allocated_label')}
                {collapsePicked && (
                  <span className={cn('ml-2 tabular-nums', overLimit && 'text-destructive')}>
                    {t('picked_count', { count: pickedCount, max: MAX_BANK_ROW_SPLIT })}
                  </span>
                )}
              </span>
              <span
                className={cn(
                  'font-mono tabular-nums',
                  overshoot && 'text-destructive',
                  balanced && 'text-success',
                )}
              >
                {formatCurrency(fees.length > 0 ? settled : allocated, transaction.currency)} /{' '}
                {formatCurrency(txAmountAbs, transaction.currency)}
              </span>
            </div>
            {overLimit && (
              <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0" />
                <p>
                  {t('over_limit_warning', { max: MAX_BANK_ROW_SPLIT, excess: pickedCount - MAX_BANK_ROW_SPLIT })}
                </p>
              </div>
            )}
            {overshoot ? (
              <div className="flex items-center gap-2 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0" />
                <p>
                  {t('overshoot_warning', {
                    excess: formatCurrency(Math.abs(leftover), transaction.currency),
                  })}
                </p>
              </div>
            ) : balanced ? (
              <div className="flex items-center gap-2 rounded-lg bg-success/10 p-3 text-sm text-success">
                <CheckIcon className="h-4 w-4 flex-shrink-0" />
                <p>{t('balanced_message')}</p>
              </div>
            ) : undershoot && Object.keys(drafts).length > 0 ? (
              // Undershoot is now a blocking state: the JE's 1930 line
              // must equal the bank's actual receipt or reconciliation
              // breaks. The user must allocate the full amount or remove
              // selections. PR #607 round-1 review fix.
              <div className="flex items-start gap-2 rounded-lg bg-muted/30 p-3 text-sm text-attn">
                <ExclamationTriangleIcon className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <p>
                  {t('undershoot_warning', {
                    amount: formatCurrency(leftover, transaction.currency),
                  })}
                </p>
              </div>
            ) : null}
            {previewBody && (
              <div className="space-y-2 pt-1" data-testid="fee-voucher-preview">
                <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                  {t('preview_title')}
                </p>
                {shownPreview?.state === 'ready' ? (
                  <VoucherLinesTable
                    lines={voucherLineViews(shownPreview.lines)}
                    showTotals
                    withCurrency
                    aria-label={t('preview_title')}
                  />
                ) : shownPreview?.state === 'failed' ? (
                  <p className="text-xs text-attn">{shownPreview.message}</p>
                ) : (
                  <Skeleton className="h-24 w-full" />
                )}
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button
            onClick={handleConfirm}
            // Confirm requires sum == tx_abs exactly (within rounding).
            // Anything else lets the JE diverge from the bank line and
            // breaks reconciliation. PR #607 round-1 review fix.
            disabled={linking || !balanced || overshoot || overLimit || explainingBlocks || !feesValid}
            loading={submitting}
          >
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
