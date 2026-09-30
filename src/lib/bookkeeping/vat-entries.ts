import type { CreateJournalEntryLineInput, VatTreatment } from '@/types'
import { isAccountVatTreatment, resolveVatTreatmentRuta } from '@/lib/vat/account-vat-treatment'

/**
 * Generate VAT journal entry lines based on VAT treatment
 *
 * Swedish VAT scenarios:
 * - Domestic 25%: Credit 2611 (utgående moms)
 * - Domestic 12%: Credit 2621
 * - Domestic 6%: Credit 2631
 * - Input VAT deduction: Debit 2641 (ingående moms)
 * - EU reverse charge (fiktiv moms): Debit 2645, Credit 2614 (offsetting)
 * - Export (non-EU): No VAT lines
 */

interface VatEntryConfig {
  vatTreatment: VatTreatment
  baseAmount: number // Amount before VAT
  direction: 'sales' | 'purchase'
}

/**
 * Get VAT rate from treatment
 */
export function getVatRate(treatment: VatTreatment): number {
  switch (treatment) {
    case 'standard_25':
      return 0.25
    case 'reduced_12':
      return 0.12
    case 'reduced_6':
      return 0.06
    case 'reverse_charge':
    case 'export':
    case 'exempt':
      return 0
    default:
      return 0.25
  }
}

/**
 * Expense/basis accounts that already populate momsdeklaration ruta 20-24
 * directly when debited (the basbelopp for a reverse-charge purchase). If an RC
 * item is booked straight to one of these, the engine must NOT add the parallel
 * basbeloppsrader: that would double-count ruta 20-24.
 *
 *   ruta 20  EU goods             4515/4516/4517
 *   ruta 21  EU services          4535/4536/4537
 *   ruta 22  non-EU services      4531/4532/4533
 *   ruta 23  domestic goods RC    4415/4416/4417
 *   ruta 24  domestic services RC 4425/4426/4427
 */
export const RC_BASIS_ACCOUNTS: ReadonlySet<string> = new Set([
  '4515', '4516', '4517',
  '4535', '4536', '4537',
  '4531', '4532', '4533',
  '4415', '4416', '4417',
  '4425', '4426', '4427',
])

export function isReverseChargeBasisAccount(account: string): boolean {
  return RC_BASIS_ACCOUNTS.has(account)
}

/**
 * The offsetting credit of the basis pair: 45xx is debited for the statistic
 * (ruta 20-22) and 4598 credited with the same amount, so the income
 * statement nets to zero. Named here because a basis leg is never the
 * business line of a booking.
 */
export const RC_BASIS_OFFSET_ACCOUNT = '4598'

/** True for either leg of the reverse-charge basis pair (the 45xx statistic or its 4598 offset). */
export function isReverseChargeBasisLeg(account: string): boolean {
  return isReverseChargeBasisAccount(account) || account === RC_BASIS_OFFSET_ACCOUNT
}

/**
 * Fiktiv-moms VAT accounts: self-assessed output VAT for reverse charge
 * (2614/2624/2634) and import (2615/2625/2635), plus the offsetting calculated
 * input legs (2645 EU/non-EU, 2647 domestic RC). The foreign supplier charged
 * no VAT, so the transaction total IS the tax base (beskattningsunderlag), and
 * the amount booked on these accounts is the self-assessed VAT: total * rate
 * added on top, never rate/(1+rate) extracted out of the total. Mirrors the
 * private set in counterparty-templates.ts used to keep these legs out of
 * learned patterns.
 */
export const REVERSE_CHARGE_VAT_ACCOUNTS: ReadonlySet<string> = new Set([
  '2614', '2624', '2634', '2615', '2625', '2635', '2645', '2647',
])

export function isReverseChargeVatAccount(account: string): boolean {
  return REVERSE_CHARGE_VAT_ACCOUNTS.has(account)
}

