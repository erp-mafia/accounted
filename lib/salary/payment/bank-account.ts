/**
 * Swedish employee bank-account validation (clearing + kontonummer).
 *
 * This is the single source of truth for validating the bank details entered
 * on the "Anställda" employee form, shared by the client forms and the server
 * Zod schema / API routes. It mirrors what the payout layer
 * (`bg-lb-generator.ts` `encodeReceiverAccount`) can actually encode, so a
 * typo is caught at data entry instead of surfacing ~20 steps later when the
 * Bankgirot LB file is generated (or never, on the SEPA/pain.001 path).
 *
 * Scope (deliberately structural, per the product decision):
 *   - Clearing must be 4 digits, OR 5 digits starting with 8 (Swedbank/
 *     Sparbanken are the only 5-digit clearings in the Swedish system).
 *   - Account number must be 5-11 digits (covers ordinary accounts through the
 *     11-digit Nordea personkonto that the generator special-cases).
 *   - Both fields are optional together (bank details may be filled in before
 *     the first salary run), but a clearing without an account (or vice versa)
 *     cannot be paid out and is rejected.
 *
 * Per-bank mod10/mod11 checksum validation is intentionally NOT done here: it
 * requires the official per-bank clearing-range table, and getting that table
 * slightly wrong produces false rejections of valid accounts. It is planned as
 * a separate, non-blocking "soft warning" follow-up once the data is vetted.
 */

import { validateSwedishAccountChecksum, type AccountChecksumResult } from '@/lib/bankgiro/account-number'

export type { AccountChecksumResult }

/** Strip spaces and hyphens so "8327-9" / "1234 5678" become plain digits. */
export function normalizeBankNumber(input: string | null | undefined): string {
  return (input ?? '').replace(/[\s-]/g, '')
}

/**
 * Non-blocking check-digit ("kontrollsiffra") result for an employee's
 * clearing/account pair. 'invalid' surfaces an advisory warning in the form,
 * but never blocks saving: the check digit catches typos, it does not prove
 * the account exists. Unrecognised clearings return 'unknown' (no warning).
 */
export function checkEmployeeAccountChecksum(
  clearing: string | null | undefined,
  account: string | null | undefined,
): AccountChecksumResult {
  return validateSwedishAccountChecksum(clearing, account)
}

/** Advisory (non-blocking) message shown when the check digit looks wrong. */
export const BANK_CHECKSUM_WARNING_SV =
  'Kontrollsiffran verkar inte stämma. Dubbelkolla numret, du kan spara ändå.'

/** 4-digit clearing, or a 5-digit Swedbank/Sparbanken clearing starting with 8. */
export function isValidClearing(clearing: string): boolean {
  return /^(\d{4}|8\d{4})$/.test(clearing)
}

/** Account number: 5-11 digits (through Nordea personkonto's 11 digits). */
export function isValidAccount(account: string): boolean {
  return /^\d{5,11}$/.test(account)
}

export type BankIssueCode =
  | 'clearing_format'
  | 'account_format'
  | 'account_required'
  | 'clearing_required'

export interface BankIssue {
  /** Matches the form field name and the Zod path for this issue. */
  field: 'clearing_number' | 'bank_account_number'
  code: BankIssueCode
  /** Swedish message (used server-side and by the hardcoded-Swedish dialog). */
  message: string
}

/**
 * Swedish issue messages. The i18n edit page maps `code` to its own
 * `salary_employee.bank_error_*` keys; the create dialog and the server use
 * these strings directly (schema messages in this repo are Swedish literals).
 */
export const BANK_ISSUE_MESSAGES_SV: Record<BankIssueCode, string> = {
  clearing_format:
    'Clearingnummer måste vara 4 siffror (eller 5 siffror som börjar med 8 för Swedbank)',
  account_format: 'Kontonummer måste vara 5-11 siffror',
  account_required: 'Kontonummer krävs när clearingnummer har angetts',
  clearing_required: 'Clearingnummer krävs när kontonummer har angetts',
}

function issue(field: BankIssue['field'], code: BankIssueCode): BankIssue {
  return { field, code, message: BANK_ISSUE_MESSAGES_SV[code] }
}

/**
 * Validate a clearing/account pair. Returns an empty array when valid (which
 * includes both fields being empty). Inputs may contain spaces/hyphens; they
 * are normalized before checking.
 */
export function validateEmployeeBankAccount(
  clearingRaw: string | null | undefined,
  accountRaw: string | null | undefined,
): BankIssue[] {
  const clearing = normalizeBankNumber(clearingRaw)
  const account = normalizeBankNumber(accountRaw)

  // Both empty: bank details are optional until a salary run is approved.
  if (!clearing && !account) return []

  const issues: BankIssue[] = []

  if (clearing && !isValidClearing(clearing)) {
    issues.push(issue('clearing_number', 'clearing_format'))
  }
  if (account && !isValidAccount(account)) {
    issues.push(issue('bank_account_number', 'account_format'))
  }

  // Both-or-neither: a lone clearing or a lone account cannot be paid out.
  if (clearing && !account) issues.push(issue('bank_account_number', 'account_required'))
  if (account && !clearing) issues.push(issue('clearing_number', 'clearing_required'))

  return issues
}

