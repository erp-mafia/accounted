import { computeLineVat } from '@/lib/bookkeeping/invoice-line-amounts'
import { ORE_TOLERANCE, roundOre, sumOre } from '@/lib/money'
import { formatPdfAmount, formatPdfCurrency, type PdfLang } from '@/lib/invoices/pdf/format'
import { quoteInvoicingProgress, type QuoteInvoicingProgress } from './quote-status'

export { quoteInvoicingProgress, type QuoteInvoicingProgress }

/**
 * Invoicing a quote (offert) in parts (crm#1196): a fixed-price job billed
 * 50 % at acceptance and 50 % at delivery, or 30/30/40, from ONE quote.
 *
 * There is no ledger of parts. Invoiced so far is the net of the live
 * invoices converted from the quote (invoices.converted_from_id), the same
 * link a whole conversion has always written; a cancelled invoice frees its
 * part again. The database refuses a conversion that would take the invoices
 * past the quote's net (invoices_converted_source_guard, migration
 * 20261015120000), so two concurrent conversions cannot both bill the rest.
 *
 * Shape of a part invoice: every product line of the quote, in its own
 * position, with its own VAT rate, revenue account, article and dimensions,
 * billing its share of the line's net as one unit (quantity 1, unit price =
 * the share, no discount: the quote's discount is already in the line net).
 * VAT is computed per line on that share, so the beskattningsunderlag per
 * skattesats on the invoice is exact (ML 17 kap 24 § p.9-11), and the
 * invoice notes say which part of which quote it bills (p.7). The notes reach
 * both the PDF and the Peppol cbc:Note; Peppol drops text lines, so the
 * reference must not live in a text line.
 *
 * The last part takes the remainder: each group of lines that books alike
 * (VAT rate, revenue account, article, dimensions) gets exactly what its
 * earlier parts left, so the parts sum to the quote to the öre per rate.
 */

/** Which part of a quote to invoice: a percent of its net, or a net amount. */
export type QuoteInvoicePart = { percent: number; amount?: undefined } | { amount: number; percent?: undefined }

/** A quote line as the conversion reads it (invoice_items of the quote). */
export interface QuoteSourceLine {
  sort_order: number
  line_type?: 'product' | 'text' | null
  description: string
  quantity: number
  unit: string
  unit_price: number
  discount_percent?: number | null
  line_total: number
  vat_rate?: number | null
  vat_amount?: number | null
  revenue_account?: string | null
  article_id?: string | null
  /** The article number the quote printed, frozen on its line (crm#1084). */
  article_number?: string | null
  sales_order_item_id?: string | null
  dimensions?: Record<string, string> | null
}

/** A live invoice converted from the quote, with the lines it billed. */
export interface QuoteConversion {
  status: string
  subtotal?: number | string | null
  items?: Array<{
    line_type?: string | null
    line_total?: number | string | null
    vat_rate?: number | string | null
    revenue_account?: string | null
    article_id?: string | null
    dimensions?: Record<string, string> | null
  }> | null
}

export type ResolvedQuotePart =
  /** `rest`: the part is everything not yet invoiced. */
  | { ok: true; amount: number; rest: boolean; progress: QuoteInvoicingProgress }
  | { ok: false; code: 'INVOICE_QUOTE_ALREADY_INVOICED'; progress: QuoteInvoicingProgress }
  | {
      ok: false
      code: 'INVOICE_QUOTE_PART_OUT_OF_RANGE'
      progress: QuoteInvoicingProgress
      requested: number
    }

/**
 * The net amount the next invoice from a quote bills.
 *
 * No part: everything not yet invoiced (the whole quote the first time).
 * A percent is of the quote's net, not of what remains: "50 %" twice
 * invoices the quote once. A request within rounding of what remains is the
 * remainder: each earlier part rounded to the öre, so 30 % + 30 % + 40 % of
 * 100,01 is 30,00 + 30,00 + 40,01, never a 0,01 left over. Half an öre per
 * invoice is the most that rounding can have moved it, so the band cannot
 * swallow a real difference.
 */
