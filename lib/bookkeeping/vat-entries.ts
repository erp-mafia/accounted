import type { CreateJournalEntryLineInput, VatTreatment } from '@/types'

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
 * basbeloppsrader — that would double-count ruta 20-24.
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
 * The self-assessed VAT rate to apply to a reverse-charge line.
 *
 * Under omvänd skattskyldighet the supplier charges no VAT, so the line's own
 * `vat_rate` is 0 (the v1 supplier-invoice API mandates this). The buyer must
 * still self-assess output + input VAT at the Swedish statutory rate that would
 * apply to the service domestically — 25% under huvudregeln for EU services
 * (ML 6 kap 34 §), 12%/6% for reduced-rated services. Resolution order:
 *
 *   1. explicit per-item `reverse_charge_rate` (the UI's self-assessment picker)
 *   2. a positive `vat_rate` on the line (legacy/API callers that encoded the
 *      self-assessment rate directly on vat_rate)
 *   3. 25% huvudregel default — never silently drop the fiktiv-moms lines.
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
 * Generate reverse-charge basis lines for momsdeklaration ruta 20-24.
 *
 * The fiktiv-moms pair (2645/26x4 or 2647/26x4) only carries the VAT amounts
 * (ruta 30-32 and the offsetting part of ruta 48). The underlying basbelopp
 * (vad köpet de facto kostade) must also land on the 44xx/45xx series so
 * Skatteverket sees ruta 20-24 populated — ML 13 kap kräver att både underlag
 * och moms redovisas. SKV avvisar deklarationer med ruta 30-32 men tom 20-24
 * (felkod FK004 "Eftersom det finns ett belopp i någon momsuppgift som avser
 * utgående moms på inköp (30-32) måste det finnas ett belopp i någon av
 * momsuppgifterna avseende momspliktiga inköp vid omvänd betalningsskyldighet
 * (20-24)").
 *
 * Användarens valda kostnadskonto (t.ex. 6540) bibehålls i resultaträkningen
 * via en parallell motkonto-rad: 45xx debiteras, 4598 krediteras med samma
 * belopp. Resultaträkningen påverkas inte (4598 nettar ut 45xx), men 45xx
 * fångas av momsdeklarationsberäkningen för rätt ruta 20-24.
 *
 * Konto-mappning (BAS 2026 + swedish-vat reference §7):
 *
 *   EU services       (huvudregeln)  4535/4536/4537 → ruta 21
 *   Non-EU services                  4531/4532/4533 → ruta 22
 *   Domestic services (byggtjänster) 4425/4426/4427 → ruta 24
 *   Domestic goods    (RC varor)     4415/4416/4417 → ruta 23
 *
 * EU-varor (ruta 20, 4515/4516/4517) hanteras inte här eftersom våra supplier
 * invoices saknar varor/tjänster-diskriminering. Standard-supplier-flödet är
 * tjänster (SaaS, konsulttjänster); EU-varuhandel sker normalt via SIE-import
 * eller manuell verifikation och får bokas direkt på 4515-konton.
 */
export function generateReverseChargeBasisLines(
  baseAmount: number,
  vatRate: number = 0.25,
  supplierType: 'eu_business' | 'non_eu_business' | 'swedish_business',
): CreateJournalEntryLineInput[] {
  if (baseAmount <= 0) return []

  const basisAccount = pickBasisAccount(vatRate, supplierType)
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
      account_number: '4598',
      debit_amount: 0,
      credit_amount: amount,
      line_description: `Motkonto beräknad omvänd moms ${rateLabel}`,
    },
  ]
}

function pickBasisAccount(
  vatRate: number,
  supplierType: 'eu_business' | 'non_eu_business' | 'swedish_business',
): { account: string; label: string } | null {
  const rateIdx = vatRate === 0.25 ? 0 : vatRate === 0.12 ? 1 : vatRate === 0.06 ? 2 : -1
  if (rateIdx < 0) return null

  if (supplierType === 'eu_business') {
    return {
      account: ['4535', '4536', '4537'][rateIdx],
      label: 'Inköp tjänster annat EU-land',
    }
  }
  if (supplierType === 'non_eu_business') {
    return {
      account: ['4531', '4532', '4533'][rateIdx],
      label: 'Inköp tjänster land utanför EU',
    }
  }
  // swedish_business — domestic RC (byggtjänster m.m.)
  return {
    account: ['4425', '4426', '4427'][rateIdx],
    label: 'Inköp tjänster i Sverige omvänd skattskyldighet',
  }
}

/**
 * Generate reverse charge lines (fiktiv moms)
 * For EU/non-EU purchases: Debit 2645 + Credit 26x4 (offsetting entries)
 * For domestic reverse charge: Debit 2647 + Credit 26x4 (offsetting entries)
 */
export function generateReverseChargeLines(
  baseAmount: number,
  vatRate: number = 0.25,
  isDomestic: boolean = false
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
