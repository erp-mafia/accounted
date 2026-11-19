import type { InvoiceItem } from '@/types'
import { creditedAmount } from './build-credit-note'

/**
 * One row of the kreditfaktura: the original's row with quantity, line total
 * and moms negated by their sign (creditedAmount), the unit price and rate
 * kept. Every row then reads as the original's turned around, a rabatt or
 * öresavrundning row included (it comes back positive), so the rows add up to
 * the credit note's header and the reversing verifikat (buildCreditNoteLines)
 * books each one on the other side of the original's.
 */
export function buildCreditNoteItem(invoiceId: string, item: InvoiceItem) {
  return {
    invoice_id: invoiceId,
    sort_order: item.sort_order,
    line_type: item.line_type ?? 'product',
    description: item.description,
    quantity: creditedAmount(item.quantity),
    unit: item.unit,
    unit_price: item.unit_price,
    // Carried so the kreditfaktura's face arithmetic still multiplies out
    // (antal x a-pris - rabatt = summa) and the PDF shows the same Rabatt
    // column the original did (ML 17 kap 24 §: prisnedsattningen ska framga).
    discount_percent: item.discount_percent ?? 0,
    line_total: creditedAmount(item.line_total),
    vat_rate: item.vat_rate ?? 0,
    vat_amount: creditedAmount(item.vat_amount),
    revenue_account: item.revenue_account ?? null,
    article_id: item.article_id ?? null,
    // The kreditfaktura prints the article number its original printed.
    article_number: item.article_number ?? null,
    deduction_type: item.deduction_type ?? null,
    // Positive magnitude, unlike the negated amounts above: invoice_items has
    // CHECK (deduction_amount >= 0). The reversing verifikat books 1513 from
    // this (generateRotRutLines), so the kreditfaktura reverses exactly the
    // amount the original booked.
    deduction_amount: item.deduction_amount
      ? Math.abs(item.deduction_amount)
      : 0,
    labor_hours: item.labor_hours ?? null,
    work_type: item.work_type ?? null,
    housing_designation: item.housing_designation ?? null,
    apartment_number: item.apartment_number ?? null,
    brf_org_number: item.brf_org_number ?? null,
    accrual_period_start: item.accrual_period_start ?? null,
    accrual_period_end: item.accrual_period_end ?? null,
    accrual_balance_account: item.accrual_balance_account ?? null,
    dimensions: item.dimensions ?? {},
  }
}
