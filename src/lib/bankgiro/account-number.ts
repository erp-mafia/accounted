/**
 * Swedish bank account check-digit validation ("kontrollsiffra"), per the
 * Bankgirot manual "Bankernas kontonummeruppbyggnad".
 *
 * Used ONLY as a non-blocking hint: a passing check digit does not prove the
 * account exists at the bank, and a clearing we don't recognise returns
 * 'unknown' (no opinion) rather than a guess. It covers the major, high-volume
 * banks; everything else falls through to 'unknown' so we never warn on a
 * valid-but-unmapped account.
 *
 * The clearing -> (type, comment) mapping and the two algorithms are
 * cross-checked against the public jop-io/kontonummer.js reference (MIT) and
 * verified against a real example account (Forex 9420 / 4172385) in the tests.
 *
 * Account structure recap:
 *   Type 1: 4-digit clearing + up to 7-digit account, mod11 check digit last.
 *     comment 1: mod11 over the last 10 digits of clearing+account.
 *     comment 2: mod11 over the full clearing+account (11 digits).
 *   Type 2: check digit lives in the account alone.
 *     comment 1: mod10 over a 10-digit account.
 *     comment 2: mod11 over a 9-digit account (Handelsbanken).
 *     comment 3: mod10 over a 6-10 digit account; the 5-digit 8xxxx clearing
 *                carries its own mod10 check digit too (Swedbank/Sparbanken).
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

// Ordered resolution: exact-clearing exceptions win over ranges. Only the
// major banks are mapped; anything else returns null -> 'unknown'. The bank
// names in the comments are for reference; the display name comes from
// lookupBankByClearing in lib/salary/payment/bank-account.ts.
function resolveClearingRule(clearing4: number): ClearingRule | null {
  // Nordea personkonto (10-digit mod10 account): exceptions inside the 3xxx range.
  if (clearing4 === 3300 || clearing4 === 3782) return { type: 2, comment: 1 }

  const inRange = (lo: number, hi: number) => clearing4 >= lo && clearing4 <= hi

  // Type 1, comment 1 (mod11 over the last 10 digits of clearing+account).
  if (inRange(1100, 1199)) return { type: 1, comment: 1 } // Nordea
  if (inRange(1200, 1399)) return { type: 1, comment: 1 } // Danske Bank
  if (inRange(1400, 2099)) return { type: 1, comment: 1 } // Nordea
  if (inRange(2400, 2499)) return { type: 1, comment: 1 } // Danske Bank
  if (inRange(3000, 3299)) return { type: 1, comment: 1 } // Nordea
  if (inRange(3410, 3999)) return { type: 1, comment: 1 } // Nordea
  if (inRange(5000, 5999)) return { type: 1, comment: 1 } // SEB
  if (inRange(7000, 7999)) return { type: 1, comment: 1 } // Swedbank
  if (inRange(9400, 9449)) return { type: 1, comment: 1 } // Forex Bank

  // Type 1, comment 2 (mod11 over the full clearing+account).
  if (inRange(4000, 4999)) return { type: 1, comment: 2 } // Nordea

  // Type 2, comment 2 (mod11 over a 9-digit account).
  if (inRange(6000, 6999)) return { type: 2, comment: 2 } // Handelsbanken

  // Type 2, comment 3 (mod10 over the account; 5-digit clearing also mod10).
  if (inRange(8000, 8999)) return { type: 2, comment: 3 } // Swedbank/Sparbanken

  return null
}

function digitsOnly(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '')
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
  // comment 3: Swedbank/Sparbanken. Account is 6-10 digits (mod10); a 5-digit
  // 8xxxx clearing carries its own mod10 check digit.
  if (account.length < 6 || account.length > 10) return 'unknown'
  const accountOk = luhnValidate(account)
  const clearingOk = clearing.length === 5 ? luhnValidate(clearing) : true
  return accountOk && clearingOk ? 'valid' : 'invalid'
}