/**
 * Every moms account a generated verifikat can carry: the output legs
 * (2611-2613 domestic, plus the fiktiv-moms and import legs above), the
 * deductible input leg 2641, and the clearing account 2650. Used to tell a
 * proposal's moms lines apart from the business line it books against.
 */
export const GENERATED_VAT_ACCOUNTS: ReadonlySet<string> = new Set([
  '2610', '2611', '2612', '2613', '2616', '2617', '2618',
  '2620', '2621', '2622', '2623', '2630', '2631', '2632', '2633',
  '2641', '2642', '2650',
  ...REVERSE_CHARGE_VAT_ACCOUNTS,
])

/** True for a moms leg of a generated verifikat (ingående, utgående, fiktiv or clearing). */
export function isGeneratedVatAccount(account: string): boolean {
  return GENERATED_VAT_ACCOUNTS.has(account)
}

/**
 * The self-assessed VAT rate to apply to a reverse-charge line.
 *
 * Under omvänd skattskyldighet the supplier charges no VAT, so the line's own
 * `vat_rate` is 0 (the v1 supplier-invoice API mandates this). The buyer must
 * still self-assess output + input VAT at the Swedish statutory rate that would
 * apply to the service domestically: 25% under huvudregeln for EU services
 * (ML 6 kap 34 §), 12%/6% for reduced-rated services. Resolution order:
 *
 *   1. explicit per-item `reverse_charge_rate` (the UI's self-assessment picker)
 *   2. a positive `vat_rate` on the line (legacy/API callers that encoded the
 *      self-assessment rate directly on vat_rate)
 *   3. 25% huvudregel default: never silently drop the fiktiv-moms lines.
 *
 * Keeping this in one place means the booking engine and the review-dialog
 * preview can never drift. The original bug was two independent copies of a
 * `rate > 0` assumption, each skipping the VAT entirely on a 0%-rate RC line.
 */
export function resolveReverseChargeRate(
  item: { vat_rate?: number | null; reverse_charge_rate?: number | null },
): number {
  const explicit = item.reverse_charge_rate
  if (explicit != null && explicit > 0) return explicit
  if (item.vat_rate != null && item.vat_rate > 0) return item.vat_rate
  return 0.25
}

/**
 * Generate output VAT lines for sales invoices
 * Debit 1510 Kundfordringar [total incl VAT]
 * Credit 30xx Försäljning [subtotal]
 * Credit 26xx Utgående moms [vat_amount]
 */
export function generateSalesVatLines(config: VatEntryConfig): CreateJournalEntryLineInput[] {
  const lines: CreateJournalEntryLineInput[] = []
  const vatRate = getVatRate(config.vatTreatment)

  if (vatRate === 0) return lines

  const vatAmount = Math.round(config.baseAmount * vatRate * 100) / 100

  // Determine the output VAT account
  let vatAccount: string
  switch (config.vatTreatment) {
    case 'standard_25':
      vatAccount = '2611' // Utgående moms försäljning 25%
      break
    case 'reduced_12':
      vatAccount = '2621' // Utgående moms försäljning 12%
      break
    case 'reduced_6':
      vatAccount = '2631' // Utgående moms försäljning 6%
      break
    default:
      return lines
  }

  lines.push({
    account_number: vatAccount,
    debit_amount: 0,
    credit_amount: vatAmount,
    line_description: `Utgående moms ${vatRate * 100}%`,
  })

  return lines
}

/**
 * The supplier classification the reverse-charge producers already carry
 * (booking templates, suppliers, kontantmetod groups).
 */
export type ReverseChargeSupplierType = 'eu_business' | 'non_eu_business' | 'swedish_business'

