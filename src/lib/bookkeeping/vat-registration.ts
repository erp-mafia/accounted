import type { VatTreatment } from '@/types'

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