export function resolveQuotePart(
  quote: { subtotal?: number | string | null },
  conversions: ReadonlyArray<QuoteConversion> | null | undefined,
  part?: QuoteInvoicePart | null,
): ResolvedQuotePart {
  const progress = quoteInvoicingProgress(quote, conversions)
  if (progress.fullyInvoiced) return { ok: false, code: 'INVOICE_QUOTE_ALREADY_INVOICED', progress }
  if (!part) return { ok: true, amount: progress.remaining, rest: true, progress }

  const requested =
    part.percent !== undefined
      ? roundOre((progress.quoteSubtotal * part.percent) / 100)
      : roundOre(part.amount)
  const slack = ORE_TOLERANCE * (progress.invoiceCount + 1) + 1e-9
  if (progress.remaining > 0 && Math.abs(requested - progress.remaining) <= slack) {
    return { ok: true, amount: progress.remaining, rest: true, progress }
  }
  if (requested <= 0 || requested > progress.remaining) {
    return { ok: false, code: 'INVOICE_QUOTE_PART_OUT_OF_RANGE', progress, requested }
  }
  return { ok: true, amount: requested, rest: false, progress }
}

/** An invoice_items row of a part invoice (invoice_id is added by the caller). */
export interface QuotePartLine {
  sort_order: number
  line_type: 'product' | 'text'
  description: string
  quantity: number
  unit: string
  unit_price: number
  discount_percent: number
  line_total: number
  vat_rate: number
  vat_amount: number
  revenue_account: string | null
  article_id: string | null
  article_number: string | null
  sales_order_item_id: null
  dimensions: Record<string, string>
}

function isProduct(line: { line_type?: string | null }): boolean {
  return line.line_type !== 'text'
}

/** Lines that book alike share a key: what they bill can move between them without changing a verifikat. */
function bookingKey(line: {
  vat_rate?: number | string | null
  revenue_account?: string | null
  article_id?: string | null
  dimensions?: Record<string, string> | null
}): string {
  const dims = Object.entries(line.dimensions ?? {})
    .filter(([, value]) => value !== '' && value != null)
    .sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify([Number(line.vat_rate ?? 0), line.revenue_account ?? null, line.article_id ?? null, dims])
}

/**
 * Split `amount` over `weights` in proportion, to the öre, summing exactly
 * to `amount`: the rounding difference lands on the heaviest weight (all of
 * it when the weights sum to zero).
 */
export function splitByWeight(amount: number, weights: readonly number[]): number[] {
  if (weights.length === 0) return []
  let heaviest = 0
  for (let i = 1; i < weights.length; i++) {
    if (Math.abs(weights[i]) > Math.abs(weights[heaviest])) heaviest = i
  }
  const total = sumOre(weights)
  const shares =
    total === 0
      ? weights.map(() => 0)
      : weights.map((weight) => roundOre((amount * weight) / total))
  shares[heaviest] = roundOre(shares[heaviest] + roundOre(amount - sumOre(shares)))
  return shares
}

/**
 * The remainder per booking group, or null when the earlier invoices cannot
 * be attributed to the quote's lines (a converted draft was edited onto a
 * rate or account the quote does not have): the caller then splits the rest
 * in proportion instead.
 */
function remainderByGroup(
  product: readonly QuoteSourceLine[],
  conversions: ReadonlyArray<QuoteConversion>,
  amount: number,
): number[] | null {
  const groupTotals = new Map<string, number>()
  for (const line of product) {
    const key = bookingKey(line)
    groupTotals.set(key, roundOre((groupTotals.get(key) ?? 0) + Number(line.line_total)))
  }
  const invoicedByGroup = new Map<string, number>()
  for (const conversion of conversions) {
    if (conversion.status === 'cancelled') continue
    for (const item of conversion.items ?? []) {
      if (!isProduct(item)) continue
      const key = bookingKey(item)
      if (!groupTotals.has(key)) {
        if (Number(item.line_total ?? 0) !== 0) return null
        continue
      }
      invoicedByGroup.set(key, roundOre((invoicedByGroup.get(key) ?? 0) + Number(item.line_total ?? 0)))
    }
  }
  const remainders = new Map<string, number>()
  for (const [key, total] of groupTotals) {
    remainders.set(key, roundOre(total - (invoicedByGroup.get(key) ?? 0)))
  }
  if (Math.abs(sumOre([...remainders.values()]) - amount) > ORE_TOLERANCE) return null

  const shares = new Array<number>(product.length).fill(0)
  for (const [key, remainder] of remainders) {
    const members = product.map((line, index) => ({ line, index })).filter(({ line }) => bookingKey(line) === key)
    const split = splitByWeight(remainder, members.map(({ line }) => Number(line.line_total)))
    members.forEach(({ index }, i) => {
      shares[index] = split[i]
    })
  }
  return shares
}

