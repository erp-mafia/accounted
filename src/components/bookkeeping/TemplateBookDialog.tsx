'use client'

import { useEffect, useMemo, useState } from 'react'
import { useTranslations } from 'next-intl'
import { cn, formatCurrency } from '@/lib/utils'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { applyTemplate } from '@/lib/bookkeeping/template-library'
import {
  balancingAmountInput,
  checkTemplateLines,
  shownTemplateLines,
  templateLinesSeed,
  withLineAccount,
  withLineAmount,
  type TemplateLinesEdits,
} from '@/lib/bookkeeping/template-line-edit'
import { proposalLinesToFormLines } from '@/lib/bookkeeping/proposal-lines'
import { useProposalPreview } from '@/lib/hooks/use-proposal-preview'
import type { BookingTemplate } from '@/lib/bookkeeping/booking-templates'
import TemplatePicker from '@/components/transactions/TemplatePicker'
import { KonteringLinesEditor } from '@/components/bookkeeping/KonteringLinesEditor'
import { useCompany } from '@/contexts/CompanyContext'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { parseAmountInput } from '@/lib/money'
import { ArrowLeftIcon, ArrowUturnLeftIcon, CheckIcon } from '@/components/icons'
import type { BookingTemplateLibrary } from '@/types'
import { useAccounts, useFiscalPeriods } from '@/lib/reference-data/hooks'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'
import { todayIsoStockholm } from '@/lib/dates/iso'
import VoucherWarningsDialog from '@/components/bookkeeping/VoucherWarningsDialog'
import type { VoucherWarning } from '@/lib/bookkeeping/voucher-plausibility'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired after a verifikat is booked from a template. */
  onCreated: () => void
}

const BLANK_LINE: FormLine = { account_number: '', debit_amount: '', credit_amount: '', line_description: '' }

/**
 * "Bokför från mall" (UI-migration plan PR 4, scene 9): a centered modal
 * with the same picker every other surface uses (catalog, standard and own
 * library templates, by family), then date + editable amount that recomputes
 * the kontering live, a "Balanserar" row, and direct booking (user action, so
 * no Granskning detour).
 *
 * The kontering is the mall's starting point, not a lock (crm#1351): its
 * lines sit in the same editor as a verifikat's, so a share that differs
 * from booking to booking (a fee taken off a payout) is adjusted before
 * booking, and booking waits until debit and credit match. A new total or
 * another mall computes the lines again; the mall itself is never changed
 * (lib/bookkeeping/template-line-edit.ts).
 */
