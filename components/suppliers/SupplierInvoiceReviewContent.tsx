'use client'

import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { AccountNumber } from '@/components/ui/account-number'
import { formatCurrency } from '@/lib/utils'
import {
  resolveReverseChargeRate,
  isReverseChargeBasisAccount,
  generateReverseChargeBasisLines,
} from '@/lib/bookkeeping/vat-entries'
import type { Supplier } from '@/types'

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
}

interface SupplierInvoiceReviewContentProps {
  supplier: Supplier
  invoiceNumber: string
  invoiceDate: string
  dueDate: string
  deliveryDate?: string
  currency: string
  exchangeRate?: string
  reverseCharge: boolean
  paymentReference?: string
  items: ReviewLineItem[]
  subtotal: number
  totalVat: number
  total: number
}

function formatAmount(amount: number): string {
  return amount.toLocaleString('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

interface JournalPreviewLine {
  account_number: string
  description: string
  debit: number
  credit: number
}

function getOutputVatAccount(rate: number): string {
  if (rate === 0.12) return '2624'
  if (rate === 0.06) return '2634'
  return '2614'
}

function buildJournalPreview(
  items: ReviewLineItem[],
  subtotal: number,
  totalVat: number,
  total: number,
  reverseCharge: boolean,
  supplierType: string | undefined,
  // FX multiplier applied to every amount. 1 when the invoice is in SEK or
  // when no rate is set. Matches what the backend writes — items go through
  // resolveSekAmount(item.line_total, null, currency, exchange_rate), so the
  // saved verifikation is always in SEK, never in invoice currency.
  fxRate: number,
): JournalPreviewLine[] {
  const lines: JournalPreviewLine[] = []
  const toSek = (n: number) => Math.round(n * fxRate * 100) / 100

  // Aggregate expense amounts by account number (in SEK)
  const expenseByAccount = new Map<string, number>()
  for (const item of items) {
    const current = expenseByAccount.get(item.account_number) || 0
    expenseByAccount.set(item.account_number, current + toSek(item.amount))
  }

  // Debit: Expense accounts
  for (const [accountNumber, amount] of expenseByAccount) {
    lines.push({
      account_number: accountNumber,
      description: accountNumber,
      debit: amount,
      credit: 0,
    })
  }

  // Per-line effective VAT — manual override wins over computed amount × rate.
  // The engine reads stored vat_amount; the preview must reflect the same.
  const itemVat = (item: ReviewLineItem) =>
    item.vat_amount != null
      ? Math.round(item.vat_amount * 100) / 100
      : Math.round(item.amount * item.vat_rate * 100) / 100

  if (reverseCharge) {
    // Reverse charge: the supplier charges no VAT, so the buyer self-assesses at
    // the Swedish statutory rate (resolveReverseChargeRate — 25% huvudregel
    // default, or the per-item reverse_charge_rate). We book BOTH the fiktiv-moms
    // pair (2645/2647 + 2614/2624/2634) AND the basbeloppsrader (44xx/45xx +
    // 4598), exactly as the engine does, so this preview matches the saved
    // verifikat. ML 16 kap requires both sides reported; silent netting is
    // prohibited (Skatteverket felkod FK004). Driving off the resolved rate (not
    // item.vat_rate) is what makes a 0%-rate RC line book its VAT at all.
    const isDomesticRC = supplierType === 'swedish_business'
    const inputAccount = isDomesticRC ? '2647' : '2645'
    const rcSupplierType: 'eu_business' | 'non_eu_business' | 'swedish_business' =
      supplierType === 'non_eu_business' || supplierType === 'swedish_business'
        ? supplierType
        : 'eu_business'

    // Base per self-assessed rate, plus the non-basis-account portion that needs
    // parallel basbeloppsrader (items booked straight to a 44xx/45xx basis
    // account already populate ruta 20-24 via the expense line, so they're
    // excluded there to avoid double-counting).
    const baseByRate = new Map<number, number>()
    const nonBasisBaseByRate = new Map<number, number>()
    for (const item of items) {
      const rate = resolveReverseChargeRate(item)
      const sek = toSek(item.amount)
      baseByRate.set(rate, (baseByRate.get(rate) || 0) + sek)
      if (!isReverseChargeBasisAccount(item.account_number)) {
        nonBasisBaseByRate.set(rate, (nonBasisBaseByRate.get(rate) || 0) + sek)
      }
    }

    for (const [rate, netAmount] of baseByRate) {
      if (netAmount <= 0) continue
      const fiktivVat = Math.round(netAmount * rate * 100) / 100
      const outputAccount = getOutputVatAccount(rate)
      lines.push({
        account_number: inputAccount,
        description: inputAccount,
        debit: fiktivVat,
        credit: 0,
      })
      lines.push({
        account_number: outputAccount,
        description: outputAccount,
        debit: 0,
        credit: fiktivVat,
      })
      const nonBasisBase = nonBasisBaseByRate.get(rate) || 0
      if (nonBasisBase > 0) {
        for (const bl of generateReverseChargeBasisLines(nonBasisBase, rate, rcSupplierType)) {
          lines.push({
            account_number: bl.account_number,
            description: bl.line_description ?? bl.account_number,
            debit: bl.debit_amount,
            credit: bl.credit_amount,
          })
        }
      }
    }

    // Credit: 2440 at subtotal (no real VAT for reverse charge)
    lines.push({
      account_number: '2440',
      description: 'Leverantörsskulder',
      debit: 0,
      credit: toSek(subtotal),
    })
  } else {
    if (totalVat > 0) {
      // Sum per-rate using effective (manual-or-computed) VAT, so the preview
      // matches what groupVatByRate will write to 2641 server-side.
      const vatByRate = new Map<number, number>()
      for (const item of items) {
        const v = itemVat(item)
        if (v > 0) {
          vatByRate.set(item.vat_rate, (vatByRate.get(item.vat_rate) || 0) + v)
        }
      }
      for (const [, vat] of vatByRate) {
        lines.push({
          account_number: '2641',
          description: 'Ingående moms',
          debit: toSek(vat),
          credit: 0,
        })
      }
    }
    // Credit: 2440 at total incl. VAT
    lines.push({
      account_number: '2440',
      description: 'Leverantörsskulder',
      debit: 0,
      credit: toSek(total),
    })
  }

  return lines
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
  paymentReference,
  items,
  subtotal,
  totalVat,
  total,
}: SupplierInvoiceReviewContentProps) {
  const t = useTranslations('supplier_invoice_editor')
  const parsedRate = exchangeRate ? parseFloat(exchangeRate) : NaN
  const fxRate = currency !== 'SEK' && Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : 1
  const journalLines = buildJournalPreview(items, subtotal, totalVat, total, reverseCharge, supplier.supplier_type, fxRate)
  const totalDebit = journalLines.reduce((sum, l) => sum + l.debit, 0)
  const totalCredit = journalLines.reduce((sum, l) => sum + l.credit, 0)
  const showingSek = fxRate !== 1

  const ACCOUNT_LABELS: Record<string, string> = {
    '2440': t('account_2440'),
    '2641': t('account_2641'),
    '2645': t('account_2645'),
    '2647': t('account_2647'),
    '2614': t('account_2614'),
    '2624': t('account_2624'),
    '2634': t('account_2634'),
  }

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
            <Badge variant="outline" className="border-orange-300 text-orange-700 dark:text-orange-400">
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
          <p className="font-medium">{invoiceDate}</p>
        </div>
        <div>
          <span className="text-muted-foreground">{t('due_date_label')}</span>
          <p className="font-medium">{dueDate}</p>
        </div>
        {deliveryDate && (
          <div>
            <span className="text-muted-foreground">{t('delivery_date_label')}</span>
            <p className="font-medium">{deliveryDate}</p>
          </div>
        )}
      </div>

      {/* Line items — table on desktop, cards on mobile */}
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
              const displayRate = reverseCharge ? resolveReverseChargeRate(item) : item.vat_rate
              const vatAmount = reverseCharge
                ? Math.round(item.amount * displayRate * 100) / 100
                : item.vat_amount != null
                  ? Math.round(item.vat_amount * 100) / 100
                  : Math.round(item.amount * item.vat_rate * 100) / 100
              return (
                <tr key={index} className="border-b last:border-0">
                  <td className="py-2">
                    <AccountNumber number={item.account_number} size="sm" />
                  </td>
                  <td className="py-2">{item.description}</td>
                  <td className="py-2 text-right font-mono">{formatAmount(item.amount)}</td>
                  <td className="py-2 text-right">{Math.round(displayRate * 100)}%</td>
                  <td className="py-2 text-right font-mono">{formatAmount(vatAmount)}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
      <div className="sm:hidden space-y-2">
        {items.map((item, index) => {
          const displayRate = reverseCharge ? resolveReverseChargeRate(item) : item.vat_rate
          const vatAmount = reverseCharge
            ? Math.round(item.amount * displayRate * 100) / 100
            : item.vat_amount != null
              ? Math.round(item.vat_amount * 100) / 100
              : Math.round(item.amount * item.vat_rate * 100) / 100
          return (
            <div key={index} className="border rounded-lg p-3 text-sm space-y-1.5">
              <div className="flex items-center justify-between">
                <p className="font-medium">{item.description}</p>
                <AccountNumber number={item.account_number} size="sm" />
              </div>
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
          <span>{formatCurrency(subtotal, currency)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{reverseCharge ? t('vat_reverse_charge') : t('vat_label_short')}</span>
          <span>{formatCurrency(totalVat, currency)}</span>
        </div>
        <Separator />
        <div className="flex justify-between font-bold text-xl sm:text-2xl">
          <span>{t('total_label')}</span>
          <span>{formatCurrency(total, currency)}</span>
        </div>
        {currency !== 'SEK' && exchangeRate && (
          <div className="flex justify-between text-muted-foreground">
            <span>{t('review_sek_amount_at_rate', { rate: exchangeRate })}</span>
            <span>{formatCurrency(total * parseFloat(exchangeRate))}</span>
          </div>
        )}
      </div>

      {/* Verifikation preview */}
      <div className="bg-muted/50 border rounded-lg p-3 sm:p-4 space-y-2">
        <p className="text-sm font-semibold text-muted-foreground">
          {t('review_voucher_preview_title')}
          {showingSek && (
            <span className="ml-1.5 font-normal text-xs">{t('review_voucher_in_sek_suffix')}</span>
          )}
        </p>
        <div className="hidden sm:block">
          <table className="w-full text-sm font-mono">
            <thead className="[&_th]:font-medium [&_th]:text-[11px] [&_th]:uppercase [&_th]:tracking-wider [&_th]:text-muted-foreground">
              <tr className="text-left">
                <th className="pb-1 w-16">{t('col_account')}</th>
                <th className="pb-1">{t('col_description')}</th>
                <th className="pb-1 w-24 text-right">{t('col_debit')}</th>
                <th className="pb-1 w-24 text-right">{t('col_credit')}</th>
              </tr>
            </thead>
            <tbody>
              {journalLines.map((line, index) => (
                <tr key={index} className="border-b border-dashed border-muted-foreground/20 last:border-0">
                  <td className="py-1">
                    <AccountNumber number={line.account_number} size="sm" />
                  </td>
                  <td className="py-1 text-xs">
                    {ACCOUNT_LABELS[line.account_number] || line.description}
                  </td>
                  <td className="py-1 text-right">
                    {line.debit > 0 ? formatAmount(line.debit) : ''}
                  </td>
                  <td className="py-1 text-right">
                    {line.credit > 0 ? formatAmount(line.credit) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="border-t font-semibold">
                <td className="pt-1" colSpan={2}>{t('sum_label')}</td>
                <td className="pt-1 text-right">{formatAmount(totalDebit)}</td>
                <td className="pt-1 text-right">{formatAmount(totalCredit)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div className="sm:hidden space-y-1.5 text-sm">
          {journalLines.map((line, index) => (
            <div key={index} className="flex items-center justify-between py-1 border-b border-dashed border-muted-foreground/20 last:border-0">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <AccountNumber number={line.account_number} size="sm" />
                  <span className="text-xs text-muted-foreground truncate">
                    {ACCOUNT_LABELS[line.account_number] || line.description}
                  </span>
                </div>
              </div>
              <span className="font-mono text-xs shrink-0 ml-2">
                {line.debit > 0 ? t('debit_short', { amount: formatAmount(line.debit) }) : t('credit_short', { amount: formatAmount(line.credit) })}
              </span>
            </div>
          ))}
          <div className="flex justify-between pt-1 border-t font-semibold text-xs font-mono">
            <span>{t('sum_label')}</span>
            <span>{t('debit_credit_short', { debit: formatAmount(totalDebit), credit: formatAmount(totalCredit) })}</span>
          </div>
        </div>
      </div>

      {/* Payment reference */}
      {paymentReference && (
        <div className="border-t pt-3 text-sm text-muted-foreground">
          <p>{t('review_payment_reference_inline', { reference: paymentReference })}</p>
        </div>
      )}
    </div>
  )
}
