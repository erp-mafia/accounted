import type { SpendVatCode } from '@accounted/connect-contract'
import type { ReverseChargeKind } from '@/lib/bookkeeping/vat-entries'
import { isNotVatRegistered, type VatRegistration } from '@/lib/bookkeeping/vat-registration'

/**
 * The VAT codes Accounted publishes to a spend provider, and what each books
 * as when an expense comes back carrying it. This file is the spend family's
 * Swedish VAT knowledge (the codes, their BAS accounts, the representation
 * accounts and the förenklad faktura limit) and sits in SE pack territory
 * (scripts/checks/jurisdiction-welds.mjs): the rest of lib/spend asks here.
 *
 * Accounted has no tax-code table: VAT follows each account's treatment
 * (chart_of_accounts.default_vat_treatment) and the momsdeklaration reads the
 * VAT accounts. A provider like Pleo needs codes its users pick per expense,
 * so this is a fixed, purchase-side list (sales VAT has no place on a card
 * expense). Codes are stable identifiers: a rename at the provider never
 * changes what a code books.
 *
 * Booking per code (swedish-daily-bookkeeping, references/foreign-purchases.md
 * and cost-types-and-underlag.md):
 *
 *   SE25, SE12, SE6  Swedish VAT on the receipt: input VAT on 2641 (ruta 48),
 *                    the net on the expense account. Never without a receipt
 *                    (ML 13 kap 31 §): lib/spend/evaluate.ts books it as cost.
 *   MOMSFRI          no VAT: exempt (bank and card fees, insurance) or
 *                    outside the scope.
 *   UTLMOMS          foreign VAT the merchant charged correctly (a hotel or
 *                    restaurant abroad): never deductible in the Swedish
 *                    return, the gross goes to cost, no ruta.
 *   EUTJ, UTLTJ      a service from an EU / non-EU business that charged no
 *                    VAT: reverse charge at 25 %, 2645 and 2614 (rutor 21 or
 *                    22, 30 and 48), the basis pair from
 *                    generateReverseChargePurchaseLines.
 *   EUVARA           goods from an EU business without VAT: unionsinternt
 *                    förvärv at 25 % (rutor 20, 30 and 48).
 *
 * A company that is not VAT registered gets EJMOMS in place of every code
 * with VAT on the receipt (the VAT is part of what it paid, the gross goes
 * to cost) and keeps the reverse-charge codes: the rule
 * vatTreatmentForRegistration applies on every other booking path, since
 * self-assessment is a separate obligation from deduction.
 */

/** Debiterad ingående moms (ruta 48): Swedish VAT on a receipt. */
const INPUT_VAT_DOMESTIC = '2641'

/**
 * Representation accounts (BAS 6070-6072 extern, 7630-7632 intern): the VAT
 * base is capped per person and occasion (ML 13 kap 24-25 §§), which the
 * coding alone cannot say.
 */
export const REPRESENTATION_ACCOUNTS: ReadonlySet<string> = new Set(['6070', '6071', '6072', '7630', '7631', '7632'])

/** A förenklad faktura gives no VAT deduction above this amount including VAT (ML 17 kap 26-28 §§). */
export const SIMPLIFIED_RECEIPT_VAT_LIMIT = 4000

export type SpendVatHandling =
  | { kind: 'domestic'; rate: number; account: string }
  | { kind: 'none' }
  | { kind: 'reverse'; rate: number; reverseKind: ReverseChargeKind }

export interface SpendVatCodeDefinition {
  code: string
  name: string
  type: 'standard' | 'reverse'
  rate: number
  handling: SpendVatHandling
  inputVatAccount: string | null
  outputVatAccount: string | null
  /** The account VAT treatments (chart_of_accounts.default_vat_treatment) whose usual code this is. */
  treatments: readonly string[]
}