export default function TemplateBookDialog({ open, onOpenChange, onCreated }: Props) {
  const t = useTranslations('bookkeeping')
  const tLines = useTranslations('journal_form')
  const { toast } = useToast()

  const { company } = useCompany()
  const { periods } = useFiscalPeriods()
  const { accounts, isLoading: accountsLoading } = useAccounts()
  const [selected, setSelected] = useState<
    { kind: 'library'; raw: BookingTemplateLibrary } | { kind: 'static'; template: BookingTemplate } | null
  >(null)
  const [entryDate, setEntryDate] = useState(() => todayIsoStockholm())
  const [amountInput, setAmountInput] = useState('')
  // The person's changes to the computed lines, for the mall and total they were made on.
  const [edits, setEdits] = useState<TemplateLinesEdits<FormLine> | null>(null)
  // Which button's request is in flight: only that one spins, both stay disabled.
  const [submitting, setSubmitting] = useState<'book' | 'draft' | null>(null)
  // The warnings a refused booking came back with (VOUCHER_NEEDS_CONFIRMATION),
  // shown for the person to confirm or go back and correct the lines.
  const [voucherWarnings, setVoucherWarnings] = useState<VoucherWarning[] | null>(null)

  // Reset per open so yesterday's half-typed amount never leaks into today.
  useEffect(() => {
    if (open) return
    setSelected(null)
    setAmountInput('')
    setEdits(null)
    setEntryDate(todayIsoStockholm())
  }, [open])

  const amount = useMemo(() => {
    const parsed = parseAmountInput(amountInput)
    return parsed !== null && parsed > 0 ? parsed : 0
  }, [amountInput])

  // The live kontering, recomputed on every amount change: an own library
  // template from its line pattern (applyTemplate), a catalog template by
  // the server the way a bank row of that total is booked with it (moms,
  // omvänd skattskyldighet settled with the company's momskoder).
  const staticPreview = useProposalPreview(
    selected?.kind === 'static' && amount > 0 ? { amount, template_id: selected.template.id } : null,
  )
  const computedLines = useMemo<FormLine[]>(() => {
    if (!selected || amount <= 0) return []
    return selected.kind === 'library'
      ? applyTemplate(selected.raw.lines, amount)
      : proposalLinesToFormLines(staticPreview.lines)
  }, [selected, amount, staticPreview.lines])
  // Never book lines computed for an amount the field no longer shows.
  const linesPending = selected?.kind === 'static' && staticPreview.loading
  const selectedName = selected ? (selected.kind === 'library' ? selected.raw.name : selected.template.name_sv) : null
  const seed = templateLinesSeed(
    selected ? (selected.kind === 'library' ? selected.raw.id : selected.template.id) : '',
    amount,
  )
  const lines = shownTemplateLines(computedLines, edits, seed)
  const edited = edits !== null && edits.seed === seed
  const check = useMemo(() => checkTemplateLines(lines), [lines])
  const balanced = !linesPending && check.bookable

  const accountNames = useMemo(
    () => new Map(accounts.map((a) => [a.account_number, a.account_name])),
    [accounts],
  )
  // Every change starts from the lines on screen and belongs to this mall and total.
  const editLines = (change: (current: FormLine[]) => FormLine[]) => {
    if (linesPending) return
    setEdits({ seed, lines: change(lines) })
  }

  const periodForDate = periods.find(
    (p) => p.period_start <= entryDate && entryDate <= p.period_end,
  )

  // `asDraft` posts with ?as_draft=true, which the route already understands
  // (createDraftEntry vs createJournalEntry). A draft gets no voucher number
  // and stays editable, matching the "Spara som utkast" affordance the manual
  // JournalEntryForm has always had. Booking from a template previously
  // committed straight away, with no way to review first.
  // `acknowledged`: the warning codes the person confirmed in the warnings
  // dialog. The server checks again and refuses anything new.
  const handleBook = async (asDraft = false, acknowledged?: string[]) => {
    if (!selected || !balanced) return
    if (!periodForDate) {
      toast({ title: t('tpl_no_period'), variant: 'destructive' })
      return
    }
    setSubmitting(asDraft ? 'draft' : 'book')
    try {
      const res = await fetch(
        `/api/bookkeeping/journal-entries${asDraft ? '?as_draft=true' : ''}`,
        {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fiscal_period_id: periodForDate.id,
          entry_date: entryDate,
          description: selectedName,
          lines: check.postLines,
          ...(acknowledged ? { acknowledged_warnings: acknowledged } : {}),
        }),
        },
      )
      const result = await res.json()
      if (!res.ok) {
        // A voucher that deviates is not a failure: show what deviates and
        // let the person book it anyway, as the manual form does. As a toast
        // it said "read the warnings and confirm" with neither on screen.
        const warnings = result?.error?.details?.warnings
        if (!asDraft && result?.error?.code === 'VOUCHER_NEEDS_CONFIRMATION' && Array.isArray(warnings)) {
          setVoucherWarnings(warnings as VoucherWarning[])
          return
        }
        toast({
          title: asDraft ? t('tpl_toast_draft_failed') : t('toast_post_failed'),
          description: getErrorMessage(result, { context: 'journal_entry' }),
          variant: 'destructive',
        })
        return
      }
      // MRU ordering for the next open; fire-and-forget.
      if (selected.kind === 'library') {
        void fetch(`/api/settings/booking-templates/${selected.raw.id}/touch`, {
          method: 'POST',
        }).catch(() => {})
      }
      toast({
        title: asDraft ? t('tpl_toast_draft_saved_title') : t('toast_posted_title'),
        description: asDraft
          ? t('tpl_toast_draft_saved_description')
          : t('toast_posted_description', {
              voucher: formatVoucher(result.data ?? {}),
            }),
      })
      onOpenChange(false)
      onCreated()
    } catch {
      toast({ title: t('toast_post_failed_generic'), variant: 'destructive' })
    } finally {
      setSubmitting(null)
    }
  }

  return (
    <>
    <VoucherWarningsDialog
      warnings={voucherWarnings}
      processing={submitting !== null}
      onCancel={() => setVoucherWarnings(null)}
      onConfirm={() => {
        const confirmed = voucherWarnings
        setVoucherWarnings(null)
        if (confirmed) void handleBook(false, confirmed.map((warning) => warning.code))
      }}
    />
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className={cn('sm:min-w-[460px]', selected ? 'sm:max-w-2xl' : 'sm:max-w-lg')}>
        <DialogHeader>
          {/* data-ph-mask: the template name is user data */}
          <DialogTitle data-ph-mask="" className="font-display text-lg tracking-tight">
            {selectedName ?? t('tpl_dialog_title')}
          </DialogTitle>
        </DialogHeader>

        {!selected ? (
          <div className="-mx-2 flex h-[420px] min-h-0 flex-col overflow-hidden">
            <TemplatePicker
              direction="all"
              entityType={company?.entity_type}
              dense
              includeSystemLibrary
              onSelect={(template) => setSelected({ kind: 'static', template })}
              onPickLibraryTemplate={(raw) => setSelected({ kind: 'library', raw })}
            />
          </div>
        ) : (
          <div className="space-y-4">
            <button
              type="button"
              onClick={() => setSelected(null)}
              className="inline-flex items-center gap-1.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
            >
              <ArrowLeftIcon className="h-3.5 w-3.5" />
              {t('tpl_back')}
            </button>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="tpl-date">{t('tpl_date_label')}</Label>
                <Input
                  id="tpl-date"
                  type="date"
                  value={entryDate}
                  onChange={(e) => setEntryDate(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="tpl-amount">{t('tpl_amount_label')}</Label>
                <Input
                  id="tpl-amount"
                  inputMode="decimal"
                  placeholder="0,00"
                  value={amountInput}
                  onChange={(e) => setAmountInput(e.target.value)}
                  autoFocus
                  className="tabular-nums"
                />
              </div>
            </div>

            {/* Live kontering: the mall's lines, editable before booking */}
            {(selected.kind === 'static' && staticPreview.error) || lines.length === 0 ? (
              <div className="rounded-lg border border-border">
                {selected.kind === 'static' && staticPreview.error ? (
                  <p role="alert" className="px-3 py-4 text-center text-[13px] text-destructive">
                    {staticPreview.error}
                  </p>
                ) : (
                  <p className="px-3 py-4 text-center text-[13px] text-muted-foreground">
                    {t('tpl_enter_amount')}
                  </p>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">{t('tpl_lines_hint')}</p>
                <KonteringLinesEditor
                  lines={lines}
                  accounts={accounts}
                  accountName={(accountNumber) => accountNames.get(accountNumber)}
                  accountsDisabled={accountsLoading || linesPending}
                  onAccountChange={(index, accountNumber) =>
                    editLines((current) =>
                      withLineAccount(current, index, accountNumber, accountNames.get(accountNumber) ?? ''),
                    )
                  }
                  onAmountChange={(index, field, value) =>
                    editLines((current) => withLineAmount(current, index, field, value))
                  }
                  amountInputProps={(index, field) => ({
                    onDoubleClick: () => {
                      const fill = balancingAmountInput(lines, index, field)
                      if (fill !== null) editLines((current) => withLineAmount(current, index, field, fill))
                    },
                    title: t('tpl_fill_balance_tooltip'),
                  })}
                  onAdd={() => editLines((current) => [...current, { ...BLANK_LINE }])}
                  onRemove={(index) => editLines((current) => current.filter((_, i) => i !== index))}
                  labels={{
                    account: tLines('col_account'),
                    debit: tLines('col_debit'),
                    credit: tLines('col_credit'),
                    addRow: tLines('add_line'),
                    removeRow: tLines('remove_line'),
                  }}
                  toolbar={
                    edited ? (
                      <Button type="button" variant="ghost" size="sm" onClick={() => setEdits(null)}>
                        <ArrowUturnLeftIcon className="mr-1 h-3.5 w-3.5" aria-hidden />
                        {t('tpl_reset_lines')}
                      </Button>
                    ) : undefined
                  }
                />
                <div
                  className={cn(
                    'flex items-center justify-between border-t border-border px-1 pt-2 text-[12.5px]',
                    balanced ? 'text-success' : 'text-destructive',
                  )}
                >
                  <span className="inline-flex items-center gap-1.5">
                    {balanced && <CheckIcon className="h-3.5 w-3.5" />}
                    {balanced
                      ? t('tpl_balances')
                      : check.incomplete > 0
                        ? t('tpl_line_incomplete')
                        : check.difference !== 0
                          ? t('tpl_not_balancing_diff', { amount: formatCurrency(Math.abs(check.difference)) })
                          : t('tpl_not_balancing')}
                  </span>
                  <span className="tabular-nums">
                    {formatCurrency(check.totalDebit)} / {formatCurrency(check.totalCredit)}
                  </span>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting !== null}>
                {t('tpl_cancel')}
              </Button>
              <Button
                variant="outline"
                onClick={() => void handleBook(true)}
                disabled={!balanced || submitting !== null}
                loading={submitting === 'draft'}
                title={t('tpl_save_draft_tooltip')}
              >
                {t('tpl_save_draft')}
              </Button>
              <Button
                onClick={() => void handleBook()}
                disabled={!balanced || submitting !== null}
                loading={submitting === 'book'}
              >
                {t('tpl_book')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
    </>
  )
}
