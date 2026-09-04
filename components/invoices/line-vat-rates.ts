import {
  getAvailableVatRates,
  getPermittedVatRates,
  type VatRateOption,
} from '@/lib/invoices/vat-rules'
import type { CustomerType } from '@/types'

/**
 * The invoice editor's per-line Moms picker derives FOUR different behaviours
 * from the customer's VAT rules, and they must not share one set of rates:
 *
 *   - which options are RENDERED   → getPermittedVatRates() (the lawful set)
 *   - what a new line STARTS on    → getAvailableVatRates() (the default)
 *   - whether an article's rate is ADOPTED → the default set
 *   - what a customer switch SNAPS to     → the default
 *
 * Under huvudregeln (ML 6 kap. 34 §, Article 44 VAT Directive) a B2B service is
 * taxed where the buyer is established, so 0% (reverse charge for a VAT-
 * validated EU business, export outside the EU) is the right DEFAULT for a
 * foreign business customer. It is not the only lawful rate: the ML 6 kap.
 * exceptions taxed where the supply is performed (fastighetstjänster 25%,
 * persontransporter 6%, korttidsuthyrning of transport vehicles 25%,
 * restaurang/catering 12%, admission to cultural and sports events 6%) carry
 * Swedish VAT even when the buyer is a German or a US company. A Stockholm
 * hotel night sold to a German company is such a supply, so the picker has to
 * OFFER 12% while still DEFAULTING to 0%.
 *
 * Kept in a plain module (no JSX, no hooks) so the rules are unit-testable:
 * the repo does not render components in tests.
 */

/** The minimum this module needs to know about the picked customer. */
export interface VatRateCustomer {
  customer_type: CustomerType
  vat_number_validated?: boolean | null
  /** ISO 3166-1 alpha-2; gates reverse charge together with the two above. */
  country?: string | null
}

/** One invoice line as the editor's form holds it. */
export interface VatRateLine {
  vat_rate?: number | null
  line_type?: 'product' | 'text' | null
}

export interface LineVatRatePlan {
  /** Rendered picker options: the PERMITTED set. 0% stays first. */
  options: VatRateOption[]
  /** The DEFAULT set. One locked 0% option for a foreign business customer. */
  defaultRates: VatRateOption[]
  /** The rate a new line starts on and a customer switch snaps to. */
  defaultRate: number
  /** True when the DEFAULT set holds exactly one rate (foreign business, 0%). */
  hasSingleDefault: boolean
  /** True only when there is genuinely nothing to choose between. */
  isPickerLocked: boolean
}

/**
 * The rate the empty form's first line carries, before any customer is picked.
 * Mirrors the editor's defaultValues.
 */
export const FALLBACK_VAT_RATE = 25

export function resolveLineVatRates(
  customer: VatRateCustomer | null | undefined,
): LineVatRatePlan {
  if (!customer) {
    return {
      options: [],
      defaultRates: [],
      defaultRate: FALLBACK_VAT_RATE,
      hasSingleDefault: false,
      isPickerLocked: false,
    }
  }
  const validated = customer.vat_number_validated ?? false
  const defaultRates = getAvailableVatRates(customer.customer_type, validated, customer.country)
  const options = getPermittedVatRates(customer.customer_type, validated, customer.country)
  return {
    options,
    defaultRates,
    defaultRate: defaultRates[0]?.rate ?? FALLBACK_VAT_RATE,
    hasSingleDefault: defaultRates.length === 1,
    isPickerLocked: options.length === 1,
  }
}

/**
 * Which lines a customer switch may move onto the new customer's default rate.
 *
 * Only lines still sitting on the PREVIOUS customer's default are moved: those
 * were never chosen, they were inherited, so leaving them behind is what
 * produced the two stale-rate bugs (25% surviving onto a reverse-charge
 * invoice, 0% surviving onto a domestic one).
 *
 * A line the user moved off that default is a deliberate choice and is left
 * alone. Snapping every line was the older behaviour and it destroyed the
 * lawful case this whole rule exists for: a 12% hotel night or a 6% event
 * ticket sold to a foreign business, taxed where the supply is performed.
 * Nothing on a line distinguishes those from ordinary consulting, so the
 * user's explicit rate is the only signal there is, and overwriting it would
 * be guessing.
 *
 * Free-text rows (line_type 'text') carry no amounts and never book; they are
 * left untouched so a switch cannot dirty the form with meaningless rates.
 */
export function planCustomerSwitchVatSnap(params: {
  items: VatRateLine[]
  previousDefaultRate: number
  nextDefaultRate: number
}): Array<{ index: number; rate: number }> {
  const { items, previousDefaultRate, nextDefaultRate } = params
  if (previousDefaultRate === nextDefaultRate) return []

  const snaps: Array<{ index: number; rate: number }> = []
  items.forEach((item, index) => {
    if (item?.line_type === 'text') return
    // An absent rate falls back to the old default, exactly like the server
    // does (item.vat_rate ?? getVatRules().rate), so such a line still follows.
    const current = item?.vat_rate ?? previousDefaultRate
    if (current !== previousDefaultRate) return
    snaps.push({ index, rate: nextDefaultRate })
  })
  return snaps
}

/**
 * True when a Swedish rate is actually selected on an invoice whose customer
 * defaults to 0% (validated EU business or non-EU business). That is lawful
 * only for the supplies taxed where they are performed, so it earns the single
 * ochre attention sentence. Silent otherwise: 0% is the normal case and needs
 * no commentary.
 */
export function hasSwedishVatToForeignBusiness(params: {
  plan: LineVatRatePlan
  items: VatRateLine[]
}): boolean {
  const { plan, items } = params
  if (!plan.hasSingleDefault || plan.defaultRate !== 0) return false
  return items.some((item) => item?.line_type !== 'text' && (item?.vat_rate ?? 0) > 0)
}
