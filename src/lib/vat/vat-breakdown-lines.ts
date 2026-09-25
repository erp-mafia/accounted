/**
 * Recover a supplier invoice's VAT when its extracted lines are silent about it.
 *
 * Why this exists: an extracted invoice carries two different partitions of
 * the same net. `lineItems` is what the supplier itemised ("Abonnemang",
 * "Trafik"), and `vatBreakdown` is what it reports per VAT rate (3107.96 at
 * 25 %, 928 at 0 %). They rarely line up, so an extractor asked for a rate per
 * itemised line honestly answers `null` on a mixed invoice: no single rate
 * describes that line.
 *
 * The staging path derives the header VAT by summing the per-line VAT, which
 * makes a silent-line invoice stage with `vat_amount: 0`. That is not a
 * cosmetic loss: createSupplierInvoiceRegistrationEntry gates the whole 2641
 * posting on `vat_amount > 0`, so every öre of deductible ingående moms on
 * such an invoice was dropped and the gross booked as cost.
 *
 * Three outcomes, in order of how much the document actually determines:
 *
 *   uniform_rate  one legal rate covers the whole net, so the itemised lines
 *                 keep their descriptions and just get that rate.
 *   rebuilt       the net splits across rates, so the VAT bases become the
 *                 lines. That is the partition Skatteverket follows anyway;
 *                 the itemised descriptions move to the invoice notes.
 *   unreconciled  the document charges VAT that cannot be traced to a rate.
 *                 Staging refuses. A number nobody can derive from the
 *                 underlag is not one to book, and the old silent zero was
 *                 exactly that failure with the opposite sign.
 *
 * A line that STATES its VAT, including an explicit zero (a pension premium,
 * an exempt supply), has already answered the question: this never overrides
 * it. Only silence triggers the recovery.
 */

import { roundOre } from '@/lib/money'
import { isLegalVatRate, normalizeVatRateToDecimal } from './supplier-invoice-line-checks'

/** One `vatBreakdown` entry as the extraction contract emits it: percent rate. */
export interface VatBreakdownEntry {
  base: number
  rate: number
  amount: number
}

/** A line shaped like the extraction's `lineItems`, so callers map it unchanged. */
export interface DerivedVatLine {
  description: string
  quantity: 1
  unitPrice: number
  lineTotal: number
  /** Percent, matching the extraction contract (25, 12, 6, 0). */
  vatRate: number
  vatAmount: number
}

export type VatBreakdownOutcome =
  /** The lines already answered, or the document charges no VAT. */
  | { status: 'not_applicable' }
  /** One rate covers the whole net: apply this percent to the existing lines. */
  | { status: 'uniform_rate'; rate: number }
  /** The net splits across rates: stage these lines instead of the itemised ones. */
  | { status: 'rebuilt'; lines: DerivedVatLine[] }
  /** VAT was charged that the document cannot explain; refuse to stage. */
  | { status: 'unreconciled'; reason: string }

/** Öre tolerance: a document's own rounding may leave one öre per comparison. */
const TOLERANCE = 0.011

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseEntries(raw: unknown): VatBreakdownEntry[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const entries: VatBreakdownEntry[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') return null
    const { base, rate, amount } = item as Record<string, unknown>
    if (!isFiniteNumber(base) || !isFiniteNumber(rate) || !isFiniteNumber(amount)) return null
    entries.push({ base, rate, amount })
  }
  return entries
}

/** The percent rate implied by a net and a VAT amount, when it is a legal one. */
function impliedLegalRate(subtotal: number, documentVat: number): number | null {
  if (roundOre(subtotal) === 0) return null
  for (const decimal of [0.25, 0.12, 0.06]) {
    if (Math.abs(roundOre(subtotal * decimal) - roundOre(documentVat)) <= TOLERANCE) {
      return Math.round(decimal * 100)
    }
  }
  return null
}

export interface VatBreakdownInput {
  /**
   * Whether ANY line stated a VAT rate or amount, including an explicit zero.
   * False means every line was silent, which is the only case this handles.
   */
  linesStateVat: boolean
  /** VAT the underlag says was charged (`totals.vatAmount`). */
  documentVat: number
  /** Net the underlag reports (`totals.subtotal`). */
  subtotal: number
  /** Raw `extracted_data.vatBreakdown`; any shape, validated here. */
  breakdown: unknown
  /** False for reverse charge, exempt and export: those zero the lines by design. */
  deductsInputVat: boolean
}

