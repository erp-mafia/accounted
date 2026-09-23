import {
  resolveVatTreatmentRuta,
  type AccountVatTreatment,
} from '@/lib/vat/account-vat-treatment'
import type { VatDeclarationRutor } from '@/types'

/**
 * Fortnox per-account momskod (Account.VATCode on /accounts) to Accounted's
 * account VAT treatment, keyed by the momsdeklaration ruta each code feeds.
 *
 * Fortnox names its codes after the ruta (the UI shows them as "MP1 (05)",
 * "I (48)"), so the translation is ruta to ruta: a code translates only when
 * Accounted's treatment lands THIS account on the same ruta Fortnox does.
 * That check is done per account number, not per code, because Accounted
 * derives the ruta from treatment + account (class, and 4425-4427 for the
 * 23/24 split), so the same code can translate on one account and not on
 * its neighbour: IT (24) on 4425 translates, IT on 4010 does not, since
 * Accounted would file 4010 on ruta 23. A mismatch answers null and the
 * account falls back to the label suggestion; the translation never asserts
 * a ruta Fortnox disagrees with.
 *
 * The keys are the codes Fortnox ships by default; a company can rename or
 * add codes, and anything not listed translates to null.
 *
 * Deliberately absent, with the ruta they feed:
 * - U1-U3 (10-12), I (48), UOS/UEU/UTFU (30-32), UI25/12/6 (60-62), R1/R2
 *   (49): moms accounts (class 2), which carry no treatment in Accounted.
 * - UT (06, uttag), 3VEU/3FEU (37-38, trepartshandel), BI (50, import
 *   beskattningsunderlag): no matching treatment exists yet.
 */
export const FORTNOX_VAT_CODES: Readonly<Record<
  string,
  { treatment: AccountVatTreatment; ruta: keyof VatDeclarationRutor }
>> = {
  // Ruta 05-08: momspliktig försäljning
  MP1: { treatment: 'standard_25', ruta: 'ruta05' },
  MP2: { treatment: 'reduced_12', ruta: 'ruta05' },
  MP3: { treatment: 'reduced_6', ruta: 'ruta05' },
  BVMB: { treatment: 'vmb', ruta: 'ruta07' },
  HFS: { treatment: 'rental_voluntary', ruta: 'ruta08' },
  // Ruta 20-24: inköp med omvänd betalningsskyldighet
  IVEU: { treatment: 'reverse_charge_eu_goods', ruta: 'ruta20' },
  ITEU: { treatment: 'reverse_charge_eu_services', ruta: 'ruta21' },
  ITGLOB: { treatment: 'reverse_charge_non_eu_services', ruta: 'ruta22' },
  IV: { treatment: 'reverse_charge_domestic', ruta: 'ruta23' },
  IT: { treatment: 'reverse_charge_domestic', ruta: 'ruta24' },
  // Ruta 35-42: försäljning undantagen från moms
  VTEU: { treatment: 'reverse_charge_eu_goods', ruta: 'ruta35' },
  E: { treatment: 'export_goods', ruta: 'ruta36' },
  FTEU: { treatment: 'reverse_charge_eu_services', ruta: 'ruta39' },
  'ÖTEU': { treatment: 'export_services', ruta: 'ruta40' },
  OTTU: { treatment: 'reverse_charge_domestic', ruta: 'ruta41' },
  MF: { treatment: 'exempt', ruta: 'ruta42' },
}

/**
 * Translate one Fortnox VATCode for the given account. Null when the code is
 * unknown or blank, or when Accounted would file the account on a different
 * ruta than the code names (a revenue code on a purchase account, IT on a
 * class 4 account outside 4425-4427, and so on).
 */
export function fortnoxVatCodeToTreatment(
  code: string | null | undefined,
  accountNumber: string,
): AccountVatTreatment | null {
  if (!code) return null
  const entry = FORTNOX_VAT_CODES[code.trim().toUpperCase()]
  if (!entry) return null
  const accountClass = Number(accountNumber.charAt(0))
  const landsOn = resolveVatTreatmentRuta(entry.treatment, accountClass, accountNumber)
  return landsOn?.box === entry.ruta ? entry.treatment : null
}
