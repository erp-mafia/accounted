import type { VatDeclarationRutor } from '@/types'

export const ACCOUNT_VAT_TREATMENTS = [
  'standard_25', 'reduced_12', 'reduced_6', 'exempt',
  'reverse_charge_domestic', 'reverse_charge_eu_goods',
  'reverse_charge_eu_services', 'reverse_charge_non_eu_services',
  'export_goods', 'export_services', 'vmb', 'rental_voluntary',
  'oss', 'triangulation_eu_goods',
] as const

export type AccountVatTreatment = typeof ACCOUNT_VAT_TREATMENTS[number]
export type AccountVatRate = 0 | 0.06 | 0.12 | 0.25 | null

export interface AccountVatRutaMapping {
  box: keyof VatDeclarationRutor
  side: 'credit' | 'debit'
}

/**
 * Revenue (class 3) treatments and the momsdeklaration box they feed. A key
 * mapped to `null` is a valid revenue treatment whose amounts are deliberately
 * kept out of every ruta: OSS sales (unionsordningen) are declared only in the
 * quarterly OSS declaration, never in the Swedish momsdeklaration
 * (Skatteverket: "Den försäljning som du redovisar i OSS ska du inte redovisa
 * i den vanliga momsdeklarationen"). Treatments missing from the map are
 * purchase-only.
 */
const REVENUE_RUTA: Partial<Record<AccountVatTreatment, keyof VatDeclarationRutor | null>> = {
  standard_25: 'ruta05', reduced_12: 'ruta05', reduced_6: 'ruta05',
  exempt: 'ruta42', reverse_charge_domestic: 'ruta41',
  reverse_charge_eu_goods: 'ruta35', reverse_charge_eu_services: 'ruta39',
  triangulation_eu_goods: 'ruta38',
  export_goods: 'ruta36', export_services: 'ruta40', vmb: 'ruta07',
  rental_voluntary: 'ruta08',
  oss: null,
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
  // Trepartshandel: the middleman declares the purchase in ruta 37 and the
  // onward sale in ruta 38, with no output or input VAT on either. One
  // treatment rather than two, resolved by account class, exactly as
  // reverse_charge_eu_goods already is.
  if (treatment === 'triangulation_eu_goods') return { box: 'ruta37', side: 'debit' }
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
  if (accountClass === 3) return treatment in REVENUE_RUTA
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
  // VMB has no single sats; OSS accounts carry the destination country's
  // rate, which is not a Swedish sats and never drives ruta 05 arithmetic.
  if (treatment === 'vmb' || treatment === 'oss') return null
  if (treatment === 'rental_voluntary') return 0.25
  if (treatment === 'export_goods' || treatment === 'export_services') return 0
  // Trepartshandel is zero on BOTH sides, so it cannot take the reverse-charge
  // fall-through below. The middleman does not self-assess acquisition VAT at
  // all: that is the simplification the scheme exists for, and the tax is
  // accounted for by the final buyer in the destination country. Without this
  // line a purchase account would default to 25 % and invent a rate the trade
  // does not have.
  if (treatment === 'triangulation_eu_goods') return 0
  // Reverse charge on a class 4 to 6 account carries a real acquisition rate,
  // which drives the rc-basis check.
  return accountClass >= 4 && accountClass <= 6 ? 0.25 : 0
}

export function isAccountVatTreatment(value: unknown): value is AccountVatTreatment {
  return typeof value === 'string' &&
    (ACCOUNT_VAT_TREATMENTS as readonly string[]).includes(value)
}

/**
 * The union's name as it appears in Swedish account labels. "EG" (Europeiska
 * gemenskapen) is the pre-Lisbon term; charts created before the 2009 rename
 * kept it, and a single chart routinely carries both spellings, because
 * accounts added later picked up current BAS names while the older ones were
 * never renamed. Both spellings mean the same rutor, so the vocabulary is
 * defined once here instead of being spelled out at each of the six places
 * that test for it: a term added to one branch and forgotten in another is
 * exactly how the EG labels came to be read as momsfri.
 *
 * OUTSIDE_UNION must be tested before UNION everywhere, since "utanför EU"
 * also satisfies UNION. Its trailing \b keeps "utanför Europa" from reading
 * as a sale outside the union.
 */
const UNION = /\b(?:eu|eg)\b/
const OUTSIDE_UNION = /utanför\s+(?:eu|eg)\b/

export interface SuggestedVatTreatment {
  treatment: AccountVatTreatment
  rate: number | null
}

/**
 * The momssats an account label spells out ("Inköp varor EU 12%", "Försäljning
 * 6 % moms"), or null when it names none. Shared by the label suggestion and
 * the provider-code prefill: a source system's reverse-charge code says
 * which ruta the basis feeds but not the acquisition rate, and Fortnox ships
 * 4516/4517-style 12% and 6% accounts under the same IVEU code as 4515.
 */
export function vatRateFromLabel(label: string): 0.25 | 0.12 | 0.06 | null {
  const percent = /\b(25|12|6)\s*%/.exec(label)
  if (!percent) return null
  return percent[1] === '25' ? 0.25 : percent[1] === '12' ? 0.12 : 0.06
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
  const percent = vatRateFromLabel(name)
  const rate = percent ?? 0.25

  if (accountClass === 3) {
    if (/\boss\b|one stop shop|unionsordning/.test(name)) return { treatment: 'oss', rate: null }
    if (/vmb|vinstmarginal/.test(name)) return { treatment: 'vmb', rate: null }
    if (/hyra|uthyrning/.test(name) && /frivillig/.test(name)) return { treatment: 'rental_voluntary', rate }
    if (/omvänd/.test(name)) return { treatment: 'reverse_charge_domestic', rate: 0 }
    if ((/export/.test(name) || OUTSIDE_UNION.test(name)) && /var/.test(name)) return { treatment: 'export_goods', rate: 0 }
    if ((/export/.test(name) || OUTSIDE_UNION.test(name)) && /tjänst|tjanst/.test(name)) return { treatment: 'export_services', rate: 0 }
    // Before the plain EU-goods rule, which would otherwise swallow it: a
    // trepartshandel label names EU and varor too, but files ruta 38, not 35.
    if (/trepart/.test(name) && /var/.test(name)) {
      return { treatment: 'triangulation_eu_goods', rate: 0 }
    }
    if (UNION.test(name) && /var/.test(name)) {
      // BAS 3106 "Försäljning varor till annat EU-land, momspliktig" carries
      // Swedish moms below the OSS threshold and destination-country moms
      // (OSS) above it. The label cannot tell which, so leave the row for
      // review instead of suggesting the momsfri ruta 35 treatment.
      if (/momspliktig/.test(name)) return null
      return { treatment: 'reverse_charge_eu_goods', rate: 0 }
    }
    if (UNION.test(name) && /tjänst|tjanst/.test(name)) return { treatment: 'reverse_charge_eu_services', rate: 0 }
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
  if ((OUTSIDE_UNION.test(name) || /import/.test(name)) && /var/.test(name)) return null
  if (OUTSIDE_UNION.test(name) && /tjänst|tjanst/.test(name)) {
    return { treatment: 'reverse_charge_non_eu_services', rate }
  }
  if (/trepart/.test(name) && /var/.test(name)) return { treatment: 'triangulation_eu_goods', rate: 0 }
  if (UNION.test(name) && /var/.test(name)) return { treatment: 'reverse_charge_eu_goods', rate }
  if (UNION.test(name) && /tjänst|tjanst/.test(name)) return { treatment: 'reverse_charge_eu_services', rate }
  return null
}
