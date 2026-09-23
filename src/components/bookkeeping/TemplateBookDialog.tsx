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
import { staticTemplateToFormLines } from '@/lib/bookkeeping/proposal-lines'
import type { BookingTemplate } from '@/lib/bookkeeping/booking-templates'
import TemplatePicker from '@/components/transactions/TemplatePicker'
import { useCompany } from '@/contexts/CompanyContext'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { roundOre } from '@/lib/money'
import { ArrowLeft, Check, Loader2 } from 'lucide-react'
import type { BookingTemplateLibrary } from '@/types'
import { useFiscalPeriods } from '@/lib/reference-data/hooks'
import type { FormLine } from '@/components/bookkeeping/JournalEntryForm'

interface Props {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Fired after a verifikat is booked from a template. */
  onCreated: () => void
}

/** Sum a side of the computed lines in öre-safe steps. */
function sumSide(lines: FormLine[], side: 'debit_amount' | 'credit_amount'): number {
  return lines.reduce((acc, l) => roundOre(acc + (parseFloat(l[side]) || 0)), 0)
}

/**
 * "Bokför från mall" (UI-migration plan PR 4, scene 9): a centered modal
 * with the same picker every other surface uses (catalog, standard and own
 * library templates, by family), then date + editable amount that recomputes
 * the kontering live, a "Balanserar" row, and direct booking (user action, so
 * no Granskning detour).
 */
export default function TemplateBookDialog({ open, onOpenChange, onCreated }: Props) {
  const t = useTranslations('bookkeeping')
  const { toast } = useToast()

  const { company } = useCompany()
  const { periods } = useFiscalPeriods()
  const [selected, setSelected] = useState<
    { kind: 'library'; raw: BookingTemplateLibrary } | { kind: 'static'; template: BookingTemplate } | null
  >(null)
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().split('T')[0])
  const [amountInput, setAmountInput] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Reset per open so yesterday's half-typed amount never leaks into today.
  useEffect(() => {
    if (open) return
    setSelected(null)
    setAmountInput('')
    setEntryDate(new Date().toISOString().split('T')[0])
  }, [open])

  const amount = useMemo(() => {
    const parsed = parseFloat(amountInput.replace(/\s/g, '').replace(',', '.'))
    return Number.isFinite(parsed) && parsed > 0 ? roundOre(parsed) : 0
  }, [amountInput])

  // The live kontering: recomputed from the template's line pattern on
  // every amount change (momssplit etc. handled by applyTemplate).
  const lines = useMemo<FormLine[]>(() => {
    if (!selected || amount <= 0) return []
    return selected.kind === 'library'
      ? applyTemplate(selected.raw.lines, amount)
      : staticTemplateToFormLines(selected.template, amount, company?.entity_type)
  }, [selected, amount, company?.entity_type])
  const selectedName = selected ? (selected.kind === 'library' ? selected.raw.name : selected.template.name_sv) : null
  const totalDebit = sumSide(lines, 'debit_amount')
  const totalCredit = sumSide(lines, 'credit_amount')
  const balanced = lines.length >= 2 && totalDebit === totalCredit && totalDebit > 0

  const periodForDate = periods.find(
    (p) => p.period_start <= entryDate && entryDate <= p.period_end,
  )

  const handleBook = async () => {
    if (!selected || !balanced) return
    if (!periodForDate) {
      toast({ title: t('tpl_no_period'), variant: 'destructive' })
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/bookkeeping/journal-entries', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fiscal_period_id: periodForDate.id,
          entry_date: entryDate,
          description: selectedName,
          lines: lines.map((l) => ({
            account_number: l.account_number,
            debit_amount: parseFloat(l.debit_amount) || 0,
            credit_amount: parseFloat(l.credit_amount) || 0,
            line_description: l.line_description || undefined,
          })),
        }),
      })
      const result = await res.json()
      if (!res.ok) {
        toast({
          title: t('toast_post_failed'),
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
        title: t('toast_posted_title'),
        description: t('toast_posted_description', {
          voucher: formatVoucher(result.data ?? {}),
        }),
      })
      onOpenChange(false)
      onCreated()
    } catch {
      toast({ title: t('toast_post_failed_generic'), variant: 'destructive' })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !submitting && onOpenChange(next)}>
      <DialogContent className="sm:min-w-[460px] sm:max-w-lg">
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
              <ArrowLeft className="h-3.5 w-3.5" />
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

            {/* Live kontering preview */}
            <div className="rounded-lg border border-border">
              {lines.length === 0 ? (
                <p className="px-3 py-4 text-center text-[13px] text-muted-foreground">
                  {t('tpl_enter_amount')}
                </p>
              ) : (
                <>
                  {lines.map((l, i) => (
                    <div
                      key={i}
                      className="flex items-center gap-3 border-b border-border/60 px-3 py-2 text-[13px] last:border-b-0"
                    >
                      <span className="w-12 font-mono text-muted-foreground">
                        {l.account_number}
                      </span>
                      <span className="min-w-0 flex-1 truncate">{l.line_description}</span>
                      <span className="w-24 text-right tabular-nums">
                        {l.debit_amount ? formatCurrency(parseFloat(l.debit_amount)) : ''}
                      </span>
                      <span className="w-24 text-right tabular-nums text-muted-foreground">
                        {l.credit_amount ? formatCurrency(parseFloat(l.credit_amount)) : ''}
                      </span>
                    </div>
                  ))}
                  <div
                    className={cn(
                      'flex items-center justify-between px-3 py-2 text-[12.5px]',
                      balanced ? 'text-success' : 'text-destructive',
                    )}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      {balanced && <Check className="h-3.5 w-3.5" />}
                      {balanced ? t('tpl_balances') : t('tpl_not_balancing')}
                    </span>
                    <span className="tabular-nums">
                      {formatCurrency(totalDebit)} / {formatCurrency(totalCredit)}
                    </span>
                  </div>
                </>
              )}
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={submitting}>
                {t('tpl_cancel')}
              </Button>
              <Button onClick={() => void handleBook()} disabled={!balanced || submitting}>
                {submitting && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
                {t('tpl_book')}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
