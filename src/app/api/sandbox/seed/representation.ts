/**
 * The sandbox's representation demo: a customer lunch at Demokafé, booked the
 * way a correct real booking of it looks (accounted#80, crm#1342).
 *
 * Prospects learn the product from this verifikat, so every part of it is the
 * rule, not an approximation:
 *
 *   Account. A måltid at extern representation is not deductible at all for
 *   income tax since 2017 (IL 16 kap. 2 §); only enklare förtäring (coffee,
 *   a bun, fruit) up to 60 kr per person is. A lunch therefore lands in full
 *   on 6072 Representation, ej avdragsgill. It used to sit on 5810 Biljetter,
 *   a travel account, and 6071 would have been the other classic mistake
 *   (swedish-daily-bookkeeping, cost-types-and-underlag B1 "Traps").
 *
 *   VAT. The deduction survives, on a beskattningsunderlag of at most 300 kr
 *   excl. moms per person and occasion (ML 13 kap. 24-25 §§; swedish-vat,
 *   section 3). A food-only restaurant meal is 12 %, so the cap is 36 kr per
 *   person. Two people at 240 kr excl. moms stay under it (28,80 kr against
 *   72 kr), so the whole VAT goes to 2641 and nothing non-deductible is added
 *   to the cost. The split is computed, not assumed, so a later change of the
 *   amounts cannot silently over-deduct.
 *
 *   Syfte and deltagare. Skatteverket wants the purpose and every participant
 *   (name and company) documented, or the VAT deduction falls even with a
 *   perfect invoice (cost-types-and-underlag A7). They are written as the
 *   verifikat's anteckning: a written note is enough, no separate uploaded
 *   document is needed, which is exactly what crm#1342 asked.
 *
 * Pure: route.ts posts the voucher and writes the rows.
 */

import { PINNED_JURISDICTION, resolveAccountRole } from '@/lib/bookkeeping/account-roles'
import { computeLineVat } from '@/lib/bookkeeping/invoice-line-amounts'
import { buildSupplierDescription } from '@/lib/bookkeeping/supplier-invoice-description'
import { roundOre } from '@/lib/money'
import type { CreateJournalEntryInput } from '@/types'

/**
 * BAS 2026 6072 Representation, ej avdragsgill. No account role names
 * representation yet, and the demo company is a Swedish enskild firma on the
 * BAS chart, so the one number is spelled here (decision 2026-10-21).
 */
export const SANDBOX_REPRESENTATION_ACCOUNT = '6072'

const INPUT_VAT_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'input_vat')
const PAYABLES_ACCOUNT = resolveAccountRole(PINNED_JURISDICTION, 'accounts_payable')

/**
 * The café's invoice line, shared by the registered supplier invoice, the
 * inbox item and the staged operation so all three book the same thing.
 * Food only, no alcohol: one rate, so no schablon (46 kr) applies.
 */
export const SANDBOX_REPRESENTATION_LINE = {
  description: 'Lunch, 2 personer',
  participants: 2,
  net: 240,
  vatRatePercent: 12,
  vat: 28.8,
  total: 268.8,
} as const

/** ML 13 kap. 24-25 §§: the VAT base per person and occasion, excl. moms. */
const VAT_BASE_CAP_PER_PERSON = 300

/** Both lunches are with the same customer contact; the purposes differ. */
const PARTICIPANTS_TEXT = 'Deltagare: Demo Användare (Sandlådan Konsult) och Karin Björk (Björk & Partner AB).'

/** The anteckning on the registered invoice and on its verifikat. */
export const SANDBOX_REPRESENTATION_NOTES =
  'Extern representation, kundlunch. Syfte: uppföljning av webbutvecklingsuppdraget och planering av nästa fas. ' +
  PARTICIPANTS_TEXT

/** The anteckning the staged inbox operation carries for its own lunch. */
export const SANDBOX_STAGED_REPRESENTATION_NOTES =
  'Extern representation, kundlunch. Syfte: genomgång av offert för nästa projektfas. ' + PARTICIPANTS_TEXT

/**
 * The part of a single-rate representation invoice's VAT that may be
 * deducted: the rate applied to the base capped at 300 kr per person, never
 * more than the VAT actually charged.
 */
export function deductibleRepresentationVat(line: {
  net: number
  vat: number
  vatRatePercent: number
  participants: number
}): number {
  const cappedBase = Math.min(line.net, line.participants * VAT_BASE_CAP_PER_PERSON)
  return Math.min(line.vat, computeLineVat(cappedBase, line.vatRatePercent))
}

export interface SandboxRepresentationVoucherInput {
  fiscalPeriodId: string
  entryDate: string
  supplierInvoiceId: string
  supplierInvoiceNumber: string
  arrivalNumber: number
  supplierName: string
}

/**
 * The registration verifikat of the representation invoice under
 * faktureringsmetoden: the cost and the deductible VAT against 2440, with
 * the description the product's own registration path writes. VAT above
 * the cap would be cost, so it is added to 6072, not claimed on 2641.
 */
export function buildSandboxRepresentationVoucher(input: SandboxRepresentationVoucherInput): CreateJournalEntryInput {
  const line = SANDBOX_REPRESENTATION_LINE
  const deductibleVat = deductibleRepresentationVat(line)
  const nonDeductibleVat = roundOre(line.vat - deductibleVat)
  const desc = buildSupplierDescription(
    'Leverantörsfaktura',
    input.supplierInvoiceNumber,
    input.supplierName,
    `(ankomstnr ${input.arrivalNumber})`,
  )

  return {
    fiscal_period_id: input.fiscalPeriodId,
    entry_date: input.entryDate,
    description: desc,
    source_type: 'supplier_invoice_registered',
    source_id: input.supplierInvoiceId,
    notes: SANDBOX_REPRESENTATION_NOTES,
    lines: [
      {
        account_number: SANDBOX_REPRESENTATION_ACCOUNT,
        debit_amount: roundOre(line.net + nonDeductibleVat),
        credit_amount: 0,
        line_description: desc,
        dimensions: {},
      },
      ...(deductibleVat > 0
        ? [{
            account_number: INPUT_VAT_ACCOUNT,
            debit_amount: deductibleVat,
            credit_amount: 0,
            line_description: `Ingående moms ${line.vatRatePercent}% ${desc}`,
            dimensions: {},
          }]
        : []),
      {
        account_number: PAYABLES_ACCOUNT,
        debit_amount: 0,
        credit_amount: line.total,
        line_description: desc,
        dimensions: {},
      },
    ],
  }
}
