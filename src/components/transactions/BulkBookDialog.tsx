'use client'

import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { useEffect, useMemo, useState } from 'react'
import { useBookingTemplates, useCashAccounts, useCompanySettings } from '@/lib/reference-data/hooks'
import { useTranslations } from 'next-intl'
import { resolveAccount } from '@/lib/cash-accounts/resolve-account'
import { bankNetAccountTest } from '@/lib/bookkeeping/bank-leg'
import type { CashAccount } from '@/types'
import {
  Dialog,
  DialogConsequence,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { VoucherLinesTable } from '@/components/bookkeeping/VoucherLinesTable'
import { voucherLineViews } from '@/lib/bookkeeping/voucher-line-view'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { LateReveal, Skeleton } from '@/components/ui/skeleton'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { StatusGlyph } from '@/components/ui/status-glyph'
import { TOTAL_TD_CLASS, VTD_CLASS, VTH_CLASS } from '@/components/ui/dry-table'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { applyTemplate } from '@/lib/bookkeeping/template-library'
import { formatAmount, formatCurrency, formatDate, cn } from '@/lib/utils'
import LineDimensionFields from '@/components/dimensions/LineDimensionFields'
import DuplicateBookingDialog from '@/components/transactions/DuplicateBookingDialog'
import { PlusIcon, XMarkIcon } from '@/components/icons'
import type { BookingTemplateLibraryLine } from '@/types'
import type { BookedDuplicateCandidate } from '@/lib/transactions/booking-duplicate-detection'
import type { TransactionWithInvoice } from './transaction-types'
import { parseAmountInput, formatAmountInput, roundOre } from '@/lib/money'
import { lineBalance } from '@/lib/bookkeeping/line-balance'

interface BulkBookDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  transactions: TransactionWithInvoice[]
  onSuccess: () => void
}

type Mode = 'one_line_per_tx' | 'sum_per_account'
type Tab = 'template' | 'manual'

/** A section label (Stil v3): 12px/500 in sentence case, the same look as a field label. */
const SECTION_LABEL_CLASS = 'text-[12px] font-medium leading-4 text-foreground/80'
/** A help or status line under a section: 12px, muted unless it reports a problem. */
const HELP_CLASS = 'text-[12px] leading-4 text-muted-foreground'
/** A cell of the manual line editor: a 44px row holding a 32px field, over a hairline. */
const MANUAL_TD_CLASS = 'h-11 border-b-hairline py-1.5 pr-2 align-middle'

/**
 * A choice chip (Stil v3 dialog anatomy): a 28px 6px rectangle on a hairline
 * at rest, on the wash while chosen. aria-pressed carries the state.
 */
const CHOICE_CHIP_CLASS =
  'inline-flex h-7 items-center whitespace-nowrap rounded-md px-2.5 text-[13px] font-medium transition-[background-color,box-shadow,color,transform] duration-150 active:scale-[0.97] active:duration-100 motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/70 focus-visible:ring-offset-1'
const CHOICE_CHIP_REST_CLASS =
  'text-muted-foreground shadow-[inset_0_0_0_0.5px_hsl(var(--line-strong))] hover:bg-secondary/60 hover:text-foreground'
const CHOICE_CHIP_PRESSED_CLASS = 'bg-secondary text-strong'

interface PreviewLine {
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description: string | undefined
}

interface ManualLine {
  id: string
  account_number: string
  debit_amount: string  // form-state strings; parsed on send
  credit_amount: string
  line_description: string
}

function parseAmount(s: string): number {
  return parseAmountInput(s) ?? 0
}

function newManualLineId(): string {
  return `ml-${Math.random().toString(36).slice(2, 10)}`
}

