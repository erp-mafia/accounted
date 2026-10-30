'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { useToast } from '@/components/ui/use-toast'
import { addDaysIso } from '@/lib/dates/iso'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { FORECAST_ROW_CATEGORIES, FORECAST_ROW_CONFIDENCES } from '@/lib/forecast/rows'
import { parseAmountInput } from '@/lib/money'

const SELECT_CLASS = 'h-10 w-full rounded-lg border border-input bg-card px-4 text-sm'

interface ForecastRowDialogProps {
  /** Today in Stockholm, from the forecast: the earliest date a row counts on. */
  today: string
  onOpenChange: (open: boolean) => void
  onAdded: () => void
}

/**
 * A person adds money they expect in or out to the liquidity forecast: a
 * date, an amount, which way, a category and how sure it is. Saved as a
 * manual forecast row (POST /api/reports/cash-forecast/rows); it never
 * reaches the books, so there is nothing to confirm beyond the form.
 */
export function ForecastRowDialog({ today, onOpenChange, onAdded }: ForecastRowDialogProps) {
  const t = useTranslations('cash_forecast')
  const locale = useLocale() as ErrorLocale
  const { toast } = useToast()
  const [date, setDate] = useState(() => addDaysIso(today, 7))
  const [amountText, setAmountText] = useState('')
  const [direction, setDirection] = useState<'in' | 'out'>('in')
  const [category, setCategory] = useState<(typeof FORECAST_ROW_CATEGORIES)[number]>('revenue')
  const [confidence, setConfidence] = useState<(typeof FORECAST_ROW_CONFIDENCES)[number]>('likely')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const amount = parseAmountInput(amountText)
  const amountValid = amount !== null && amount > 0
  const canSubmit = amountValid && date >= today

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!canSubmit || busy) return
    setBusy(true)
    try {
      const res = await fetch('/api/reports/cash-forecast/rows', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expected_date: date, amount, direction, category, confidence, note: note.trim() || null }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        toast({ title: t('form_failed'), description: getErrorMessage(body, { locale }), variant: 'destructive' })
        return
      }
      toast({ title: t('form_added') })
      onAdded()
      onOpenChange(false)
    } catch (err) {
      toast({ title: t('form_failed'), description: getErrorMessage(err, { locale }), variant: 'destructive' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="space-y-6">
          <DialogHeader>
            <DialogTitle>{t('form_title')}</DialogTitle>
            <DialogDescription>{t('form_description')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <SegmentedControl
              value={direction}
              onChange={(value) => {
                setDirection(value)
                if (value === 'out' && category === 'revenue') setCategory('other')
              }}
              options={[
                { value: 'in', label: t('form_in') },
                { value: 'out', label: t('form_out') },
              ]}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="forecast-row-date">{t('form_date')}</Label>
                <Input id="forecast-row-date" type="date" min={today} value={date} onChange={(e) => setDate(e.target.value)} required />
              </div>
              <div className="space-y-2">
                <Label htmlFor="forecast-row-amount">{t('form_amount')}</Label>
                <Input
                  id="forecast-row-amount"
                  inputMode="decimal"
                  autoComplete="off"
                  className="tabular-nums"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  aria-invalid={amountText !== '' && !amountValid}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="forecast-row-category">{t('form_category')}</Label>
                <select
                  id="forecast-row-category"
                  className={SELECT_CLASS}
                  value={category}
                  onChange={(e) => setCategory(e.target.value as typeof category)}
                >
                  {FORECAST_ROW_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {t(`category_${c}`)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="forecast-row-confidence">{t('form_confidence')}</Label>
                <select
                  id="forecast-row-confidence"
                  className={SELECT_CLASS}
                  value={confidence}
                  onChange={(e) => setConfidence(e.target.value as typeof confidence)}
                >
                  {FORECAST_ROW_CONFIDENCES.map((c) => (
                    <option key={c} value={c}>
                      {t(`confidence_${c}`)}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="forecast-row-note">{t('form_note')}</Label>
              <Input id="forecast-row-note" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            {amountText !== '' && !amountValid && <div className="text-[12.5px] text-destructive">{t('form_amount_invalid')}</div>}
          </div>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => onOpenChange(false)} disabled={busy}>
              {t('form_cancel')}
            </Button>
            <Button type="submit" loading={busy} disabled={!canSubmit}>
              {t('form_submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