/**
 * The lines of a part invoice billing `amount` of the quote. Text lines are
 * kept in place so the invoice reads like the quote; a product line whose
 * share is zero is left out.
 */
export function buildQuotePartLines(params: {
  lines: readonly QuoteSourceLine[]
  amount: number
  rest: boolean
  conversions: ReadonlyArray<QuoteConversion>
}): QuotePartLine[] {
  const ordered = [...params.lines].sort((a, b) => a.sort_order - b.sort_order)
  const product = ordered.filter(isProduct)
  const shares =
    (params.rest ? remainderByGroup(product, params.conversions, params.amount) : null) ??
    splitByWeight(params.amount, product.map((line) => Number(line.line_total)))
  const shareOf = new Map(product.map((line, index) => [line, shares[index]]))

  const out: QuotePartLine[] = []
  for (const line of ordered) {
    if (!isProduct(line)) {
      out.push({
        sort_order: out.length,
        line_type: 'text',
        description: line.description,
        quantity: 0,
        unit: '',
        unit_price: 0,
        discount_percent: 0,
        line_total: 0,
        vat_rate: 0,
        vat_amount: 0,
        revenue_account: null,
        article_id: null,
        article_number: null,
        sales_order_item_id: null,
        dimensions: {},
      })
      continue
    }
    const share = shareOf.get(line) ?? 0
    if (share === 0) continue
    const vatRate = Number(line.vat_rate ?? 0)
    out.push({
      sort_order: out.length,
      line_type: 'product',
      description: line.description,
      quantity: 1,
      unit: 'st',
      unit_price: share,
      discount_percent: 0,
      line_total: share,
      vat_rate: vatRate,
      vat_amount: computeLineVat(share, vatRate),
      revenue_account: line.revenue_account ?? null,
      article_id: line.article_id ?? null,
      article_number: line.article_number ?? null,
      sales_order_item_id: null,
      dimensions: line.dimensions ?? {},
    })
  }
  return out
}

/** Header totals of a part invoice: the sum of its lines, as the invoice builder sums them. */
export function quotePartTotals(lines: readonly QuotePartLine[]): {
  subtotal: number
  vat_amount: number
  total: number
} {
  const product = lines.filter(isProduct)
  const subtotal = sumOre(product.map((line) => line.line_total))
  const vatAmount = sumOre(product.map((line) => line.vat_amount))
  return { subtotal, vat_amount: vatAmount, total: roundOre(subtotal + vatAmount) }
}

/**
 * The sentence a part invoice carries in its notes, in the document's
 * language: which quote, how much of it, and what was invoiced before.
 */
export function quotePartNote(params: {
  language: PdfLang
  quoteNumber: string | null
  quoteSubtotal: number
  amount: number
  invoicedBefore: number
  currency: string
}): string {
  const { language, quoteSubtotal, amount, invoicedBefore, currency } = params
  const number = params.quoteNumber ?? ''
  const percent = quoteSubtotal > 0 ? formatPercent((amount / quoteSubtotal) * 100, language) : null
  const part = formatPdfAmount(amount, language)
  const whole = formatPdfCurrency(quoteSubtotal, currency, language)
  const before = formatPdfCurrency(invoicedBefore, currency, language)
  if (language === 'en') {
    return (
      `Partial invoice of quote ${number}: ${part} of ${whole} excl. VAT${percent ? ` (${percent})` : ''}.` +
      (invoicedBefore > 0 ? ` Previously invoiced: ${before}.` : '')
    )
  }
  return (
    `Delfakturering av offert ${number}: ${part} av ${whole} exkl. moms${percent ? ` (${percent})` : ''}.` +
    (invoicedBefore > 0 ? ` Tidigare fakturerat: ${before}.` : '')
  )
}

function formatPercent(value: number, language: PdfLang): string {
  const formatted = new Intl.NumberFormat(language === 'en' ? 'en-US' : 'sv-SE', {
    maximumFractionDigits: 2,
  }).format(roundOre(value))
  return language === 'en' ? `${formatted}%` : `${formatted} %`
}
