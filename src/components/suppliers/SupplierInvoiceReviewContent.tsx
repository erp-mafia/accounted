'use client'

import { useTranslations } from 'next-intl'
import { CalendarDaysIcon } from '@/components/icons'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { AccountNumber } from '@/components/ui/account-number'
import { VoucherLinesTable } from '@/components/bookkeeping/VoucherLinesTable'
import { voucherLineViews } from '@/lib/bookkeeping/voucher-line-view'
import { formatAmount, formatCurrency, formatDate } from '@/lib/utils'
import type { ChartVatTreatments } from '@/lib/bookkeeping/vat-entries'
import { buildSupplierDescription } from '@/lib/bookkeeping/supplier-invoice-description'
import {
  supplierInvoiceRegistrationLines,
  type SupplierInvoiceBookingItem,
} from '@/lib/bookkeeping/supplier-invoice-registration-lines'
import { supplierInvoiceEditorAmounts } from '@/lib/supplier-invoices/editor-amounts'
import type { StatedRateVat } from '@/lib/vat/document-vat'
import { inferVatTreatment } from '@/lib/supplier-invoices/form-payload'
import { roundOre } from '@/lib/money'
import { itemHasAccrual } from '@/lib/bookkeeping/accruals/account-suggestions'
import type { InvoiceBookingMoment } from '@/lib/bookkeeping/booking-mode'
import type { Supplier, SupplierInvoiceReverseChargeKind } from '@/types'

interface ReviewLineItem {
  description: string
  amount: number
  account_number: string
  vat_rate: number
  // When set, the user typed the deductible VAT explicitly (manual override).
  // Used for bilförmån 50%, representation tak, FX-rundningar etc.
  vat_amount?: number
  // Self-assessed VAT rate for omvänd skattskyldighet (0.06/0.12/0.25). The
  // supplier charges no VAT (vat_rate = 0); this drives the fiktiv-moms preview.
  reverse_charge_rate?: number
  // Särskild löneskatt på pensionskostnader: previews the self-balancing
  // 7533 D / 2514 K pair the engine injects for flagged 741x lines.
  apply_slp?: boolean
  // Per-row dimensions bag: two rows on one account with different tags
  // book as two lines.
  dimensions?: Record<string, string>
  // Periodisering: when both dates are set, the registration entry books the
  // net to the 17xx/29xx interim account instead of account_number (mirrored via
  // resolveBookingAccount so this preview matches the saved verifikat).
  accrual_period_start?: string | null
  accrual_period_end?: string | null
  accrual_balance_account?: string | null
}

const accrualMonth = (date: string): string => date.slice(0, 7)

interface SupplierInvoiceReviewContentProps {
  supplier: Supplier
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  deliveryDate?: string
  currency: string
  exchangeRate?: string
  reverseCharge: boolean
  /** Goods or services under an EU supplier's reverse charge, as the payload sends it. */
  reverseChargeKind?: SupplierInvoiceReverseChargeKind
  paymentReference?: string
  items: ReviewLineItem[]
  /** Include the invoice rounding in both the payable and journal preview. */
  oreRounding: boolean
  /**
   * When the registration verifikat is posted (booking-mode.ts). Only 'issue'
   * posts it on confirm; under kontantmetoden ('payment') the invoice is
   * booked at payment as a cash entry with no 2440, and under deferred
   * booking ('manual') by the explicit Bokför step, so no preview is shown.
   */
  bookingMoment: InvoiceBookingMoment
  /**
   * The company's momskoder (chartVatTreatmentsOf over the kontoplan): an
   * item on an account that reports ruta 20-24 itself previews no basis pair
   * and that account's momssats, as the registration books it.
   */
  chartVatTreatments: ChartVatTreatments
  /** The invoice's default dimensions bag (kostnadsställe/projekt), when picked. */
  defaultDimensions?: Record<string, string>
  /** The invoice's own moms per rate, as the payload sends it (vat_breakdown). */
  statedVat?: StatedRateVat[] | null
}

/**
 * The rows as the create paths store them (lib/supplier-invoices/create.ts
 * over buildSupplierInvoicePayload): the line total and its moms as the
 * editor totals them, a reverse charge with no supplier moms and its
 * self-assessed rate, periodisering and SLP only where the payload sends
 * them, and the invoice's rounding as its own zero-VAT row.
 */
function bookingItems(
  items: ReviewLineItem[],
  itemTotals: Array<{ lineTotal: number; vatAmount: number }>,
  reverseCharge: boolean,
  roundingItem: { account_number: string; amount: number } | null,
): SupplierInvoiceBookingItem[] {
  const rows: SupplierInvoiceBookingItem[] = items.map((item, index) => ({
    account_number: item.account_number,
    line_total: itemTotals[index].lineTotal,
    vat_rate: reverseCharge ? 0 : item.vat_rate,
    vat_amount: reverseCharge ? 0 : itemTotals[index].vatAmount,
    reverse_charge_rate: reverseCharge ? (item.reverse_charge_rate ?? 0.25) : null,
    accrual_period_start: itemHasAccrual(item) ? item.accrual_period_start : null,
    accrual_period_end: itemHasAccrual(item) ? item.accrual_period_end : null,
    accrual_balance_account: itemHasAccrual(item) ? (item.accrual_balance_account ?? null) : null,
    dimensions: item.dimensions,
    apply_slp: item.apply_slp === true && !itemHasAccrual(item),
  }))
  if (roundingItem) {
    rows.push({
      account_number: roundingItem.account_number,
      line_total: roundingItem.amount,
      vat_rate: 0,
      vat_amount: 0,
      reverse_charge_rate: reverseCharge ? 0.25 : null,
    })
  }
  return rows
}

