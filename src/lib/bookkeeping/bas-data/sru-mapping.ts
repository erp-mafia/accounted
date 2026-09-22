/**
 * SRU code computation for a BAS account number.
 *
 * The code is the INK2R (räkenskapsschema) field the account lands in when
 * an aktiebolag files its income tax return, taken from the same
 * BAS-to-SRU mapping the INK2 engine files with (bas.se/kontoplaner/sru/,
 * mirrored in lib/reports/ink2/account-mappings.ts). One source of truth:
 * the chart of accounts, the SIE #SRU records and the INK2R form can never
 * disagree about where an account belongs.
 *
 * History: until 2026-09 this file replicated the range table from migration
 * 20240101000021_sru_codes.sql, which mixed made-up NE-style codes for the
 * income statement (7310-7325; the NE-bilaga actually uses 7400-7505) with a
 * coarse balance-sheet table whose codes mostly do not exist on INK2R
 * (7203, 7210-7212, 7220-7222) or point at the wrong post (2614 and 2645
 * landed on 7231 "Andelar i intresseföretag", 12xx on 7202 "Förskott
 * immateriella"). The reference data, every seeded chart and every SIE
 * export carried those values; migration 20260911120000 repairs the rows
 * that still hold them.
 *
 * Enskild firma files the NE-bilaga instead (lib/reports/ne-bilaga), which
 * maps by account range at filing time and never reads sru_code; the INK2R
 * code is still the standard BAS SRU column and is what the chart shows.
 */
import { ACCOUNT_NUMBER_RE } from '@/lib/invariants'
import { INK2R_ACCOUNT_MAPPINGS, isAccountInMapping } from '@/lib/reports/ink2/account-mappings'

/**
 * 899x (resultat, årets resultat) is not range-mapped by the engine because
 * the form splits it into vinst (7450) / förlust (7550) by sign at filing
 * time. The official table lists 899x under 7450/7550; the chart shows 7450.
 */
const ARETS_RESULTAT_SRU = '7450'
const isAretsResultatAccount = (num: string): boolean => num >= '8990' && num <= '8999'

/**
 * Compute the INK2R SRU code for a BAS account number. Returns null for
 * numbers no INK2R post covers (e.g. malformed input).
 */
export function computeSRUCode(accountNumber: string): string | null {
  const num = String(accountNumber).trim()
  if (!ACCOUNT_NUMBER_RE.test(num)) return null
  if (isAretsResultatAccount(num)) return ARETS_RESULTAT_SRU
  for (const mapping of INK2R_ACCOUNT_MAPPINGS) {
    if (isAccountInMapping(num, mapping)) return mapping.sruCode
  }
  return null
}
