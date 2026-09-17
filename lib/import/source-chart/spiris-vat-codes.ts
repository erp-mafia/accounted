import {
  resolveVatTreatmentRuta,
  type AccountVatTreatment,
} from '@/lib/vat/account-vat-treatment'

/**
 * Spiris Bokföring VAT codes, which name the momsdeklaration ruta directly.
 *
 * Spiris Bokföring was called Visma eEkonomi until recently, and the rename is
 * worth knowing here for a reason beyond recognising the product: this repo
 * already has a `visma` provider, and the Fortnox momskod prefill deliberately
 * left it out because the API answers opaque VatCodeIds that need a /vatcodes
 * lookup. The chart CSV from the same product needs no lookup at all, so the
 * file route reaches a provider the API route gave up on.
 *
 * This is the easy end of the provider-code problem. Fortnox ships opaque
 * mnemonics that need a lookup table and land on an ambiguous ruta about half
 * the time; Spiris writes the ruta into the code, so "05-25%" is ruta 05 at
 * 25 % and there is nothing to guess. Measured across six yearly exports from
 * one company, every code took one of two shapes and every code appeared on
 * exactly one account class:
 *
 *   <ruta>-<rate>%   634 occurrences   "05-25%", "35-0%", "23-12%"
 *   <ruta>            36 occurrences   "48" only, on class 2 accounts
 *
 * The ruta alone would be enough to pick a treatment, but the account class is
 * checked too: a translation that silently accepted ruta 20 on a revenue
 * account would put an acquisition in a sales box.
 */

/** A Spiris code split into the parts it names. */
export interface SpirisVatCode {
  /** Momsdeklaration ruta, two digits exactly as written ("05", not "5"). */
  ruta: string
  /** The rate the code names, or null for the bare "48" form that names none. */
  rate: number | null
}

/**
 * Revenue rutor (class 3) and the treatment that files them.
 *
 * Ruta 05 is absent because it is the one ruta whose treatment depends on the
 * rate rather than the box: 25/12/6 are three different treatments.
 */
const REVENUE_TREATMENT: Record<string, AccountVatTreatment> = {
  '06': 'own_use',
  '07': 'vmb',
  '08': 'rental_voluntary',
  '35': 'reverse_charge_eu_goods',
  '38': 'triangulation_eu_goods',
  '36': 'export_goods',
  '39': 'reverse_charge_eu_services',
  '40': 'export_services',
  '41': 'reverse_charge_domestic',
  '42': 'exempt',
}

/** Cost rutor (classes 4 to 6) and the treatment that files them. */
const COST_TREATMENT: Record<string, AccountVatTreatment> = {
  '20': 'reverse_charge_eu_goods',
  '21': 'reverse_charge_eu_services',
  '22': 'reverse_charge_non_eu_services',
  '37': 'triangulation_eu_goods',
  '50': 'import_goods',
  // Both are omvänd skattskyldighet inom Sverige, and one treatment covers
  // them: which ruta gets filed is decided downstream by
  // resolveVatTreatmentRuta from the account number (441x varor, 442x
  // tjänster). Carrying two treatments that resolve identically would add a
  // state nothing reads. What the split DOES buy is a check, see
  // filesTheRutaItNames: the account number only carries the goods/services
  // distinction for those six BAS numbers, and outside them the code would be
  // filed in whichever box the fallback picks rather than the one Spiris
  // wrote.
  '23': 'reverse_charge_domestic',
  '24': 'reverse_charge_domestic',
}

