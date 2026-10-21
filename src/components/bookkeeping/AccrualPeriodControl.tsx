'use client'

import { useLocale, useTranslations } from 'next-intl'
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
  accrualCoversOnlyInvoiceMonth,
  computeInstallmentAmounts,
  countCalendarMonths,
} from '@/lib/bookkeeping/accruals/compute'
import { accrualHintKey, accrualThresholdSek, shouldShowK2AccrualHint } from '@/components/bookkeeping/accrual-k2-hint'
import {
  DEFAULT_ACCRUED_REVENUE_ACCOUNT,
  isAccruedBalanceAccount,
  periodEndsBeforeInvoiceMonth,
} from '@/lib/bookkeeping/accruals/account-suggestions'
import type { AccrualDirection, EntityType } from '@/types'

export interface AccrualFormValue {
  start: string
  end: string
  balanceAccount: string
}

// The statutory BAS interim accounts per direction: a fixed list reads
// better than a full account combobox and mirrors the DB CHECK (17xx/29xx).
// Each direction has two kinds: förutbetald (months from the invoice on) and
// upplupen (months before the invoice month): a cost on 17xx / 29xx, revenue
// on 29xx / 17xx.
const BALANCE_ACCOUNT_OPTIONS: Record<AccrualDirection, Array<{ value: string; label: string }>> = {
  expense: [
    { value: '1710', label: '1710 Förutbetalda hyreskostnader' },
    { value: '1720', label: '1720 Förutbetalda leasingavgifter' },
    { value: '1730', label: '1730 Förutbetalda försäkringspremier' },
    { value: '1740', label: '1740 Förutbetalda räntekostnader' },
    { value: '1790', label: '1790 Övriga förutbetalda kostnader' },
    { value: '2960', label: '2960 Upplupna räntekostnader' },
    { value: '2990', label: '2990 Övriga upplupna kostnader' },
  ],
  revenue: [
    { value: '2970', label: '2970 Förutbetalda intäkter' },
    { value: '2971', label: '2971 Förutbetalda hyresintäkter' },
    { value: '2972', label: '2972 Förutbetalda medlemsavgifter' },
    { value: '2979', label: '2979 Övriga förutbetalda intäkter' },
    // Upplupen intäkt: BAS 1790, the catch-all interimsfordran (the API also
    // takes 1750/1760/1780).
    { value: DEFAULT_ACCRUED_REVENUE_ACCOUNT, label: `${DEFAULT_ACCRUED_REVENUE_ACCOUNT} Övriga upplupna intäkter` },
  ],
}

/**
 * Per-line periodisering panel for the invoice editors: service period +
 * interim balance account + a live preview naming the months the amount
 * lands in ("Hela beloppet bokförs i november 2026", or "N månader × X kr,
 * oktober 2026 till november 2026"), so a period that reaches into the
 * invoice month by one day is visible before it is booked. The parent
 * owns the toggle; this renders only while periodisering is active on the
 * line. VAT is never affected: only the net amount is deferred.
 */
