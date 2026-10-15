import { isAccountNumber } from '@/lib/invariants/account-number'
import type { K1Post } from './bilaga2'

/**
 * BAS 2026 accounts to the posts of BFNAR 2010:1 bilaga 2.
 *
 * No official mapping exists: BAS publishes none for ideella föreningar under
 * K1 (its K1 material is for enskilda näringsidkare and maps to NE rows), so
 * this table is ours. It follows the BFN definitions of each post (BFNAR
 * 2010:1 chapters 2, 6 and 7 with the commentary) and, where those do not
 * decide, the BAS coupling for INK3R (INK3_P1-241119.xlsx, Ideella
 * föreningar, stiftelser m.fl.), whose rows are close to bilaga 2. It must be
 * reviewed by an accountant before the förenklat årsbokslut leaves beta (the
 * 2026-09-08 decision on förening rules).
 *
 * Every BAS account in classes 1-8 lands in exactly one post or in exactly one
 * excluded range (pinned by account-mapping.test.ts). The ranges are disjoint;
 * order does not matter.
 *
 * Choices worth a reviewer's eye:
 *   - 3901 Medlemsavgifter is the seeded account (BAS has none, INK3R note 1).
 *   - 3902-3909 are free BAS sub-accounts under 3900; BAS has no account for
 *     övriga verksamhetsintäkter (course, training and service fees, BFN
 *     commentary to 7.5), so a förening that wants the post creates one there.
 *   - 3980-3989 (offentliga bidrag, BFNAR 2010:1 2.1) and 3993 (donationer och
 *     gåvor, 2.3) are Gåvor och bidrag; the rest of 38xx-39xx is Övriga intäkter.
 *   - 4xxx (varuinköp and lagerförändring) is Försäljningskostnader, as in BFN
 *     example 7-10; 67xx (särskilt för ideella föreningar) is
 *     Verksamhetskostnader, as the stipendier in BFN example 5-2.
 *   - Förskott to leverantörer (148x) and every skattefordran are Övriga
 *     fordringar (6.51, 6.54); 17xx too, since bilaga 2 has no post for
 *     förutbetalda kostnader och upplupna intäkter.
 *   - Förskott from kunder (242x-243x, 2450) and 29xx are Övriga skulder
 *     (6.73-6.77); lagstadgade avgifter, personalskatt and moms are
 *     Skatteskulder (6.72).
 *   - 80xx-87xx go to Finansiella intäkter or Finansiella kostnader by the
 *     sign of each account's balance; income and cost are never netted
 *     across accounts.
 */

export interface K1AccountRange {
  start: string
  end: string
  /** The post a credit balance (an income, a liability) goes to. */
  credit: K1Post
  /** The post a debit balance (a cost, an asset) goes to. */
  debit: K1Post
}

export type K1ExclusionReason =
  /** Avsättningar are not allowed under K1 (BFNAR 2010:1 6.68). */
  | 'avsattning'
  /** Equity accounts of another legal form (enskild firma, aktiebolag, ekonomisk förening). */
  | 'other_form_equity'
  /** Årets resultat accounts (899x): the result is computed, never a post. */
  | 'result_account'

export interface K1ExcludedRange {
  start: string
  end: string
  reason: K1ExclusionReason
}

function post(start: string, end: string, target: K1Post): K1AccountRange {
  return { start, end, credit: target, debit: target }
}

/** A credit balance is a financial income, a debit balance a financial cost. */
function financial(start: string, end: string): K1AccountRange {
  return { start, end, credit: 'finansiellaIntakter', debit: 'finansiellaKostnader' }
}

