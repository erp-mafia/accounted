/**
 * The moms of a privately paid purchase (utlägg), decided by where the seller
 * is and what was bought, never by the currency alone (crm#1028):
 *
 *   - a seller in Sweden: the receipt's moms is ingående moms on 2641;
 *   - a seller abroad, no omvänd skattskyldighet: the whole amount is cost.
 *     A receipt with foreign VAT, anything taxed where it is bought or
 *     performed (the exceptions to huvudregeln in ML 6 kap.: hotell as a
 *     fastighetstjänst, restaurang, persontransport such as a taxi or a
 *     flight, tillträde till evenemang; goods sold over the counter abroad),
 *     and a VAT-exempt service. A receipt without VAT is not enough to make
 *     a purchase reverse charge;
 *   - a service under huvudregeln (ML 6 kap. 33 §: SaaS, licences, ads,
 *     consulting) from a seller abroad that charged no VAT: omvänd
 *     skattskyldighet. The company reports the VAT and deducts it (2614 K /
 *     2645 D) and the purchase lands in ruta 21 (EU) or ruta 22 (outside the
 *     EU).
 *
 * The last case is booked by the expense-claims service from `reverse_charge`
 * through generateReverseChargePurchaseLines, the producer every other
 * reverse-charge purchase uses, so no client builds those lines and the fiktiv
 * moms never posts without its basis pair. Framework-free: the inbox dialog
 * previews with the same function the service books with.
 */

import type { CreateJournalEntryLineInput } from '@/types'
import { generateReverseChargePurchaseLines, type ReverseChargeKind } from '@/lib/bookkeeping/vat-entries'
import {
  reverseChargeAccountConflict,
  vatCodeRuleForAccount,
  type VoucherVatCodeAccountRow,
} from '@/lib/bookkeeping/voucher-line-vat-code'
import { normalizeVatNumber } from '@/lib/vat/vat-number'

/**
 * The omvänd-skattskyldighet purchases an utlägg books without custom lines:
 * a service from a seller in another EU country (ruta 21) or outside the EU
 * (ruta 22), the Utlägg form's Utomlands choice.
 */
export const EXPENSE_CLAIM_REVERSE_CHARGE_KINDS = [
  'eu_services',
  'non_eu_services',
] as const satisfies readonly ReverseChargeKind[]

export type ExpenseClaimReverseCharge = (typeof EXPENSE_CLAIM_REVERSE_CHARGE_KINDS)[number]

/**
 * The reverse-charge lines of an utlägg on its purchase amount (`base`: the
 * receipt carries no VAT, so the amount is the beskattningsunderlag), or null
 * when the cost account cannot carry them (reverseChargeAccountConflict, as
 * bank categorization refuses it). The account decides as it does on a
 * konteringsrad (vatCodeRuleForAccount, crm#1096), read from its chart row
 * (`row`, null or undefined when the chart holds none):
 *
 *   - an account that reports ruta 20-24 itself (4531, or one whose kontoplan
 *     momskod is reverse charge) keeps its box and rate and takes only the
 *     fiktiv moms, and only for the purchase it reports: 4531 with
 *     eu_services is null;
 *   - a purchase account without a momskod reports something else itself
 *     (trepartshandel ruta 37, the import basis ruta 50, a reverse-charge
 *     momskod without a Swedish rate) or is the 4598 offset: null, since the
 *     basis pair would declare the purchase a second time;
 *   - any other account (an ordinary cost account, or one in class 7-8,
 *     which reports no box) takes the fiktiv moms at 25 % and the basis pair
 *     of `kind`.
 */
export function expenseClaimReverseChargeLines(
  base: number,
  kind: ExpenseClaimReverseCharge,
  expenseAccount: string,
  row: VoucherVatCodeAccountRow | null | undefined,
): CreateJournalEntryLineInput[] | null {
  if (reverseChargeAccountConflict(expenseAccount, row, kind)) return null
  const rule = vatCodeRuleForAccount(expenseAccount, row)
  if (rule.mode === 'fixed') {
    return generateReverseChargePurchaseLines({ base, rate: rule.code.rate, kind, basisBase: 0 })
  }
  return generateReverseChargePurchaseLines({ base, kind })
}

/**
 * The answer to "Var finns säljaren?" in the inbox utlägg dialog, one per
 * booking: Swedish moms on 2641, the whole amount as cost abroad, or
 * omvänd skattskyldighet on a service from the EU or from outside it.
 */
export type ExpenseVatCase = 'domestic' | 'abroad' | 'reverse_charge_eu' | 'reverse_charge_non_eu'

export const EXPENSE_VAT_CASES: readonly ExpenseVatCase[] = [
  'domestic',
  'abroad',
  'reverse_charge_eu',
  'reverse_charge_non_eu',
]

export function reverseChargeForVatCase(vatCase: ExpenseVatCase): ExpenseClaimReverseCharge | undefined {
  if (vatCase === 'reverse_charge_eu') return 'eu_services'
  if (vatCase === 'reverse_charge_non_eu') return 'non_eu_services'
  return undefined
}

/**
 * Merchant categories of a purchase bought where it is used: a meal, a ride,
 * a hotel night, parking, fuel or groceries. Abroad they are taxed where they
 * are performed or sold (ML 6 kap.), never by omvänd skattskyldighet here.
 */
const BOUGHT_ON_THE_SPOT: ReadonlySet<string> = new Set([
  'restaurant',
  'cafe',
  'taxi',
  'parking',
  'fuel',
  'grocery',
  'hotel',
])

/**
 * The answers the dialog offers for a receipt. The extraction's merchant
 * category only routes the question, it never answers it: a receipt bought on
 * the spot is offered no reverse-charge answer.
 */
export function expenseVatCasesForReceipt(receipt: {
  merchantCategory?: string | null
}): readonly ExpenseVatCase[] {
  return receipt.merchantCategory && BOUGHT_ON_THE_SPOT.has(receipt.merchantCategory)
    ? ['domestic', 'abroad']
    : EXPENSE_VAT_CASES
}

/**
 * The answer a receipt gives by itself, or null when it gives none. Only VAT
 * the receipt shows decides, and only when the seller's VAT number agrees
 * with the currency: SEK moms is Swedish, VAT in another currency is foreign
 * and booked as cost. SEK moms beside a foreign VAT number, or foreign-currency
 * VAT beside a Swedish one (a Swedish seller billing in euro, or the buyer's
 * own number read as the seller's), is asked. So is a receipt without VAT, or
 * whose VAT was not read: it may be a Swedish purchase without moms, a meal
 * abroad or a service under omvänd skattskyldighet, and neither the currency
 * nor the amount tells them apart.
 */
export function vatCaseFromReceipt(receipt: {
  currency: string
  vatAmount: number | null | undefined
  sellerVatNumber?: string | null
}): ExpenseVatCase | null {
  if (receipt.vatAmount == null || !(receipt.vatAmount > 0)) return null
  const country = vatNumberCountry(receipt.sellerVatNumber)
  if (receipt.currency.toUpperCase() === 'SEK') return country !== null && country !== 'SE' ? null : 'domestic'
  return country === 'SE' ? null : 'abroad'
}

/** The country prefix of a VAT number, or null when it has none. */
function vatNumberCountry(vatNumber: string | null | undefined): string | null {
  const prefix = normalizeVatNumber(vatNumber ?? '').slice(0, 2)
  return /^[A-Z]{2}$/.test(prefix) ? prefix : null
}
