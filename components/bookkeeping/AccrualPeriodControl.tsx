'use client'

import { useTranslations } from 'next-intl'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatCurrency } from '@/lib/utils'
import {
  computeInstallmentAmounts,
  countCalendarMonths,
} from '@/lib/bookkeeping/accruals/compute'
import type { AccrualDirection } from '@/types'

export interface AccrualFormValue {
  start: string
  end: string
  balanceAccount: string
}

// The statutory BAS interim accounts per direction: a fixed list reads
// better than a full account combobox and mirrors the DB CHECK (17xx/29xx).
const BALANCE_ACCOUNT_OPTIONS: Record<AccrualDirection, Array<{ value: string; label: string }>> = {
  expense: [
    { value: '1710', label: '1710 Förutbetalda hyreskostnader' },
    { value: '1720', label: '1720 Förutbetalda leasingavgifter' },
    { value: '1730', label: '1730 Förutbetalda försäkringspremier' },
    { value: '1740', label: '1740 Förutbetalda räntekostnader' },
    { value: '1790', label: '1790 Övriga förutbetalda kostnader' },
  ],
  revenue: [
    { value: '2970', label: '2970 Förutbetalda intäkter' },
    { value: '2971', label: '2971 Förutbetalda hyresintäkter' },
    { value: '2972', label: '2972 Förutbetalda medlemsavgifter' },
    { value: '2979', label: '2979 Övriga förutbetalda intäkter' },
  ],
}

/**
 * Per-line periodisering panel for the invoice editors: service period +
 * interim balance account + a live "N månader × X kr" preview. The parent
 * owns the toggle; this renders only while periodisering is active on the
 * line. VAT is never affected: only the net amount is deferred.
 */
export default function AccrualPeriodControl({
  direction,
  amount,
  value,
  onChange,
  onRemove,
  idPrefix,
}: {
  direction: AccrualDirection
  /** Net line amount (ex VAT): drives the preview and the K2 hint. */
  amount: number
  value: AccrualFormValue
  onChange: (next: AccrualFormValue) => void
  onRemove: () => void
  idPrefix: string
}) {
  const t = useTranslations('accruals')

  let preview: string | null = null
  let previewInvalid: string | null = null
  if (value.start && value.end) {
    if (value.end < value.start) {
      previewInvalid = t('preview_invalid_period')
    } else {
      try {
        const months = countCalendarMonths(value.start, value.end)
        if (months < 2) {
          previewInvalid = t('preview_min_months')
        } else if (amount > 0) {
          const amounts = computeInstallmentAmounts(amount, months)
          preview = t('preview', {
            months,
            amount: formatCurrency(amounts[0]),
          })
        }
      } catch {
        previewInvalid = t('preview_invalid_period')
      }
    }
  }

  const showK2Hint = amount > 0 && amount < 5000

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t('panel_title')}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          onClick={onRemove}
          aria-label={t('remove_aria')}
        >
          <X className="h-3.5 w-3.5 text-muted-foreground" />
        </Button>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-start`} className="text-xs">
            {t('start_label')}
          </Label>
          <Input
            id={`${idPrefix}-start`}
            type="date"
            className="h-9"
            value={value.start}
            onChange={(e) => onChange({ ...value, start: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={`${idPrefix}-end`} className="text-xs">
            {t('end_label')}
          </Label>
          <Input
            id={`${idPrefix}-end`}
            type="date"
            className="h-9"
            value={value.end}
            onChange={(e) => onChange({ ...value, end: e.target.value })}
          />
        </div>
        <div className="space-y-1.5">
          <Label className="text-xs">{t('account_label')}</Label>
          <Select
            value={value.balanceAccount}
            onValueChange={(account) => onChange({ ...value, balanceAccount: account })}
          >
            <SelectTrigger className="h-9" aria-label={t('account_label')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {BALANCE_ACCOUNT_OPTIONS[direction].map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {(preview || previewInvalid) && (
        <p
          className={
            previewInvalid ? 'text-xs text-destructive' : 'text-xs text-muted-foreground tabular-nums'
          }
        >
          {previewInvalid ?? preview}
        </p>
      )}
      {showK2Hint && (
        <p className="text-xs text-muted-foreground">{t('k2_hint')}</p>
      )}
    </div>
  )
}