/**
 * Conservative clearing-number -> bank-name lookup, for reassurance next to the
 * field. Only the major, long-stable, unambiguous ranges are included; any
 * clearing not in this table returns null (show nothing) rather than a guessed
 * name. The full authoritative table lands with the checksum follow-up.
 *
 * Ranges are matched on the leading 4 digits, so a 5-digit Swedbank clearing
 * (8xxxx) maps via its 8xxx prefix.
 */
const BANK_CLEARING_RANGES: ReadonlyArray<{ min: number; max: number; bank: string; bic: string }> = [
  { min: 1100, max: 1199, bank: 'Nordea', bic: 'NDEASESS' },
  { min: 1200, max: 1399, bank: 'Danske Bank', bic: 'DABASESX' },
  { min: 1400, max: 2099, bank: 'Nordea', bic: 'NDEASESS' },
  { min: 2400, max: 2499, bank: 'Danske Bank', bic: 'DABASESX' },
  { min: 3000, max: 3399, bank: 'Nordea', bic: 'NDEASESS' },
  { min: 5000, max: 5999, bank: 'SEB', bic: 'ESSESESS' },
  { min: 6000, max: 6999, bank: 'Handelsbanken', bic: 'HANDSESS' },
  { min: 7000, max: 7999, bank: 'Swedbank', bic: 'SWEDSESS' },
  { min: 8000, max: 8999, bank: 'Swedbank/Sparbanken', bic: 'SWEDSESS' },
  { min: 9500, max: 9549, bank: 'Nordea (Plusgirot)', bic: 'NDEASESS' },
  { min: 9960, max: 9969, bank: 'Nordea (Plusgirot)', bic: 'NDEASESS' },
]

/** Bank name for a (partial) clearing number, or null when not confidently known. */
export function lookupBankByClearing(clearingRaw: string | null | undefined): string | null {
  const clearing = normalizeBankNumber(clearingRaw)
  if (clearing.length < 4) return null
  const first4 = Number.parseInt(clearing.slice(0, 4), 10)
  if (Number.isNaN(first4)) return null
  const hit = BANK_CLEARING_RANGES.find((r) => first4 >= r.min && first4 <= r.max)
  return hit ? hit.bank : null
}

/**
 * Bank BIC (SWIFT) for a clearing number, or null when the clearing is not in
 * the table above. Used to fill the debtor agent (DbtrAgt) in the pain.001
 * salary payment file without asking the company to type its BIC by hand: the
 * clearing number it already entered for the debtor account deterministically
 * identifies the bank. Only confidently-known, long-stable ranges are covered;
 * an unknown clearing returns null so the caller can fall back or fail loudly
 * rather than emit a guessed BIC into a real payment instruction.
 */
export function lookupBicByClearing(clearingRaw: string | null | undefined): string | null {
  const clearing = normalizeBankNumber(clearingRaw)
  if (clearing.length < 4) return null
  const first4 = Number.parseInt(clearing.slice(0, 4), 10)
  if (Number.isNaN(first4)) return null
  const hit = BANK_CLEARING_RANGES.find((r) => first4 >= r.min && first4 <= r.max)
  return hit ? hit.bic : null
}

/**
 * Fallback BIC lookup by the free-text bank name saved in company settings, for
 * the (rare) banks not covered by the clearing ranges above (e.g.
 * Länsförsäkringar, Skandiabanken). Matched on a normalized substring so
 * "Danske Bank Sverige" still resolves. Only BICs we are confident about are
 * listed; anything else returns null. Never guess a BIC for a real payment.
 */
const BANK_NAME_BIC: ReadonlyArray<{ match: string; bic: string }> = [
  { match: 'handelsbanken', bic: 'HANDSESS' },
  { match: 'länsförsäkringar', bic: 'ELLFSESS' },
  { match: 'lansforsakringar', bic: 'ELLFSESS' },
  { match: 'skandia', bic: 'SKIASESS' },
  { match: 'swedbank', bic: 'SWEDSESS' },
  { match: 'sparbank', bic: 'SWEDSESS' },
  { match: 'danske', bic: 'DABASESX' },
  { match: 'nordea', bic: 'NDEASESS' },
  { match: 'seb', bic: 'ESSESESS' },
]

export function lookupBicByBankName(nameRaw: string | null | undefined): string | null {
  const name = (nameRaw ?? '').trim().toLowerCase()
  if (!name) return null
  const hit = BANK_NAME_BIC.find((b) => name.includes(b.match))
  return hit ? hit.bic : null
}