/**
 * What kind of omvänd-skattskyldighet purchase this is. It decides the basis
 * account, and with it the momsdeklaration ruta, plus whether the fiktiv
 * ingående moms goes to 2645 or 2647 (BAS 2026, swedish-vat reference):
 *
 *   eu_goods          4515/4516/4517  ruta 20  2645  (unionsinternt förvärv)
 *   eu_services       4535/4536/4537  ruta 21  2645  (huvudregeln, ML 6 kap. 33 §)
 *   non_eu_services   4531/4532/4533  ruta 22  2645
 *   domestic_services 4425/4426/4427  ruta 24  2647  (ML 16 kap: byggtjänster m.m.)
 *
 * The output leg is 2614/2624/2634 (ruta 30/31/32) for every kind.
 */
export type ReverseChargeKind = 'eu_goods' | 'eu_services' | 'non_eu_services' | 'domestic_services'

export const REVERSE_CHARGE_KINDS: readonly ReverseChargeKind[] = [
  'eu_goods', 'eu_services', 'non_eu_services', 'domestic_services',
]

/**
 * The kind a producer books when nothing tells it which one applies: EU
 * services, the most common reverse-charge purchase. The same default the
 * mapping rules, booking templates without a supplier type and the
 * rc-basis-gaps repair (4535) already use.
 */
export const DEFAULT_REVERSE_CHARGE_KIND: ReverseChargeKind = 'eu_services'

/**
 * vat_treatment spellings that name the basis box of a reverse-charge
 * purchase, in the vocabulary chart_of_accounts.default_vat_treatment already
 * uses. A booking surface that accepts one books vat_treatment
 * 'reverse_charge' with this kind; plain 'reverse_charge' keeps working and
 * takes DEFAULT_REVERSE_CHARGE_KIND.
 */
export const REVERSE_CHARGE_TREATMENT_KINDS = {
  reverse_charge_eu_goods: 'eu_goods',
  reverse_charge_eu_services: 'eu_services',
  reverse_charge_non_eu_services: 'non_eu_services',
} as const satisfies Record<string, ReverseChargeKind>

export function isReverseChargeKind(value: unknown): value is ReverseChargeKind {
  return typeof value === 'string' && (REVERSE_CHARGE_KINDS as readonly string[]).includes(value)
}

export function reverseChargeKindForSupplierType(supplierType: ReverseChargeSupplierType): ReverseChargeKind {
  if (supplierType === 'non_eu_business') return 'non_eu_services'
  if (supplierType === 'swedish_business') return 'domestic_services'
  return 'eu_services'
}

/** The momsdeklaration box the basis pair of a kind lands in. */
export function reverseChargeKindRuta(kind: ReverseChargeKind): 'ruta20' | 'ruta21' | 'ruta22' | 'ruta24' {
  if (kind === 'eu_goods') return 'ruta20'
  if (kind === 'non_eu_services') return 'ruta22'
  if (kind === 'domestic_services') return 'ruta24'
  return 'ruta21'
}

const RC_BASIS_BOXES: ReadonlySet<string> = new Set(['ruta20', 'ruta21', 'ruta22', 'ruta23', 'ruta24'])

/**
 * Whether a debit on `account` already reports the reverse-charge basis in
 * ruta 20-24 by itself, so a producer must not add the 44xx/45xx / 4598 pair
 * on top of it (the pair would count the purchase twice).
 *
 * With the account's chart row (`accountVatTreatment` is its
 * default_vat_treatment, null when unset) this is the declaration's own rule
 * (fetchDynamicVatAccounts + rutorFromTotals): a configured treatment decides,
 * so a class 4-6 account set to a reverse_charge_* purchase treatment reports
 * its own box whatever its number, and an unconfigured account reports only
 * when it is one of the static BAS basis accounts (RC_BASIS_ACCOUNTS).
 *
 * Without the row (`undefined`) the 44xx/45xx range stands in, as it always
 * has for the pure producers (mapping rules, booking templates): it covers the
 * static accounts and the company-numbered basis accounts (4518, 4534, 4538)
 * that carry a configured treatment in practice.
 */
