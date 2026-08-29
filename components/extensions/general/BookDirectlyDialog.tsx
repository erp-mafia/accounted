'use client'

import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Plus, Trash2, Search, Check, BookmarkPlus } from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import { loadBasCatalog, type CatalogAccount } from '@/lib/bookkeeping/bas-catalog-client'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import BookingTemplatePicker from '@/components/bookkeeping/BookingTemplatePicker'
import { TemplateForm } from '@/components/settings/TemplateForm'
import { deriveTemplateLinesFromBooking } from '@/lib/bookkeeping/template-library'
import { ActivateAccountsDialog } from '@/components/bookkeeping/ActivateAccountsDialog'
import { useCompany } from '@/contexts/CompanyContext'
import { useAccounts, useCashAccounts, useFiscalPeriods } from '@/lib/reference-data/hooks'
import {
  useSubmitWithAccountActivation,
  throwOnStructuredError,
} from '@/lib/hooks/use-submit-with-account-activation'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { resolveAccount } from '@/lib/cash-accounts/resolve-account'
import { renderChannelContextNotes } from '@/lib/documents/channel-context-notes'
import { formatCounterpartyName } from '@/lib/bookkeeping/counterparty-templates'
import { AttnLine } from '@/components/ui/attn-line'
import type { BookingTemplateLibrary, CashAccount, InboxChannelContext, InvoiceExtractionResult } from '@/types'

interface InboxItem {
  id: string
  document_id: string | null
  matched_transaction_id: string | null
  extracted_data: InvoiceExtractionResult | null
  // Verified human answers from the delivering chat (WhatsApp items):
  // prefills the notes field so representation deltagare + syfte reach the
  // verifikat. Absent for email/upload items.
  channel_context?: InboxChannelContext | null
}

interface PickerTransaction {
  id: string
  date: string
  description: string
  amount: number
  currency: string | null
  amount_sek?: number | null
  exchange_rate?: number | null
}

// SEK magnitude of a (usually-SEK) bank transaction. Foreign rows are
// normalised via their stored amount_sek/exchange_rate so ranking against the
// underlag's SEK value is apples-to-apples.
function txSekAmount(tx: PickerTransaction): number {
  const cur = (tx.currency ?? 'SEK').toUpperCase()
  if (cur === 'SEK') return Math.abs(tx.amount)
  return Math.abs(
    resolveSekAmount(tx.amount, tx.amount_sek ?? null, tx.currency, tx.exchange_rate ?? null),
  )
}

interface FormLine {
  account_number: string
  debit_amount: string
  credit_amount: string
}

const BLANK_LINE: FormLine = { account_number: '', debit_amount: '', credit_amount: '' }

// Swedish entity labels for the "Spara som mall" editor. Hard-coded to match
// this dialog's Swedish-only surface (the shared TemplateForm handles the rest
// of its own strings bilingually).
const TEMPLATE_ENTITY_LABELS: Record<string, string> = {
  all: 'Alla',
  enskild_firma: 'Enskild firma',
  aktiebolag: 'Aktiebolag',
}

interface Props {
  open: boolean
  onOpenChange: (v: boolean) => void
  item: InboxItem
  /** Signed URL + mime of the inbox document, threaded from the workspace so
      the underlag can be shown beside the form without an extra round-trip. */
  docUrl?: string | null
  docMime?: string | null
  onSuccess: () => void | Promise<void>
}

// Compute the prefill lines. Booking is always in SEK (BFL/BFNAR), so when
// a transaction is selected and the document is in a foreign currency, the
// transaction's SEK amount is the canonical figure. The cost-account row
// stays blank: the user must pick a cost account themselves.
// bankAccount defaults to '1930' but is replaced by the resolved ledger account
// once the cash-accounts fetch completes.
function buildPrefillLines(
  item: InboxItem,
  selectedTransactionAmount: number | null = null,
  bankAccount: string = '1930',
): FormLine[] {
  const docTotal = item.extracted_data?.totals?.total ?? null
  const docVat = item.extracted_data?.totals?.vatAmount ?? null
  const docCurrency = item.extracted_data?.invoice?.currency ?? 'SEK'

  // Prefer the transaction amount when available: it's already in SEK and
  // matches the bank movement we'll be marking as booked.
  const total = selectedTransactionAmount != null
    ? Math.abs(selectedTransactionAmount)
    : docTotal

  if (total == null || total <= 0) {
    return [{ ...BLANK_LINE }, { ...BLANK_LINE }]
  }

  const totalRounded = Math.round(total * 100) / 100

  // VAT prefill rules:
  // - Foreign-currency document → skip VAT (reverse charge is the common
  //   case; user can add it manually if needed).
  // - SEK-denominated document with extracted VAT → split it out on 2641.
  // - SEK without extracted VAT → leave VAT row out, single net row.
  const useDocVat =
    docCurrency === 'SEK' &&
    selectedTransactionAmount == null &&
    docVat != null &&
    docVat > 0
  const vatRounded = useDocVat ? Math.round((docVat ?? 0) * 100) / 100 : 0
  const net = Math.round((totalRounded - vatRounded) * 100) / 100

  const lines: FormLine[] = [
    {
      account_number: '',
      debit_amount: String(net),
      credit_amount: '',
    },
  ]
  if (vatRounded > 0) {
    lines.push({
      account_number: '2641',
      debit_amount: String(vatRounded),
      credit_amount: '',
    })
  }
  lines.push({
    account_number: bankAccount,
    debit_amount: '',
    credit_amount: String(totalRounded),
  })
  return lines
}

