'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
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
import { Plus, Trash2, Search, Check, BookmarkPlus, Tags } from 'lucide-react'
import { Skeleton } from '@/components/ui/skeleton'
import { cn, formatCurrency } from '@/lib/utils'
import { roundOre } from '@/lib/money'
import {
  applyCostAccountSuggestion,
  buildBookDirectPrefillLines,
  manualBookDirectLines,
  reconcileBookDirectLines,
  toBookDirectPayloadLine,
  withExplicitAccountEdit,
  type BookDirectFormLine,
  type BookDirectLineRole,
} from '@/lib/bookkeeping/book-direct-prefill'
import AccountCombobox from '@/components/bookkeeping/AccountCombobox'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'
import { loadBasCatalog, type CatalogAccount } from '@/lib/bookkeeping/bas-catalog-client'
import DocumentViewerPane from '@/components/bookkeeping/DocumentViewerPane'
import TemplateApplyButton from '@/components/bookkeeping/TemplateApplyButton'
import { TemplateForm } from '@/components/settings/TemplateForm'
import { deriveTemplateLinesFromBooking } from '@/lib/bookkeeping/template-library'
import { ActivateAccountsDialog } from '@/components/bookkeeping/ActivateAccountsDialog'
import { useCompany } from '@/contexts/CompanyContext'
import { useAccounts, useCashAccounts, useCompanySettings, useFiscalPeriods } from '@/lib/reference-data/hooks'
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
import { FOREIGN_CURRENCIES, type BookingTemplateLibrary, type CashAccount, type InboxChannelContext, type InvoiceExtractionResult } from '@/types'

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