export function costAccountReportsRcBasis(account: string, accountVatTreatment?: string | null): boolean {
  if (accountVatTreatment === undefined) return /^4[45]\d{2}$/.test(account)
  if (isAccountVatTreatment(accountVatTreatment)) {
    const mapping = resolveVatTreatmentRuta(accountVatTreatment, Number(account.charAt(0)), account)
    return mapping !== null && RC_BASIS_BOXES.has(mapping.box)
  }
  return isReverseChargeBasisAccount(account)
}

/** One reverse-charge purchase (or one rate group of one). */
export interface ReverseChargePurchase {
  /** Beskattningsunderlag in SEK: the purchase amount, the seller charged no VAT. */
  base: number
  /** Self-assessed Swedish rate (resolveReverseChargeRate). Defaults to 25 %. */
  rate?: number
  kind: ReverseChargeKind
  /**
   * The part of `base` that still needs the basis pair. Defaults to all of
   * it. Pass 0, or the share booked elsewhere, when the cost line already sits
   * on an account that reports ruta 20-24 itself (costAccountReportsRcBasis).
   */
  basisBase?: number
}

/**
 * The complete line set of a reverse-charge purchase: the fiktiv-moms pair
 * (2645|2647 D / 26x4 K, ruta 30-32 and 48) AND the basis pair (44xx|45xx D /
 * 4598 K, ruta 20-24). This is the only exported way to generate the fiktiv
 * pair, so no producer can post rutor 30-32 without the basis that
 * Skatteverket requires beside them (felkod FK004: "Eftersom det finns ett
 * belopp i någon momsuppgift som avser utgående moms på inköp (30-32) måste
 * det finnas ett belopp i någon av momsuppgifterna avseende momspliktiga
 * inköp vid omvänd betalningsskyldighet (20-24)"). Four producers used to pair
 * the two generators on their own; the category path forgot (#2919).
 *
 * The user's cost account (e.g. 6540) stays in the income statement: 45xx is
 * debited and 4598 credited with the same amount, so the pair nets to zero
 * there while the 45xx account feeds the declaration box.
 *
 * Domestic goods (ruta 23, 4415-4417) have no kind: no producer books them.
 */
export function generateReverseChargePurchaseLines(purchase: ReverseChargePurchase): CreateJournalEntryLineInput[] {
  if (!(purchase.base > 0)) return []
  const rate = purchase.rate ?? 0.25
  return [
    ...fiktivMomsLines(purchase.base, rate, purchase.kind === 'domestic_services'),
    ...basisPairLines(purchase.basisBase ?? purchase.base, rate, purchase.kind),
  ]
}

/**
 * The basis pair alone, for a supplier credit note that mirrors the pair its
 * registration posted next to hand-built reversed fiktiv lines. Producers that
 * book a purchase use generateReverseChargePurchaseLines.
 */
export function generateReverseChargeBasisLines(
  baseAmount: number,
  vatRate: number = 0.25,
  supplierType: ReverseChargeSupplierType,
): CreateJournalEntryLineInput[] {
  return basisPairLines(baseAmount, vatRate, reverseChargeKindForSupplierType(supplierType))
}

function basisPairLines(
  baseAmount: number,
  vatRate: number,
  kind: ReverseChargeKind,
): CreateJournalEntryLineInput[] {
  if (baseAmount <= 0) return []

  const basisAccount = pickBasisAccount(vatRate, kind)
  if (!basisAccount) return []

  const amount = Math.round(baseAmount * 100) / 100
  const rateLabel = `${Math.round(vatRate * 100)}%`

  return [
    {
      account_number: basisAccount.account,
      debit_amount: amount,
      credit_amount: 0,
      line_description: `${basisAccount.label} ${rateLabel} (basbelopp omvänd skattskyldighet)`,
    },
    {
      account_number: RC_BASIS_OFFSET_ACCOUNT,
      debit_amount: 0,
      credit_amount: amount,
      line_description: `Motkonto beräknad omvänd moms ${rateLabel}`,
    },
  ]
}

