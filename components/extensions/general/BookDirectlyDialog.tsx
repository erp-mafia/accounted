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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Badge } from '@/components/ui/badge'
import { useToast } from '@/components/ui/use-toast'
import { Loader2, Plus, Trash2, AlertTriangle, Search, Check } from 'lucide-react'
import { cn, formatCurrency } from '@/lib/utils'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import BookingTemplatePicker from '@/components/bookkeeping/BookingTemplatePicker'
import { ActivateAccountsDialog } from '@/components/bookkeeping/ActivateAccountsDialog'
import { useCompany } from '@/contexts/CompanyContext'
import {
  useSubmitWithAccountActivation,
  throwOnStructuredError,
} from '@/lib/hooks/use-submit-with-account-activation'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { resolveSekAmount } from '@/lib/bookkeeping/currency-utils'
import { resolveAccount } from '@/lib/cash-accounts/resolve-account'
import type { BASAccount, CashAccount, FiscalPeriod, InvoiceExtractionResult } from '@/types'

interface InboxItem {
  id: string
  document_id: string | null
  matched_transaction_id: string | null
  extracted_data: InvoiceExtractionResult | null
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

  // null = fetch pending; array = loaded (may be empty on error: falls back to '1930')
  const [cashAccounts, setCashAccounts] = useState<CashAccount[] | null>(null)

  const [periods, setPeriods] = useState<FiscalPeriod[]>([])
  const [accounts, setAccounts] = useState<BASAccount[]>([])
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
    setNotes('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id])

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

  // Fetch cash accounts once when the dialog opens so the settlement line can
  // be routed to the correct ledger account instead of the hardcoded '1930'.
  useEffect(() => {
    if (!open) return
    setCashAccounts(null)
    let cancelled = false
    fetch('/api/cash-accounts')
      .then((r) => {
        if (!r.ok) throw new Error(`cash-accounts fetch failed: ${r.status}`)
        return r.json()
      })
      .then((json) => {
        if (cancelled) return
        setCashAccounts((json.data ?? []) as CashAccount[])
      })
      .catch(() => {
        // Fall back to empty list: resolveAccount will return '1930'
        if (!cancelled) setCashAccounts([])
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id])

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

  // Fetch fiscal periods and accounts on first open
  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      try {
        const [periodsRes, accountsRes] = await Promise.all([
          fetch('/api/bookkeeping/fiscal-periods'),
          fetch('/api/bookkeeping/accounts'),
        ])
        const periodsJson = await periodsRes.json()
        const accountsJson = await accountsRes.json()
        if (cancelled) return
        setPeriods(periodsJson.data || [])
        setAccounts(accountsJson.data || [])
      } catch (err) {
        console.error('[book-direct] fetch reference data failed:', err)
      }
    })()
    return () => { cancelled = true }
  }, [open])

  // Auto-select fiscal period matching the entry date
  useEffect(() => {
    if (periods.length === 0) return
    const match = periods.find(
      (p) => entryDate >= p.period_start && entryDate <= p.period_end
    )
    if (match) {
      setPeriodId(match.id)
    } else if (!periodId && periods.length > 0) {
      setPeriodId(periods[0].id)
    }
  }, [entryDate, periods, periodId])

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

  const updateLine = useCallback((idx: number, patch: Partial<FormLine>) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)))
  }, [])

  const addLine = useCallback(() => {
    setLines((prev) => [...prev, { ...BLANK_LINE }])
  }, [])

  const removeLine = useCallback((idx: number) => {
    setLines((prev) => prev.length <= 2 ? prev : prev.filter((_, i) => i !== idx))
  }, [])

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

  const disabledReason = useMemo(() => {
    if (isSubmitting) return null
    if (!entryDate) return 'Välj datum'
    if (!periodId) return 'Välj räkenskapsperiod'
    if (description.trim().length === 0) return 'Fyll i beskrivning'
    if (lines.some((l) => l.account_number.trim().length === 0)) return 'Alla rader behöver ett konto'
    if (!totals.balanced) return 'Debet och kredit måste vara lika'
    return null
  }, [isSubmitting, entryDate, periodId, description, lines, totals.balanced])

  const canSubmit = !isSubmitting && disabledReason === null

  const postBooking = useCallback(async () => {
    const payload = {
      fiscal_period_id: periodId,
      entry_date: entryDate,
      description: description.trim(),
      notes: notes.trim() || undefined,
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
              <Label htmlFor="bd-period">Räkenskapsperiod</Label>
              <Select
                value={periodId}
                onValueChange={setPeriodId}
                disabled={isSubmitting || periods.length === 0}
              >
                <SelectTrigger id="bd-period">
                  <SelectValue placeholder="Välj period" />
                </SelectTrigger>
                <SelectContent>
                  {periods.map((p) => {
                    const lockState = p.locked_at
                      ? 'låst'
                      : p.is_closed
                        ? 'stängd'
                        : null
                    return (
                      <SelectItem key={p.id} value={p.id}>
                        {p.period_start}: {p.period_end}
                        {lockState && ` (${lockState})`}
                      </SelectItem>
                    )
                  })}
                </SelectContent>
              </Select>
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
              <div className="max-h-56 overflow-y-auto rounded-md border">
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
                    <td className="px-3 py-2 text-right font-medium uppercase tracking-wider text-muted-foreground">
                      Summa
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">
                      {totals.debit.toFixed(2)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums font-medium">
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
              </div>
              {totals.balanced ? (
                <Badge variant="success" className="text-[11px]">
                  Balanserad
                </Badge>
              ) : (
                <span className="text-xs text-muted-foreground flex items-center gap-1.5 tabular-nums">
                  <AlertTriangle className="h-3.5 w-3.5 text-warning" />
                  Diff {totals.diff.toFixed(2)}
                </span>
              )}
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
                disabledReason ? 'text-warning-foreground' : 'text-muted-foreground'
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
    </Dialog>
  )
}