export default function AccrualPeriodControl({
  direction,
  amount,
  currency,
  exchangeRate,
  value,
  onChange,
  onRemove,
  idPrefix,
  entityType,
  invoiceDate,
  fiscalYearStart = null,
}: {
  direction: AccrualDirection
  /** Net line amount (ex VAT), in `currency`: drives the preview and the K2 hint. */
  amount: number
  /** ISO code of `amount`. Missing is treated as SEK (the editors' default). */
  currency?: string | null
  /**
   * SEK per unit of `currency`. Only the supplier-invoice form has one; the
   * customer-invoice editor carries no rate, so the K2 hint stays hidden on
   * its foreign-currency lines instead of comparing kronor to euros.
   */
  exchangeRate?: number | null
  value: AccrualFormValue
  onChange: (next: AccrualFormValue) => void
  onRemove: () => void
  idPrefix: string
  /**
   * Picks the regelverk the materiality hint cites: K1 (BFNAR 2006:1) for
   * enskild firma, K2 (BFNAR 2016:10) otherwise. Missing keeps the K2
   * wording (the historical default).
   */
  entityType?: EntityType | null
  /**
   * The invoice date on the form. A period lying only in its month is
   * refused by the API (nothing would be deferred), and with an upplupen
   * account (29xx on a cost, 17xx on revenue) the period has to end before
   * this date's month; the panel says so.
   */
  invoiceDate?: string | null
  /**
   * The start of the fiscal year the line is booked in: K2's limit is
   * 7 000 kr from a year starting 2026 (BFNAR 2025:2), 5 000 kr before.
   * Missing keeps 5 000 kr.
   */
  fiscalYearStart?: string | null
}) {
  const t = useTranslations('accruals')
  const locale = useLocale()

  // Upplupen kostnad (expense on 29xx) or intäkt (revenue on 17xx). Its
  // months must lie before the invoice month (the API refuses anything else).
  const accrued = isAccruedBalanceAccount(direction, value.balanceAccount)
  const accruedReachesInvoiceMonth =
    accrued && Boolean(value.end && invoiceDate) &&
    !periodEndsBeforeInvoiceMonth(value.end, invoiceDate as string)

  let preview: string | null = null
  let previewInvalid: string | null = null
  if (value.start && value.end) {
    if (value.end < value.start) {
      previewInvalid = t('preview_invalid_period')
    } else {
      try {
        const months = countCalendarMonths(value.start, value.end)
        if (invoiceDate && accrualCoversOnlyInvoiceMonth(invoiceDate, value.start, value.end)) {
          previewInvalid = t('invoice_month_only')
        } else if (months === 1) {
          preview = t('preview_one_month', { month: formatPeriodMonth(value.start, locale) })
        } else if (amount > 0) {
          const amounts = computeInstallmentAmounts(amount, months)
          preview = t('preview', {
            months,
            amount: formatCurrency(amounts[0], currency || 'SEK'),
            first: formatPeriodMonth(value.start, locale),
            last: formatPeriodMonth(value.end, locale),
          })
        }
      } catch {
        previewInvalid = t('preview_invalid_period')
      }
    }
  }

  // The vasentlighetsgrans (K1 5 000 kr, K2 5 000 or 7 000 kr by the fiscal
  // year) is measured in kronor, and it is a simplification the company may
  // use, not an obligation. So when the line is in a foreign currency and no
  // rate is available, show nothing at all rather than compare the raw
  // foreign amount against a SEK threshold.
  const thresholdSek = accrualThresholdSek({ entityType, fiscalYearStart })
  const showMaterialityHint = shouldShowK2AccrualHint({ amount, currency, exchangeRate, thresholdSek })
  const materialityHintKey = accrualHintKey(entityType)

  return (
    <div className="rounded-lg border bg-muted/30 p-3 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {t('panel_title')}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
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
      {accrued && (
        <p className={accruedReachesInvoiceMonth ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}>
          {direction === 'expense'
            ? t(accruedReachesInvoiceMonth ? 'accrued_cost_period_invalid' : 'accrued_cost_hint')
            : t(accruedReachesInvoiceMonth ? 'accrued_income_period_invalid' : 'accrued_income_hint')}
        </p>
      )}
      {showMaterialityHint && (
        <p className="text-xs text-muted-foreground">
          {t(materialityHintKey, { amount: new Intl.NumberFormat(locale === 'en' ? 'en-US' : 'sv-SE').format(thresholdSek) })}
        </p>
      )}
    </div>
  )
}

/** '2026-11-30' → 'november 2026' (sv) / 'November 2026' (en). */
function formatPeriodMonth(date: string, locale: string): string {
  const year = Number(date.slice(0, 4))
  const month = Number(date.slice(5, 7))
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-US' : 'sv-SE', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(Date.UTC(year, month - 1, 1)))
}