// Swedish entity labels for the "Spara som mall" editor. Hard-coded to match
// this dialog's Swedish-only surface (the shared TemplateForm handles the rest
// of its own strings bilingually).
const TEMPLATE_ENTITY_LABELS: Record<string, string> = {
  all: 'Alla',
  enskild_firma: 'Enskild firma',
  aktiebolag: 'Aktiebolag',
  ideell_forening: 'Ideell förening',
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
  // Per-line kostnadsställe/projekt (the route posts each line's bag). Same
  // gate and row affordance as the voucher form, so its wording is reused.
  const { settings: companySettings } = useCompanySettings()
  const dimensionsEnabled = companySettings?.dimensions_enabled === true
  // Only an explicit false changes the prefill: a non-registered company has
  // no avdragsrätt, so the receipt's VAT is cost and no 2641 row is generated.
  // undefined while settings load prefills as before; the reconcile effect
  // below applies the loaded value by role.
  const vatRegistered = companySettings?.vat_registered
  const tJournal = useTranslations('journal_form')
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
  // Generated cost / VAT / settlement rows. Replaced when the document
  // changes, then reconciled by role when the transaction or the resolved
  // cash account changes (see the effects below). '1930' is only the
  // temporary settlement default until that account resolves.
  const [lines, setLines] = useState<BookDirectFormLine[]>(() =>
    buildBookDirectPrefillLines(item.extracted_data, null, '1930', { vatRegistered }),
  )
  // Generated roles the user deleted since this item opened. Every later
  // prefill refresh leaves them out, so picking a transaction or the cash
  // account resolving cannot bring back a row the user removed (a deleted
  // VAT row would otherwise return as a 2641 debit). Cleared on open and on
  // a new item. A ref: it never drives rendering, and the reconcile effect
  // must see the reset effect's clear in the same commit.
  const suppressedRolesRef = useRef<Set<BookDirectLineRole>>(new Set())

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

  // Reset state when a different item opens the dialog. Lines are a fresh
  // prefill (no transaction yet) on the '1930' placeholder. The reconcile
  // effect below runs in the same commit (it also fires on open and on a new
  // item) and moves an untouched settlement leg onto the resolved cash
  // account. vatRegistered is read as known at open but is not a dependency:
  // a later change is applied by role in the reconcile effect, which keeps
  // the user's date, description, notes and transaction choice instead of
  // resetting them on a settings revalidation.
  useEffect(() => {
    if (!open) return
    suppressedRolesRef.current.clear()
    setEntryDate(item.extracted_data?.invoice?.invoiceDate || new Date().toISOString().slice(0, 10))
    setLines(buildBookDirectPrefillLines(item.extracted_data, null, '1930', { vatRegistered }))
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
  // supplier (counterparty templates). Fills only a still-empty generated
  // cost row: never a generic seed (the old silent-'5010' incident is the
  // reason there is no fallback), never a manual or template row, never over
  // anything the user typed, and only for expense-shaped templates (cost on
  // debit, settlement on credit) so an income template can't plant a revenue
  // account on a purchase. A late response must not land on row 0.
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
        setLines((current) => applyCostAccountSuggestion(current, debit))
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
    if (targetCurrency === 'SEK' || !(FOREIGN_CURRENCIES as readonly string[]).includes(targetCurrency)) {
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
    // Recompute generated amounts when the transaction or the resolved bank
    // account changes. Rows match by role, so a VAT leg appearing or
    // disappearing cannot move 2641 or its dimensions onto the settlement
    // credit. An untouched settlement default follows the resolved cash
    // account; an explicit account commit stays. Manual and template rows
    // have no role and are left as they are. bankAccount is null while cash
    // accounts load: '1930' is only the temporary generated default. A
    // non-registered company gets no VAT row (the total stays on cost), and
    // roles the user deleted are not generated again.
    const next = buildBookDirectPrefillLines(
      item.extracted_data,
      selectedTransactionAmount,
      bankAccount ?? '1930',
      { vatRegistered, suppressedRoles: suppressedRolesRef.current },
    )
    setLines((current) => reconcileBookDirectLines(current, next))
  }, [open, item, selectedTransactionAmount, bankAccount, vatRegistered])

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

  const updateLine = useCallback((
    idx: number,
    patch: Partial<Pick<BookDirectFormLine, 'account_number' | 'debit_amount' | 'credit_amount'>>,
  ) => {
    setLines((prev) => prev.map((l, i) => (i === idx ? withExplicitAccountEdit(l, patch) : l)))
  }, [])

  const addLine = useCallback(() => {
    // Manual row: no generated role, so a later prefill refresh leaves it alone.
    setLines((prev) => [...prev, { account_number: '', debit_amount: '', credit_amount: '' }])
  }, [])

  const removeLine = useCallback((idx: number) => {
    if (lines.length <= 2) return
    // A deleted generated row stays deleted for this item: see suppressedRolesRef.
    const role = lines[idx]?.role
    if (role) suppressedRolesRef.current.add(role)
    setLines(lines.filter((_, i) => i !== idx))
  }, [lines])

  // Open/close a line's kostnadsställe/projekt row; closing clears its bag.
  const toggleLineDimensions = useCallback((idx: number) => {
    setLines((prev) =>
      prev.map((l, i) => (i === idx ? { ...l, dimensions: l.dimensions ? undefined : {} } : l)),
    )
  }, [])

  const updateLineDimension = useCallback((idx: number, dimNo: string, code: string | null) => {
    setLines((prev) =>
      prev.map((l, i) => {
        if (i !== idx) return l
        const dims = { ...(l.dimensions ?? {}) }
        const trimmed = code?.trim()
        if (trimmed) dims[dimNo] = trimmed
        else delete dims[dimNo]
        return { ...l, dimensions: dims }
      }),
    )
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
      // Untagged manual rows: the next prefill refresh must not reinterpret
      // 2641 or a 19-account as generated VAT or settlement.
      setLines(manualBookDirectLines(templateLines))
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
      lines: lines.map(toBookDirectPayloadLine),
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
                  <div className="space-y-2 px-3 py-3" aria-busy="true" aria-label="Laddar…">
                    {[0, 1, 2, 3].map((i) => (
                      <Skeleton key={i} className="h-8 w-full" />
                    ))}
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
                                : 'border-l-2 border-transparent hover:bg-secondary/35'
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
                                  <Badge variant="secondary" className="shrink-0 text-[11px] px-1.5 py-0">
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
            {accountSuggestion && lines.some((l) => l.role === 'cost' && l.account_number === accountSuggestion.account) && (
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
                  {lines.flatMap((line, idx) => [
                    <tr key={`line-${idx}`}>
                      <td className="px-3 py-2">
                        {/* The line's tag toggle sits with its account: a
                            bag describes the account's line. */}
                        <div className="flex items-center gap-1">
                          <div className="min-w-0 flex-1">
                            <AccountCombobox
                              value={line.account_number}
                              accounts={accounts}
                              catalog={catalog}
                              onChange={(v) => updateLine(idx, { account_number: v })}
                            />
                          </div>
                          {dimensionsEnabled && (
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon-sm"
                              onClick={() => toggleLineDimensions(idx)}
                              disabled={isSubmitting}
                              aria-label={tJournal('row_dimensions_aria')}
                              aria-expanded={line.dimensions != null}
                              title={tJournal('row_dimensions_aria')}
                              className={cn('shrink-0', line.dimensions != null ? 'text-foreground' : 'text-muted-foreground')}
                            >
                              <Tags className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </div>
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
                          size="icon-sm"
                          onClick={() => removeLine(idx)}
                          disabled={isSubmitting || lines.length <= 2}
                          aria-label="Ta bort rad"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>,
                    // The line's kostnadsställe/projekt, posted with the line.
                    ...(dimensionsEnabled && line.dimensions != null
                      ? [
                          <tr key={`dims-${idx}`} className="bg-muted/20">
                            <td colSpan={4} className="px-3 py-2">
                              <div className="max-w-md">
                                <LineDimensionFields
                                  dimensions={line.dimensions}
                                  onChange={(dimNo, code) => updateLineDimension(idx, dimNo, code)}
                                  disabled={isSubmitting}
                                  inputClassName="h-8"
                                />
                              </div>
                            </td>
                          </tr>,
                        ]
                      : []),
                  ])}
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
                <TemplateApplyButton
                  onApply={handleTemplateApply}
                  entityType={company?.entity_type}
                  disabled={isSubmitting}
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
                <span className="text-xs text-muted-foreground">Balanserad</span>
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
                loading={isSubmitting}
                title={disabledReason ?? undefined}
              >
                {isSubmitting ? 'Bokför…' : 'Bokför'}
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