export const K1_ACCOUNT_RANGES: readonly K1AccountRange[] = [
  // Tillgångar
  post('1000', '1099', 'immateriellaAnlaggningstillgangar'),
  post('1100', '1199', 'byggnaderOchMark'),
  post('1200', '1299', 'inventarier'),
  post('1300', '1359', 'finansiellaPlaceringar'),
  // Lån till närstående, uppskjuten skattefordran, andra långfristiga fordringar.
  post('1360', '1399', 'ovrigaFordringar'),
  post('1400', '1479', 'varulager'),
  // Förskott till leverantörer (6.51).
  post('1480', '1489', 'ovrigaFordringar'),
  post('1490', '1499', 'varulager'),
  post('1500', '1599', 'kundfordringar'),
  post('1600', '1799', 'ovrigaFordringar'),
  post('1800', '1899', 'finansiellaPlaceringar'),
  post('1900', '1999', 'kassaOchBank'),

  // Eget kapital: 2060-2068 and the ändamålsbestämda medel 2070-2079 (6.67).
  // The form's closing account (2069) is moved to Årets över-/underskott by
  // the engine, which reads it from the legal form profile.
  post('2060', '2079', 'balanseradeOverUnderskott'),
  post('2100', '2199', 'obeskattadeReserver'),

  // Skulder
  post('2300', '2419', 'laneskulder'),
  // Förskott från kunder, ej inlösta presentkort, pågående arbeten (6.73).
  post('2420', '2439', 'ovrigaSkulder'),
  post('2440', '2449', 'leverantorsskulder'),
  // Fakturerad men ej upparbetad intäkt: a förskott (6.73).
  post('2450', '2459', 'ovrigaSkulder'),
  post('2460', '2479', 'leverantorsskulder'),
  post('2480', '2489', 'laneskulder'),
  post('2490', '2499', 'ovrigaSkulder'),
  post('2500', '2739', 'skatteskulder'),
  post('2740', '2839', 'ovrigaSkulder'),
  post('2840', '2849', 'laneskulder'),
  // Avräkning för skatter och avgifter (skattekonto), anståndsbelopp.
  post('2850', '2859', 'skatteskulder'),
  post('2860', '2999', 'ovrigaSkulder'),

  // Intäkter
  post('3000', '3799', 'forsaljningsintakter'),
  post('3800', '3900', 'ovrigaIntakter'),
  post('3901', '3901', 'medlemsavgifter'),
  post('3902', '3909', 'ovrigaVerksamhetsintakter'),
  post('3910', '3979', 'ovrigaIntakter'),
  post('3980', '3989', 'gavorOchBidrag'),
  post('3990', '3992', 'ovrigaIntakter'),
  post('3993', '3993', 'gavorOchBidrag'),
  post('3994', '3999', 'ovrigaIntakter'),

  // Kostnader
  post('4000', '4999', 'forsaljningskostnader'),
  post('5000', '6699', 'ovrigaExternaKostnader'),
  post('6700', '6799', 'verksamhetskostnader'),
  post('6800', '6999', 'ovrigaExternaKostnader'),
  post('7000', '7699', 'personalkostnader'),
  post('7700', '7739', 'avOchNedskrivningar'),
  // Nedskrivning and återföring on vissa omsättningstillgångar (INK3R 6.10).
  post('7740', '7749', 'ovrigaKostnader'),
  post('7750', '7789', 'avOchNedskrivningar'),
  post('7790', '7799', 'ovrigaKostnader'),
  post('7800', '7899', 'avOchNedskrivningar'),
  post('7900', '7999', 'ovrigaKostnader'),

  // Finansiella poster, bokslutsdispositioner, skatt
  financial('8000', '8799'),
  post('8800', '8899', 'bokslutsdispositioner'),
  post('8900', '8989', 'skatt'),
]

export const K1_EXCLUDED_RANGES: readonly K1ExcludedRange[] = [
  { start: '2000', end: '2059', reason: 'other_form_equity' },
  { start: '2080', end: '2099', reason: 'other_form_equity' },
  { start: '2200', end: '2299', reason: 'avsattning' },
  { start: '8990', end: '8999', reason: 'result_account' },
]

function inRange(accountNumber: string, range: { start: string; end: string }): boolean {
  return accountNumber >= range.start && accountNumber <= range.end
}

/** The range an account belongs to, or null (not a BAS class 1-8 account, or excluded). */
export function k1RangeForAccount(accountNumber: string): K1AccountRange | null {
  if (!isAccountNumber(accountNumber)) return null
  return K1_ACCOUNT_RANGES.find((range) => inRange(accountNumber, range)) ?? null
}

/** Why an account is left out of every post, or null when it is not excluded. */
export function k1ExclusionForAccount(accountNumber: string): K1ExclusionReason | null {
  if (!isAccountNumber(accountNumber)) return null
  return K1_EXCLUDED_RANGES.find((range) => inRange(accountNumber, range))?.reason ?? null
}

/**
 * The post an account balance goes to. `balance` is debit minus credit; a
 * range whose two sides differ (the financial ones) picks by its sign.
 */
export function k1PostForAccount(accountNumber: string, balance: number): K1Post | null {
  const range = k1RangeForAccount(accountNumber)
  if (!range) return null
  return balance < 0 ? range.credit : range.debit
}

/** Balance sheet and income statement accounts: BAS classes 1-8. */
export function isStatementAccount(accountNumber: string): boolean {
  return isAccountNumber(accountNumber) && accountNumber >= '1000' && accountNumber <= '8999'
}

/** Income statement accounts: BAS classes 3-8. */
export function isResultAccount(accountNumber: string): boolean {
  return isAccountNumber(accountNumber) && accountNumber >= '3000' && accountNumber <= '8999'
}
