/**
 * Swedish bank account check-digit validation ("kontrollsiffra"), per the
 * Bankgirot document "Bankernas kontonummer / Bank Account Numbers in Swedish
 * Banks", dated 2024-02-22 (bankgirot.se,
 * bankernaskontonummeruppbyggnad_anvandarmanual_sv.pdf).
 *
 * Used ONLY as a non-blocking hint: a passing check digit does not prove the
 * account exists at the bank, and a clearing the document does not list
 * returns 'unknown' (no opinion) rather than a guess.
 *
 * Account structure, as the document defines it:
 *   Type 1: 4-digit clearing + 7-digit account (check digit last), 11-modul
 *           with the weights 1, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1.
 *     comment 1: weighs the clearing except its first digit, and the 7
 *                account digits (10 digits).
 *     comment 2: weighs the whole clearing and the 7 account digits (11 digits).
 *   Type 2: the clearing is not part of the account number.
 *     comment 1: 10-digit account, 10-modul over the last 10 digits.
 *     comment 2: 9-digit account, 11-modul over the 9 digits (Handelsbanken).
 *     comment 3: account of up to 10 digits, 10-modul over the last 10 digits
 *                "som regel" (as a rule).
 *
 * Two rules here are not in the 2024-02-22 document and are kept from the
 * earlier implementation, cross-checked against the public jop-io/kontonummer.js
 * reference (MIT): Forex Bank 9400-9449 as Type 1 comment 1 (anchored by a real
 * example account, 9420 / 4172385, in the tests), and the 10-modul check of the
 * fifth digit of a 5-digit Swedbank clearing (8xxx-x).
 */
import { luhnValidate } from './luhn'

export type AccountChecksumResult = 'valid' | 'invalid' | 'unknown'

// Swedish "11-modulen" weights. For an N-digit input the last N weights are
// used, applied left-to-right, so the rightmost (check) digit gets weight 1.
// Valid when the weighted sum is non-zero and divisible by 11.
const MOD11_WEIGHTS = [1, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]

function mod11Valid(digits: string): boolean {
  if (digits.length === 0 || digits.length > MOD11_WEIGHTS.length) return false
  const weights = MOD11_WEIGHTS.slice(MOD11_WEIGHTS.length - digits.length)
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    sum += Number(digits[i]) * weights[i]
  }
  return sum !== 0 && sum % 11 === 0
}

interface ClearingRule {
  type: 1 | 2
  comment: 1 | 2 | 3
}

interface ClearingRange extends ClearingRule {
  from: number
  to: number
}

// The document's tables, Type 1 then Type 2, each range with its comment
// number. The bank names in the comments are for reference; the display name
// comes from lookupBankByClearing in lib/payments/bank-account.ts.
const CLEARING_RANGES: ReadonlyArray<ClearingRange> = [
  // Type 1, comment 1: clearing except its first digit + 7 account digits.
  { from: 1100, to: 1199, type: 1, comment: 1 }, // Nordea
  { from: 1200, to: 1399, type: 1, comment: 1 }, // Danske Bank
  { from: 1400, to: 2099, type: 1, comment: 1 }, // Nordea
  { from: 2400, to: 2499, type: 1, comment: 1 }, // Danske Bank
  { from: 3000, to: 3399, type: 1, comment: 1 }, // Nordea (except personkonto 3300)
  { from: 3400, to: 3409, type: 1, comment: 1 }, // Länsförsäkringar Bank
  { from: 3410, to: 3999, type: 1, comment: 1 }, // Nordea (except personkonto 3782)
  { from: 5000, to: 5999, type: 1, comment: 1 }, // SEB
  { from: 7000, to: 7999, type: 1, comment: 1 }, // Swedbank
  { from: 9060, to: 9069, type: 1, comment: 1 }, // Länsförsäkringar Bank
  { from: 9070, to: 9079, type: 1, comment: 1 }, // Multitude Bank
  { from: 9120, to: 9124, type: 1, comment: 1 }, // SEB
  { from: 9130, to: 9149, type: 1, comment: 1 }, // SEB
  { from: 9170, to: 9179, type: 1, comment: 1 }, // IKANO Bank
  { from: 9230, to: 9239, type: 1, comment: 1 }, // Marginalen Bank
  { from: 9250, to: 9259, type: 1, comment: 1 }, // SBAB
  { from: 9270, to: 9279, type: 1, comment: 1 }, // ICA Banken
  { from: 9280, to: 9289, type: 1, comment: 1 }, // Resurs Bank
  { from: 9400, to: 9449, type: 1, comment: 1 }, // Forex Bank: not in the 2024-02-22 document, see the header
  { from: 9460, to: 9469, type: 1, comment: 1 }, // Santander Consumer Bank
  { from: 9580, to: 9589, type: 1, comment: 1 }, // Aion Bank
  { from: 9630, to: 9639, type: 1, comment: 1 }, // Lån & Spar Bank Sverige
  { from: 9680, to: 9689, type: 1, comment: 1 }, // BlueStep Finans

  // Type 1, comment 2: the whole clearing + 7 account digits.
  { from: 2300, to: 2399, type: 1, comment: 2 }, // Ålandsbanken Sverige
  { from: 4000, to: 4999, type: 1, comment: 2 }, // Nordea
  { from: 9020, to: 9029, type: 1, comment: 2 }, // Länsförsäkringar Bank
  { from: 9040, to: 9049, type: 1, comment: 2 }, // Citibank
  { from: 9100, to: 9109, type: 1, comment: 2 }, // Nordnet Bank
  { from: 9150, to: 9169, type: 1, comment: 2 }, // Skandiabanken
  { from: 9190, to: 9199, type: 1, comment: 2 }, // DNB Bank
  { from: 9260, to: 9269, type: 1, comment: 2 }, // DNB Bank
  { from: 9390, to: 9399, type: 1, comment: 2 }, // Landshypotek
  { from: 9470, to: 9479, type: 1, comment: 2 }, // BNP Paribas, Sverige filial
  { from: 9550, to: 9569, type: 1, comment: 2 }, // Avanza Bank
  { from: 9590, to: 9599, type: 1, comment: 2 }, // Erik Penser
  { from: 9640, to: 9649, type: 1, comment: 2 }, // NOBA Bank Group
  { from: 9660, to: 9669, type: 1, comment: 2 }, // Svea Bank
  { from: 9670, to: 9679, type: 1, comment: 2 }, // JAK Medlemsbank
  { from: 9700, to: 9709, type: 1, comment: 2 }, // Ekobanken
  { from: 9710, to: 9719, type: 1, comment: 2 }, // Lunar Bank
  { from: 9750, to: 9759, type: 1, comment: 2 }, // Northmill Bank
  { from: 9780, to: 9789, type: 1, comment: 2 }, // Klarna Bank
  { from: 9880, to: 9889, type: 1, comment: 2 }, // Riksgälden

  // Type 2, comment 1: 10-digit account, 10-modul.
  { from: 9180, to: 9189, type: 2, comment: 1 }, // Danske Bank
  { from: 9300, to: 9349, type: 2, comment: 1 }, // Swedbank (f.d. Sparbanken Öresund)
  { from: 9570, to: 9579, type: 2, comment: 1 }, // Sparbanken Syd
  { from: 9890, to: 9899, type: 2, comment: 1 }, // Riksgälden

  // Type 2, comment 2: 9-digit account, 11-modul.
  { from: 6000, to: 6999, type: 2, comment: 2 }, // Handelsbanken

  // Type 2, comment 3: account of up to 10 digits, 10-modul.
  { from: 8000, to: 8999, type: 2, comment: 3 }, // Swedbank
  { from: 9500, to: 9549, type: 2, comment: 3 }, // Nordea/Plusgirot
  { from: 9960, to: 9969, type: 2, comment: 3 }, // Nordea/Plusgirot
]

