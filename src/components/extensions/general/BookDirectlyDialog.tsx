'use client'

import { useState, useEffect, useMemo, useCallback, useRef } from 'react'
import { useTranslations } from 'next-intl'
import {
  Dialog,
  DialogConsequence,
  DialogContent,
  DialogFooter,
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
import {
  BookmarkIcon,
  CheckIcon,
  ChevronDownIcon,
  HashtagIcon,
  MagnifyingGlassIcon,
  PlusIcon,
  XMarkIcon,
} from '@/components/icons'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { LoadError } from '@/components/ui/empty-state'
import { TOTAL_TD_CLASS, VTH_CLASS } from '@/components/ui/dry-table'
import { MENU_SEPARATOR_CLASS } from '@/components/ui/field-classes'
import { POPOVER_ENTER_CLASS, POPOVER_SURFACE_CLASS } from '@/components/ui/popover-surface'
import { cn, formatCurrency, formatAmount } from '@/lib/utils'
import { roundOre, formatAmountInput } from '@/lib/money'
import { lineBalance } from '@/lib/bookkeeping/line-balance'
import {
  applyCostAccountSuggestion,
  bankRowSekAmount,
  bookDirectDocumentCurrency,
  bookDirectFxRefusal,
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
import { isCardLedgerAccount } from '@/lib/cash-accounts/card-ledger'
import { ActivateAccountsDialog } from '@/components/bookkeeping/ActivateAccountsDialog'
import VoucherWarningsDialog from '@/components/bookkeeping/VoucherWarningsDialog'
import type { VoucherWarning } from '@/lib/bookkeeping/voucher-plausibility'
import { useCompany } from '@/contexts/CompanyContext'
import { useAccounts, useCashAccounts, useCompanySettings, useFiscalPeriods } from '@/lib/reference-data/hooks'
import {
  useSubmitWithAccountActivation,
  throwOnStructuredError,
} from '@/lib/hooks/use-submit-with-account-activation'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { resolveSekAmount, sekOfForeign } from '@/lib/bookkeeping/currency-utils'
import { resolveAccount } from '@/lib/cash-accounts/resolve-account'
import { renderChannelContextNotes } from '@/lib/documents/channel-context-notes'
import { formatCounterpartyName } from '@/lib/bookkeeping/counterparty-template-format'
import { AttnLine } from '@/components/ui/attn-line'
import type { BookingTemplateLibrary, CashAccount, InboxChannelContext, InvoiceExtractionResult } from '@/types'
import { todayIsoStockholm } from '@/lib/dates/iso'
import type { UnbookedBankRow } from '@/lib/documents/underlag-bank-candidates'
import { useUnderlagBankCandidates } from '@/components/inbox/use-underlag-bank-candidates'

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

type PickerTransaction = UnbookedBankRow

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

/** A section label (Stil v3): 12px/500 in sentence case, the same look as a field label. */
const SECTION_LABEL_CLASS = 'text-[12px] font-medium leading-4 text-foreground/80'
/** A help or status line under a field or section: 12px, muted unless it reports a problem. */
const HELP_CLASS = 'text-[12px] leading-4 text-muted-foreground'
/** A konteringsrad cell: a 36px ledger row holding a 28px field, over a hairline. */
const LINE_TD_CLASS = 'h-9 border-b-hairline py-1 pr-2 align-middle'

/**
 * One bank row as the payment line and the picker show it: date, text,
 * amount (a foreign row with its kronor value under it) and the inbox's
 * "Matchad" mark when the inbox already paired this row with the underlag.
 */
function BankRowText({ tx, matched }: { tx: PickerTransaction; matched: boolean }) {
  const cur = (tx.currency || 'SEK').toUpperCase()
  return (
    <span className="flex min-w-0 flex-1 items-center gap-3 text-[13px]">
      <span className="date-figures shrink-0 text-[12px] text-muted-foreground">{tx.date}</span>
      <span className="min-w-0 flex-1 truncate">{tx.description}</span>
      {matched && (
        <Badge variant="secondary" className="shrink-0">
          Matchad
        </Badge>
      )}
      <span className="shrink-0 text-right tabular-nums">
        {formatCurrency(tx.amount, cur)}
        {cur !== 'SEK' && (
          <span className="block text-[12px] leading-4 text-muted-foreground">
            ≈ {formatCurrency(txSekAmount(tx), 'SEK')}
          </span>
        )}
      </span>
    </span>
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

export default function BookDirectlyDialog({ open, onOpenChange, item, docUrl = null, docMime = null, onSuccess }: Props) {
  const { toast } = useToast()
  const { company } = useCompany()

  // Underlag total + currency. Booking happens in SEK, so a foreign total needs
  // an FX rate to rank/compare against the (SEK) bank transactions. That rate
  // only ranks, it is never a booking amount: the kronor of a foreign underlag
  // come from the bank row, or the person types them
  // (lib/bookkeeping/book-direct-prefill.ts).
  const targetAmount = item.extracted_data?.totals?.total ?? null
  const targetCurrency = bookDirectDocumentCurrency(item.extracted_data)

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
  const tInbox = useTranslations('inbox_workspace')
  // Full BAS catalogue (static reference data, fetched once per session). Lets
  // the account picker surface standard accounts the company hasn't activated
  // yet; picking one activates it at commit via the existing
  // ActivateAccountsDialog rail. Without it the picker only knows the active
  // chart, which reads as "the account doesn't exist".
  const [catalog, setCatalog] = useState<CatalogAccount[]>([])
  const [entryDate, setEntryDate] = useState<string>(
    item.extracted_data?.invoice?.invoiceDate || todayIsoStockholm()
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
  const [txSearch, setTxSearch] = useState('')
  // The unbooked bank rows, the underlag's SEK rate (e.g. ~9.8 for USD; null
  // for SEK, pending or unsupported) and the ranking: the one hook the
  // inbox match picker uses too. A search goes to the database, and a picked
  // row stays readable (rowById) after a search stops listing it.
  const {
    ranked: rankedCandidates,
    rowById,
    loading: isLoadingTransactions,
    error: transactionsError,
    retry: retryTransactions,
    fxRate,
  } = useUnderlagBankCandidates({ open, extractedData: item.extracted_data, search: txSearch })

  const [isSubmitting, setIsSubmitting] = useState(false)
  // Booking-time voucher warnings (VOUCHER_NEEDS_CONFIRMATION): "Bokför
  // ändå" resends with the codes the dialog showed.
  const [voucherWarnings, setVoucherWarnings] = useState<VoucherWarning[] | null>(null)
  const acknowledgedWarningsRef = useRef<string[] | null>(null)

  // "Spara som mall": derive amount-parameterised template lines from the
  // current konteringsrader so the user can save the pattern they just worked
  // out. Labels come from the loaded BAS chart; the user reviews/edits in the
  // shared TemplateForm before saving.
  const [showSaveTemplate, setShowSaveTemplate] = useState(false)

  // Stil v3 anatomy: the bank row picker is a popover anchored under the
  // payment line; the template actions and the note sit behind "Fler
  // alternativ" (open on arrival when the note is prefilled, so the person
  // reads what lands on the verifikat); a failed submit is said in the
  // footer, not only in the toast.
  const tCommon = useTranslations('common')
  const [bankPickerOpen, setBankPickerOpen] = useState(false)
  const bankTriggerRef = useRef<HTMLButtonElement>(null)
  const bankPanelRef = useRef<HTMLDivElement>(null)
  const bankSearchRef = useRef<HTMLInputElement>(null)
  const [moreOpen, setMoreOpen] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)

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
    setEntryDate(item.extracted_data?.invoice?.invoiceDate || todayIsoStockholm())
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
    const prefilledNotes = renderChannelContextNotes(item.channel_context, { includeCaption: true }) ?? ''
    setNotes(prefilledNotes)
    setMoreOpen(prefilledNotes.trim().length > 0)
    setBankPickerOpen(false)
    setSubmitError(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, item.id])

  // The bank row picker closes on a press outside it (its trigger toggles it)
  // and takes focus into its search field when it opens. Escape is handled by
  // the dialog's onEscapeKeyDown below, so it closes the picker, not the dialog.
  useEffect(() => {
    if (!bankPickerOpen) return
    bankSearchRef.current?.focus()
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target
      if (!(target instanceof Node)) return
      if (bankPanelRef.current?.contains(target) || bankTriggerRef.current?.contains(target)) return
      setBankPickerOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [bankPickerOpen])

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
        // P&L cost on debit (4xxx-8xxx), settlement on credit (a bank, or a
        // company card's liability account): keeps private and balance-sheet
        // templates (2013, 1630, 12xx) out of a cost field.
        if (!debit || !/^[4-8]/.test(debit) || !credit || !(credit.startsWith('19') || isCardLedgerAccount(credit))) return
        setLines((current) => applyCostAccountSuggestion(current, debit))
        setAccountSuggestion({ account: debit, counterparty: match.template.counterparty_name })
      } catch {
        // Prefill is best-effort; the field simply stays blank.
      }
    })()
    return () => { cancelled = true }
  }, [open, item.id, item.extracted_data?.supplier?.name])

  // SEK-equivalent of the underlag total: the estimate shown before a bank row is picked.
  const targetSek = useMemo(() => {
    if (targetAmount == null) return null
    if (targetCurrency === 'SEK') return targetAmount
    if (fxRate != null) return sekOfForeign(targetAmount, fxRate)
    return null
  }, [targetAmount, targetCurrency, fxRate])

  // The picked bank row, once a list has loaded it.
  const selectedTransaction = useMemo(
    () => (selectedTransactionId ? rowById.get(selectedTransactionId) ?? null : null),
    [selectedTransactionId, rowById],
  )

  // When the user picks a transaction (or the toggle changes), re-derive
  // the prefilled amounts so foreign-currency invoices follow the SEK
  // figure on the actual bank movement. Normalised to SEK: a foreign bank
  // row is booked at its SEK value, never its face amount. A foreign row
  // with neither a stored SEK value nor a rate has no kronor amount at all
  // (null): the lenient resolveSekAmount would hand back its face amount,
  // which is the 100 EUR booked as 100 kr this dialog must not prefill.
  const selectedTransactionAmount = useMemo(
    () => (selectedTransaction ? bankRowSekAmount(selectedTransaction) : null),
    [selectedTransaction],
  )
  // What the prefill is told. A row that is picked but has no kronor amount
  // is the prefill's "chosen, but unusable" (NaN): the legs stay unresolved
  // and do not fall back to the document total.
  const prefillTransactionAmount =
    selectedTransaction && selectedTransactionAmount === null ? Number.NaN : selectedTransactionAmount

  // What the route would refuse for a foreign-currency underlag: its own
  // rule, so nothing is offered here that the server refuses. Two things
  // block, a picked bank row without a kronor amount and a row that carries
  // the document's foreign total as kronor. Typing kronor without a bank row
  // does not: that is how a receipt somebody paid privately is booked. A
  // picked row the list has not loaded is unknown here and left to the server.
  const fxRefusal = useMemo(
    () => (selectedTransactionId && !selectedTransaction
      ? null
      : bookDirectFxRefusal(item.extracted_data, selectedTransaction, lines.map(toBookDirectPayloadLine))),
    [item.extracted_data, selectedTransactionId, selectedTransaction, lines],
  )

  // The settlement currency to resolve against:
  // - When a transaction is selected, use that transaction's currency.
  // - Otherwise, use the document's currency (falls back to SEK).
  const settlementCurrency = useMemo(() => {
    if (selectedTransaction) return (selectedTransaction.currency ?? 'SEK').toUpperCase()
    return targetCurrency
  }, [selectedTransaction, targetCurrency])

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
      prefillTransactionAmount,
      bankAccount ?? '1930',
      { vatRegistered, suppressedRoles: suppressedRolesRef.current },
    )
    setLines((current) => reconcileBookDirectLines(current, next))
  }, [open, item, prefillTransactionAmount, bankAccount, vatRegistered])

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

  const filteredTransactions = useMemo(() => rankedCandidates.map((c) => c.row), [rankedCandidates])

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
    const { totalDebit, totalCredit, balanced, difference } = lineBalance(lines)
    return { debit: totalDebit, credit: totalCredit, balanced, diff: difference }
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
          ? { debit_amount: formatAmountInput(fill, '.'), credit_amount: '' }
          : { credit_amount: formatAmountInput(fill, '.'), debit_amount: '' }
      )
    },
    [computeBalancingDiff, updateLine]
  )

  // Replace the line set with a booking template's computed rows. The picker
  // hands back JournalEntryForm-shaped lines; we keep only what book-direct
  // posts: account, amounts and the dimensions the template set on a line. A
  // meaningful supplier description is preserved: the template name only
  // fills an empty field.
  const handleTemplateApply = useCallback(
    (
      templateLines: Array<{
        account_number: string
        debit_amount: string
        credit_amount: string
        dimensions?: Record<string, string>
      }>,
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
    // First: both are what the route refuses for a foreign underlag, and a
    // foreign figure in the kronor columns matters more than a missing field.
    if (fxRefusal === 'bank_row_without_sek') return tInbox('book_direct_fx_transaction_no_sek')
    if (fxRefusal === 'face_amount') return tInbox('book_direct_fx_face_amount', { currency: targetCurrency })
    if (!entryDate) return 'Välj datum'
    if (!periodId) return 'Datumet matchar ingen öppen räkenskapsperiod'
    if (derivedPeriodBlocked) return 'Räkenskapsperioden är låst eller stängd'
    if (description.trim().length === 0) return 'Fyll i beskrivning'
    if (lines.some((l) => l.account_number.trim().length === 0)) return 'Alla rader behöver ett konto'
    if (!totals.balanced) return 'Debet och kredit måste vara lika'
    return null
  }, [isSubmitting, fxRefusal, tInbox, targetCurrency, entryDate, periodId, derivedPeriodBlocked, description, lines, totals.balanced])

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
      ...(acknowledgedWarningsRef.current ? { acknowledged_warnings: acknowledgedWarningsRef.current } : {}),
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
    setSubmitError(null)
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
        const anyErr = err as { body?: { error?: { code?: string; details?: { warnings?: VoucherWarning[] } } }; status?: number }
        const warnings = anyErr.body?.error?.details?.warnings
        if (anyErr.body?.error?.code === 'VOUCHER_NEEDS_CONFIRMATION' && Array.isArray(warnings)) {
          setVoucherWarnings(warnings)
          return
        }
        const message = getErrorMessage(anyErr.body ?? err, {
          context: 'journal_entry',
          statusCode: anyErr.status,
        })
        setSubmitError(message)
        toast({
          title: 'Kunde inte bokföra',
          description: message,
          variant: 'destructive',
        })
      }
    } finally {
      setIsSubmitting(false)
    }
  }, [canSubmit, runSubmit, toast, onSuccess, onOpenChange])

  // Resend past the warnings the person just read; the server checks again.
  const handleConfirmWarnings = useCallback(async () => {
    const warnings = voucherWarnings
    if (!warnings) return
    acknowledgedWarningsRef.current = warnings.map((w) => w.code)
    setVoucherWarnings(null)
    try {
      await handleSubmit()
    } finally {
      acknowledgedWarningsRef.current = null
    }
  }, [voucherWarnings, handleSubmit])

  // The header's context line: the underlag as the inbox names it
  // (supplier · kind · total), the object this dialog books.
  const documentKind = item.extracted_data?.documentKind
  const contextLine = [
    item.extracted_data?.supplier?.name?.trim() || null,
    documentKind ? tInbox(`doc_kind_${documentKind}`) : null,
    targetAmount != null ? formatCurrency(targetAmount, targetCurrency) : null,
  ]
    .filter(Boolean)
    .join(' · ')

  // Account names beside the numbers: the active chart first, the BAS
  // catalogue for an account that activates at commit.
  const catalogNameMap = useMemo(
    () => Object.fromEntries(catalog.map((a) => [a.account_number, a.account_name])),
    [catalog],
  )
  const accountLabel = (accountNumber: string): string | null =>
    accountNameMap[accountNumber] ?? catalogNameMap[accountNumber] ?? null

  // The date field reads as invalid while it lands in no open period.
  const periodProblem = !entryDate || (periods.length > 0 && (!periodId || derivedPeriodBlocked))

  // The footer's left side: what is still missing, a refused submit, or what
  // Bokför will do.
  // What is still missing reads quietly (it is why Bokför waits, not an
  // error); only a submit that failed is red.
  const footerProblem = disabledReason ?? submitError
  const footerFailed = !disabledReason && Boolean(submitError)
  const consequence = selectedTransactionId
    ? tInbox('book_direct_consequence_bank')
    : tInbox('book_direct_consequence')

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="document"
        onEscapeKeyDown={(event) => {
          // Escape closes the open bank row picker first, then the dialog.
          if (bankPickerOpen) {
            event.preventDefault()
            setBankPickerOpen(false)
            bankTriggerRef.current?.focus()
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Bokför direkt</DialogTitle>
          <DialogDescription data-ph-mask="" className="tabular-nums">
            {contextLine}
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,560px)]">
          {/* Document column: sticky on desktop so the underlag stays visible
              while the form scrolls; stacks above the form on smaller screens,
              at 35vh: a multi-page PDF scrolls inside it, and a taller box
              took most swipes on a phone before the form. */}
          <div className="h-[35vh] lg:sticky lg:top-0 lg:h-[72vh] lg:self-start">
            <DocumentViewerPane
              documentId={item.document_id}
              mime={docMime}
              downloadUrl={docUrl}
              className="h-full"
            />
          </div>

          {/* Booking form: sections 20px apart, no boxes. */}
          <div className="min-w-0 space-y-5">
            <div className="space-y-1.5">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-[140px_minmax(0,1fr)]">
                <div className="space-y-1">
                  <Label htmlFor="bd-date">Datum</Label>
                  <Input
                    id="bd-date"
                    type="date"
                    value={entryDate}
                    onChange={(e) => setEntryDate(e.target.value)}
                    disabled={isSubmitting}
                    aria-invalid={periodProblem || undefined}
                    aria-describedby="bd-period"
                    className="date-figures tabular-nums"
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="bd-description">Beskrivning</Label>
                  <Input
                    id="bd-description"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    disabled={isSubmitting}
                    aria-invalid={description.trim().length === 0 || undefined}
                    placeholder="Leverantör · fakturanummer"
                  />
                </div>
              </div>
              {/* The fiscal period, derived from the date (periods never
                  overlap): text, not a picker, so it can never disagree with
                  the date. Red when the date cannot be booked. */}
              <div id="bd-period" aria-live="polite">
                {periods.length === 0 ? (
                  <p className={HELP_CLASS}>Hämtar perioder …</p>
                ) : derivedPeriod ? (
                  <p className={cn(HELP_CLASS, 'tabular-nums', derivedPeriodBlocked && 'text-destructive')}>
                    Räkenskapsperiod {derivedPeriod.period_start}: {derivedPeriod.period_end}
                    {(derivedPeriod.locked_at || derivedPeriod.is_closed) && (
                      <>
                        {' '}({derivedPeriod.locked_at ? 'låst' : 'stängd'})
                      </>
                    )}
                  </p>
                ) : (
                  <p className={cn(HELP_CLASS, 'text-destructive')}>
                    Datumet ligger utanför öppna räkenskapsperioder. Ändra datumet eller skapa perioden under Bokföring.
                  </p>
                )}
              </div>
            </div>

            {/* Payment: the bank row this underlag settles (optional). One
                line with the picked row; the picker is a popover under it. */}
            <section className="space-y-1.5">
              <div className={SECTION_LABEL_CLASS}>Koppla till banktransaktion (valfritt)</div>
              <div className="relative">
                <div className="flex min-h-10 items-center gap-3 border-b-hairline py-1">
                  <div className="flex min-w-0 flex-1 items-center">
                    {selectedTransaction ? (
                      <BankRowText
                        tx={selectedTransaction}
                        matched={item.matched_transaction_id === selectedTransaction.id}
                      />
                    ) : selectedTransactionId && isLoadingTransactions ? (
                      <Skeleton className="h-4 w-48" />
                    ) : (
                      <span className="text-[13px] text-muted-foreground">
                        {selectedTransactionId
                          ? tInbox('book_direct_bank_row_selected')
                          : tInbox('book_direct_no_bank_row')}
                      </span>
                    )}
                  </div>
                  <Button
                    ref={bankTriggerRef}
                    type="button"
                    variant="ghost"
                    aria-haspopup="dialog"
                    aria-expanded={bankPickerOpen}
                    aria-controls={bankPickerOpen ? 'bd-bank-picker' : undefined}
                    onClick={() => setBankPickerOpen((wasOpen) => !wasOpen)}
                    disabled={isSubmitting}
                    className="-mr-2.5 shrink-0"
                  >
                    {selectedTransactionId ? tInbox('book_direct_bank_change') : tInbox('book_direct_bank_pick')}
                    <ChevronDownIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  </Button>
                </div>

                {bankPickerOpen && (
                  <div
                    ref={bankPanelRef}
                    id="bd-bank-picker"
                    role="dialog"
                    aria-label="Koppla till banktransaktion (valfritt)"
                    className={cn(
                      'absolute right-0 top-full z-20 mt-1 flex w-full max-w-[440px] flex-col p-1',
                      POPOVER_SURFACE_CLASS,
                      POPOVER_ENTER_CLASS,
                    )}
                  >
                    <div className="relative p-1">
                      <MagnifyingGlassIcon className="pointer-events-none absolute left-3.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        ref={bankSearchRef}
                        placeholder="Sök på beskrivning…"
                        value={txSearch}
                        onChange={(e) => setTxSearch(e.target.value)}
                        className="pl-8"
                        disabled={isSubmitting}
                      />
                    </div>
                    <div className="max-h-64 overflow-y-auto">
                      {isLoadingTransactions ? (
                        <LateReveal className="space-y-2 px-2 py-2" aria-label="Laddar…">
                          {[0, 1, 2, 3].map((i) => (
                            <Skeleton key={i} className="h-7 w-full" />
                          ))}
                        </LateReveal>
                      ) : transactionsError ? (
                        // The rows could not load: said in place of them, not as "none".
                        <LoadError className="px-2" title="Kunde inte hämta transaktioner" description={transactionsError} onRetry={retryTransactions} />
                      ) : filteredTransactions.length === 0 ? (
                        <p className="px-2.5 py-2 text-[13px] text-muted-foreground">
                          Inga okategoriserade transaktioner.
                        </p>
                      ) : (
                        <ul role="listbox" aria-label="Koppla till banktransaktion (valfritt)">
                          {displayedTransactions.slice(0, 30).map((tx) => {
                            const isSelected = selectedTransactionId === tx.id
                            return (
                              <li key={tx.id} role="none">
                                <button
                                  type="button"
                                  role="option"
                                  aria-selected={isSelected}
                                  className="flex min-h-7.5 w-full items-center gap-2 rounded-md px-2.5 py-1 text-left transition-colors duration-150 hover:bg-secondary/60 focus-visible:bg-secondary/60 focus-visible:outline-none disabled:opacity-40"
                                  onClick={() => {
                                    setSelectedTransactionId(isSelected ? null : tx.id)
                                    setBankPickerOpen(false)
                                  }}
                                  disabled={isSubmitting}
                                >
                                  <span className="flex w-4 shrink-0 justify-center">
                                    {isSelected ? <CheckIcon className="h-3.5 w-3.5" /> : null}
                                  </span>
                                  <BankRowText tx={tx} matched={item.matched_transaction_id === tx.id} />
                                </button>
                              </li>
                            )
                          })}
                        </ul>
                      )}
                    </div>
                    {selectedTransactionId && (
                      <>
                        <div className={MENU_SEPARATOR_CLASS} />
                        <button
                          type="button"
                          className="flex min-h-7.5 w-full items-center gap-2 rounded-md px-2.5 text-left text-[13px] transition-colors duration-150 hover:bg-secondary/60 focus-visible:bg-secondary/60 focus-visible:outline-none"
                          onClick={() => {
                            setSelectedTransactionId(null)
                            setBankPickerOpen(false)
                          }}
                          disabled={isSubmitting}
                        >
                          <span className="w-4 shrink-0" aria-hidden="true" />
                          Rensa val
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              {!selectedTransactionId && (
                <p className={HELP_CLASS}>
                  Välj en transaktion om dokumentet motsvarar en redan-bokad
                  bankhändelse: den bokas då samtidigt. Lämna tom för en
                  fristående verifikation.
                </p>
              )}
            </section>

            {/* Journal entry lines: Konto | Debet | Kredit with a Summa row. */}
            <section className="space-y-2">
              <div className="flex items-baseline justify-between gap-3">
                <h3 className={SECTION_LABEL_CLASS}>Konteringsrader</h3>
                <div className="text-right text-[12px] leading-4 text-muted-foreground">
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
              {/* A hint, not a stop: without a bank row the kronor are typed. */}
              {targetCurrency !== 'SEK' && !selectedTransactionId && (
                <AttnLine>{tInbox('book_direct_fx_hint', { currency: targetCurrency })}</AttnLine>
              )}
              {fxRefusal === 'bank_row_without_sek' && (
                <AttnLine>{tInbox('book_direct_fx_bank_row_without_sek', { currency: targetCurrency })}</AttnLine>
              )}
              {targetCurrency !== 'SEK' && selectedTransactionAmount != null && (
                <p className={HELP_CLASS}>
                  Underlaget är i {targetCurrency}. Bokföringen sker i SEK enligt
                  transaktionens belopp. Momsraden har lämnats bort: vid behov
                  lägg till en rad för omvänd skattskyldighet manuellt.
                </p>
              )}
              {accountSuggestion && lines.some((l) => l.role === 'cost' && l.account_number === accountSuggestion.account) && (
                <p className={HELP_CLASS}>
                  Konto {accountSuggestion.account} föreslaget från tidigare bokföringar av{' '}
                  {formatCounterpartyName(accountSuggestion.counterparty)}
                </p>
              )}
              {/* Below sm (a phone) the columns narrow and the account's name
                  hides beside its number, so a line is about 310px and fits
                  the dialog. overflow-x-auto stays for the one case that is
                  still wider: the dimensions toggle on every line. */}
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px]">
                  <thead>
                    <tr>
                      <th className={cn(VTH_CLASS, 'pr-3')}>Konto</th>
                      <th className={cn(VTH_CLASS, 'w-[88px] pr-2 text-right sm:w-[112px]')}>Debet</th>
                      <th className={cn(VTH_CLASS, 'w-[88px] pr-2 text-right sm:w-[112px]')}>Kredit</th>
                      <th className={cn(VTH_CLASS, 'w-8 pr-0')}>
                        <span className="sr-only">{tJournal('remove_line')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.flatMap((line, idx) => [
                      <tr key={`line-${idx}`}>
                        <td className={cn(LINE_TD_CLASS, 'pr-3')}>
                          {/* The account, its name, and the line's tag toggle:
                              a bag describes the account's line. */}
                          <div className="flex items-center gap-2">
                            <div className="w-[80px] shrink-0 sm:w-[120px]">
                              <AccountCombobox
                                value={line.account_number}
                                accounts={accounts}
                                catalog={catalog}
                                onChange={(v) => updateLine(idx, { account_number: v })}
                                className="h-7"
                              />
                            </div>
                            <span className="hidden min-w-0 flex-1 truncate text-muted-foreground sm:block">
                              {accountLabel(line.account_number)}
                            </span>
                            {dimensionsEnabled && (
                              <Button
                                type="button"
                                variant="ghost"
                                size="icon"
                                onClick={() => toggleLineDimensions(idx)}
                                disabled={isSubmitting}
                                aria-label={tJournal('row_dimensions_aria')}
                                aria-expanded={line.dimensions != null}
                                title={tJournal('row_dimensions_aria')}
                                className={cn('shrink-0', line.dimensions != null ? 'text-foreground' : 'text-muted-foreground')}
                              >
                                <HashtagIcon className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </div>
                        </td>
                        <td className={LINE_TD_CLASS}>
                          <Input
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            value={line.debit_amount}
                            onChange={(e) => updateLine(idx, { debit_amount: e.target.value, credit_amount: e.target.value ? '' : line.credit_amount })}
                            onDoubleClick={() => handleFillBalance(idx, 'debit')}
                            disabled={isSubmitting}
                            className="h-7 text-right tabular-nums"
                            placeholder="0,00"
                          />
                        </td>
                        <td className={LINE_TD_CLASS}>
                          <Input
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            value={line.credit_amount}
                            onChange={(e) => updateLine(idx, { credit_amount: e.target.value, debit_amount: e.target.value ? '' : line.debit_amount })}
                            onDoubleClick={() => handleFillBalance(idx, 'credit')}
                            disabled={isSubmitting}
                            className="h-7 text-right tabular-nums"
                            placeholder="0,00"
                          />
                        </td>
                        <td className={cn(LINE_TD_CLASS, 'pr-0 text-right')}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground"
                            onClick={() => removeLine(idx)}
                            disabled={isSubmitting || lines.length <= 2}
                            aria-label={tJournal('remove_line')}
                          >
                            <XMarkIcon className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>,
                      // The line's kostnadsställe/projekt, posted with the line.
                      ...(dimensionsEnabled && line.dimensions != null
                        ? [
                            <tr key={`dims-${idx}`}>
                              <td colSpan={4} className="border-b-hairline py-2 pr-0">
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
                  <tfoot>
                    <tr>
                      {/* Where the user reconciles the sums: whether it
                          balances, or what is still missing to balance. */}
                      <td className={cn(TOTAL_TD_CLASS, 'pr-3')}>
                        {totals.balanced ? (
                          <span className="font-normal text-muted-foreground">{tInbox('book_direct_balanced')}</span>
                        ) : totals.diff !== 0 ? (
                          <span className="text-destructive">
                            {tInbox('book_direct_off_by', { amount: formatAmount(Math.abs(totals.diff)) })}
                          </span>
                        ) : (
                          <span className="font-normal text-muted-foreground">{tJournal('sum')}</span>
                        )}
                      </td>
                      <td className={cn(TOTAL_TD_CLASS, 'pr-2 text-right')}>{formatAmount(totals.debit)}</td>
                      <td className={cn(TOTAL_TD_CLASS, 'pr-2 text-right')}>{formatAmount(totals.credit)}</td>
                      <td className={cn(TOTAL_TD_CLASS, 'pr-0')} />
                    </tr>
                  </tfoot>
                </table>
              </div>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <Button
                  type="button"
                  variant="ghost"
                  onClick={addLine}
                  disabled={isSubmitting}
                  className="-ml-2.5"
                >
                  <PlusIcon className="h-3.5 w-3.5" />
                  {tJournal('add_line')}
                </Button>
                {totals.diff !== 0 && (
                  <span className={HELP_CLASS}>
                    Dubbelklicka i ett tomt beloppsfält för att fylla i differensen
                  </span>
                )}
              </div>
            </section>

            {/* Fler alternativ: a booking template (apply one, or save this
                kontering as one) and the internal note. */}
            <section className="space-y-3">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setMoreOpen((wasOpen) => !wasOpen)}
                aria-expanded={moreOpen}
                aria-controls="bd-more"
                className="-ml-2.5"
              >
                {tCommon('more_options')}
                <ChevronDownIcon
                  className={cn('h-3.5 w-3.5 text-muted-foreground transition-transform duration-150', moreOpen && 'rotate-180')}
                />
              </Button>
              {moreOpen && (
                <div id="bd-more" className="space-y-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <TemplateApplyButton
                      onApply={handleTemplateApply}
                      entityType={company?.entity_type}
                      disabled={isSubmitting}
                      // A foreign underlag has no amount to offer before a bank
                      // row is picked: targetSek is then a Riksbank estimate for
                      // ranking, not what the bank drew.
                      defaultAmount={
                        selectedTransactionAmount != null
                          ? Math.abs(selectedTransactionAmount)
                          : targetCurrency === 'SEK'
                            ? targetSek ?? undefined
                            : undefined
                      }
                    />
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setShowSaveTemplate(true)}
                      disabled={isSubmitting || derivedTemplateLines.length < 2}
                      title={
                        derivedTemplateLines.length < 2
                          ? 'Fyll i minst två konteringsrader med konto och belopp'
                          : undefined
                      }
                    >
                      <BookmarkIcon className="h-3.5 w-3.5" />
                      Spara som mall
                    </Button>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor="bd-notes">Anteckningar (valfritt)</Label>
                    <Textarea
                      id="bd-notes"
                      value={notes}
                      onChange={(e) => setNotes(e.target.value)}
                      disabled={isSubmitting}
                      rows={2}
                      placeholder="Intern kommentar om verifikationen"
                    />
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>

        <DialogFooter>
          <DialogConsequence aria-live="polite" className={cn('tabular-nums', footerFailed && 'text-destructive')}>
            {footerProblem ?? consequence}
          </DialogConsequence>
          <Button
            type="button"
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={isSubmitting}
          >
            {tCommon('cancel')}
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
        </DialogFooter>
      </DialogContent>
      <ActivateAccountsDialog
        open={activationDialog.open}
        accountNumbers={activationDialog.accountNumbers}
        onConfirm={confirmActivation}
        onCancel={cancelActivation}
      />

      <VoucherWarningsDialog
        warnings={voucherWarnings}
        processing={isSubmitting}
        onCancel={() => setVoucherWarnings(null)}
        onConfirm={handleConfirmWarnings}
      />

      {/* Save the current kontering as a reusable template. Amounts are stored
          as ratios of the total, so the user picks a fresh amount when applying
          the mall later. The shared TemplateForm re-seeds from the derived lines
          each time the dialog opens (Radix unmounts its content when closed). */}
      <Dialog open={showSaveTemplate} onOpenChange={setShowSaveTemplate}>
        <DialogContent size="form">
          <DialogHeader>
            <DialogTitle>{tJournal('save_template_dialog_title')}</DialogTitle>
            <DialogDescription>{tJournal('save_template_dialog_description')}</DialogDescription>
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