function pickBasisAccount(
  vatRate: number,
  kind: ReverseChargeKind,
): { account: string; label: string } | null {
  const rateIdx = vatRate === 0.25 ? 0 : vatRate === 0.12 ? 1 : vatRate === 0.06 ? 2 : -1
  if (rateIdx < 0) return null

  if (kind === 'eu_goods') {
    return {
      account: ['4515', '4516', '4517'][rateIdx],
      label: 'Inköp varor från annat EU-land',
    }
  }
  if (kind === 'eu_services') {
    return {
      account: ['4535', '4536', '4537'][rateIdx],
      label: 'Inköp tjänster annat EU-land',
    }
  }
  if (kind === 'non_eu_services') {
    return {
      account: ['4531', '4532', '4533'][rateIdx],
      label: 'Inköp tjänster land utanför EU',
    }
  }
  // domestic_services: domestic RC (byggtjänster m.m.)
  return {
    account: ['4425', '4426', '4427'][rateIdx],
    label: 'Inköp tjänster i Sverige omvänd skattskyldighet',
  }
}

/**
 * The fiktiv-moms pair. Private on purpose: see
 * generateReverseChargePurchaseLines.
 * For EU/non-EU purchases: Debit 2645 + Credit 26x4 (offsetting entries)
 * For domestic reverse charge: Debit 2647 + Credit 26x4 (offsetting entries)
 */
function fiktivMomsLines(
  baseAmount: number,
  vatRate: number,
  isDomestic: boolean,
): CreateJournalEntryLineInput[] {
  const vatAmount = Math.round(baseAmount * vatRate * 100) / 100

  // Determine output account based on rate
  let outputAccount: string
  switch (vatRate) {
    case 0.25:
      outputAccount = '2614' // Utgående moms omvänd skattskyldighet 25%
      break
    case 0.12:
      outputAccount = '2624' // Utgående moms omvänd skattskyldighet 12%
      break
    case 0.06:
      outputAccount = '2634' // Utgående moms omvänd skattskyldighet 6%
      break
    default:
      outputAccount = '2614'
  }

  // Input VAT account: 2647 for domestic RC (ML 16 kap), 2645 for EU/non-EU
  const inputAccount = isDomestic ? '2647' : '2645'
  const context = isDomestic ? 'omvänd skattskyldighet i Sverige' : 'omvänd skattskyldighet'

  return [
    {
      account_number: inputAccount,
      debit_amount: vatAmount,
      credit_amount: 0,
      line_description: `Fiktiv ingående moms ${vatRate * 100}% (${context})`,
    },
    {
      account_number: outputAccount,
      debit_amount: 0,
      credit_amount: vatAmount,
      line_description: `Fiktiv utgående moms ${vatRate * 100}% (${context})`,
    },
  ]
}

/**
 * Generate input VAT deduction line for domestic purchases
 * Debit 2641 Ingående moms
 */
export function generateInputVatLine(
  totalAmount: number,
  vatRate: number = 0.25
): CreateJournalEntryLineInput | null {
  if (vatRate === 0) return null

  // Extract VAT from total amount (VAT-inclusive)
  const vatAmount = Math.round((totalAmount * vatRate) / (1 + vatRate) * 100) / 100

  return {
    account_number: '2641', // Debiterad ingående moms
    debit_amount: vatAmount,
    credit_amount: 0,
    line_description: `Ingående moms ${vatRate * 100}%`,
  }
}

/**
 * Calculate the net amount (excl VAT) from a total amount
 */
export function extractNetAmount(totalAmount: number, vatRate: number): number {
  if (vatRate === 0) return totalAmount
  return Math.round((totalAmount / (1 + vatRate)) * 100) / 100
}

/**
 * Calculate VAT amount from a total amount (VAT-inclusive)
 */
export function extractVatAmount(totalAmount: number, vatRate: number): number {
  if (vatRate === 0) return 0
  return Math.round((totalAmount - totalAmount / (1 + vatRate)) * 100) / 100
}
