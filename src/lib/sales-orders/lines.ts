import type { Customer, SalesOrderItemInput } from '@/types'
import { getVatRules, getPermittedVatRates } from '@/lib/invoices/vat-rules'
import { computeLineNet } from '@/lib/invoices/line-amounts'
import { roundOre } from '@/lib/money'

/**
 * Order-line normalisation + totals.
 *
 * Same line math as invoices (computeLineNet: net of the percentage
 * discount, öre-exact) and the same per-customer VAT gating, so an order
 * that saves here always converts into an invoice buildInvoiceWriteData()
 * accepts. Order totals are informational (the order never books); the
 * invoice recomputes its own totals from the lines it is given.
 */
export interface SalesOrderLineRow {
  id?: string
  sort_order: number
  line_type: 'product' | 'text'
  description: string
  quantity: number
  unit: string
  unit_price: number
  discount_percent: number
  vat_rate: number
  line_total: number
  article_id: string | null
  revenue_account: string | null
  dimensions: Record<string, string>
}

export interface SalesOrderTotals {
  subtotal: number
  vat_amount: number
  total: number
}

export type NormalizeLinesResult =
  | { ok: true; rows: SalesOrderLineRow[]; totals: SalesOrderTotals }
  | { ok: false; code: string; details?: Record<string, unknown> }

export function normalizeSalesOrderLines(
  items: SalesOrderItemInput[],
  customer: Pick<Customer, 'customer_type' | 'vat_number_validated'> & { country?: string | null },
): NormalizeLinesResult {
  const vatRules = getVatRules(customer.customer_type, customer.vat_number_validated, customer.country)
  const allowed = new Set(
    getPermittedVatRates(customer.customer_type, customer.vat_number_validated, customer.country).map((r) => r.rate),
  )

  const rows: SalesOrderLineRow[] = []
  let subtotal = 0
  let vat = 0

  for (let index = 0; index < items.length; index++) {
    const item = items[index]
    if (item.line_type === 'text') {
      rows.push({
        id: item.id,
        sort_order: index,
        line_type: 'text',
        description: item.description,
        quantity: 0,
        unit: '',
        unit_price: 0,
        discount_percent: 0,
        vat_rate: 0,
        line_total: 0,
        article_id: null,
        revenue_account: null,
        dimensions: {},
      })
      continue
    }
    const rate = item.vat_rate !== undefined ? item.vat_rate : vatRules.rate
    if (!allowed.has(rate)) {
      // Same envelope the invoice builder answers for a rate the customer
      // type does not permit (e.g. 25 % to a validated EU business).
      return {
        ok: false,
        code: 'INVOICE_CREATE_VAT_RULE_VIOLATION',
        details: {
          attemptedRate: rate,
          allowedRates: Array.from(allowed),
          customerType: customer.customer_type,
          line: index,
        },
      }
    }
    const discount = item.discount_percent ?? 0
    const lineTotal = computeLineNet(item.quantity, item.unit_price, discount)
    const lineVat = roundOre((lineTotal * rate) / 100)
    subtotal = roundOre(subtotal + lineTotal)
    vat = roundOre(vat + lineVat)
    rows.push({
      id: item.id,
      sort_order: index,
      line_type: 'product',
      description: item.description,
      quantity: item.quantity,
      unit: item.unit,
      unit_price: item.unit_price,
      discount_percent: discount,
      vat_rate: rate,
      line_total: lineTotal,
      article_id: item.article_id ?? null,
      revenue_account: item.revenue_account ?? null,
      dimensions: item.dimensions ?? {},
    })
  }

  return {
    ok: true,
    rows,
    totals: { subtotal, vat_amount: vat, total: roundOre(subtotal + vat) },
  }
}
