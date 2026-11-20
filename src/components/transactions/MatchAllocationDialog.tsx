'use client'

import { sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslations } from 'next-intl'
import { createClient } from '@/lib/supabase/client'
import { useCompany } from '@/contexts/CompanyContext'
import {
  Dialog,
  DialogConsequence,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  holdEscapeWhileUnsaved,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { EmptyState, LoadError } from '@/components/ui/empty-state'
import { Badge } from '@/components/ui/badge'
import { AttnLine } from '@/components/ui/attn-line'
import { StatusGlyph } from '@/components/ui/status-glyph'
import { MENU_ITEM_CLASS } from '@/components/ui/field-classes'
import {
  POPOVER_ENTER_CLASS,
  POPOVER_ENTER_UP_CLASS,
  POPOVER_SURFACE_CLASS,
} from '@/components/ui/popover-surface'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatAmount, formatCurrency, formatDate, cn, isValidExchangeRate, chunk } from '@/lib/utils'
import { useComboboxNavigation } from '@/lib/hooks/use-combobox-navigation'
import { useAnchoredDropdown } from '@/components/bookkeeping/use-anchored-dropdown'
import {
  ChevronDownIcon,
  MagnifyingGlassIcon,
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
import { effectiveOrgNumber } from '@/lib/company/org-number'
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

/** The picker list's own width when the field is narrower (a phone). */
const PICKER_MIN_WIDTH = 320

// The picked rows and the totals under them share their last two columns
// (Belopp and the remove button), so the amounts line up in one column.
const PICKED_GRID_CLASS =
  'grid grid-cols-[56px_minmax(0,1fr)_112px_28px] items-center gap-x-3 sm:grid-cols-[64px_minmax(0,1fr)_88px_104px_128px_28px]'
const FEE_GRID_CLASS =
  'grid grid-cols-[88px_minmax(0,1fr)_112px_28px] items-center gap-x-3 sm:grid-cols-[96px_minmax(0,1fr)_128px_28px]'
const TOTAL_GRID_CLASS = 'grid grid-cols-[minmax(0,1fr)_112px_28px] items-center gap-x-3 sm:grid-cols-[minmax(0,1fr)_128px_28px]'

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
  return isValidExchangeRate(candidate.exchangeRate) ? sekOfForeign(candidate.remaining, candidate.exchangeRate) : null
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
  // The invoices could not be read: said in place of them (never "no open
  // invoices"), with "Försök igen".
  const [loadFailed, setLoadFailed] = useState(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
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
  // A failed confirm, link or paste says so where the action is (Stil v3):
  // the footer, under the link buttons, in the paste area.
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [linkError, setLinkError] = useState<string | null>(null)
  const [pasteError, setPasteError] = useState<{ title?: string; message: string } | null>(null)
  // "Lägg till faktura": a search field whose list of open invoices opens as
  // an anchored popover under it (portaled, so the dialog's scroll can never
  // clip it). The field shows while asked for, and always while nothing is
  // picked yet.
  const [pickerRequested, setPickerRequested] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const pickerFieldRef = useRef<HTMLDivElement>(null)
  const addButtonRef = useRef<HTMLButtonElement>(null)
  const pickerListId = useId()
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
        setLoadFailed(false)
      } catch {
        if (cancelled) return
        setCandidates([])
        setCapped(false)
        setLoadFailed(true)
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
  }, [open, transaction, company, kind, supabase, appliedSearch, initialAllocations, customerCandidate, supplierCandidate, loadAttempt])

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
      setSubmitError(null)
      setLinkError(null)
      setPasteError(null)
      setPickerRequested(false)
      setPickerOpen(false)
      prefillApplied.current = false
    }
  }, [open])

  // A refusal belongs to the split it was given for: any edit clears it.
  useEffect(() => {
    setSubmitError(null)
  }, [drafts, fees, explainingAcknowledged])

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

  // The picked rows, oldest due date first (they stay whatever the search
  // says; past PICKED_INLINE_MAX they fold into the summary line and show only
  // when it is expanded), and the picker's rows: what the search returned and
  // is not picked yet, oldest due date first.
  const pickedRows = useMemo(
    () =>
      Object.values(drafts)
        .map((d) => d.candidate)
        .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    [drafts],
  )
  const pickable = useMemo(
    () => candidates.filter((c) => !drafts[c.id]).sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    [candidates, drafts],
  )

  // The picker. The field shows while asked for and while nothing is picked;
  // its list opens on focus, typing or an arrow key.
  const pickerFieldShown = pickerRequested || pickedCount === 0
  const pickerListShown = pickerOpen && pickerFieldShown

  // Portaled, and glued to the field while anything scrolls or the window resizes.
  const {
    pos: pickerPos,
    style: pickerStyle,
    panelRef: pickerPanelRef,
    attachPanel: attachPickerPanel,
  } = useAnchoredDropdown(pickerFieldRef, pickerListShown, PICKER_MIN_WIDTH)

  /** Close the list; a field shown on request goes with it. Focus returns to "Lägg till faktura" on request. */
  const closePicker = useCallback((refocus = false) => {
    setPickerOpen(false)
    setPickerRequested(false)
    if (refocus) requestAnimationFrame(() => addButtonRef.current?.focus())
  }, [])

  function openPicker() {
    setPickerRequested(true)
    setPickerOpen(true)
  }

  function pickFromList(candidate: AllocationCandidate) {
    addAllocation(candidate)
    setSearch('')
    closePicker(true)
  }

  const openPickerList = useCallback(() => setPickerOpen(true), [])
  const closePickerList = useCallback(() => closePicker(), [closePicker])
  const pickerInsideRefs = useMemo(() => [pickerFieldRef, pickerPanelRef, addButtonRef], [])
  const {
    highlightedIndex,
    setHighlightedIndex,
    handleKeyDown: handlePickerKeyDown,
  } = useComboboxNavigation({
    count: pickable.length,
    isOpen: pickerListShown,
    open: openPickerList,
    close: closePickerList,
    activate: (index) => {
      const candidate = loading || loadFailed ? undefined : pickable[index]
      if (!candidate) return false
      pickFromList(candidate)
    },
    listRef: pickerPanelRef,
    insideRefs: pickerInsideRefs,
    closeOnTab: true,
  })
  useEffect(() => {
    setHighlightedIndex(0)
  }, [pickable, setHighlightedIndex])

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
        defaultAmount = sekOfForeign(candidate.remaining, candidate.exchangeRate)
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
    setPasteError(null)
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
      setPasteError({
        title: t('paste_failed'),
        message: getErrorMessage(err, { context: kind === 'customer_invoice' ? 'invoice' : 'supplier_invoice' }),
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
    setPasteError(null)
    const beslut = readBeslutFile(await file.text().catch(() => ''))
    if (!beslut) {
      setPasteError({ message: t('paste_beslut_invalid') })
      return
    }
    if (!beslutFileIsForCompany(beslut, effectiveOrgNumber(companySettings?.org_number, company.org_number))) {
      setPasteError({ message: t('paste_beslut_wrong_company') })
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
    setSubmitError(null)
    try {
      if (!requestBody) {
        setSubmitError(t('error_no_allocations_description'))
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
        setSubmitError(
          getErrorMessage(body, {
            context: kind === 'customer_invoice' ? 'invoice' : 'supplier_invoice',
            statusCode: response.status,
          }),
        )
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
      setSubmitError(
        getErrorMessage(err, {
          context: kind === 'customer_invoice' ? 'invoice' : 'supplier_invoice',
        }),
      )
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
    setLinkError(null)
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
        setLinkError(getErrorMessage(json, { context: 'transaction', statusCode: res.status }))
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
      setLinkError(getErrorMessage(err, { context: 'transaction' }))
    } finally {
      setLinking(false)
    }
  }

  if (!transaction) return null

  const headLabelClass = 'text-[12px] font-medium leading-4 text-muted-foreground'
  const hasPrefill = (initialAllocations ?? []).some((a) => a.kind === kind)
  const pickerHasRows = !loading && !loadFailed && pickable.length > 0
  const invoicedAfterPayment = (c: AllocationCandidate) => !!c.invoiceDate && c.invoiceDate > transaction.date

  // What the confirm does, on the footer's left (Stil v3): the
  // samlingsverifikation and what becomes of the invoices; until the split
  // balances, why the confirm waits. A refused confirm says so in this spot.
  const canConfirm = balanced && !overshoot && !overLimit && feesValid && !explainingBlocks
  const partialLabels = canConfirm
    ? pickedRows
        .filter(
          (c) =>
            c.currency === txCurrency &&
            parseAmount(drafts[c.id]?.amount ?? '') < roundOre(c.remaining) - TOLERANCE,
        )
        .map((c) => c.label)
    : []
  const consequence = canConfirm
    ? `${t('consequence_batch')} ${
        partialLabels.length > 0
          ? t('consequence_partial', { count: partialLabels.length, labels: partialLabels.join(', ') })
          : t('consequence_paid', { count: pickedCount })
      }`
    : pickedCount > 0 && !explainingBlocks
      ? t('consequence_unbalanced')
      : null

  // The picker's list: the open invoices not picked yet, as an anchored
  // popover under the search field.
  const pickerPanel = (
    <div
      ref={attachPickerPanel}
      // data-dialog-companion: a press in the portaled panel is inside the
      // dialog (DialogContent), so it never dismisses it. data-ph-mask:
      // invoice numbers and counterparties are user data.
      data-dialog-companion=""
      data-ph-mask=""
      className={cn(
        'pointer-events-auto fixed z-50 overflow-y-auto overscroll-contain p-1',
        POPOVER_SURFACE_CLASS,
        pickerPos?.top === undefined ? POPOVER_ENTER_UP_CLASS : POPOVER_ENTER_CLASS,
      )}
      style={pickerStyle}
    >
      {loading ? (
        <LateReveal className="space-y-1 p-1">
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </LateReveal>
      ) : loadFailed ? (
        <LoadError className="px-2.5 pb-2 pt-2" onRetry={() => setLoadAttempt((n) => n + 1)} />
      ) : candidates.length === 0 && !appliedSearch ? (
        <EmptyState className="px-2.5 pb-2 pt-2" title={t('empty_title')} description={t('empty_description')} />
      ) : pickable.length === 0 ? (
        <p className="px-2.5 py-2 text-[13px] text-muted-foreground">
          {appliedSearch ? t('picker_no_match', { query: appliedSearch }) : t('picker_none_left')}
        </p>
      ) : (
        <div role="listbox" id={pickerListId} aria-label={t('add_invoice')}>
          {pickable.map((c, i) => {
            const highlighted = i === highlightedIndex
            return (
              <button
                key={c.id}
                type="button"
                role="option"
                aria-selected={highlighted}
                data-highlighted={highlighted || undefined}
                // Rows keep the focus in the search field.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pickFromList(c)}
                onMouseEnter={() => setHighlightedIndex(i)}
                className={cn(MENU_ITEM_CLASS, 'items-start gap-3 py-1.5 text-left', highlighted && 'bg-secondary/60')}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium text-strong">
                    {t('picker_row_title', { label: c.label, name: c.counterpartyName })}
                  </span>
                  <span className="block text-[12px] leading-4 text-muted-foreground">
                    {t('picker_row_due', { date: formatDate(c.dueDate) })}
                  </span>
                  {/* Money that arrived before the invoice existed rarely
                      paid it: the next period's identical invoice is the
                      classic wrong pick when the real one is already
                      settled. A hint, not a block: prepayments exist. */}
                  {invoicedAfterPayment(c) && (
                    <Badge variant="warning" className="mt-1">
                      {t('invoiced_after_payment_badge', { date: formatDate(c.invoiceDate!) })}
                    </Badge>
                  )}
                </span>
                <span className="shrink-0 tabular-nums">{formatCurrency(c.remaining, c.currency)}</span>
              </button>
            )
          })}
        </div>
      )}
      {capped && !loading && !loadFailed && (
        <p className="mt-1 border-t-hairline px-2.5 pb-1 pt-2 text-[12px] leading-4 text-muted-foreground">
          {appliedSearch
            ? tPicker('capped_search_hint', { limit: PICKER_LIMIT })
            : tPicker('capped_hint', { limit: PICKER_LIMIT })}
        </p>
      )}
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="wide"
        // Escape in the picker's list (or a fee row's account list) closes
        // that list first, not the dialog.
        onEscapeKeyDown={(event) => holdEscapeWhileUnsaved(event, pickerListShown)}
      >
        <DialogHeader>
          <DialogTitle>{t('title')}</DialogTitle>
          {/* The bank row as the context line; data-ph-mask: user data. */}
          <DialogDescription data-ph-mask="">
            {transaction.description} · {formatDate(transaction.date)} · {transaction.amount > 0 ? '+' : ''}
            {formatCurrency(transaction.amount, transaction.currency)}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* Already-explained guard: the ledger already books this row.
              Shown first, before any invoice can be picked: the mistake this
              prevents is picking the next period's identical invoices for a
              row whose payment was already booked by hand. */}
          {explaining && (
            <div className="space-y-2" data-testid="already-booked-panel" role="status" aria-live="polite">
              <div className="flex items-start gap-2 text-[13px] leading-5">
                <StatusGlyph tone="warning" size={16} className="mt-0.5" />
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="font-medium text-strong">
                    {explainingAcknowledged ? t('already_booked_acknowledged_title') : t('already_booked_title')}
                  </div>
                  <div className="text-muted-foreground">
                    {explainingAcknowledged
                      ? t('already_booked_acknowledged_note', { labels: explainingLabels })
                      : t(transaction.amount > 0 ? 'already_booked_body_in' : 'already_booked_body_out', {
                          amount: formatCurrency(explaining.total, 'SEK'),
                          count: explaining.vouchers.length,
                        })}
                  </div>
                </div>
              </div>
              {!explainingAcknowledged && (
                <>
                  <ul className="ml-6 border-t-hairline" data-ph-mask="">
                    {explaining.vouchers.map((v) => (
                      <li
                        key={v.journal_entry_id}
                        className="flex min-h-9 items-center justify-between gap-3 border-b-hairline py-1.5 text-[13px]"
                      >
                        <span className="flex min-w-0 items-baseline gap-2">
                          <span className="shrink-0 font-medium tabular-nums text-strong">{v.voucher_label}</span>
                          <span className="date-figures shrink-0 text-[12px] text-muted-foreground">
                            {formatDate(v.entry_date)}
                          </span>
                          {v.description && (
                            <span className="truncate text-[12px] text-muted-foreground">{v.description}</span>
                          )}
                        </span>
                        <span className="shrink-0 tabular-nums">{formatCurrency(v.amount, 'SEK')}</span>
                      </li>
                    ))}
                  </ul>
                  <div className="flex flex-wrap items-center gap-2 pl-6">
                    {explainingLinkable ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={handleLinkToExplaining}
                        disabled={submitting}
                        loading={linking}
                      >
                        {t('already_booked_link', { labels: explainingLabels })}
                      </Button>
                    ) : (
                      <p className="min-w-0 flex-1 text-[12px] leading-4 text-muted-foreground">
                        {t('already_booked_foreign_hint', { currency: txCurrency })}
                      </p>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => setExplainingAcknowledged(true)}
                      disabled={linking || submitting}
                    >
                      {t('already_booked_book_anyway')}
                    </Button>
                  </div>
                  {linkError && (
                    <p role="alert" className="pl-6 text-[12px] leading-4 text-destructive">
                      <span className="font-medium">{t('already_booked_link_failed')}.</span> {linkError}
                    </p>
                  )}
                </>
              )}
            </div>
          )}

          {/* The invoices the row pays: a header with the two ways to add
              them, the paste box for a list of numbers (#75), the picker,
              then the picked rows with their amounts and the fee rows. */}
          <section className="space-y-1.5" aria-label={t('invoices_label')}>
            <div className="flex min-h-7 items-center gap-1">
              <span className={cn(headLabelClass, 'flex-1')}>
                {t('invoices_label')}
                {collapsePicked && (
                  <span className={cn('ml-2 tabular-nums', overLimit && 'text-destructive')}>
                    {t('picked_count', { count: pickedCount, max: MAX_BANK_ROW_SPLIT })}
                  </span>
                )}
              </span>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setPasteOpen((v) => !v)
                  setPasteError(null)
                }}
                aria-expanded={pasteOpen}
                aria-controls="match-allocation-paste"
                className="text-muted-foreground"
              >
                {t('paste_toggle')}
              </Button>
              {!pickerFieldShown && (
                <Button
                  ref={addButtonRef}
                  type="button"
                  variant="ghost"
                  onClick={openPicker}
                  aria-haspopup="listbox"
                  className="-mr-2.5 text-muted-foreground"
                >
                  {t('add_invoice')}
                </Button>
              )}
            </div>

            {pasteOpen && (
              <div id="match-allocation-paste" className="space-y-2 pb-2">
                <Label htmlFor="match-allocation-paste-text" className="sr-only">
                  {t('paste_label')}
                </Label>
                <Textarea
                  id="match-allocation-paste-text"
                  value={pasteText}
                  onChange={(e) => setPasteText(e.target.value)}
                  placeholder={t('paste_placeholder')}
                  className="min-h-[96px] font-mono text-[13px]"
                  spellCheck={false}
                />
                <div className="flex flex-wrap items-start gap-3">
                  <p className="min-w-0 flex-1 text-[12px] leading-4 text-muted-foreground">
                    {kind === 'customer_invoice' ? t('paste_hint_customer') : t('paste_hint_supplier')}
                  </p>
                  <div className="flex shrink-0 gap-2">
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
                          variant="ghost"
                          onClick={() => beslutInputRef.current?.click()}
                          disabled={pasting || submitting || settingsLoading}
                          title={t('paste_beslut_help')}
                        >
                          {t('paste_beslut_file')}
                        </Button>
                      </>
                    )}
                    <Button
                      type="button"
                      variant="outline"
                      onClick={handleApplyPaste}
                      loading={pasting}
                      disabled={!pasteText.trim() || submitting}
                    >
                      {t('paste_apply')}
                    </Button>
                  </div>
                </div>
                {pasteError && (
                  <p role="alert" className="text-[12px] leading-4 text-destructive">
                    {pasteError.title && <span className="font-medium">{pasteError.title}.</span>} {pasteError.message}
                  </p>
                )}
              </div>
            )}

            {pasteResult && (
              <div className="space-y-1 pb-2 text-[12px] leading-4" role="status" aria-live="polite">
                <div className="flex items-start gap-2">
                  <p className="min-w-0 flex-1 pt-1.5 tabular-nums">
                    <span className="text-foreground">
                      {t('paste_result_picked', {
                        count: pasteResult.picks.length,
                        amount: formatCurrency(pasteResult.pickedTotal, txCurrency),
                      })}
                    </span>
                    {pasteResult.skipped.length > 0 && (
                      <span className="text-attn">
                        {'. '}
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
                      </span>
                    )}
                  </p>
                  <Button
                    type="button"
                    size="icon"
                    variant="ghost"
                    onClick={() => setPasteResult(null)}
                    aria-label={t('paste_close')}
                    className="shrink-0 text-muted-foreground"
                  >
                    <XMarkIcon className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {pasteResult.skipped.length > 0 && (
                  <ul className="max-h-40 overflow-y-auto border-t-hairline" data-ph-mask="">
                    {pasteResult.skipped.map((skip, i) => (
                      <li
                        key={`${skip.reason}-${skip.text}-${i}`}
                        className="flex items-center justify-between gap-3 border-b-hairline py-1"
                      >
                        <span className="min-w-0 truncate font-mono tabular-nums">{skip.text}</span>
                        <span className="shrink-0 text-muted-foreground">{pasteReasonLabel(skip)}</span>
                      </li>
                    ))}
                  </ul>
                )}
                {pasteResult.truncated && <p className="text-attn">{t('paste_truncated', { max: MAX_PASTED_REFERENCES })}</p>}
                {pasteResult.capped && <p className="text-attn">{t('paste_capped', { max: PASTE_OPEN_INVOICES_MAX })}</p>}
              </div>
            )}

            {pickerFieldShown && (
              <div ref={pickerFieldRef} className="relative pb-1.5">
                {isSearching ? (
                  <SpinnerIcon className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 animate-spin text-muted-foreground" />
                ) : (
                  <MagnifyingGlassIcon className="pointer-events-none absolute left-2.5 top-2 h-4 w-4 text-muted-foreground" />
                )}
                <Input
                  // Asked for by "Lägg till faktura", or a split that opens
                  // with nothing to prefill: the focus starts here, so the
                  // open invoices show at once.
                  autoFocus={pickerRequested || !hasPrefill}
                  value={search}
                  onChange={(e) => {
                    setSearch(e.target.value)
                    setPickerOpen(true)
                  }}
                  onFocus={() => setPickerOpen(true)}
                  onClick={() => setPickerOpen(true)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && pickerListShown) {
                      e.preventDefault()
                      closePicker(true)
                      return
                    }
                    handlePickerKeyDown(e)
                  }}
                  placeholder={t('search_placeholder')}
                  aria-label={t('add_invoice')}
                  role="combobox"
                  aria-expanded={pickerListShown}
                  aria-controls={pickerListShown && pickerHasRows ? pickerListId : undefined}
                  aria-autocomplete="list"
                  autoComplete="off"
                  spellCheck={false}
                  className="pl-8"
                />
                {pickerListShown && pickerPos && createPortal(pickerPanel, document.body)}
              </div>
            )}

            {/* Hundreds of picks fold into one line, expandable */}
            {collapsePicked && (
              <div className="flex min-h-11 items-center justify-between gap-3 border-b-hairline text-[13px]">
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
                <Button type="button" variant="ghost" onClick={() => setDrafts({})} className="text-muted-foreground">
                  {t('picked_clear')}
                </Button>
              </div>
            )}

            {pickedCount > 0 && (!collapsePicked || pickedExpanded) && (
              <div data-ph-mask="">
                <div
                  aria-hidden="true"
                  className={cn(PICKED_GRID_CLASS, 'h-8 border-b-hairline', headLabelClass)}
                >
                  <span>{t('col_invoice')}</span>
                  <span>{kind === 'customer_invoice' ? t('col_customer') : t('col_supplier')}</span>
                  <span className="hidden sm:block">{t('col_due')}</span>
                  <span className="hidden text-right sm:block">{t('col_remaining')}</span>
                  <span className="text-right">{t('col_amount')}</span>
                  <span />
                </div>
                <ul>
                  {pickedRows.map((c) => {
                    const draft = drafts[c.id]
                    return (
                      <li key={c.id} className={cn(PICKED_GRID_CLASS, 'min-h-11 border-b-hairline py-1.5 text-[13px]')}>
                        <span className="truncate font-medium tabular-nums text-strong">{c.label}</span>
                        <span className="min-w-0">
                          <span className="block truncate text-muted-foreground">{c.counterpartyName}</span>
                          {invoicedAfterPayment(c) && (
                            <Badge variant="warning" className="mt-1">
                              {t('invoiced_after_payment_badge', { date: formatDate(c.invoiceDate!) })}
                            </Badge>
                          )}
                        </span>
                        <span className="date-figures hidden text-muted-foreground sm:block">{formatDate(c.dueDate)}</span>
                        <span className="hidden text-right tabular-nums text-muted-foreground sm:block">
                          {c.currency === txCurrency ? formatAmount(c.remaining) : formatCurrency(c.remaining, c.currency)}
                        </span>
                        <span className="min-w-0">
                          <Input
                            type="text"
                            inputMode="decimal"
                            value={draft?.amount ?? ''}
                            onChange={(e) => setDraftAmount(c.id, e.target.value)}
                            className="text-right tabular-nums"
                            aria-label={t('amount_input_aria', { label: c.label })}
                          />
                          {/* FX hint: only for cross-currency rows, so the
                              user sees what the row-currency amount is in the
                              invoice's currency. A missing or out-of-range
                              rate warns instead of defaulting to a
                              misleading number. PR #607 round-1 review. */}
                          {c.currency !== txCurrency &&
                            (isValidExchangeRate(c.exchangeRate) ? (
                              <span className="mt-0.5 block text-right text-[12px] leading-4 tabular-nums text-muted-foreground">
                                ≈ {formatCurrency(parseAmount(draft?.amount ?? '') / c.exchangeRate, c.currency)}
                              </span>
                            ) : (
                              <span className="mt-0.5 block text-right text-[12px] leading-4 text-attn">
                                {t('fx_rate_missing_warning', { currency: c.currency })}
                              </span>
                            ))}
                        </span>
                        <Button
                          type="button"
                          size="icon"
                          variant="ghost"
                          onClick={() => removeAllocation(c.id)}
                          aria-label={t('remove_aria', { label: c.label })}
                          className="text-muted-foreground"
                        >
                          <XMarkIcon className="h-3.5 w-3.5" />
                        </Button>
                      </li>
                    )
                  })}
                </ul>
              </div>
            )}

            {/* Fee rows (issue #131): the payment service's fee on the row,
                booked without VAT on a class 6 account, in the same columns
                as the invoices so the amounts line up. */}
            {fees.length > 0 && (
              <div data-testid="fee-rows">
                <ul>
                  {fees.map((fee, index) => {
                    const n = index + 1
                    const accountId = `match-allocation-fee-account-${fee.key}`
                    const accountInvalid = fee.account.length >= 4 && !feeAccountOk(fee.account)
                    return (
                      <li key={fee.key} className="border-b-hairline py-1.5">
                        <div className={FEE_GRID_CLASS}>
                          <div className="min-w-0">
                            <label htmlFor={accountId} className="sr-only">
                              {t('fee_account_aria', { n })}
                            </label>
                            <AccountCombobox
                              id={accountId}
                              value={fee.account}
                              accounts={feeAccounts}
                              onChange={(value) => updateFee(fee.key, { account: value.trim() })}
                              placeholder={PAYMENT_FEE_ACCOUNT}
                            />
                          </div>
                          <Input
                            value={fee.description}
                            onChange={(e) => updateFee(fee.key, { description: e.target.value })}
                            placeholder={t('fee_description_placeholder')}
                            maxLength={PAYOUT_FEE_DESCRIPTION_MAX}
                            aria-label={t('fee_description_aria', { n })}
                          />
                          <Input
                            type="text"
                            inputMode="decimal"
                            value={fee.amount}
                            onChange={(e) => updateFee(fee.key, { amount: e.target.value })}
                            aria-label={t('fee_amount_aria', { n })}
                            className="text-right tabular-nums"
                          />
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            onClick={() => removeFee(fee.key)}
                            aria-label={t('fee_remove_aria', { n })}
                            className="text-muted-foreground"
                          >
                            <XMarkIcon className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                        {accountInvalid && (
                          <p className="mt-1 text-[12px] leading-4 text-destructive">{t('fee_account_invalid')}</p>
                        )}
                      </li>
                    )
                  })}
                </ul>
                {!payoutFeesWithinInvoices(allocated, feeTotal) && (
                  <p className="mt-1 text-[12px] leading-4 text-destructive">{t('fee_too_large')}</p>
                )}
                <p className="mt-1 text-[12px] leading-4 text-muted-foreground">{t('fee_vat_note')}</p>
              </div>
            )}

            {/* The tally against the bank row: with fee rows, the invoices
                and the fees first, then the net. */}
            {pickedCount > 0 && (
              <div className="text-[13px] tabular-nums">
                {fees.length > 0 && (
                  <>
                    <div className={cn(TOTAL_GRID_CLASS, 'min-h-9')}>
                      <span className="text-muted-foreground">{t('invoices_label')}</span>
                      <span className="text-right">{formatCurrency(allocated, transaction.currency)}</span>
                      <span />
                    </div>
                    <div className={cn(TOTAL_GRID_CLASS, 'min-h-9')}>
                      <span className="text-muted-foreground">{t('fees_label')}</span>
                      <span className="text-right">
                        {kind === 'customer_invoice' ? '' : '+'}
                        {formatCurrency(kind === 'customer_invoice' ? -feeTotal : feeTotal, transaction.currency)}
                      </span>
                      <span />
                    </div>
                  </>
                )}
                <div className={cn(TOTAL_GRID_CLASS, 'min-h-11', fees.length > 0 && 'border-t-total')}>
                  <span className="text-muted-foreground">{t('net_label')}</span>
                  <span className={cn('text-right font-medium text-strong', overshoot && 'text-destructive')}>
                    {formatCurrency(fees.length > 0 ? settled : allocated, transaction.currency)}
                  </span>
                  <span />
                </div>
              </div>
            )}
          </section>

          {/* Where the split stands, as one line. Undershoot blocks too: the
              verifikat's bank line must equal the bank's actual receipt or
              reconciliation breaks (PR #607 round-1 review). */}
          {(overLimit || overshoot || balanced || (undershoot && pickedCount > 0) || offerFee) && (
            <div className="space-y-2">
              {overLimit && (
                <div className="flex items-start gap-2 text-[13px] leading-5 text-destructive">
                  <StatusGlyph tone="error" size={16} className="mt-0.5" />
                  <span>
                    {t('over_limit_warning', { max: MAX_BANK_ROW_SPLIT, excess: pickedCount - MAX_BANK_ROW_SPLIT })}
                  </span>
                </div>
              )}
              {overshoot ? (
                <div className="flex items-start gap-2 text-[13px] leading-5 text-destructive">
                  <StatusGlyph tone="error" size={16} className="mt-0.5" />
                  <span>
                    {t('overshoot_warning', { excess: formatCurrency(Math.abs(leftover), transaction.currency) })}
                  </span>
                </div>
              ) : balanced ? (
                <div className="flex items-start gap-2 text-[13px] leading-5 text-foreground/80">
                  <StatusGlyph tone="ok" size={16} className="mt-0.5" />
                  <span>{t('balanced_message')}</span>
                </div>
              ) : undershoot && pickedCount > 0 ? (
                <AttnLine>{t('undershoot_warning', { amount: formatCurrency(leftover, transaction.currency) })}</AttnLine>
              ) : null}
              {/* Offered once the invoices and the row are a krona or more
                  apart in the fee's direction, prefilled with that gap. */}
              {offerFee && (
                <AttnLine tone="info" action={{ label: t('fee_add'), onClick: addFeeRow }}>
                  {t(kind === 'customer_invoice' ? 'fee_offer_customer' : 'fee_offer_supplier', {
                    amount: formatCurrency(feeGap, txCurrency),
                  })}
                </AttnLine>
              )}
            </div>
          )}

          {/* Fee rows: the verifikat the confirm would post, from the
              route's dry run (the bank leg on the row's own account), once
              the row balances. */}
          {previewBody && (
            <div className="space-y-1.5" data-testid="fee-voucher-preview">
              <div className={headLabelClass}>{t('preview_title')}</div>
              {shownPreview?.state === 'ready' ? (
                <VoucherLinesTable
                  lines={voucherLineViews(shownPreview.lines)}
                  showTotals
                  withCurrency
                  aria-label={t('preview_title')}
                />
              ) : shownPreview?.state === 'failed' ? (
                <AttnLine>{shownPreview.message}</AttnLine>
              ) : (
                <LateReveal className="space-y-1">
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                  <Skeleton className="h-9 w-full" />
                </LateReveal>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {submitError ? (
            <DialogConsequence role="alert" className="text-destructive">
              <span className="font-medium">{t('error_submit_title')}.</span> {submitError}
            </DialogConsequence>
          ) : (
            consequence && (
              <DialogConsequence>
                {/* data-ph-mask: a partial names its invoice numbers. */}
                <span data-ph-mask="">{consequence}</span>
              </DialogConsequence>
            )
          )}
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
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
