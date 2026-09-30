import type { VatTreatment } from '@/types'
import { roundOre } from '@/lib/money'

/**
 * Icke momsregistrerad verksamhet has no deduction right for input VAT
 * (avdragsrätt, 13 kap. ML 2023:200) and charges no output VAT, so a bank
 * transaction booked for such a company carries no moms line: input VAT on
 * 2641 could never be reclaimed and output VAT on 26xx would never be
 * declared. This is the bank-transaction half of the rule
 * app/api/supplier-invoices/route.ts already applies to supplier-invoice
 * lines. Reverse charge stays allowed: self-assessment is a separate
 * obligation from deduction.
 *
 * The seam is the VAT treatment itself. Every mapping-result builder
 * (category, static template, counterparty template, DB mapping rule)
 * resolves its treatment through vatTreatmentForRegistration before it emits
 * lines, so a non-registered company books exactly the lines it would for an
 * exempt supply, on every path that reaches a builder (dashboard, v1 REST,
 * MCP, the staged commit, proposals). Callers pass
 * company_settings.vat_registered as they loaded it; only an explicit false
 * changes anything, so a caller that does not load the flag (null or
 * undefined) books exactly as before.
 */
export type VatRegistration = boolean | null | undefined

/** The treatment a rate-bearing booking resolves to for a non-registered company. */
export const NO_VAT_TREATMENT = 'exempt' as const satisfies VatTreatment

const RATE_BEARING: ReadonlySet<string> = new Set<VatTreatment>([
  'standard_25',
  'reduced_12',
  'reduced_6',
])

export function isNotVatRegistered(vatRegistered: VatRegistration): boolean {
  return vatRegistered === false
}

/**
 * The treatment a booking uses given the company's VAT registration: a
 * rate-bearing treatment becomes exempt for a non-registered company; every
 * other treatment (reverse charge, export, exempt, none) passes through, as
 * does everything for a registered company.
 */
export function vatTreatmentForRegistration<T extends string | null | undefined>(
  treatment: T,
  vatRegistered: VatRegistration,
): T | typeof NO_VAT_TREATMENT {
  if (!isNotVatRegistered(vatRegistered)) return treatment
  return treatment && RATE_BEARING.has(treatment) ? NO_VAT_TREATMENT : treatment
}

/**
 * The supplier-invoice half of the rule, for the paths that build lines from
 * an underlag (the inbox tool, its commit executor, the inbox convert): the
 * moms a seller charged a non-registered company can never be reclaimed, so
 * it is part of what the purchase cost, and the company still owes the
 * seller all of it. True when the company is not registered and the invoice
 * is not reverse charge (the carve-out the create route makes, for the same
 * reason as above). An exempt or export label does not change the answer:
 * the moms on the underlag is still owed, and the net path those labels take
 * for a registered company would drop it from the payable.
 */
export function sellerVatIsCost(vatRegistered: VatRegistration, reverseCharge: boolean): boolean {
  return isNotVatRegistered(vatRegistered) && !reverseCharge
}

/** The supplier-invoice line fields foldSellerVatIntoCost reads and rewrites. */
export interface SellerVatLine {
  line_total: number
  unit_price: number
  vat_rate: number
  vat_amount: number
}

/**
 * Book each line's seller moms as cost, for an invoice where sellerVatIsCost
 * holds: vat_amount is added to line_total, the unit price scales with it,
 * and the line carries vat_rate 0 and vat_amount 0. The registration
 * verifikat then debits the gross on the cost account, books nothing on 2641
 * and credits 2440 with the same payable a registered company would owe.
 * `sellerVat` is the moms moved, for a preview to name.
 */
export function foldSellerVatIntoCost<T extends SellerVatLine>(
  lines: readonly T[],
): { lines: T[]; sellerVat: number } {
  const folded = lines.map((line) => {
    if (line.vat_rate === 0 && line.vat_amount === 0) return line
    const gross = roundOre(line.line_total + line.vat_amount)
    const unitPrice = line.line_total === 0
      ? line.unit_price
      : roundOre(line.unit_price * (gross / line.line_total))
    return { ...line, line_total: gross, unit_price: unitPrice, vat_rate: 0, vat_amount: 0 }
  })
  const sellerVat = roundOre(lines.reduce((sum, line) => sum + line.vat_amount, 0))
  return { lines: folded, sellerVat }
}

/** What a preview says about a fold: the moms it moved and the payable left on 2440. */
export function sellerVatAsCostNote(sellerVat: number, payable: number): string {
  return 'The company is not VAT-registered, so it has no avdragsrätt for ingående moms (13 kap. ML 2023:200): '
    + (sellerVat !== 0 ? `the seller's VAT ${sellerVat} is added to the cost lines` : 'the lines carry no seller VAT')
    + `, nothing is booked on 2641, and 2440 is credited with ${payable}.`
}
