import type { Invoice, CompanySettings } from '@/types'

/**
 * Shape accepted by getDisplayTotal. `currency` is widened to `string` so the
 * helper works for both customer (`Invoice`) and supplier (`SupplierInvoice`)
 * rows. `ore_rounding` is the optional per-invoice override (see below).
 */
type InvoiceTotalShape = {
  total: Invoice['total']
  currency: string
  /** Per-invoice öresavrundning override. Wins over the company setting when set. */
  ore_rounding?: boolean | null
}
type CompanyRoundingShape = Pick<CompanySettings, 'ore_rounding'>

export interface DisplayTotal {
  /** Total to render to the user (rounded if öresavrundning applies, raw otherwise). */
  displayed: number
  /** displayed - raw total. Zero when rounding does not apply or the total is already an integer. */
  roundingDelta: number
  /** True when rounding is enabled, currency is SEK, and there are öre to round. */
  applies: boolean
}

/**
 * Single source of truth for öresavrundning display logic. Mirrors the rule
 * baked into the PDF template since day one: only SEK invoices, only when
 * rounding is enabled, and only when there's actually a non-integer total to
 * round. The helper centralizes the rule so the list, detail page, and PDF
 * cannot drift apart.
 *
 * Resolution order for "is rounding enabled":
 *   1. the per-invoice override (`invoice.ore_rounding`) when not null,
 *   2. else the company-wide setting (`company.ore_rounding`),
 *   3. else default-on.
 * Callers that want a different null-fallback (e.g. supplier invoices, where
 * rounding never existed historically) pass `{ ore_rounding: false }` as the
 * company arg so a null per-invoice flag resolves to off.
 */
export function getDisplayTotal(
  invoice: InvoiceTotalShape,
  company: CompanyRoundingShape | null | undefined,
): DisplayTotal {
  const enabled = invoice.ore_rounding ?? company?.ore_rounding ?? true
  if (!enabled || invoice.currency !== 'SEK') {
    return { displayed: invoice.total, roundingDelta: 0, applies: false }
  }
  const rounded = Math.round(invoice.total)
  if (rounded === invoice.total) {
    return { displayed: invoice.total, roundingDelta: 0, applies: false }
  }
  return {
    displayed: rounded,
    roundingDelta: Math.round((rounded - invoice.total) * 100) / 100,
    applies: true,
  }
}

type AmountToPayShape = InvoiceTotalShape & {
  /** ROT/RUT deduction (fakturamodellen). Reduces what the customer owes. */
  deduction_total?: number | null
  /** Set on credit notes; the deduction rule does not apply to those. */
  credited_invoice_id?: string | null
}

export interface AmountToPay {
  /** The öresavrundning outcome on the invoice total (before any deduction). */
  rounding: DisplayTotal
  /** True when a ROT/RUT deduction reduces the amount to pay. */
  deductionApplies: boolean
  /** Customer-facing "Att betala": rounded total minus any ROT/RUT deduction. */
  toPay: number
}

/**
 * Customer-facing "Att betala" for an invoice: öresavrundning via
 * getDisplayTotal, then the ROT/RUT deduction (the customer only owes
 * total - deduction; the rest is reclaimed from Skatteverket via
 * fakturamodellen). Extracted from the PDF totals block so the invoice email
 * shows the exact same amount as the attached PDF and the two cannot drift.
 */
export function getAmountToPay(
  invoice: AmountToPayShape,
  company: CompanyRoundingShape | null | undefined,
): AmountToPay {
  const rounding = getDisplayTotal(invoice, company)
  const deductionApplies = !invoice.credited_invoice_id && (invoice.deduction_total ?? 0) > 0
  const toPay = deductionApplies
    ? Math.round((rounding.displayed - (invoice.deduction_total ?? 0)) * 100) / 100
    : rounding.displayed
  return { rounding, deductionApplies, toPay }
}
