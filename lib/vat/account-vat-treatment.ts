import type { VatDeclarationRutor } from '@/types'

export const ACCOUNT_VAT_TREATMENTS = [
  'standard_25', 'reduced_12', 'reduced_6', 'exempt',
  'reverse_charge_domestic', 'reverse_charge_eu_goods',
  'reverse_charge_eu_services', 'reverse_charge_non_eu_services',
  'export_goods', 'export_services', 'vmb', 'rental_voluntary',
] as const

export type AccountVatTreatment = typeof ACCOUNT_VAT_TREATMENTS[number]
export type AccountVatRate = 0 | 0.06 | 0.12 | 0.25 | null

export interface AccountVatRutaMapping {
  box: keyof VatDeclarationRutor
  side: 'credit' | 'debit'
}

const REVENUE_RUTA: Record<AccountVatTreatment, keyof VatDeclarationRutor | null> = {
  standard_25: 'ruta05', reduced_12: 'ruta05', reduced_6: 'ruta05',
  exempt: 'ruta42', reverse_charge_domestic: 'ruta41',
  reverse_charge_eu_goods: 'ruta35', reverse_charge_eu_services: 'ruta39',
  reverse_charge_non_eu_services: null,
  export_goods: 'ruta36', export_services: 'ruta40', vmb: 'ruta07',
  rental_voluntary: 'ruta08',
}

export function resolveVatTreatmentRuta(
  treatment: AccountVatTreatment,
  accountClass: number,
  accountNumber?: string,
): AccountVatRutaMapping | null {
  if (accountClass === 3) {
    const box = REVENUE_RUTA[treatment]
    return box ? { box, side: 'credit' } : null
  }
  if (accountClass < 4 || accountClass > 6) return null
  if (treatment === 'reverse_charge_eu_goods') return { box: 'ruta20', side: 'debit' }
  if (treatment === 'reverse_charge_eu_services') return { box: 'ruta21', side: 'debit' }
  if (treatment === 'reverse_charge_non_eu_services') return { box: 'ruta22', side: 'debit' }
  if (treatment === 'reverse_charge_domestic') {
    const isKnownServiceAccount = accountNumber != null && /^442[567]$/.test(accountNumber)
    return { box: accountClass === 4 && !isKnownServiceAccount ? 'ruta23' : 'ruta24', side: 'debit' }
  }
  return null
}

export function isVatTreatmentAllowedForAccountClass(
  treatment: AccountVatTreatment,
  accountClass: number,
): boolean {
  return resolveVatTreatmentRuta(treatment, accountClass) !== null
}

export function vatTreatmentsForAccountClass(accountClass: number | null): AccountVatTreatment[] {
  if (accountClass === null) return []
  return ACCOUNT_VAT_TREATMENTS.filter((treatment) =>
    isVatTreatmentAllowedForAccountClass(treatment, accountClass)
  )
}

export function defaultRateForVatTreatment(
  treatment: AccountVatTreatment,
  accountClass: number,
): AccountVatRate {
  if (treatment === 'standard_25') return 0.25
  if (treatment === 'reduced_12') return 0.12
  if (treatment === 'reduced_6') return 0.06
  if (treatment === 'exempt') return 0
  if (treatment === 'vmb') return null
  if (treatment === 'rental_voluntary') return 0.25
  if (treatment === 'export_goods' || treatment === 'export_services') return 0
  return accountClass >= 4 && accountClass <= 6 ? 0.25 : 0
}

export function isAccountVatTreatment(value: unknown): value is AccountVatTreatment {
  return typeof value === 'string' &&
    (ACCOUNT_VAT_TREATMENTS as readonly string[]).includes(value)
}

export interface SuggestedVatTreatment {
  treatment: AccountVatTreatment
  rate: number | null
}

/**
 * Suggest a VAT treatment from a SIE account label. SIE #SRU and #KTYP are
 * deliberately excluded: neither record carries a momsdeklaration treatment.
 * Suggestions are persisted only after the user reviews the import mapping.
 */
export function suggestVatTreatment(
  accountNumber: string,
  accountName: string,
): SuggestedVatTreatment | null {
  const accountClass = Number(accountNumber.charAt(0))
  if (accountClass < 3 || accountClass > 6) return null
  const name = accountName.toLocaleLowerCase('sv-SE')
  const percent = /\b(25|12|6)\s*%/.exec(name)
  const rate = percent ? Number(percent[1]) / 100 : 0.25

  if (accountClass === 3) {
    if (/vmb|vinstmarginal/.test(name)) return { treatment: 'vmb', rate: null }
    if (/hyra|uthyrning/.test(name) && /frivillig/.test(name)) return { treatment: 'rental_voluntary', rate }
    if (/omvänd/.test(name)) return { treatment: 'reverse_charge_domestic', rate: 0 }
    if (/export|utanför eu/.test(name) && /var/.test(name)) return { treatment: 'export_goods', rate: 0 }
    if (/export|utanför eu/.test(name) && /tjänst|tjanst/.test(name)) return { treatment: 'export_services', rate: 0 }
    if (/\beu\b/.test(name) && /var/.test(name)) return { treatment: 'reverse_charge_eu_goods', rate: 0 }
    if (/\beu\b/.test(name) && /tjänst|tjanst/.test(name)) return { treatment: 'reverse_charge_eu_services', rate: 0 }
    if (/momsfri|utan moms/.test(name)) return { treatment: 'exempt', rate: 0 }
    if (/försälj|forsalj|intäkt|intakt/.test(name) && percent) {
      return {
        treatment: rate === 0.12 ? 'reduced_12' : rate === 0.06 ? 'reduced_6' : 'standard_25',
        rate,
      }
    }
    return null
  }

  if (/omvänd/.test(name) && /sverige|svensk|inrikes/.test(name)) return { treatment: 'reverse_charge_domestic', rate }
  if (/utanför eu|import/.test(name) && /var/.test(name)) return null
  if (/utanför eu/.test(name) && /tjänst|tjanst/.test(name)) {
    return { treatment: 'reverse_charge_non_eu_services', rate }
  }
  if (/\beu\b/.test(name) && /var/.test(name)) return { treatment: 'reverse_charge_eu_goods', rate }
  if (/\beu\b/.test(name) && /tjänst|tjanst/.test(name)) return { treatment: 'reverse_charge_eu_services', rate }
  return null
}