export function SupplierInvoiceReviewContent({
  supplier,
  invoiceNumber,
  invoiceDate,
  dueDate,
  deliveryDate,
  currency,
  exchangeRate,
  reverseCharge,
  reverseChargeKind,
  paymentReference,
  items,
  oreRounding,
  bookingMoment,
  chartVatTreatments,
  defaultDimensions,
  statedVat,
}: SupplierInvoiceReviewContentProps) {
  const t = useTranslations('supplier_invoice_editor')
  const { itemTotals, subtotal, totalVat, total, figures, roundingItem } = supplierInvoiceEditorAmounts(
    items, currency, reverseCharge, oreRounding, statedVat,
  )
  const parsedRate = exchangeRate ? parseFloat(exchangeRate) : NaN
  const fxRate = currency !== 'SEK' && Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 1
  // The description the engine will stamp on every line of this verifikat.
  // The ankomstnummer suffix the backend appends is deliberately absent: it is
  // assigned on save, so it does not exist yet at preview time. Everything
  // before it is byte-identical to what gets posted.
  const voucherDescription = buildSupplierDescription(
    'Leverantörsfaktura',
    invoiceNumber,
    supplier.name,
  )
  // Only a confirm that posts the registration verifikat gets its preview:
  // under kontantmetoden or deferred booking the 2440 shape below is never
  // written at registration.
  const showsVoucher = bookingMoment === 'issue'
  // The verifikat comes from supplierInvoiceRegistrationLines, the function
  // createSupplierInvoiceRegistrationEntry posts, over the rows as they will
  // be stored (crm#1190: a hand-kept copy here dropped the moms of every row
  // below zero). A foreign invoice without a rate previews at 1, as before;
  // the create paths refuse it. A line that nets to nothing on both sides is
  // left out of the table: it books nothing anyone can read.
  const journalLines = !showsVoucher ? [] : supplierInvoiceRegistrationLines(
    {
      currency,
      exchange_rate: currency === 'SEK' ? null : fxRate,
      reverse_charge: reverseCharge,
      reverse_charge_kind: reverseChargeKind ?? null,
      vat_treatment: inferVatTreatment(items, reverseCharge),
      default_dimensions: defaultDimensions,
      total,
    },
    bookingItems(items, itemTotals, reverseCharge, roundingItem),
    supplier.supplier_type,
    voucherDescription,
    chartVatTreatments,
  )
    .filter((line) => roundOre(line.debit_amount) !== 0 || roundOre(line.credit_amount) !== 0)
  const showingSek = fxRate !== 1

  // No account-label lookup any more: the BESKRIVNING column shows the
  // line_description that will actually be posted. A hardcoded label map
  // covering 11 accounts meant the column silently mixed "account label" (for
  // those) with "raw account number" (for every expense account), and neither
  // was the posted text. The account's own name stays available on the
  // AccountNumber hover card.

  return (
    <div className="space-y-4">
      {/* Supplier info */}
      <div className="bg-muted rounded-lg p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-2 sm:justify-between">
        <div className="min-w-0">
          <p className="font-medium text-base truncate">{supplier.name}</p>
          <p className="text-sm text-muted-foreground">{t('review_invoice_number_label', { number: invoiceNumber })}</p>
        </div>
        <div className="flex flex-wrap gap-1.5 sm:gap-2 shrink-0">
          {reverseCharge && (
            <Badge variant="warning">
              {t('reverse_charge_badge')}
            </Badge>
          )}
          {currency !== 'SEK' && (
            <Badge variant="outline" className="text-sm">
              {currency}
              {exchangeRate && t('review_currency_rate_suffix', { rate: exchangeRate })}
            </Badge>
          )}
        </div>
      </div>

      {/* Dates */}
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 sm:gap-4 text-sm">
        <div>
          <span className="text-muted-foreground">{t('invoice_date_label')}</span>
          <p className="font-medium">{formatDate(invoiceDate)}</p>
        </div>
        <div>
          <span className="text-muted-foreground">{t('due_date_label')}</span>
          <p className="font-medium">{formatDate(dueDate)}</p>
        </div>
        {deliveryDate && (
          <div>
            <span className="text-muted-foreground">{t('delivery_date_label')}</span>
            <p className="font-medium">{formatDate(deliveryDate)}</p>
          </div>
        )}
      </div>

      {/* Line items: table on desktop, cards on mobile */}
      <div className="hidden sm:block">
        <table className="w-full text-sm">
          <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
            <tr className="border-b text-left">
              <th className="py-2 w-20">{t('col_account')}</th>
              <th className="py-2">{t('col_description')}</th>
              <th className="py-2 w-28 text-right">{t('col_amount')}</th>
              <th className="py-2 w-16 text-right">{t('col_vat_rate')}</th>
              <th className="py-2 w-24 text-right">{t('col_vat')}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item, index) => {
              // For reverse charge the supplier charges 0%, so show the
              // self-assessed rate/amount the buyer books (matches the voucher
              // preview below). Manual vat_amount overrides only apply to
              // ordinary deductible VAT, never to RC self-assessment.
              const { vatRate: displayRate, vatAmount } = itemTotals[index]
              return (
                <tr key={index} className="border-b last:border-0">
                  <td className="py-2">
                    <AccountNumber number={item.account_number} size="sm" />
                  </td>
                  <td className="py-2">
                    {item.description}
                    {itemHasAccrual(item) && (
                      <div className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                        <CalendarDaysIcon className="h-3 w-3 shrink-0" />
                        <span className="tabular-nums">
                          {t('review_accrual_line_info', {
                            from: accrualMonth(item.accrual_period_start!),
                            to: accrualMonth(item.accrual_period_end!),
                          })}
                        </span>
                      </div>
                    )}
                  </td>
                  <td className="py-2 text-right tabular-nums">{formatAmount(item.amount)}</td>
                  <td className="py-2 text-right">{Math.round(displayRate * 100)}%</td>
                  <td className="py-2 text-right tabular-nums">{formatAmount(vatAmount)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="sm:hidden space-y-2">
        {items.map((item, index) => {
          const { vatRate: displayRate, vatAmount } = itemTotals[index]
          return (
            <div key={index} className="border rounded-lg p-3 text-sm space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="font-medium">{item.description}</p>
                <AccountNumber number={item.account_number} size="sm" />
              </div>
              {itemHasAccrual(item) && (
                <div className="flex items-center gap-1 text-xs text-muted-foreground">
                  <CalendarDaysIcon className="h-3 w-3 shrink-0" />
                  <span className="tabular-nums">
                    {t('review_accrual_line_info', {
                      from: accrualMonth(item.accrual_period_start!),
                      to: accrualMonth(item.accrual_period_end!),
                    })}
                  </span>
                </div>
              )}
              <div className="flex items-center justify-between text-muted-foreground">
                <span>{formatAmount(item.amount)} kr</span>
                <span className="text-xs">{t('review_vat_inline', { rate: Math.round(displayRate * 100), amount: formatAmount(vatAmount) })}</span>
              </div>
            </div>
          )
        })}
      </div>

      {/* Totals */}
      <div className="space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t('net_excl_vat')}</span>
          <span className="tabular-nums">{formatCurrency(subtotal, currency)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{reverseCharge ? t('vat_reverse_charge') : t('vat_label_short')}</span>
          <span className="tabular-nums">{formatCurrency(totalVat, currency)}</span>
        </div>
        {figures.rounding.applies && (
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t('ore_rounding_label')}</span>
            <span className="tabular-nums">{formatCurrency(figures.rounding.roundingDelta, currency)}</span>
          </div>
        )}
        <Separator />
        <div className="flex justify-between font-bold text-xl sm:text-2xl">
          <span>{t('total_payable_label')}</span>
          <span className="tabular-nums">{formatCurrency(figures.toPay, currency)}</span>
        </div>
        {currency !== 'SEK' && exchangeRate && (
          <div className="flex justify-between text-muted-foreground">
            <span>{t('review_sek_amount_at_rate', { rate: exchangeRate })}</span>
            <span className="tabular-nums">{formatCurrency(total * parseFloat(exchangeRate))}</span>
          </div>
        )}
      </div>

      {/* Verifikation preview */}
      {showsVoucher ? (
        <div className="bg-muted/50 border rounded-lg p-3 sm:p-4 space-y-2">
          <p className="text-sm font-semibold text-muted-foreground">
            {t('review_voucher_preview_title')}
            {showingSek && (
              <span className="ml-1.5 font-normal text-xs">{t('review_voucher_in_sek_suffix')}</span>
            )}
          </p>
          <VoucherLinesTable
            lines={voucherLineViews(journalLines)}
            showTotals
          />
          {figures.rounding.applies && (
            <p className="text-xs text-muted-foreground">
              {t('review_ore_rounding_note', {
                delta: formatCurrency(figures.rounding.roundingDelta, currency),
              })}
            </p>
          )}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          {bookingMoment === 'payment' ? t('review_books_at_payment') : t('review_books_on_book_step')}
        </p>
      )}

      {/* Payment reference */}
      {paymentReference && (
        <div className="border-t pt-3 text-sm text-muted-foreground">
          <p>{t('review_payment_reference_inline', { reference: paymentReference })}</p>
        </div>
      )}
    </div>
  )
}
