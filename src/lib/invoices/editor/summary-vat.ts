import type { VatTreatment } from '@/types'

/**
 * The VAT lines of the editor's Summering.
 *
 * A 0 % rate prints a "Moms 0 %" line with its reason (omvänd
 * skattskyldighet, export, momsfri) instead of no line at all: an EU or
 * export invoice that showed only Delsumma and Att betala read as if the
 * VAT had been forgotten. A seller who is not VAT registered charges no VAT
 * and gets no VAT line, as before.
 *
 * Pure: the editor renders what this returns.
 */

/** Why a 0 % rate charges no VAT. */
export type ZeroVatReason = 'reverse_charge' | 'export' | 'exempt'

/** The priced lines at one rate (text rows excluded). */
export interface SummaryVatGroup {
  rate: number
  base: number
  vat: number
}

export type SummaryVatLine =
  /** "Netto 25 %": only when the invoice carries more than one rate. */
  | { kind: 'net'; rate: number; amount: number }
  /**
   * "Moms 25 %", or "Moms 0 % · omvänd skattskyldighet" with a reason. rate
   * null: the plain "Moms" line of an invoice with nothing priced yet.
   */
  | { kind: 'vat'; rate: number | null; amount: number; reason: ZeroVatReason | null }

/**
 * The reason a 0 % rate is 0, from the invoice's VAT treatment as the write
 * path derives it (deriveInvoiceVatHeader): reverse charge and export say so,
 * anything else at 0 % is a momsfri supply.
 */
export function zeroVatReason(treatment: VatTreatment): ZeroVatReason {
  if (treatment === 'reverse_charge') return 'reverse_charge'
  if (treatment === 'export') return 'export'
  return 'exempt'
}

export function buildSummaryVatLines(input: {
  vatRegistered: boolean
  groups: ReadonlyArray<SummaryVatGroup>
  /** The invoice's VAT treatment (deriveInvoiceVatHeader().vat_treatment). */
  treatment: VatTreatment
}): SummaryVatLine[] {
  if (!input.vatRegistered) return []

  // A rate that only an empty row carries is not part of the invoice yet.
  const priced = input.groups.filter((group) => group.base !== 0)
  const groups = [...(priced.length > 0 ? priced : input.groups)].sort((a, b) => b.rate - a.rate)

  const lines: SummaryVatLine[] = []
  for (const group of groups) {
    if (groups.length > 1) lines.push({ kind: 'net', rate: group.rate, amount: group.base })
    if (group.rate === 0) {
      lines.push({ kind: 'vat', rate: 0, amount: 0, reason: zeroVatReason(input.treatment) })
    } else if (group.vat !== 0) {
      lines.push({ kind: 'vat', rate: group.rate, amount: group.vat, reason: null })
    }
  }
  if (!lines.some((line) => line.kind === 'vat')) lines.push({ kind: 'vat', rate: null, amount: 0, reason: null })
  return lines
}
