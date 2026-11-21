import { computeLineVat } from '@/lib/bookkeeping/invoice-line-amounts'
import { roundOre } from '@/lib/money'

/**
 * One VAT row of the totals block on an invoice's own page. rate null: the
 * plain "Moms" label.
 */
export interface DetailVatRow {
  key: string
  rate: number | null
  amount: number
}

/**
 * The VAT rows of the totals block on an invoice's own page, per rate.
 *
 * A rate is shown when its VAT is not zero, whatever the sign: a
 * kreditfaktura stores its moms negated (buildCreditNoteItem), and its page
 * must show "Moms 25 % -250 kr" as its PDF does (pdf-template), not drop
 * every rate and print "Moms 0 kr" under a total that includes the moms.
 *
 * Pure: the page renders what this returns.
 */
export function buildDetailVatRows(input: {
  items: ReadonlyArray<{ vat_rate?: number | null; vat_amount?: number | null; line_total: number }>
  /** The invoice was registered from the books: its header holds the VAT, its lines none. */
  registeredFromBooks: boolean
  headerVatAmount: number
  headerVatRate: number | null | undefined
  vatRegistered: boolean
}): DetailVatRow[] {
  const vatByRate = new Map<number, number>()
  for (const item of input.items) {
    const rate = item.vat_rate ?? 0
    // The stored line VAT is what the invoice states and booked (the PDF
    // prints the same); a legacy row that carries none is recomputed with
    // the rule the builder stores (crm#1343).
    const lineVat = item.vat_amount || computeLineVat(item.line_total, rate)
    vatByRate.set(rate, roundOre((vatByRate.get(rate) || 0) + lineVat))
  }
  const entries = Array.from(vatByRate.entries())
    .filter(([, vat]) => vat !== 0)
    .sort(([a], [b]) => b - a)
  if (entries.length > 0) {
    return entries.map(([rate, vat]) => ({ key: String(rate), rate, amount: vat }))
  }
  // crm#1131: a registration from the books has no lines to sum; its header
  // holds the VAT its verifikat booked, at one rate. Summing nothing printed
  // "Moms 0" under a total that includes it.
  if (input.registeredFromBooks && input.headerVatAmount !== 0) {
    return [{ key: 'header', rate: input.headerVatRate || null, amount: input.headerVatAmount }]
  }
  if (!input.vatRegistered && input.headerVatAmount === 0) return []
  return [{ key: 'zero', rate: null, amount: 0 }]
}