export default function BulkBookDialog({
  open,
  onOpenChange,
  transactions,
  onSuccess,
}: BulkBookDialogProps) {
  const { toast } = useToast()
  const t = useTranslations('tx_bulk_book')
  const tVoucher = useTranslations('voucher_lines')

  const [tab, setTab] = useState<Tab>('template')
  // Session-cached and scoped to the active company (system + company + its
  // team) by /api/settings/booking-templates. A bare browser read of
  // booking_template_library leaned on RLS, which is membership-wide, and so
  // listed every company's templates for a user in several companies.
  // Templates the company hid are left out, as in the other pickers.
  const { templates: allTemplates, isLoading: loadingTemplates } = useBookingTemplates()
  const templates = useMemo(() => allTemplates.filter((tpl) => !tpl.is_hidden), [allTemplates])
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null)
  // null = fetch pending; array = loaded (may be empty on error: falls back to '1930')
  // Session-cached (lib/reference-data); null only while the list is still
  // loading, which the pre-fill below reads as "not resolved yet".
  const { cashAccounts: cachedCashAccounts, isLoading: cashAccountsLoading } = useCashAccounts()
  const cashAccounts: CashAccount[] | null = cashAccountsLoading ? null : cachedCashAccounts
  const { settings: companySettings } = useCompanySettings()
  const [mode, setMode] = useState<Mode>('one_line_per_tx')
  const [description, setDescription] = useState('')
  const [manualLines, setManualLines] = useState<ManualLine[]>([])
  const [submitting, setSubmitting] = useState(false)
  // A refused or failed submit, said in the footer's consequence spot (the
  // toast still fires): the dialog stays open with the person's choices.
  const [submitError, setSubmitError] = useState<string | null>(null)
  // Booking-time duplicate guard fired for one of the selected txs
  // (TRANSACTION_BOOK_POSSIBLE_DUPLICATE): surface the candidate for review
  // with "Bokför ändå" (re-runs the whole batch with force=true) instead of
  // dead-ending in a toast. Match/ignore are not offered here: resolving one
  // row differently belongs on the transaction list, outside the batch.
  const [duplicateCandidate, setDuplicateCandidate] = useState<BookedDuplicateCandidate | null>(null)
  // Dimension tagging (kostnadsställe/projekt): the pair renders only when
  // company_settings.dimensions_enabled, same gate as JournalEntryForm. One
  // header-level default bag applies to both tabs; the server tags the
  // generated voucher's lines with it.
  const dimensionsEnabled = companySettings?.dimensions_enabled === true
  const [defaultDims, setDefaultDims] = useState<Record<string, string>>({})

  // Documents that will inherit onto the new verifikat. Computed from
  // transactions.document_id; the RPC reads these and updates each doc's
  // journal_entry_id atomically with the verifikat commit.
  const docCount = useMemo(
    () => transactions.filter((tx) => tx.document_id).length,
    [transactions],
  )

  const txCount = transactions.length
  const sharedDate = transactions[0]?.date
  const sharedCurrency = transactions[0]?.currency ?? 'SEK'
  const direction: 'income' | 'expense' = useMemo(() => {
    if (transactions.length === 0) return 'income'
    return transactions[0]!.amount > 0 ? 'income' : 'expense'
  }, [transactions])
  const txSumAbs = useMemo(
    () => roundOre(transactions.reduce((s, tx) => s + Math.abs(tx.amount), 0)),
    [transactions],
  )

  // Currency homogeneity. A samlingsverifikation must be expressed in one
  // redovisningsvaluta (BFL 4 kap 6 §), so `txSumAbs` above is only a
  // meaningful number while every selected tx shares a currency: across
  // currencies it would add 100 EUR to 100 SEK as if they were one unit.
  // We therefore split the selection per currency and, when it spans more
  // than one, never render the combined scalar and never let confirm fire.
  // NULL currency is legacy for the column default 'SEK'.
  const currencyTotals = useMemo(() => {
    const byCurrency = new Map<string, number>()
    for (const tx of transactions) {
      const code = tx.currency ?? 'SEK'
      byCurrency.set(code, roundOre((byCurrency.get(code) ?? 0) + Math.abs(tx.amount)))
    }
    return Array.from(byCurrency.entries()).sort(([a], [b]) => a.localeCompare(b))
  }, [transactions])
  const isMixedCurrency = currencyTotals.length > 1

  const selectedTemplate = useMemo(
    () => templates.find((tpl) => tpl.id === selectedTemplateId) ?? null,
    [templates, selectedTemplateId],
  )

  // Reset state when dialog closes so the next open starts clean.
  useEffect(() => {
    if (!open) {
      setTab('template')
      setSelectedTemplateId(null)
      setMode('one_line_per_tx')
      setDescription('')
      setManualLines([])
      setDefaultDims({})
      setSubmitError(null)
    } else if (sharedDate) {
      // Pre-fill description with a sensible default the user can edit.
      setDescription(t('default_description', { date: sharedDate }))
    }
  }, [open, sharedDate, t])

  // Pre-fill the bank side from the txs (one line per tx with the resolved
  // ledger account and correct Dr/Cr direction). We intentionally do NOT
  // pre-fill a counterpart account: swedish-compliance flagged that a
  // hardcoded 3001/5800 prefill nudges users into submitting verifikat
  // without a VAT line (26xx) for momsregistrerade affärshändelser. The
  // bank side is the unambiguous part the user always wants; the
  // counterpart (and any VAT split) is the user's responsibility.
  // Gate on cashAccounts !== null so lines are only built after the account
  // fetch resolves: this prevents the form from briefly showing '1930' when
  // the resolved account differs.
  useEffect(() => {
    if (tab !== 'manual') return
    if (manualLines.length > 0) return
    if (transactions.length === 0) return
    if (cashAccounts === null) return
    const isIncome = direction === 'income'
    const bankLines: ManualLine[] = transactions.map((tx) => {
      const { account } = resolveAccount(
        cashAccounts,
        tx.cash_account_id ?? null,
        tx.currency ?? 'SEK',
      )
      return {
        id: newManualLineId(),
        account_number: account,
        debit_amount: isIncome ? formatAmountInput(Math.abs(tx.amount)) : '',
        credit_amount: isIncome ? '' : formatAmountInput(Math.abs(tx.amount)),
        line_description: (tx.description || '').slice(0, 40).trim(),
      }
    })
    // One empty counterpart row to scaffold the next entry. Account
    // left blank: user must choose, which avoids the no-VAT trap.
    const counterpart: ManualLine = {
      id: newManualLineId(),
      account_number: '',
      debit_amount: '',
      credit_amount: '',
      line_description: '',
    }
    setManualLines([...bankLines, counterpart])
  }, [tab, manualLines.length, transactions, direction, cashAccounts])

  // Live line preview: driven by either the template/mode pair (template
  // tab) or the user-edited manual lines (manual tab). Same downstream
  // invariants (balance + bank-leg match) apply to both paths.
  const previewLines = useMemo<PreviewLine[]>(() => {
    if (tab === 'manual') {
      return manualLines
        .map<PreviewLine>((ml) => ({
          account_number: ml.account_number,
          debit_amount: roundOre(parseAmount(ml.debit_amount)),
          credit_amount: roundOre(parseAmount(ml.credit_amount)),
          line_description: ml.line_description.trim() || undefined,
        }))
        .filter((l) => l.debit_amount > 0 || l.credit_amount > 0)
    }
    if (!selectedTemplate) return []
    const templateLines = (selectedTemplate.lines ?? []) as BookingTemplateLibraryLine[]
    const lines: PreviewLine[] = []
    if (mode === 'sum_per_account') {
      const applied = applyTemplate(templateLines, txSumAbs)
      for (const fl of applied) {
        const debit = parseFloat(fl.debit_amount || '0') || 0
        const credit = parseFloat(fl.credit_amount || '0') || 0
        if (debit === 0 && credit === 0) continue
        lines.push({
          account_number: fl.account_number,
          debit_amount: roundOre(debit),
          credit_amount: roundOre(credit),
          line_description: fl.line_description,
        })
      }
    } else {
      for (const tx of transactions) {
        const applied = applyTemplate(templateLines, Math.abs(tx.amount))
        for (const fl of applied) {
          const debit = parseFloat(fl.debit_amount || '0') || 0
          const credit = parseFloat(fl.credit_amount || '0') || 0
          if (debit === 0 && credit === 0) continue
          const tag = (tx.description || '').slice(0, 40).trim()
          lines.push({
            account_number: fl.account_number,
            debit_amount: roundOre(debit),
            credit_amount: roundOre(credit),
            line_description: tag
              ? `${fl.line_description ?? ''}, ${tag}`.trim()
              : fl.line_description,
          })
        }
      }
    }
    return lines
  }, [tab, manualLines, selectedTemplate, mode, transactions, txSumAbs])

  // Balance + bank-leg match are the two invariants the RPC will check; we
  // surface them here so the user knows whether confirm will succeed.
  const previewBalance = useMemo(() => lineBalance(previewLines), [previewLines])
  const previewDifference = previewBalance.difference
  const isBalanced = previewDifference === 0
  // The bank side is measured as the RPC measures it (bankNetAccountTest): on
  // the ledgers the selected rows settle on, resolved the way the bank lines
  // above are pre-filled. Counting 1900-1999 alone left a row on a cash
  // account outside 19xx (a Stripe balance on 1686) impossible to confirm.
  // Until the cash accounts have loaded every row resolves to the 1930
  // default, which is the 1900-1999 rule.
  const settlementLedgers = useMemo(
    () =>
      transactions.map(
        (tx) => resolveAccount(cashAccounts ?? [], tx.cash_account_id ?? null, tx.currency ?? 'SEK').account,
      ),
    [transactions, cashAccounts],
  )
  const isBankLine = bankNetAccountTest(settlementLedgers)
  const bankLineNet = previewLines
    .filter((l) => isBankLine(l.account_number))
    .reduce((s, l) => s + l.debit_amount - l.credit_amount, 0)
  const expectedBankNet = direction === 'income' ? txSumAbs : -txSumAbs
  const bankMatches = Math.abs(bankLineNet - expectedBankNet) < 0.005

  // The active tab gates which selector must be valid. Both paths still
  // need a non-empty description, ≥2 lines, balance, bank-leg match,
  // and (for manual mode) valid 4-digit account numbers: without this,
  // the server's Zod schema rejects a 1-3-digit entry with a 400 only
  // after submit.
  const tabReady = tab === 'template' ? selectedTemplate !== null : manualLines.length > 0
  const allAccountsValid = previewLines.every((l) => /^\d{4}$/.test(l.account_number))
  const canConfirm =
    !submitting &&
    !isMixedCurrency &&
    tabReady &&
    description.trim().length > 0 &&
    previewLines.length >= 2 &&
    isBalanced &&
    bankMatches &&
    allAccountsValid

  function setDefaultDimension(dimNo: string, code: string | null) {
    setDefaultDims((prev) => {
      const next = { ...prev }
      const trimmed = code?.trim()
      if (trimmed) next[dimNo] = trimmed
      else delete next[dimNo]
      return next
    })
  }

  // Compact display, e.g. "KS01 · P001" (dim-number order) for the preview badge.
  const dimsSummary = Object.entries(defaultDims)
    .filter(([, v]) => v)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, v]) => v)
    .join(' · ')

  function updateManualLine(id: string, patch: Partial<Omit<ManualLine, 'id'>>) {
    setManualLines((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)))
  }

  function removeManualLine(id: string) {
    setManualLines((prev) => prev.filter((l) => l.id !== id))
  }

  function addManualLine() {
    setManualLines((prev) => [
      ...prev,
      {
        id: newManualLineId(),
        account_number: '',
        debit_amount: '',
        credit_amount: '',
        line_description: '',
      },
    ])
  }

  // `opts` is only ever passed by the duplicate-dialog retry; the footer
  // button's onClick hands over a click event, which carries no `force`.
  async function handleConfirm(opts?: { force?: boolean }) {
    if (!canConfirm) return
    const force = opts?.force === true
    setSubmitting(true)
    setSubmitError(null)
    try {
      // Build the payload per the active tab. Template path uses the
      // existing schema branch (template_id + mode). Manual path sends
      // the user-edited lines directly.
      // Header-level default dimensions ride as a top-level field on both
      // branches; only sent when the user actually picked something.
      const defaultDimensions =
        dimensionsEnabled && Object.keys(defaultDims).length > 0
          ? { default_dimensions: defaultDims }
          : {}
      const payload =
        tab === 'manual'
          ? {
              tx_ids: transactions.map((tx) => tx.id),
              entry_description: description.trim(),
              manual_lines: previewLines.map((l) => ({
                account_number: l.account_number,
                debit_amount: l.debit_amount,
                credit_amount: l.credit_amount,
                currency: sharedCurrency,
                line_description: l.line_description ?? undefined,
              })),
              ...defaultDimensions,
              ...(force ? { force: true } : {}),
            }
          : {
              tx_ids: transactions.map((tx) => tx.id),
              template_id: selectedTemplateId,
              mode,
              entry_description: description.trim(),
              ...defaultDimensions,
              ...(force ? { force: true } : {}),
            }
      const response = await fetch('/api/transactions/bulk-book', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!response.ok) {
        const body = await response.json().catch(() => null)
        const candidate = body?.error?.details?.candidate as BookedDuplicateCandidate | undefined
        if (body?.error?.code === 'TRANSACTION_BOOK_POSSIBLE_DUPLICATE' && candidate) {
          // One of the selected txs already looks booked: open the review
          // dialog instead of a dead-end toast. "Bokför ändå" re-runs the
          // batch with force=true.
          setDuplicateCandidate(candidate)
          return
        }
        const message = getErrorMessage(body, { statusCode: response.status })
        setSubmitError(message)
        toast({
          title: t('error_title'),
          description: message,
          variant: 'destructive',
        })
        return
      }
      const body = (await response.json()) as {
        data: { voucher_series: string | null; voucher_number: number | null }
      }
      const voucherLabel =
        body.data.voucher_series && body.data.voucher_number != null
          ? formatVoucher(body.data)
          : t('unknown_voucher')
      toast({
        title: t('success_title'),
        description: t('success_description', { count: txCount, voucher: voucherLabel }),
        variant: 'success',
      })
      onSuccess()
      onOpenChange(false)
    } catch (err) {
      const message = getErrorMessage(err)
      setSubmitError(message)
      toast({
        title: t('error_title'),
        description: message,
        variant: 'destructive',
      })
    } finally {
      setSubmitting(false)
    }
  }

  if (transactions.length === 0) return null

  // Mixed-currency dead end. This is deliberately NOT the advisory-guard
  // pattern with a "book anyway" escape: a verifikat spanning two
  // redovisningsvalutor is not representable at all, so there is no correct
  // outcome to bypass to. We show the honest per-currency subtotals instead
  // of one summed scalar, and the booking UI never renders, so the request
  // is blocked before it is built. The route and the RPC refuse the same
  // selection with BULK_BOOK_MIXED_CURRENCY.
  if (isMixedCurrency) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent size="form">
          <DialogHeader>
            <DialogTitle>
              {t('title', { count: txCount, date: sharedDate ? formatDate(sharedDate) : '' })}
            </DialogTitle>
            <DialogDescription>{t('mixed_currency_description')}</DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <section>
              <h3 className={SECTION_LABEL_CLASS}>{t('mixed_currency_totals_label')}</h3>
              <table className="mt-1 w-full border-collapse text-[13px] tabular-nums">
                <tbody>
                  {currencyTotals.map(([code, total]) => (
                    <tr key={code}>
                      <td className={cn(VTD_CLASS, 'font-mono text-[12px] text-muted-foreground')}>{code}</td>
                      <td className={cn(VTD_CLASS, 'pr-0 text-right')}>{formatCurrency(total, code)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>

            <div className="flex items-start gap-2 text-[12px] leading-4 text-destructive">
              <StatusGlyph tone="error" className="mt-px" />
              <span>{t('mixed_currency_blocked')}</span>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              {t('close')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }

  // The selection's dimension tags beside the lines' label ("KS01 · P001").
  const dimsBadge = dimensionsEnabled && dimsSummary ? (
    <Badge data-ph-mask="" variant="secondary" className="font-mono tabular-nums">
      {dimsSummary}
    </Badge>
  ) : null

  // The two invariants the RPC checks, said under the lines: muted while they
  // hold, red when confirm would be refused.
  const invariants = (
    <div className="space-y-1" aria-live="polite">
      <p className={cn(HELP_CLASS, !isBalanced && 'text-destructive')}>
        {isBalanced
          ? t('balance_ok')
          : t('balance_off', {
              delta: formatCurrency(Math.abs(previewDifference)),
            })}
      </p>
      <p className={cn(HELP_CLASS, !bankMatches && 'text-destructive')}>
        {bankMatches ? t('bank_ok') : t('bank_off')}
      </p>
    </div>
  )

  const modeOptions: { value: Mode; label: string }[] = [
    { value: 'one_line_per_tx', label: t('mode_per_tx') },
    { value: 'sum_per_account', label: t('mode_sum') },
  ]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="wide">
        <DialogHeader>
          <DialogTitle>
            {t('title', { count: txCount, date: sharedDate ? formatDate(sharedDate) : '' })}
          </DialogTitle>
          <DialogDescription>
            {direction === 'income' ? t('description_income') : t('description_expense')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5">
          {/* How the verifikat is built: Mall (a booking template) or Manuell
              (hand-built lines, the "I want to book it myself" escape hatch
              asked for after PR #606). Default template. */}
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <h3 className={SECTION_LABEL_CLASS}>{t('template_label')}</h3>
              <SegmentedControl
                value={tab}
                onChange={setTab}
                aria-label={t('template_label')}
                options={[
                  { value: 'template', label: t('tab_template') },
                  { value: 'manual', label: t('tab_manual') },
                ]}
              />
            </div>

            {tab === 'template' &&
              (loadingTemplates ? (
                <LateReveal className="space-y-1">
                  <Skeleton className="h-11 w-full" />
                  <Skeleton className="h-11 w-full" />
                </LateReveal>
              ) : templates.length === 0 ? (
                <p className="py-2 text-[13px] text-muted-foreground">{t('no_templates')}</p>
              ) : (
                <div
                  role="radiogroup"
                  aria-label={t('template_label')}
                  className="max-h-[220px] overflow-y-auto border-t-hairline"
                >
                  {templates.map((tpl) => {
                    const selected = selectedTemplateId === tpl.id
                    return (
                      <button
                        key={tpl.id}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setSelectedTemplateId(tpl.id)}
                        className={cn(
                          'flex min-h-11 w-full items-center gap-2.5 border-b-hairline px-2 py-1.5 text-left transition-colors duration-150',
                          selected ? 'bg-secondary/70' : 'hover:bg-secondary/35',
                        )}
                      >
                        <span
                          aria-hidden="true"
                          className={cn(
                            'size-3.5 shrink-0 rounded-full transition-shadow duration-150',
                            selected
                              ? 'shadow-[inset_0_0_0_4px_hsl(var(--foreground)/0.88)]'
                              : 'shadow-[inset_0_0_0_1px_hsl(var(--foreground)/0.3)]',
                          )}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-strong">{tpl.name}</span>
                          {tpl.description && (
                            <span className="block truncate text-[12px] leading-4 text-muted-foreground">
                              {tpl.description}
                            </span>
                          )}
                        </span>
                        {tpl.is_system && (
                          <Badge variant="secondary" className="shrink-0">
                            {t('system_badge')}
                          </Badge>
                        )}
                      </button>
                    )
                  })}
                </div>
              ))}
          </section>

          {/* Grouping: two choices, so chips; the hint says what the chosen one does. */}
          {tab === 'template' && selectedTemplate && (
            <section className="space-y-2">
              <h3 className={SECTION_LABEL_CLASS}>{t('mode_label')}</h3>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('mode_label')}>
                {modeOptions.map((opt) => (
                  <button
                    key={opt.value}
                    type="button"
                    aria-pressed={mode === opt.value}
                    onClick={() => setMode(opt.value)}
                    className={cn(
                      CHOICE_CHIP_CLASS,
                      mode === opt.value ? CHOICE_CHIP_PRESSED_CLASS : CHOICE_CHIP_REST_CLASS,
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
              <p className={HELP_CLASS}>
                {mode === 'one_line_per_tx' ? t('mode_per_tx_hint') : t('mode_sum_hint')}
              </p>
            </section>
          )}

          {/* Description: shared by both tabs once the user has either a
              template selected or manual lines drafted. */}
          {tabReady && (
            <div className="space-y-1">
              <Label htmlFor="bulk-description">{t('description_label')}</Label>
              <Input
                id="bulk-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                maxLength={500}
                aria-invalid={description.trim().length === 0 || undefined}
              />
            </div>
          )}

          {/* Header default dims (kostnadsställe/projekt): one bag applied to
              the whole verifikat, shared by both tabs. */}
          {dimensionsEnabled && tabReady && (
            <div className="space-y-1">
              <LineDimensionFields
                dimensions={defaultDims}
                onChange={setDefaultDimension}
                inputClassName="h-8"
              />
              <p className={HELP_CLASS}>{t('dimensions_hint')}</p>
            </div>
          )}

          {tab === 'manual' ? (
            /* Manual lines: the table is both the editor and the preview.
               Lines are pre-filled from the txs on the first switch to this
               tab (one bank line per tx plus an empty counterpart line); the
               user sets accounts, amounts and descriptions, and the balance
               and bank-leg checks under it drive the confirm button. */
            <section className="space-y-2">
              <div className="flex items-center gap-2">
                <h3 className={SECTION_LABEL_CLASS}>{t('manual_lines_label')}</h3>
                {dimsBadge}
              </div>
              {/* overflow-x-auto: the fixed columns need ~350px, so on a phone the
                  Kredit field and the remove button scroll instead of clipping. */}
              <div className="overflow-x-auto">
                <table className="w-full border-collapse text-[13px] tabular-nums">
                  <thead>
                    <tr>
                      <th className={cn(VTH_CLASS, 'w-[92px] pr-2')}>{t('col_account')}</th>
                      <th className={cn(VTH_CLASS, 'pr-2')}>{t('col_description')}</th>
                      <th className={cn(VTH_CLASS, 'w-[112px] pr-2 text-right')}>{t('col_debit')}</th>
                      <th className={cn(VTH_CLASS, 'w-[112px] pr-2 text-right')}>{t('col_credit')}</th>
                      <th className={cn(VTH_CLASS, 'w-8 pr-0')}>
                        <span className="sr-only">{t('manual_remove_line')}</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {manualLines.map((line) => (
                      <tr key={line.id}>
                        <td className={MANUAL_TD_CLASS}>
                          <Input
                            value={line.account_number}
                            onChange={(e) =>
                              updateManualLine(line.id, { account_number: e.target.value.replace(/\D/g, '').slice(0, 4) })
                            }
                            placeholder="1930"
                            aria-label={t('col_account')}
                            aria-invalid={(line.account_number.length > 0 && line.account_number.length < 4) || undefined}
                            className="font-mono"
                          />
                        </td>
                        <td className={MANUAL_TD_CLASS}>
                          <Input
                            value={line.line_description}
                            onChange={(e) =>
                              updateManualLine(line.id, { line_description: e.target.value.slice(0, 200) })
                            }
                            placeholder={t('manual_description_placeholder')}
                            aria-label={t('col_description')}
                          />
                        </td>
                        <td className={MANUAL_TD_CLASS}>
                          <Input
                            inputMode="decimal"
                            value={line.debit_amount}
                            onChange={(e) => updateManualLine(line.id, { debit_amount: e.target.value })}
                            placeholder="0,00"
                            aria-label={t('col_debit')}
                            className="text-right"
                          />
                        </td>
                        <td className={MANUAL_TD_CLASS}>
                          <Input
                            inputMode="decimal"
                            value={line.credit_amount}
                            onChange={(e) => updateManualLine(line.id, { credit_amount: e.target.value })}
                            placeholder="0,00"
                            aria-label={t('col_credit')}
                            className="text-right"
                          />
                        </td>
                        <td className={cn(MANUAL_TD_CLASS, 'pr-0 text-right')}>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="text-muted-foreground"
                            onClick={() => removeManualLine(line.id)}
                            aria-label={t('manual_remove_line')}
                          >
                            <XMarkIcon className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr>
                      <td className={cn(TOTAL_TD_CLASS, 'pr-2')} />
                      <td className={cn(TOTAL_TD_CLASS, 'pr-2 font-normal text-muted-foreground')}>
                        {tVoucher('total')}
                      </td>
                      <td className={cn(TOTAL_TD_CLASS, 'pr-2 text-right')}>{formatAmount(previewBalance.totalDebit)}</td>
                      <td className={cn(TOTAL_TD_CLASS, 'pr-2 text-right')}>{formatAmount(previewBalance.totalCredit)}</td>
                      <td className={cn(TOTAL_TD_CLASS, 'pr-0')} />
                    </tr>
                  </tfoot>
                </table>
              </div>
              <Button type="button" variant="ghost" onClick={addManualLine} className="-ml-2.5">
                <PlusIcon className="h-3.5 w-3.5" />
                {t('manual_add_line')}
              </Button>
              {previewLines.length > 0 && invariants}
            </section>
          ) : (
            tabReady &&
            previewLines.length > 0 && (
              /* Det här bokförs: the template's lines for this selection. */
              <section className="space-y-2">
                <div className="flex items-center gap-2">
                  <h3 className={SECTION_LABEL_CLASS}>{t('preview_label', { count: previewLines.length })}</h3>
                  {dimsBadge}
                </div>
                <VoucherLinesTable
                  withCurrency
                  showTotals
                  maxRows={30}
                  lines={voucherLineViews(previewLines)}
                />
                {invariants}
              </section>
            )
          )}

          {/* Document inheritance: which receipts follow the txs onto the
              combined verifikat. Zero is fine (txs without docs don't break
              anything), so it only renders when there are some. */}
          {docCount > 0 && tabReady && (
            <p className={HELP_CLASS}>{t('docs_inherit_hint', { count: docCount })}</p>
          )}
        </div>

        <DialogFooter>
          <DialogConsequence aria-live="polite" className={submitError ? 'text-destructive' : undefined}>
            {submitError ?? t('consequence', { count: txCount, amount: formatCurrency(txSumAbs, sharedCurrency) })}
          </DialogConsequence>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
            {t('cancel')}
          </Button>
          <Button onClick={() => handleConfirm()} disabled={!canConfirm} loading={submitting}>
            {t('confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>

      {/* Booking-time duplicate guard review. Rendered inside the bulk dialog
          so cancelling it returns to the batch as-is; "Bokför ändå" re-runs
          the whole batch with force=true (the server re-detects and records
          the dismissal in behandlingshistorik). */}
      {duplicateCandidate && (
        <DuplicateBookingDialog
          candidate={duplicateCandidate}
          processing={submitting}
          onCancel={() => setDuplicateCandidate(null)}
          onBookAnyway={() => {
            setDuplicateCandidate(null)
            void handleConfirm({ force: true })
          }}
        />
      )}
    </Dialog>
  )
}