export const SPEND_VAT_CODES: readonly SpendVatCodeDefinition[] = [
  { code: 'SE25', name: 'Svensk moms 25 %', type: 'standard', rate: 0.25, handling: { kind: 'domestic', rate: 0.25, account: INPUT_VAT_DOMESTIC }, inputVatAccount: null, outputVatAccount: null, treatments: ['standard_25'] },
  { code: 'SE12', name: 'Svensk moms 12 %', type: 'standard', rate: 0.12, handling: { kind: 'domestic', rate: 0.12, account: INPUT_VAT_DOMESTIC }, inputVatAccount: null, outputVatAccount: null, treatments: ['reduced_12'] },
  { code: 'SE6', name: 'Svensk moms 6 %', type: 'standard', rate: 0.06, handling: { kind: 'domestic', rate: 0.06, account: INPUT_VAT_DOMESTIC }, inputVatAccount: null, outputVatAccount: null, treatments: ['reduced_6'] },
  { code: 'MOMSFRI', name: 'Ingen moms', type: 'standard', rate: 0, handling: { kind: 'none' }, inputVatAccount: null, outputVatAccount: null, treatments: ['exempt'] },
  { code: 'UTLMOMS', name: 'Utländsk moms, ej avdragsgill', type: 'standard', rate: 0, handling: { kind: 'none' }, inputVatAccount: null, outputVatAccount: null, treatments: [] },
  {
    code: 'EUTJ',
    name: 'Tjänst från EU, omvänd moms',
    type: 'reverse',
    rate: 0.25,
    handling: { kind: 'reverse', rate: 0.25, reverseKind: 'eu_services' },
    inputVatAccount: '2645',
    outputVatAccount: '2614',
    treatments: ['reverse_charge_eu_services', 'reverse_charge'],
  },
  {
    code: 'UTLTJ',
    name: 'Tjänst utanför EU, omvänd moms',
    type: 'reverse',
    rate: 0.25,
    handling: { kind: 'reverse', rate: 0.25, reverseKind: 'non_eu_services' },
    inputVatAccount: '2645',
    outputVatAccount: '2614',
    treatments: ['reverse_charge_non_eu_services'],
  },
  {
    code: 'EUVARA',
    name: 'Vara från EU, omvänd moms',
    type: 'reverse',
    rate: 0.25,
    handling: { kind: 'reverse', rate: 0.25, reverseKind: 'eu_goods' },
    inputVatAccount: '2645',
    outputVatAccount: '2614',
    treatments: ['reverse_charge_eu_goods'],
  },
]

/** The one code a company that is not VAT registered publishes. */
export const SPEND_VAT_CODE_NOT_REGISTERED: SpendVatCodeDefinition = {
  code: 'EJMOMS',
  name: 'Moms ingår i kostnaden',
  type: 'standard',
  rate: 0,
  handling: { kind: 'none' },
  inputVatAccount: null,
  outputVatAccount: null,
  treatments: [],
}

const NOT_REGISTERED_CODES: readonly SpendVatCodeDefinition[] = [
  SPEND_VAT_CODE_NOT_REGISTERED,
  ...SPEND_VAT_CODES.filter((definition) => definition.handling.kind === 'reverse'),
]

/** The codes this company publishes. */
export function spendVatCodesFor(vatRegistered: VatRegistration): readonly SpendVatCodeDefinition[] {
  return isNotVatRegistered(vatRegistered) ? NOT_REGISTERED_CODES : SPEND_VAT_CODES
}

/** A code as it came back from the provider, matched without regard to case (the provider matches the same way). */
export function findSpendVatCode(code: string | null | undefined, vatRegistered: VatRegistration): SpendVatCodeDefinition | null {
  if (!code) return null
  const wanted = code.trim().toUpperCase()
  return spendVatCodesFor(vatRegistered).find((definition) => definition.code === wanted) ?? null
}

/**
 * The usual code of an account, from its VAT treatment; null when no
 * published code fits. A company that is not VAT registered falls back to
 * EJMOMS for every treatment without a reverse-charge code of its own.
 */
export function vatCodeForTreatment(treatment: string | null | undefined, vatRegistered: VatRegistration): string | null {
  const code = treatment ? spendVatCodesFor(vatRegistered).find((definition) => definition.treatments.includes(treatment))?.code : undefined
  if (code) return code
  return isNotVatRegistered(vatRegistered) ? SPEND_VAT_CODE_NOT_REGISTERED.code : null
}

export function toContractVatCode(definition: SpendVatCodeDefinition): SpendVatCode {
  return {
    code: definition.code,
    name: definition.name,
    type: definition.type,
    rate: definition.rate,
    inputVatAccount: definition.inputVatAccount,
    outputVatAccount: definition.outputVatAccount,
  }
}