/**
 * Decide how a silent-line invoice gets its VAT, or refuse.
 *
 * Only fires when the document says VAT was charged while no line says
 * anything about it. An invoice that genuinely carries no VAT, and one whose
 * lines already state their own, are both left exactly as they were.
 */
export function deriveVatLinesFromBreakdown(input: VatBreakdownInput): VatBreakdownOutcome {
  const { linesStateVat, documentVat, subtotal, breakdown, deductsInputVat } = input

  // Reverse charge, exempt and export book no seller VAT at all: the caller
  // zeroes every line on purpose, and a breakdown must not undo that.
  if (!deductsInputVat) return { status: 'not_applicable' }
  // The lines said what the VAT is, zero included. That answer wins.
  if (linesStateVat) return { status: 'not_applicable' }
  // Nothing was charged, so nothing is missing.
  if (roundOre(documentVat) === 0) return { status: 'not_applicable' }

  const entries = parseEntries(breakdown)

  // No usable breakdown: the totals alone can still determine the answer when
  // one legal rate explains the whole net.
  if (!entries) {
    const rate = impliedLegalRate(subtotal, documentVat)
    if (rate !== null) return { status: 'uniform_rate', rate }
    return {
      status: 'unreconciled',
      reason: `underlaget anger moms ${roundOre(documentVat)} på nettot ${roundOre(subtotal)}, vilket inte motsvarar någon svensk momssats, och det finns ingen användbar vatBreakdown att härleda satsen ur.`,
    }
  }

  const baseSum = roundOre(entries.reduce((sum, e) => sum + e.base, 0))
  const amountSum = roundOre(entries.reduce((sum, e) => sum + e.amount, 0))

  if (Math.abs(amountSum - roundOre(documentVat)) > TOLERANCE) {
    return {
      status: 'unreconciled',
      reason: `vatBreakdown summerar till moms ${amountSum}, underlagets totals anger ${roundOre(documentVat)}.`,
    }
  }
  if (Math.abs(baseSum - roundOre(subtotal)) > TOLERANCE) {
    return {
      status: 'unreconciled',
      reason: `vatBreakdown summerar till underlag ${baseSum}, underlagets subtotal anger ${roundOre(subtotal)}.`,
    }
  }

  const lines: DerivedVatLine[] = []
  for (const entry of entries) {
    const decimalRate = normalizeVatRateToDecimal(entry.rate)
    // A rate outside the Swedish set normalizes to 0, which would turn a
    // charged line into a VAT-free one without saying so.
    if (!isLegalVatRate(decimalRate) || (entry.rate !== 0 && decimalRate === 0)) {
      return {
        status: 'unreconciled',
        reason: `vatBreakdown innehåller momssatsen ${entry.rate} %, som inte är en svensk sats (25, 12, 6 eller 0).`,
      }
    }
    const expected = roundOre(entry.base * decimalRate)
    if (Math.abs(expected - roundOre(entry.amount)) > TOLERANCE) {
      return {
        status: 'unreconciled',
        reason: `vatBreakdown-raden ${entry.base} @ ${entry.rate} % anger moms ${roundOre(entry.amount)}, men satsen ger ${expected}.`,
      }
    }
    const base = roundOre(entry.base)
    // A zero-base row carries neither net nor VAT: it is noise in the
    // breakdown, not a line the invoice should show.
    if (base === 0 && roundOre(entry.amount) === 0) continue
    lines.push({
      description: decimalRate === 0 ? 'Underlag utan moms' : `Underlag ${entry.rate} % moms`,
      quantity: 1,
      unitPrice: base,
      lineTotal: base,
      vatRate: entry.rate,
      vatAmount: roundOre(entry.amount),
    })
  }

  if (lines.length === 0) {
    return { status: 'unreconciled', reason: 'vatBreakdown innehåller inga rader med belopp.' }
  }

  // One rate over the whole net: the itemisation survives, it just needed a
  // rate. Rebuilding would throw away descriptions for nothing.
  if (lines.length === 1 && Math.abs(lines[0].lineTotal - roundOre(subtotal)) <= TOLERANCE) {
    return { status: 'uniform_rate', rate: lines[0].vatRate }
  }

  return { status: 'rebuilt', lines }
}
