'use client'

import { useTranslations } from 'next-intl'
import { CalendarClock } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { formatCurrency, formatDate } from '@/lib/utils'
import { getDisplayTotal } from '@/lib/invoices/rounding'
import { itemHasAccrual } from '@/lib/bookkeeping/accruals/account-suggestions'
import type { Customer, Currency } from '@/types'

interface ReviewItem {
  description: string
  quantity: number
  unit: string
  unit_price: number
  vat_rate?: number
  /** 'text' rows are free-text/blank lines — description only, no amounts. */
  line_type?: 'product' | 'text'
  // Periodisering: when both dates are set, the revenue books to the 29xx
  // interim account and dissolves monthly over the period.
  accrual_period_start?: string | null
  accrual_period_end?: string | null
  accrual_balance_account?: string | null
}

const accrualMonth = (date: string): string => date.slice(0, 7)

interface InvoiceReviewContentProps {
  customer: Customer
  invoiceDate: string
  dueDate: string
  currency: Currency
  items: ReviewItem[]
  subtotal: number
  vatAmount: number
  total: number
  yourReference?: string
  ourReference?: string
  notes?: string
  /** The invoice number that will be assigned on confirm. Null when unknown
   *  (e.g. delivery notes use a different sequence) or unfetched. */
  numberPreview?: string | null
  /** Mirrors `company_settings.ore_rounding`. Defaults to true to match `getDisplayTotal`. */
  oreRounding?: boolean
  /** Mirrors `company_settings.vat_registered`. When false and the invoice carries
   *  no VAT, the moms row is suppressed to match the PDF (pdf-template.tsx:876). */
  vatRegistered?: boolean
}

