import type { InvoiceItem } from '@/types'

export function buildCreditNoteItem(invoiceId: string, item: InvoiceItem) {
  return {
    invoice_id: invoiceId,
    sort_order: item.sort_order,
    line_type: item.line_type ?? 'product',
    description: item.description,
    quantity: -Math.abs(item.quantity),
    unit: item.unit,
    unit_price: item.unit_price,
    line_total: -Math.abs(item.line_total),
    vat_rate: item.vat_rate ?? 0,
    vat_amount: -(item.vat_amount ? Math.abs(item.vat_amount) : 0),
    revenue_account: item.revenue_account ?? null,
    article_id: item.article_id ?? null,
    deduction_type: item.deduction_type ?? null,
    deduction_amount: item.deduction_amount
      ? -Math.abs(item.deduction_amount)
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