// Exact-clearing exceptions win over the ranges: Nordea personkonto (Type 2,
// comment 1), inside the Nordea Type 1 ranges 3000-3399 and 3410-3999.
const PERSONKONTO_CLEARINGS: ReadonlySet<number> = new Set([3300, 3782])

/** The document's rule for a 4-digit clearing, or null when it lists none. */
function resolveClearingRule(clearing4: number): ClearingRule | null {
  if (PERSONKONTO_CLEARINGS.has(clearing4)) return { type: 2, comment: 1 }
  const hit = CLEARING_RANGES.find((r) => clearing4 >= r.from && clearing4 <= r.to)
  return hit ? { type: hit.type, comment: hit.comment } : null
}

function digitsOnly(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '')
}

/**
 * Whether the clearing's bank has a check-digit rule in the table above. Tells
 * apart the two 'unknown' results of validateSwedishAccountChecksum: a bank we
 * have no rule for, and an account whose length does not fit its bank's rule.
 */
export function hasSwedishAccountChecksumRule(clearingRaw: string | null | undefined): boolean {
  const clearing = digitsOnly(clearingRaw)
  return clearing.length >= 4 && resolveClearingRule(Number(clearing.slice(0, 4))) !== null
}

/**
 * Validate the check digit(s) of a Swedish clearing/account pair.
 *  - 'valid'   the check digit is consistent with the bank's rule
 *  - 'invalid' the clearing is recognised but the check digit does not match
 *  - 'unknown' clearing not in the table, or the length is implausible for the
 *              bank (so we stay silent instead of guessing)
 */
export function validateSwedishAccountChecksum(
  clearingRaw: string | null | undefined,
  accountRaw: string | null | undefined,
): AccountChecksumResult {
  const clearing = digitsOnly(clearingRaw)
  const account = digitsOnly(accountRaw)
  if (clearing.length < 4 || account.length === 0) return 'unknown'

  const rule = resolveClearingRule(Number(clearing.slice(0, 4)))
  if (!rule) return 'unknown'

  if (rule.type === 1) {
    if (account.length > 7) return 'unknown'
    const full = clearing.slice(0, 4) + account.padStart(7, '0') // 11 digits
    const input = rule.comment === 1 ? full.slice(-10) : full
    return mod11Valid(input) ? 'valid' : 'invalid'
  }

  // Type 2: the check digit lives in the account.
  if (rule.comment === 1) {
    if (account.length > 10) return 'unknown'
    return luhnValidate(account.padStart(10, '0')) ? 'valid' : 'invalid'
  }
  if (rule.comment === 2) {
    if (account.length > 9) return 'unknown'
    return mod11Valid(account.padStart(9, '0')) ? 'valid' : 'invalid'
  }
  // comment 3: Swedbank 8xxx and Nordea/Plusgirot, mod10 over the account.
  // Checked for 6-10 digits; a shorter account stays 'unknown'. A 5-digit
  // Swedbank clearing (8xxxx) carries its own mod10 check digit (not in the
  // 2024-02-22 document, see the header).
  if (account.length < 6 || account.length > 10) return 'unknown'
  const accountOk = luhnValidate(account)
  const clearingOk = clearing.length === 5 && clearing.startsWith('8') ? luhnValidate(clearing) : true
  return accountOk && clearingOk ? 'valid' : 'invalid'
}