export function InvoiceReviewContent({
  customer,
  invoiceDate,
  dueDate,
  currency,
  items,
  subtotal,
  vatAmount,
  total,
  yourReference,
  ourReference,
  notes,
  numberPreview,
  oreRounding,
  vatRegistered,
}: InvoiceReviewContentProps) {
  const t = useTranslations('invoice_review')
  const rounding = getDisplayTotal({ total, currency }, { ore_rounding: oreRounding ?? true })
  const customerTypeLabel: Record<string, string> = {
    individual: t('customer_type_individual'),
    swedish_business: t('customer_type_swedish_business'),
    eu_business: t('customer_type_eu_business'),
    non_eu_business: t('customer_type_non_eu_business'),
  }

  // Calculate per-rate VAT breakdown (free-text rows carry no amounts).
  const vatByRate = new Map<number, number>()
  for (const item of items) {
    if (item.line_type === 'text') continue
    const rate = item.vat_rate ?? 0
    const lineTotal = item.quantity * item.unit_price
    const lineVat = Math.round(lineTotal * rate / 100 * 100) / 100
    vatByRate.set(rate, (vatByRate.get(rate) || 0) + lineVat)
  }

  const showVatColumn = vatByRate.size > 1

  return (
    <div className="space-y-4">
      {numberPreview && (
        <div className="text-sm text-muted-foreground">
          {t('assigned_number_prefix')}{' '}
          <span className="font-medium tabular-nums text-foreground">{numberPreview}</span>
        </div>
      )}
      {/* Customer info */}
      <div className="bg-muted rounded-lg p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
        <div className="min-w-0">
          <p className="font-medium text-base truncate">{customer.name}</p>
          <p className="text-sm text-muted-foreground truncate">{customer.email}</p>
        </div>
        <Badge variant="outline" className="self-start sm:self-auto shrink-0">
          {customerTypeLabel[customer.customer_type] || customer.customer_type}
        </Badge>
      </div>

      {/* Dates */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
        <div>
          <span className="text-muted-foreground">{t('invoice_date')}</span>
          <p className="font-medium">{invoiceDate ? formatDate(invoiceDate) : ''}</p>
        </div>
        <div>
          <span className="text-muted-foreground">{t('due_date')}</span>
          <p className="font-medium">{dueDate ? formatDate(dueDate) : ''}</p>
        </div>
      </div>

      {/* Line items — table on desktop, cards on mobile */}
      <div className="hidden sm:block">
        <table className="w-full text-sm">
          <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
            <tr className="border-b text-left">
              <th className="py-2">{t('th_description')}</th>
              <th className="py-2 w-16 text-right">{t('th_quantity')}</th>
              <th className="py-2 w-16 text-center">{t('th_unit')}</th>
              <th className="py-2 w-24 text-right">{t('th_unit_price')}</th>
              {showVatColumn && <th className="py-2 w-16 text-right">{t('th_vat')}</th>}
              <th className="py-2 w-28 text-right">{t('th_amount')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) =>
              item.line_type === 'text' ? (
                <tr key={index} className="border-b last:border-0">
                  <td className="py-2 text-muted-foreground" colSpan={showVatColumn ? 6 : 5}>
                    {item.description || ' '}
                  </td>
                </tr>
              ) : (
                <tr key={index} className="border-b last:border-0">
                  <td className="py-2">
                    {item.description}
                    {itemHasAccrual(item) && (
                      <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                        <CalendarClock className="h-3 w-3 shrink-0" />
                        <span className="tabular-nums">
                          {t('accrual_line_info', {
                            from: accrualMonth(item.accrual_period_start!),
                            to: accrualMonth(item.accrual_period_end!),
                          })}
                        </span>
                      </p>
                    )}
                  </td>
                  <td className="py-2 text-right">{item.quantity}</td>
                  <td className="py-2 text-center">{item.unit}</td>
                  <td className="py-2 text-right">{formatCurrency(item.unit_price, currency)}</td>
                  {showVatColumn && (
                    <td className="py-2 text-right">{item.vat_rate ?? 0}%</td>
                  )}
                  <td className="py-2 text-right">
                    {formatCurrency(item.quantity * item.unit_price, currency)}
                  </td>
                </tr>
              )
            )}
          </tbody>
        </table>
      </div>
      <div className="sm:hidden space-y-2">
        {items.map((item, index) =>
          item.line_type === 'text' ? (
            <p key={index} className="text-sm text-muted-foreground px-1">{item.description || ' '}</p>
          ) : (
            <div key={index} className="border rounded-lg p-3 text-sm space-y-1.5">
              <p className="font-medium">{item.description}</p>
              {itemHasAccrual(item) && (
                <p className="flex items-center gap-1 text-xs text-muted-foreground">
                  <CalendarClock className="h-3 w-3 shrink-0" />
                  <span className="tabular-nums">
                    {t('accrual_line_info', {
                      from: accrualMonth(item.accrual_period_start!),
                      to: accrualMonth(item.accrual_period_end!),
                    })}
                  </span>
                </p>
              )}
              <div className="flex items-center justify-between text-muted-foreground">
                <span>{item.quantity} {item.unit} × {formatCurrency(item.unit_price, currency)}</span>
                {showVatColumn && <span className="text-xs">{t('mobile_vat_suffix', { rate: item.vat_rate ?? 0 })}</span>}
              </div>
              <p className="text-right font-medium">
                {formatCurrency(item.quantity * item.unit_price, currency)}
              </p>
            </div>
          )
        )}
      </div>

      {/* Totals */}
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t('subtotal')}</span>
          <span>{formatCurrency(subtotal, currency)}</span>
        </div>
        {Array.from(vatByRate.entries())
          .filter(([, vat]) => vat > 0)
          .sort(([a], [b]) => b - a)
          .map(([rate, vat]) => (
            <div key={rate} className="flex justify-between">
              <span className="text-muted-foreground">{t('vat_at_rate', { rate })}</span>
              <span>{formatCurrency(vat, currency)}</span>
            </div>
          ))}
        {Array.from(vatByRate.values()).every((vat) => vat === 0) && !(vatRegistered === false && vatAmount === 0) && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('vat_label')}</span>
            <span>{formatCurrency(0, currency)}</span>
          </div>
        )}
        {rounding.applies && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('ore_rounding')}</span>
            <span>{formatCurrency(rounding.roundingDelta, currency)}</span>
          </div>
        )}
        <Separator />
        <div className="flex justify-between font-bold text-xl sm:text-2xl">
          <span>{t('total')}</span>
          <span>{formatCurrency(rounding.displayed, currency)}</span>
        </div>
      </div>

      {/* References/notes */}
      {(yourReference || ourReference || notes) && (
        <div className="border-t pt-3 space-y-2 text-sm text-muted-foreground">
          {yourReference && (
            <p>
              <span>{t('your_reference')}</span> {yourReference}
            </p>
          )}
          {ourReference && (
            <p>
              <span>{t('our_reference')}</span> {ourReference}
            </p>
          )}
          {notes && <p>{t('notes_prefix', { notes })}</p>}
        </div>
      )}
    </div>
  )
}
