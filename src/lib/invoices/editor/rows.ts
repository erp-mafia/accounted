import { countCalendarMonths } from '@/lib/bookkeeping/accruals/compute'
import { hasLineDiscount } from '@/lib/invoices/line-amounts'

/**
 * The invoice editor's row table: which optional columns it carries and
 * which badges a row shows. Every option set through a row's menu gets a
 * visible badge, so the menu is never the only place that says a row is
 * special; the columns that are the same on every row stay out.
 *
 * Pure: the component renders what these return.
 */

/**
 * The Moms column, only when a row's rate differs from the customer's
 * default. When every row carries the default it adds nothing a reader
 * needs (Summering shows the VAT), and a rate is changed from the row menu
 * ("Ändra moms"), which then brings the column in.
 */
export function shouldShowVatColumn(input: {
  vatRegistered: boolean
  defaultRate: number
  /** The rates of the priced rows (text rows excluded), as stored. */
  rates: ReadonlyArray<number | null | undefined>
}): boolean {
  if (!input.vatRegistered) return false
  return input.rates.some((rate) => (rate ?? input.defaultRate) !== input.defaultRate)
}

/**
 * Whether a row can claim ROT, RUT or grön teknik: only on a faktura to a
 * private person. Skattereduktion is the buyer's, so a business customer
 * cannot get one (HUSFL), and offering it on a B2B row only invites a claim
 * Skatteverket refuses.
 */
export function deductionsAvailable(input: {
  isInvoiceDoc: boolean
  customerType: string | null | undefined
}): boolean {
  return input.isInvoiceDoc && input.customerType === 'individual'
}

/**
 * The Avdrag column: for a private customer, or when a row already claims a
 * deduction (an older draft to a business customer) so it can be seen and
 * removed.
 */
export function shouldShowDeductionColumn(input: {
  available: boolean
  items: ReadonlyArray<{ deduction_type?: string | null } | undefined>
}): boolean {
  return input.available || input.items.some((item) => Boolean(item?.deduction_type))
}

export type RowBadge =
  | { kind: 'discount'; percent: number }
  | { kind: 'account'; account: string }
  | { kind: 'accrual'; months: number | null }
  | { kind: 'dimensions'; dims: string }

export interface RowBadgeItem {
  line_type?: 'product' | 'text' | null
  discount_percent?: number | null
  revenue_account?: string | null
  accrual_balance_account?: string | null
  accrual_period_start?: string | null
  accrual_period_end?: string | null
  dimensions?: Record<string, string> | null
}

export interface RowBadgeContext {
  /** The linked article's own account: a row that only inherits it is not special. */
  articleAccount?: string | null
  isSelfBilled: boolean
  isInvoiceDoc: boolean
  dimensionsEnabled: boolean
  /** Periodisering is allowed (faktureringsmetoden, a domestic customer). */
  canUseAccrual: boolean
}

/** "KS01 · P001": a dimensions bag in dimension-number order. */
export function compactDimensions(dims: Record<string, string> | null | undefined): string {
  return Object.entries(dims ?? {})
    .filter(([, value]) => value)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([, value]) => value)
    .join(' · ')
}

/**
 * The badges under a row's description, in the row menu's order: Rabatt,
 * Periodisering, Konto, Dimensioner. A text row has none.
 */
export function rowOptionBadges(item: RowBadgeItem, ctx: RowBadgeContext): RowBadge[] {
  if (item.line_type === 'text') return []
  const badges: RowBadge[] = []
  if (!ctx.isSelfBilled && hasLineDiscount(item.discount_percent)) {
    badges.push({ kind: 'discount', percent: item.discount_percent as number })
  }
  if (ctx.canUseAccrual && item.accrual_balance_account != null) {
    let months: number | null = null
    if (item.accrual_period_start && item.accrual_period_end) {
      try {
        months = countCalendarMonths(item.accrual_period_start, item.accrual_period_end)
      } catch {
        months = null
      }
    }
    badges.push({ kind: 'accrual', months })
  }
  const account = item.revenue_account?.trim()
  if (ctx.isInvoiceDoc && account && account !== (ctx.articleAccount ?? null)) {
    badges.push({ kind: 'account', account })
  }
  if (ctx.isInvoiceDoc && ctx.dimensionsEnabled) {
    const dims = compactDimensions(item.dimensions)
    if (dims) badges.push({ kind: 'dimensions', dims })
  }
  return badges
}

// Units that count hours, as typed or picked from the unit list.
const HOUR_UNITS = new Set(['tim', 'timme', 'timmar', 'h', 'hr', 'hrs', 'hour', 'hours'])

/**
 * Arbetstimmar for a deduction row, taken from the row itself when it is
 * billed by the hour: 6 tim at 480 kr is 6 hours of work. Null when the
 * unit is not hours (the user types them).
 */
export function defaultLaborHours(item: { unit?: string | null; quantity?: number | null }): number | null {
  const unit = item.unit?.trim().toLowerCase() ?? ''
  const quantity = Number(item.quantity)
  if (!HOUR_UNITS.has(unit) || !Number.isFinite(quantity) || quantity <= 0) return null
  return quantity
}