// Rank candidates by closeness to the underlag's SEK value. `targetSek` is the
// document total already converted to SEK (the bank charge for a 216 USD
// receipt is ~2 109 kr, not 216): ranking against the raw foreign total used
// to bury the real match far down the list. Null target → leave order intact.
function rankBySekCloseness(
  rows: PickerTransaction[],
  targetSek: number | null
): PickerTransaction[] {
  if (targetSek == null) return rows
  const abs = Math.abs(targetSek)
  return [...rows].sort((a, b) => Math.abs(txSekAmount(a) - abs) - Math.abs(txSekAmount(b) - abs))
}

export default function BookDirectlyDialog({ open, onOpenChange, item, docUrl = null, docMime = null, onSuccess }: Props) {
  const { toast } = useToast()
  const { company } = useCompany()

  // Underlag total + currency. Booking happens in SEK, so a foreign total needs
  // an FX rate to rank/compare against the (SEK) bank transactions.
  const targetAmount = item.extracted_data?.totals?.total ?? null
  const targetCurrency = (item.extracted_data?.invoice?.currency ?? 'SEK').toUpperCase()
  // SEK per unit of the underlag currency (e.g. ~9.8 for USD). null = SEK,
  // pending, or unsupported.
  const [fxRate, setFxRate] = useState<number | null>(null)

  // Session-cached reference data (lib/reference-data), seeded by the
  // dashboard layout: the settlement account, the period and the account
  // picker are known on the first paint instead of after three round trips
  // per open. cashAccounts stays null only while the list is still loading
  // (no seed): the prefill effect below reads that as "not resolved yet".
  const { cashAccounts: cachedCashAccounts, isLoading: cashAccountsLoading } = useCashAccounts()
  const cashAccounts: CashAccount[] | null = cashAccountsLoading ? null : cachedCashAccounts
  const { periods } = useFiscalPeriods()
  const { accounts } = useAccounts()
  // Full BAS catalogue (static reference data, fetched once per session). Lets
  // the account picker surface standard accounts the company hasn't activated
  // yet; picking one activates it at commit via the existing
  // ActivateAccountsDialog rail. Without it the picker only knows the active
  // chart, which reads as "the account doesn't exist".
  const [catalog, setCatalog] = useState<CatalogAccount[]>([])
  const [entryDate, setEntryDate] = useState<string>(
    item.extracted_data?.invoice?.invoiceDate || new Date().toISOString().slice(0, 10)
  )
  const [periodId, setPeriodId] = useState<string>('')
  const [description, setDescription] = useState<string>(() => {
    const supplier = item.extracted_data?.supplier?.name?.trim() || ''
    const invoiceNum = item.extracted_data?.invoice?.invoiceNumber?.trim() || ''
    return [supplier, invoiceNum].filter(Boolean).join(' · ') || 'Bokföring från inkorg'
  })
  const [notes, setNotes] = useState<string>('')
  // Start with blank lines; they are replaced once cashAccounts resolves (see
  // the combined prefill effect below). This mirrors the TransactionBookingDialog
  // pattern of gating JournalEntryForm on bankAccount !== null.
  const [lines, setLines] = useState<FormLine[]>(() => buildPrefillLines(item))

  // Transaction picker: optional selection.
  const [selectedTransactionId, setSelectedTransactionId] = useState<string | null>(
    item.matched_transaction_id
  )
  const [transactions, setTransactions] = useState<PickerTransaction[]>([])
  const [isLoadingTransactions, setIsLoadingTransactions] = useState(false)
  const [txSearch, setTxSearch] = useState('')

  const [isSubmitting, setIsSubmitting] = useState(false)

  // "Spara som mall" — derive amount-parameterised template lines from the
  // current konteringsrader so the user can save the pattern they just worked
  // out. Labels come from the loaded BAS chart; the user reviews/edits in the
  // shared TemplateForm before saving.
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)

  // Reset state when a different item opens the dialog. We pass bankAccount
  // here but it may still be null (fetch in flight): in that case '1930' is
  // used as a placeholder and the prefill-update effect below will overwrite
  // the settlement line once the fetch resolves.
  useEffect(() => {
    if (!open) return
    setEntryDate(item.extracted_data?.invoice?.invoiceDate || new Date().toISOString().slice(0, 10))
    setLines(buildPrefillLines(item, null, bankAccount ?? '1930'))
    setSelectedTransactionId(item.matched_transaction_id)
    const supplier = item.extracted_data?.supplier?.name?.trim() || ''
    const invoiceNum = item.extracted_data?.invoice?.invoiceNumber?.trim() || ''
    setDescription([supplier, invoiceNum].filter(Boolean).join(' · ') || 'Bokföring från inkorg')
    // WhatsApp items: prefill with the rendered chat context (representation
    // deltagare + syfte, sender note) so it lands on the verifikat unless the
    // user edits it away. This is the one place the photo caption is included:
    // the user reads it here and can change or delete it before booking, which
    // no other path offers (see channel-context-notes.ts).
    //
    // The dialog always submits the field, empty string included, so clearing
    // the prefill really clears it: the server only defaults when the field is
    // absent from the request.
    setNotes(renderChannelContextNotes(item.channel_context, { includeCaption: true }) ?? '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id])

  // Cost-account prefill from the company's own booking history for this
  // supplier (counterparty templates). Fills only the first line's still-empty
  // account: never a generic seed (the old silent-'5010' incident is the
  // reason there is no fallback), never over anything the user typed, and only
  // for expense-shaped templates (cost on debit, settlement on credit) so an
  // income template can't plant a revenue account on a purchase.
  const [accountSuggestion, setAccountSuggestion] = useState<{ account: string; counterparty: string } | null>(null)
  useEffect(() => {
    if (!open) return
    setAccountSuggestion(null)
    const supplier = item.extracted_data?.supplier?.name?.trim()
    if (!supplier) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(
          `/api/settings/counterparty-templates?counterparty=${encodeURIComponent(supplier)}`
        )
        if (!res.ok) return
        const json = await res.json()
        if (cancelled) return
        const match = json?.data
        const debit: string | undefined = match?.template?.debit_account
        const credit: string | undefined = match?.template?.credit_account
        if (!match || (match.confidence ?? 0) < 0.5) return
        // P&L cost on debit (4xxx-8xxx), settlement on credit: keeps private
        // and balance-sheet templates (2013, 1630, 12xx) out of a cost field.
        if (!debit || !/^[4-8]/.test(debit) || !credit || !credit.startsWith('19')) return
        setLines((current) => {
          if (!current[0] || current[0].account_number) return current
          return current.map((l, i) => (i === 0 ? { ...l, account_number: debit } : l))
        })
        setAccountSuggestion({ account: debit, counterparty: match.template.counterparty_name })
      } catch {
        // Prefill is best-effort; the field simply stays blank.
      }
    })()
    return () => { cancelled = true }
  }, [open, item.id, item.extracted_data?.supplier?.name])

  // Fetch the underlag's SEK rate for a foreign-currency document so candidate
  // transactions can be ranked against the SEK-equivalent total (and not the
  // raw foreign number). SEK / unsupported currencies skip the fetch.
  useEffect(() => {
    if (!open) return
    setFxRate(null)
    if (targetCurrency === 'SEK' || !['EUR', 'USD', 'GBP', 'NOK', 'DKK'].includes(targetCurrency)) {
      return
    }
    let cancelled = false
    const invoiceDate = item.extracted_data?.invoice?.invoiceDate
    const dateParam = invoiceDate ? `&date=${invoiceDate}` : ''
    fetch(`/api/currency/rate?currency=${targetCurrency}${dateParam}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((body) => {
        if (cancelled) return
        const rate = body?.data?.rate
        if (typeof rate === 'number' && rate > 0) setFxRate(rate)
      })
      .catch(() => { /* leave null: ranking falls back to face amounts */ })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, targetCurrency, item.id])

  // SEK-equivalent of the underlag total: the anchor for ranking candidates.
  const targetSek = useMemo(() => {
    if (targetAmount == null) return null
    if (targetCurrency === 'SEK') return targetAmount
    if (fxRate != null) return Math.round(targetAmount * fxRate * 100) / 100
    return null
  }, [targetAmount, targetCurrency, fxRate])

  // When the user picks a transaction (or the toggle changes), re-derive
  // the prefilled amounts so foreign-currency invoices follow the SEK
  // figure on the actual bank movement. Normalised to SEK: a foreign bank
  // row is booked at its SEK value, never its face amount.
  const selectedTransactionAmount = useMemo(() => {
    if (!selectedTransactionId) return null
    const tx = transactions.find((t) => t.id === selectedTransactionId)
    if (!tx) return null
    const cur = (tx.currency ?? 'SEK').toUpperCase()
    return cur === 'SEK'
      ? tx.amount
      : resolveSekAmount(tx.amount, tx.amount_sek ?? null, tx.currency, tx.exchange_rate ?? null)
  }, [selectedTransactionId, transactions])

  // The settlement currency to resolve against:
  // - When a transaction is selected, use that transaction's currency.
  // - Otherwise, use the document's currency (falls back to SEK).
  const settlementCurrency = useMemo(() => {
    if (selectedTransactionId) {
      const tx = transactions.find((t) => t.id === selectedTransactionId)
      if (tx) return (tx.currency ?? 'SEK').toUpperCase()
    }
    return targetCurrency
  }, [selectedTransactionId, transactions, targetCurrency])

  // Resolved bank account: null while the cash-accounts fetch is in flight.
  // Derived from the cash accounts list; falls back to '1930' if the list is
  // empty or no single-currency match exists.
  const bankAccount = useMemo<string | null>(() => {
    if (cashAccounts === null) return null
    const { account } = resolveAccount(cashAccounts, null, settlementCurrency)
    return account
  }, [cashAccounts, settlementCurrency])

  useEffect(() => {
    if (!open) return
    // Update amounts when the transaction selection or resolved bank account
    // changes, but preserve user-entered account numbers. This handles "user
    // typed cost account, then picked an SEK-denominated transaction": we
    // want the SEK figure to flow into the line amounts without forgetting
    // their account pick. bankAccount may be null while the fetch is in flight;
    // pass '1930' as a safe placeholder in that case: the effect re-runs once
    // the fetch resolves and bankAccount becomes non-null.
    setLines((current) => {
      const next = buildPrefillLines(item, selectedTransactionAmount, bankAccount ?? '1930')
      return next.map((nl, i) => {
        const existing = current[i]
        if (!existing) return nl
        return {
          ...nl,
          account_number: existing.account_number || nl.account_number,
        }
      })
    })
  }, [open, item, selectedTransactionAmount, bankAccount])

  // Load the static BAS catalogue on first open (periods and accounts come
  // from the session cache above).
  useEffect(() => {
    if (!open) return
    let cancelled = false
    loadBasCatalog().then((data) => {
      if (!cancelled) setCatalog(data)
    }).catch(() => {/* search degrades to the active chart */})
    return () => { cancelled = true }
  }, [open])

  // Derive the fiscal period from the entry date. Periods never overlap, so
  // this is a total function of the date; when the date falls outside every
  // period the id clears and submit is blocked with an explanation. The old
  // else-branch silently borrowed periods[0], which could book into the wrong
  // period with only the DB period trigger left to catch it.
  useEffect(() => {
    if (periods.length === 0) return
    const match = periods.find(
      (p) => entryDate >= p.period_start && entryDate <= p.period_end
    )
    setPeriodId(match ? match.id : '')
  }, [entryDate, periods])

  // Fetch unmatched transactions whenever the dialog opens: the picker
  // is always visible now (selection is optional).
  useEffect(() => {
    if (!open) return
    let cancelled = false
    setIsLoadingTransactions(true)
    ;(async () => {
      try {
        const res = await fetch('/api/transactions?unmatched=true')
        const json = await res.json()
        if (cancelled) return
        const rows: PickerTransaction[] = (Array.isArray(json.data) ? json.data : [])
          .map((t: PickerTransaction) => ({
            id: t.id,
            date: t.date,
            description: t.description,
            amount: t.amount,
            currency: t.currency || 'SEK',
            amount_sek: t.amount_sek ?? null,
            exchange_rate: t.exchange_rate ?? null,
          }))
        // Ranking happens in a memo (it depends on the async FX rate).
        setTransactions(rows)
      } catch (err) {
        console.error('[book-direct] fetch transactions failed:', err)
      } finally {
        if (!cancelled) setIsLoadingTransactions(false)
      }
    })()
    return () => { cancelled = true }
  }, [open])

  // FX-aware ranking by closeness to the underlag's SEK value.
  const rankedTransactions = useMemo(
    () => rankBySekCloseness(transactions, targetSek),
    [transactions, targetSek],
  )

  const filteredTransactions = useMemo(() => {
    const term = txSearch.trim().toLowerCase()
    if (!term) return rankedTransactions
    return rankedTransactions.filter((t) => (t.description || '').toLowerCase().includes(term))
  }, [rankedTransactions, txSearch])

  // Pin the already-selected/matched transaction to the top so it's always
  // visible: otherwise a correct match that ranks past the rendered cap looks
  // unselected and the user re-picks it. The pinned row carries a "Matchad"
  // badge when it's the one matched in the inbox.
  const displayedTransactions = useMemo(() => {
    if (!selectedTransactionId) return filteredTransactions
    const sel = filteredTransactions.find((t) => t.id === selectedTransactionId)
    if (!sel) return filteredTransactions
    return [sel, ...filteredTransactions.filter((t) => t.id !== selectedTransactionId)]
  }, [filteredTransactions, selectedTransactionId])

  const totals = useMemo(() => {
    const debit = lines.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0)
    const credit = lines.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0)
    const roundedDebit = Math.round(debit * 100) / 100
    const roundedCredit = Math.round(credit * 100) / 100
    return {
      debit: roundedDebit,
      credit: roundedCredit,
      balanced: roundedDebit === roundedCredit && roundedDebit > 0,
      diff: Math.round((roundedDebit - roundedCredit) * 100) / 100,
    }
  }, [lines])

  // Account number → BAS name, so derived template lines get meaningful labels.
  const accountNameMap = useMemo(
    () => Object.fromEntries(accounts.map((a) => [a.account_number, a.account_name])),
    [accounts],
  )

  // Template lines derived from the current booking. Empty (<2 usable lines)
  // disables the "Spara som mall" button.
  const derivedTemplateLines = useMemo(
    () => deriveTemplateLinesFromBooking(lines, accountNameMap),
    [lines, accountNameMap],
  )

  const updateLine = useCallback((idx: number, patch: Partial<FormLine>) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)))
  }, [])

  const addLine = useCallback(() => {
    setLines((prev) => [...prev, { ...BLANK_LINE }])
  }, [])

  const removeLine = useCallback((idx: number) => {
    setLines((prev) => prev.length <= 2 ? prev : prev.filter((_, i) => i !== idx))
  }, [])

  // Outstanding imbalance from every line except `excludeIndex`.
  // Positive => debit side is short (a debit on the target row balances it);
  // negative => credit side is short. Same semantics as JournalEntryForm.
  const computeBalancingDiff = useCallback(
    (excludeIndex: number) => {
      const others = lines.filter((_, i) => i !== excludeIndex)
      const d = others.reduce((sum, l) => sum + (parseFloat(l.debit_amount) || 0), 0)
      const c = others.reduce((sum, l) => sum + (parseFloat(l.credit_amount) || 0), 0)
      return roundOre(c - d)
    },
    [lines]
  )

  // Opt-in balancing (ported from JournalEntryForm): double-click a debit or
  // credit field to fill the amount that makes the entry balance. No-op if
  // already balanced or if the balancing entry belongs on the other side.
  const handleFillBalance = useCallback(
    (idx: number, side: 'debit' | 'credit') => {
      const diff = computeBalancingDiff(idx)
      const fill = side === 'debit' ? diff : -diff
      if (fill <= 0) return
      updateLine(
        idx,
        side === 'debit'
          ? { debit_amount: fill.toFixed(2), credit_amount: '' }
          : { credit_amount: fill.toFixed(2), debit_amount: '' }
      )
    },
    [computeBalancingDiff, updateLine]
  )

  // Replace the line set with a booking template's computed rows. The picker
  // hands back JournalEntryForm-shaped lines; we keep only the three fields
  // book-direct posts. A meaningful supplier description is preserved: the
  // template name only fills an empty field.
  const handleTemplateApply = useCallback(
    (
      templateLines: Array<{ account_number: string; debit_amount: string; credit_amount: string }>,
      templateDescription: string,
    ) => {
      setLines(
        templateLines.map((l) => ({
          account_number: l.account_number,
          debit_amount: l.debit_amount,
          credit_amount: l.credit_amount,
        })),
      )
      setDescription((prev) => (prev.trim() ? prev : templateDescription))
    },
    [],
  )

  const derivedPeriod = useMemo(
    () => periods.find((p) => p.id === periodId) ?? null,
    [periods, periodId],
  )
  const derivedPeriodBlocked = !!(derivedPeriod?.locked_at || derivedPeriod?.is_closed)

  const disabledReason = useMemo(() => {
    if (isSubmitting) return null
    if (!entryDate) return 'Välj datum'
    if (!periodId) return 'Datumet matchar ingen öppen räkenskapsperiod'
    if (derivedPeriodBlocked) return 'Räkenskapsperioden är låst eller stängd'
    if (description.trim().length === 0) return 'Fyll i beskrivning'
    if (lines.some((l) => l.account_number.trim().length === 0)) return 'Alla rader behöver ett konto'
    if (!totals.balanced) return 'Debet och kredit måste vara lika'
    return null
  }, [isSubmitting, entryDate, periodId, derivedPeriodBlocked, description, lines, totals.balanced])

  const canSubmit = !isSubmitting && disabledReason === null

  const postBooking = useCallback(async () => {
    const payload = {
      fiscal_period_id: periodId,
      entry_date: entryDate,
      description: description.trim(),
      // Always send the field, '' included: the server treats an absent
      // `notes` as "default it from the chat context" and a present one as
      // the user's own value. Sending undefined for a cleared prefill would
      // resurrect the text the user just deleted onto an immutable verifikat.
      notes: notes.trim(),
      lines: lines.map((l) => ({
        account_number: l.account_number.trim(),
        debit_amount: parseFloat(l.debit_amount) || 0,
        credit_amount: parseFloat(l.credit_amount) || 0,
      })),
      transaction_id: selectedTransactionId ?? undefined,
    }
    const res = await fetch(
      `/api/extensions/ext/invoice-inbox/items/${item.id}/book-direct`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    )
    return (await throwOnStructuredError(res)) as {
      data?: { journal_entry?: { voucher_series: string; voucher_number: number } }
    }
  }, [periodId, entryDate, description, notes, lines, selectedTransactionId, item.id])

  const { runSubmit, dialog: activationDialog, confirm: confirmActivation, cancel: cancelActivation } =
    useSubmitWithAccountActivation(postBooking)

  const handleSubmit = useCallback(async () => {
    if (!canSubmit) return
    setIsSubmitting(true)
    try {
      const json = await runSubmit()
      const voucher = json?.data?.journal_entry
      toast({
        title: 'Bokfört',
        description: voucher
          ? `Verifikation ${formatVoucher(voucher)} skapad.`
          : 'Verifikation skapad.',
      })
      await onSuccess()
      onOpenChange(false)
    } catch (err) {
      if (err instanceof Error && err.message === 'cancelled') {
        // User dismissed the activation dialog: no toast needed
      } else {
        const anyErr = err as { body?: unknown; status?: number }
        toast({
          title: 'Kunde inte bokföra',
          description: getErrorMessage(anyErr.body ?? err, {
            context: 'journal_entry',
            statusCode: anyErr.status,
          }),
          variant: 'destructive',
        })
      }
    } finally {
      setIsSubmitting(false)
    }
  }, [canSubmit, runSubmit, toast, onSuccess, onOpenChange])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-6xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Bokför direkt</DialogTitle>
          <DialogDescription>
            Skapa en verifikation från underlaget. Dokumentet bifogas verifikationen som underlag.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
          {/* Document column: sticky on desktop so the underlag stays visible
              while the form scrolls; stacks above the form on smaller screens. */}
          <div className="h-[45vh] lg:sticky lg:top-0 lg:h-[72vh] lg:self-start">
            <DocumentViewerPane
              documentId={item.document_id}
              mime={docMime}
              downloadUrl={docUrl}
              className="h-full"
            />
          </div>

          {/* Booking form */}
          <div className="space-y-6 pt-2">
          {/* Metadata row */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="bd-date">Datum</Label>
              <Input
                id="bd-date"
                type="date"
                value={entryDate}
                onChange={(e) => setEntryDate(e.target.value)}
                disabled={isSubmitting}
                className="tabular-nums"
              />
            </div>
            <div className="space-y-1.5 md:col-span-2">
              <Label>Räkenskapsperiod</Label>
              {/* Derived from the entry date (periods never overlap): text,
                  not a picker, so it can never disagree with the date. */}
              {periods.length === 0 ? (
                <p className="text-sm text-muted-foreground pt-2">Hämtar perioder …</p>
              ) : derivedPeriod ? (
                <p className="text-sm pt-2 tabular-nums">
                  {derivedPeriod.period_start}: {derivedPeriod.period_end}
                  {(derivedPeriod.locked_at || derivedPeriod.is_closed) && (
                    <span className="text-attn">
                      {' '}({derivedPeriod.locked_at ? 'låst' : 'stängd'})
                    </span>
                  )}
                </p>
              ) : (
                <AttnLine className="pt-2">
                  Datumet ligger utanför öppna räkenskapsperioder. Ändra datumet eller skapa perioden under Bokföring.
                </AttnLine>
              )}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="bd-description">Beskrivning</Label>
            <Input
              id="bd-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={isSubmitting}
              placeholder="Leverantör · fakturanummer"
            />
          </div>

          {/* Transaction picker: always shown, selection is optional. */}
          <div className="rounded-lg border p-4 space-y-3">
            <div className="space-y-0.5">
              <Label className="text-sm">Koppla till banktransaktion (valfritt)</Label>
              <p className="text-xs text-muted-foreground">
                Välj en transaktion om dokumentet motsvarar en redan-bokad
                bankhändelse: den bokas då samtidigt. Lämna tom för en
                fristående verifikation.
              </p>
            </div>
            <div className="space-y-2">
              <div className="relative">
                <Search className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Sök på beskrivning…"
                  value={txSearch}
                  onChange={(e) => setTxSearch(e.target.value)}
                  className="pl-10"
                  disabled={isSubmitting}
                />
              </div>
              <div className="max-h-56 overflow-y-auto rounded-lg border">
                {isLoadingTransactions ? (
                  <div className="flex items-center justify-center py-8 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 mr-2 animate-spin" /> Laddar…
                  </div>
                ) : filteredTransactions.length === 0 ? (
                  <p className="py-6 text-center text-sm text-muted-foreground">
                    Inga okategoriserade transaktioner.
                  </p>
                ) : (
                  <ul className="divide-y">
                    {displayedTransactions.slice(0, 30).map((tx) => {
                      const isSelected = selectedTransactionId === tx.id
                      const isInboxMatch = item.matched_transaction_id === tx.id
                      const cur = (tx.currency || 'SEK').toUpperCase()
                      const sek = txSekAmount(tx)
                      return (
                        <li key={tx.id}>
                          <button
                            type="button"
                            className={cn(
                              'w-full flex items-center justify-between gap-3 px-3 py-2 text-left text-sm transition-colors',
                              isSelected
                                ? 'bg-primary/10 border-l-2 border-primary'
                                : 'border-l-2 border-transparent hover:bg-accent/40'
                            )}
                            onClick={() =>
                              setSelectedTransactionId(isSelected ? null : tx.id)
                            }
                            disabled={isSubmitting}
                          >
                            <span className="shrink-0 w-4 flex items-center justify-center">
                              {isSelected ? (
                                <Check className="h-3.5 w-3.5 text-primary" />
                              ) : null}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <p className="truncate">{tx.description}</p>
                                {isInboxMatch && (
                                  <Badge variant="secondary" className="shrink-0 text-[10px] px-1.5 py-0">
                                    Matchad
                                  </Badge>
                                )}
                              </div>
                              <p className="text-xs text-muted-foreground tabular-nums">{tx.date}</p>
                            </div>
                            <div className="text-right shrink-0">
                              <span
                                className={cn(
                                  'tabular-nums text-sm block',
                                  tx.amount < 0 ? 'text-destructive' : 'text-foreground'
                                )}
                              >
                                {formatCurrency(tx.amount, tx.currency || 'SEK')}
                              </span>
                              {cur !== 'SEK' && (
                                <span className="text-[11px] text-muted-foreground tabular-nums">
                                  ≈ {formatCurrency(sek, 'SEK')}
                                </span>
                              )}
                            </div>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>
              {selectedTransactionId && (
                <button
                  type="button"
                  className="text-xs text-muted-foreground hover:text-foreground underline"
                  onClick={() => setSelectedTransactionId(null)}
                  disabled={isSubmitting}
                >
                  Rensa val
                </button>
              )}
            </div>
          </div>

          {/* Journal entry lines */}
          <div className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label className="text-sm">Konteringsrader</Label>
              <div className="text-xs text-muted-foreground text-right">
                {targetAmount != null && (
                  <span>
                    Underlag:{' '}
                    <span className="tabular-nums font-medium text-foreground">
                      {formatCurrency(targetAmount, targetCurrency)}
                    </span>
                  </span>
                )}
                {selectedTransactionAmount != null && (
                  <span>
                    {targetAmount != null && ' · '}
                    Transaktion:{' '}
                    <span className="tabular-nums font-medium text-foreground">
                      {formatCurrency(Math.abs(selectedTransactionAmount), 'SEK')}
                    </span>
                  </span>
                )}
              </div>
            </div>
            {targetCurrency !== 'SEK' && selectedTransactionAmount != null && (
              <p className="text-[11px] text-muted-foreground">
                Underlaget är i {targetCurrency}. Bokföringen sker i SEK enligt
                transaktionens belopp. Momsraden har lämnats bort: vid behov
                lägg till en rad för omvänd skattskyldighet manuellt.
              </p>
            )}
            {accountSuggestion && lines[0]?.account_number === accountSuggestion.account && (
              <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
                Konto {accountSuggestion.account} föreslaget från tidigare bokföringar av{' '}
                {formatCounterpartyName(accountSuggestion.counterparty)}
              </p>
            )}
            <div className="rounded-lg border overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-muted/40">
                  <tr className="text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="text-left font-medium px-3 py-2 w-[40%]">Konto</th>
                    <th className="text-right font-medium px-3 py-2">Debet</th>
                    <th className="text-right font-medium px-3 py-2">Kredit</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {lines.map((line, idx) => (
                    <tr key={idx}>
                      <td className="px-3 py-2">
                        <AccountCombobox
                          value={line.account_number}
                          accounts={accounts}
                          catalog={catalog}
                          onChange={(v) => updateLine(idx, { account_number: v })}
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          value={line.debit_amount}
                          onChange={(e) => updateLine(idx, { debit_amount: e.target.value, credit_amount: e.target.value ? '' : line.credit_amount })}
                          onDoubleClick={() => handleFillBalance(idx, 'debit')}
                          disabled={isSubmitting}
                          className="text-right tabular-nums"
                          placeholder="0,00"
                        />
                      </td>
                      <td className="px-3 py-2">
                        <Input
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          value={line.credit_amount}
                          onChange={(e) => updateLine(idx, { credit_amount: e.target.value, debit_amount: e.target.value ? '' : line.debit_amount })}
                          onDoubleClick={() => handleFillBalance(idx, 'credit')}
                          disabled={isSubmitting}
                          className="text-right tabular-nums"
                          placeholder="0,00"
                        />
                      </td>
                      <td className="px-2 py-2 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => removeLine(idx)}
                          disabled={isSubmitting || lines.length <= 2}
                          aria-label="Ta bort rad"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot className="bg-muted/20 text-xs">
                  <tr>
                    <td className="px-3 py-2">
                      <div className="flex items-center justify-between gap-3">
                        {/* The remaining debit/credit gap, right where the user
                            reconciles the sums: what is still missing to balance. */}
                        {totals.diff !== 0 ? (
                          <span className="tabular-nums font-medium text-destructive">
                            Differens {Math.abs(totals.diff).toFixed(2)}
                          </span>
                        ) : (
                          <span />
                        )}
                        <span className="text-right font-medium uppercase tracking-wider text-muted-foreground">
                          Summa
                        </span>
                      </div>
                    </td>
                    <td
                      className={cn(
                        'px-3 py-2 text-right tabular-nums font-medium',
                        totals.diff !== 0 && 'text-destructive'
                      )}
                    >
                      {totals.debit.toFixed(2)}
                    </td>
                    <td
                      className={cn(
                        'px-3 py-2 text-right tabular-nums font-medium',
                        totals.diff !== 0 && 'text-destructive'
                      )}
                    >
                      {totals.credit.toFixed(2)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={addLine}
                  disabled={isSubmitting}
                >
                  <Plus className="h-3.5 w-3.5 mr-1.5" />
                  Lägg till rad
                </Button>
                <BookingTemplatePicker
                  onApply={handleTemplateApply}
                  entityType={company?.entity_type}
                  defaultAmount={
                    selectedTransactionAmount != null
                      ? Math.abs(selectedTransactionAmount)
                      : targetSek ?? undefined
                  }
                />
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setShowSaveTemplate(true)}
                  disabled={isSubmitting || derivedTemplateLines.length < 2}
                  title={
                    derivedTemplateLines.length < 2
                      ? 'Fyll i minst två konteringsrader med konto och belopp'
                      : undefined
                  }
                >
                  <BookmarkPlus className="h-3.5 w-3.5 mr-1.5" />
                  Spara som mall
                </Button>
              </div>
              {totals.balanced ? (
                <Badge variant="success" className="text-[11px]">
                  Balanserad
                </Badge>
              ) : totals.diff !== 0 ? (
                <span className="text-xs text-muted-foreground">
                  Dubbelklicka i ett tomt beloppsfält för att fylla i differensen
                </span>
              ) : null}
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="bd-notes" className="text-xs uppercase tracking-wider text-muted-foreground">
              Anteckningar (valfritt)
            </Label>
            <Textarea
              id="bd-notes"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              disabled={isSubmitting}
              rows={2}
              placeholder="Intern kommentar om verifikationen"
            />
          </div>

          <div className="flex items-center justify-between gap-3 pt-2 border-t">
            <p
              className={cn(
                'text-xs tabular-nums',
                disabledReason ? 'text-attn' : 'text-muted-foreground'
              )}
              aria-live="polite"
            >
              {disabledReason ?? 'Klar att bokföra.'}
            </p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={isSubmitting}
              >
                Avbryt
              </Button>
              <Button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit}
                title={disabledReason ?? undefined}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    Bokför…
                  </>
                ) : (
                  'Bokför'
                )}
              </Button>
            </div>
          </div>
          </div>
        </div>
      </DialogContent>
      <ActivateAccountsDialog
        open={activationDialog.open}
        accountNumbers={activationDialog.accountNumbers}
        onConfirm={confirmActivation}
        onCancel={cancelActivation}
      />

      {/* Save the current kontering as a reusable template. Amounts are stored
          as ratios of the total, so the user picks a fresh amount when applying
          the mall later. The shared TemplateForm re-seeds from the derived lines
          each time the dialog opens (Radix unmounts its content when closed). */}
      <Dialog open={showSaveTemplate} onOpenChange={setShowSaveTemplate}>
        <DialogContent className="max-w-lg max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Spara som bokföringsmall</DialogTitle>
            <DialogDescription>
              Spara den här konteringen som en återanvändbar mall. Beloppen sparas
              som andelar av totalsumman — du anger ett nytt belopp när du använder
              mallen. Kontrollera raderna nedan innan du sparar.
            </DialogDescription>
          </DialogHeader>
          {showSaveTemplate && (
            <TemplateForm
              mode="create"
              entityLabels={TEMPLATE_ENTITY_LABELS}
              initialTemplate={{
                id: '',
                company_id: null,
                team_id: null,
                created_by: null,
                name: description.trim(),
                description: '',
                category: 'other',
                entity_type: company?.entity_type ?? 'all',
                lines: derivedTemplateLines,
                is_system: false,
                is_active: true,
                created_at: '',
                updated_at: '',
              } satisfies BookingTemplateLibrary}
              onSaved={() => setShowSaveTemplate(false)}
            />
          )}
        </DialogContent>
      </Dialog>
    </Dialog>
  )
}
