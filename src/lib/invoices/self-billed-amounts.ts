/**
 * The amounts of a received self-billing invoice (mottagen självfaktura), in
 * one place for the registration (self-billed-sale.ts) and the editor's
 * Summering, so the screen shows exactly what registering it books.
 *
 * Each line's net is the whole-öre rule buildInvoiceWriteData applies
 * (computeLineNet; the self-billed item shape carries no discount). The VAT
 * is the customer's document's: on the summed base per rate, or the figure
 * the document states (vat_breakdown), spread over the lines
 * (lib/vat/document-vat.ts, crm#1367). Rates are in percent, as the
 * self-billed items carry them. Pure and client-safe.
 */
import { computeLineNet } from '@/lib/bookkeeping/invoice-line-amounts'
import { roundOre } from '@/lib/money'
import { allocateDocumentVat, type DocumentVatMismatch } from '@/lib/vat/document-vat'

export interface SelfBilledAmountItem {
  quantity: number
  unit_price: number
  /** Percent (25). Omitted: the customer's default rate. */
  vat_rate?: number | null
}

export interface SelfBilledLineAmounts {
  line_total: number
  /** Percent (25). */
  vat_rate: number
  vat_amount: number
}

export interface SelfBilledAmounts {
  ok: true
  lines: SelfBilledLineAmounts[]
  subtotal: number
  vatAmount: number
  total: number
  /** VAT per rate (percent), highest rate first. */
  byRate: Array<{ rate: number; base: number; vat: number }>
}

export function selfBilledSaleAmounts(
  items: ReadonlyArray<SelfBilledAmountItem>,
  defaultRate: number,
  statedVat?: ReadonlyArray<{ vat_rate: number; vat_amount: number }> | null,
): SelfBilledAmounts | DocumentVatMismatch {
  const nets = items.map((item) => ({
    lineTotal: computeLineNet(item.quantity, item.unit_price),
    rate: item.vat_rate ?? defaultRate,
  }))
  const allocated = allocateDocumentVat(
    nets.map((line) => ({ lineTotal: line.lineTotal, rate: line.rate / 100 })),
    statedVat?.map((entry) => ({ rate: entry.vat_rate / 100, vatAmount: entry.vat_amount })) ?? null,
  )
  if (!allocated.ok) return allocated

  const lines = nets.map((line, index) => ({
    line_total: line.lineTotal,
    vat_rate: line.rate,
    vat_amount: allocated.lineVat[index],
  }))
  const subtotal = roundOre(lines.reduce((sum, line) => sum + line.line_total, 0))
  const vatAmount = roundOre(lines.reduce((sum, line) => sum + line.vat_amount, 0))
  return {
    ok: true,
    lines,
    subtotal,
    vatAmount,
    total: roundOre(subtotal + vatAmount),
    // The helper's rate is a fraction; the self-billed items speak percent.
    byRate: allocated.byRate.map((group) => ({ rate: Math.round(group.rate * 100), base: group.base, vat: group.vat })),
  }
}
