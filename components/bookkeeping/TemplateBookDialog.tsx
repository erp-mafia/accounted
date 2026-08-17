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
import {
  applyTemplate,
  getTemplateScope,
  SCOPE_LABELS,
  TEMPLATE_CATEGORY_LABELS,
} from '@/lib/bookkeeping/template-library'
import { formatVoucher } from '@/lib/bookkeeping/voucher-series-resolver'
import { roundOre } from '@/lib/money'
import { ArrowLeft, Check, ChevronRight, Loader2, Search } from 'lucide-react'
import type { BookingTemplateLibrary, FiscalPeriod } from '@/types'
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
 * with the template list (existing booking_template_library data, MRU
 * ordering from the API), then date + editable amount that recomputes the
 * kontering live via applyTemplate, a "Balanserar" row, and direct booking
 * (user action, so no Granskning detour).
 */
export default function TemplateBookDialog({ open, onOpenChange, onCreated }: Props) {
  const t = useTranslations('bookkeeping')
  const { toast } = useToast()

  const [templates, setTemplates] = useState<BookingTemplateLibrary[] | null>(null)
  const [periods, setPeriods] = useState<FiscalPeriod[]>([])
  const [search, setSearch] = useState('')
  const [selected, setSelected] = useState<BookingTemplateLibrary | null>(null)
  const [entryDate, setEntryDate] = useState(() => new Date().toISOString().split('T')[0])
  const [amountInput, setAmountInput] = useState('')
  const [submitting, setSubmitting] = useState(false)

  // Load templates + fiscal periods when the dialog opens.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    ;(async () => {
      const [tplRes, periodRes] = await Promise.all([
        fetch('/api/settings/booking-templates'),
        fetch('/api/bookkeeping/fiscal-periods'),
      ])
      if (cancelled) return
      if (tplRes.ok) {
        const { data } = await tplRes.json()
        if (!cancelled) setTemplates(data ?? [])
      } else {
        setTemplates([])
      }
      if (periodRes.ok) {
        const { data } = await periodRes.json()
        if (!cancelled) setPeriods(data ?? [])
      }
    })()
    return () => {
      cancelled = true
    }
  }, [open])

  // Reset per open so yesterday's half-typed amount never leaks into today.
  useEffect(() => {
    if (open) return
    setSelected(null)
    setSearch('')
    setAmountInput('')
    setEntryDate(new Date().toISOString().split('T')[0])
  }, [open])

  const amount = useMemo(() => {
    const parsed = parseFloat(amountInput.replace(/\s/g, '').replace(',', '.'))
    return Number.isFinite(parsed) && parsed > 0 ? roundOre(parsed) : 0
  }, [amountInput])

  // The live kontering: recomputed from the template's line pattern on
  // every amount change (momssplit etc. handled by applyTemplate).
  const lines = useMemo<FormLine[]>(
    () => (selected && amount > 0 ? applyTemplate(selected.lines, amount) : []),
    [selected, amount],
  )
  const totalDebit = sumSide(lines, 'debit_amount')
  const totalCredit = sumSide(lines, 'credit_amount')
  const balanced = lines.length >= 2 && totalDebit === totalCredit && totalDebit > 0

  const filteredTemplates = (templates ?? []).filter((tpl) =>
    tpl.name.toLowerCase().includes(search.trim().toLowerCase()),
  )

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
          description: selected.name,
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
      void fetch(`/api/settings/booking-templates/${selected.id}/touch`, {
        method: 'POST',
      }).catch(() => {})
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
            {selected ? selected.name : t('tpl_dialog_title')}
          </DialogTitle>
        </DialogHeader>

        {!selected ? (
          <>
            <div className="flex items-center gap-2 border-b border-border/60 pb-2">
              <Search className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={t('tpl_search_placeholder')}
                className="w-full bg-transparent text-[13px] text-foreground placeholder:text-muted-foreground/60 focus:outline-none"
                autoFocus
              />
            </div>
            <div className="-mx-2 max-h-80 overflow-y-auto px-1">
              {templates === null ? (
                <div className="flex items-center justify-center gap-2 py-8 text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : filteredTemplates.length === 0 ? (
                <p className="px-2.5 py-6 text-center text-[13px] text-muted-foreground">
                  {t('tpl_empty')}
                </p>
              ) : (
                filteredTemplates.map((tpl) => (
                  <button
                    key={tpl.id}
                    type="button"
                    onClick={() => setSelected(tpl)}
                    className="flex w-full items-center gap-2.5 rounded-sm px-2.5 py-2.5 text-left transition-colors hover:bg-secondary/60"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-foreground">
                        {tpl.name}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {TEMPLATE_CATEGORY_LABELS[tpl.category] ?? tpl.category}
                        {' · '}
                        {SCOPE_LABELS[getTemplateScope(tpl)]}
                      </span>
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/60" />
                  </button>
                ))
              )}
            </div>
          </>
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