/**
 * Whether the treatment a code names actually files the ruta the code wrote,
 * for this account.
 *
 * Every other treatment fixes its box by itself, so this is a tautology for
 * them and a real test for exactly one: reverse_charge_domestic resolves to
 * ruta 23 (varor) or ruta 24 (tjänster) from the account NUMBER, and the
 * number only says which for 4415-4417 and 4425-4427. A Spiris "24" on any
 * other class 4 account resolved to ruta 23 and filed a service purchase as
 * goods, silently, because the code HAD translated and so the row never
 * reached the review list. Refusing the translation puts it there instead:
 * null is the file's existing answer for a code it cannot express, and
 * applySourceVatCodes already keeps the code on the mapping, shows it, and
 * falls back to the label suggestion.
 *
 * Asking the resolver rather than re-testing the six numbers here keeps one
 * definition of the boundary. A pinning test asserts the round trip holds for
 * every code in both tables, so a future code whose treatment files somewhere
 * else fails there rather than in a declaration.
 */
function filesTheRutaItNames(
  treatment: AccountVatTreatment,
  accountClass: number,
  accountNumber: string,
  ruta: string,
): boolean {
  return resolveVatTreatmentRuta(treatment, accountClass, accountNumber)?.box === `ruta${ruta}`
}

/**
 * Rutor that are real and correctly coded in the source, but that
 * AccountVatTreatment has no member for. They translate to null, which
 * applySourceVatCodes already handles: the code is still recorded on the
 * mapping and shown to the user, and the row falls back to the label
 * suggestion and stays in the review list rather than being silently dropped.
 *
 * Empty today. It held 37 and 38 until triangulation_eu_goods existed, and 06
 * and 50 until own_use and import_goods did: each of those boxes reached the
 * declaration through a handful of BAS numbers and nothing else, so a chart
 * that numbered the account differently dropped the amount out of the
 * declaration in silence. Kept as the named place for the next such ruta.
 *
 * Class 2 rutor (10, 11, 12, 30, 31, 32, 48, 60, 61, 62) are not listed: those
 * sit on the VAT accounts themselves, which this project maps structurally
 * rather than through an account treatment.
 */
const UNTRANSLATABLE_RUTOR = new Set<string>([])

/** Parse a raw Spiris code, or null when it is blank or malformed. */
export function parseSpirisVatCode(raw: string): SpirisVatCode | null {
  const code = raw.trim()
  if (code === '') return null

  const withRate = /^(\d{2})-(\d{1,2})%$/.exec(code)
  if (withRate) {
    const percent = Number(withRate[2])
    if (![0, 6, 12, 25].includes(percent)) return null
    return { ruta: withRate[1], rate: percent / 100 }
  }

  const bare = /^(\d{2})$/.exec(code)
  return bare ? { ruta: bare[1], rate: null } : null
}

/**
 * The treatment a Spiris code means for a given account, or null when the code
 * is blank, malformed, or names a ruta this project cannot express.
 *
 * The signature matches the `translate` parameter of applySourceVatCodes, so
 * this plugs straight into the existing provider-code path.
 */
export function spirisVatTreatment(
  code: string,
  accountNumber: string,
): AccountVatTreatment | null {
  const parsed = parseSpirisVatCode(code)
  if (!parsed) return null
  if (UNTRANSLATABLE_RUTOR.has(parsed.ruta)) return null

  const accountClass = Number(accountNumber.charAt(0))

  const named = (treatment: AccountVatTreatment | null): AccountVatTreatment | null =>
    treatment && filesTheRutaItNames(treatment, accountClass, accountNumber, parsed.ruta)
      ? treatment
      : null

  if (accountClass === 3) {
    if (parsed.ruta === '05') {
      if (parsed.rate === 0.12) return named('reduced_12')
      if (parsed.rate === 0.06) return named('reduced_6')
      // 25 % is the default, but only for a code that actually named a rate:
      // a bare "05" states nothing and must not be read as standard rate.
      return parsed.rate === 0.25 ? named('standard_25') : null
    }
    return named(REVENUE_TREATMENT[parsed.ruta] ?? null)
  }

  if (accountClass >= 4 && accountClass <= 6) {
    return named(COST_TREATMENT[parsed.ruta] ?? null)
  }

  // Classes 1, 2, 7 and 8 carry no account treatment in this project.
  return null
}
