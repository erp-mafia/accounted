/**
 * Swedish domestic bank accounts (clearing + kontonummer): the ONE definition
 * of "an account we can pay".
 *
 * `resolveDomesticBankAccount` is the single source of truth. Everything else
 * derives from it, so "accepted at entry" and "can be paid" cannot drift apart:
 *   - the employee forms and the server Zod schema / API routes
 *     (`validateEmployeeBankAccount`),
 *   - the supplier payee resolver (`lib/payments/supplier-payee.ts`),
 *   - all three payment-file generators (`bg-lb-generator.ts`,
 *     `pain001-generator.ts`, `lib/payments/pain001-supplier.ts`).
 * The contract is pinned by `__tests__/payable-account-contract.test.ts`,
 * which runs every accepted shape through every generator.
 *
 * What resolves (deliberately structural, per the product decision):
 *   - Clearing: 4 digits, OR 5 digits starting with 8 (Swedbank/Sparbanken
 *     are the only 5-digit clearings in the Swedish system).
 *   - Account: 5-10 digits. No Swedish bank in the clearing table
 *     (`lib/bankgiro/account-number.ts`) has an account longer than 10 digits
 *     without its clearing number.
 *   - One 11-digit form: a 4-digit clearing whose account repeats that
 *     clearing as its prefix (a personkonto typed in full). The redundant
 *     prefix is stripped. Any other 11-digit account names no payable account
 *     and is refused at entry instead of at payout.
 *   - Both fields are optional together (bank details may be filled in before
 *     the first salary run), but a clearing without an account (or vice versa)
 *     cannot be paid out and is rejected.
 *
 * One resolved shape does not fit every file: a 5-digit clearing with a
 * 10-digit account yields 11 account-field digits, and the Bankgirot LB
 * account field (TK 54, pos 7-16) is 10 wide. `fitsBgLb` says so; the LB
 * generator refuses that payee by name and points at pain.001, which has no
 * fixed width. It is never truncated or re-encoded.
 *
 * Per-bank mod10/mod11 check digits are advisory only (non-blocking), see
 * `checkEmployeeAccountChecksum`.
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
  account_format: 'Kontonummer måste vara 5-10 siffror, utan clearingnummer',
  account_required: 'Kontonummer krävs när clearingnummer har angetts',
  clearing_required: 'Clearingnummer krävs när kontonummer har angetts',
}

function issue(field: BankIssue['field'], code: BankIssueCode): BankIssue {
  return { field, code, message: BANK_ISSUE_MESSAGES_SV[code] }
}

/**
 * Validate a clearing/account pair. Returns an empty array when valid (which
 * includes both fields being empty). Inputs may contain spaces/hyphens; they
 * are normalized before checking. The format verdicts come from
 * `resolveDomesticBankAccount`, so an accepted pair is one every generator
 * resolves the same way.
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
  if (account && !isPayableAccountFor(clearing, account)) {
    issues.push(issue('bank_account_number', 'account_format'))
  }

  // Both-or-neither: a lone clearing or a lone account cannot be paid out.
  if (clearing && !account) issues.push(issue('bank_account_number', 'account_required'))
  if (account && !clearing) issues.push(issue('clearing_number', 'clearing_required'))

  return issues
}

/** Width of the Bankgirot LB account field (TK 54, pos 7-16). */
export const BG_LB_ACCOUNT_FIELD_WIDTH = 10

/** Why a clearing/account pair names no payable account. */
export type DomesticAccountProblem = 'clearing_format' | 'account_format'

export interface DomesticBankAccountParts {
  /** 4-digit clearing: the Bankgirot LB clearing field and the pain.001 SESBA member id. */
  clearing4: string
  /** Account digits without the clearing prefix (see the special cases below). */
  accountDigits: string
  /**
   * Whether `accountDigits` fits the 10-wide Bankgirot LB account field. False
   * only for a 5-digit clearing with a 10-digit account. pain.001 has no fixed
   * width and carries every resolved account.
   */
  fitsBgLb: boolean
}

export type DomesticBankAccountResolution =
  | ({ ok: true } & DomesticBankAccountParts)
  | { ok: false; problem: DomesticAccountProblem }

/**
 * Account-field verdict for a given (already normalized) clearing: 5-10
 * digits, or the 11-digit form that repeats a 4-digit clearing as its prefix.
 */
function isPayableAccountFor(clearing: string, account: string): boolean {
  if (/^\d{5,10}$/.test(account)) return true
  return /^\d{11}$/.test(account) && clearing.length === 4 && account.startsWith(clearing)
}

/**
 * Resolve a clearing/account pair into the 4-digit clearing and the account
 * digits used by EVERY payout format, or say why it names no payable account.
 * This is the single source of truth: the Bankgirot LB file (fixed 4-digit
 * clearing field, TK 54) and the pain.001 files (CdtrAgt ClrSysMmbId SESBA +
 * CdtrAcct BBAN without clearing) must present identical routing for the same
 * payee, or one format pays a different account than the other.
 *
 * Inputs may contain spaces/hyphens. Anything else that is not a digit makes
 * the pair invalid: a generator must never silently drop a stray character
 * and pay whatever digits remain.
 *
 * Special cases, kept format-identical here:
 *  - Swedbank 5-digit clearings (8xxx-y): the first 4 digits are the clearing,
 *    the 5th digit is carried as the leading digit of the account field.
 *  - A personkonto entered as an 11-digit account that repeats the 4-digit
 *    clearing as its prefix: the redundant prefix is stripped so the account
 *    field holds only the account itself.
 */
export function resolveDomesticBankAccount(
  clearingInput: string | null | undefined,
  accountInput: string | null | undefined,
): DomesticBankAccountResolution {
  const clearing = normalizeBankNumber(clearingInput)
  const account = normalizeBankNumber(accountInput)

  if (!isValidClearing(clearing)) return { ok: false, problem: 'clearing_format' }
  if (!isPayableAccountFor(clearing, account)) return { ok: false, problem: 'account_format' }

  const clearing4 = clearing.slice(0, 4)
  let accountDigits = account
  if (clearing.length === 5) accountDigits = clearing.slice(4) + account
  else if (account.length === 11) accountDigits = account.slice(4)

  return {
    ok: true,
    clearing4,
    accountDigits,
    fitsBgLb: accountDigits.length <= BG_LB_ACCOUNT_FIELD_WIDTH,
  }
}

/** A payment-file format a payee account has to be carried in. */
export type PayeeAccountFormat = 'pain001' | 'bg_lb'

/** Why a payee cannot be written into a payment file of a given format. */
export type PayeeAccountProblem = DomesticAccountProblem | 'bg_lb_account_too_long'

/**
 * What is wrong and what to do about it, in Swedish, as the tail of a
 * "<Namn>: ..." sentence. Never contains the clearing or account number: the
 * text ends up in toasts, API responses and logs, and a bank account number is
 * personal data.
 */
export const PAYEE_ACCOUNT_PROBLEM_SV: Record<PayeeAccountProblem, string> = {
  clearing_format:
    'clearingnumret är ogiltigt (4 siffror, eller 5 siffror som börjar med 8 för Swedbank). Rätta bankuppgifterna.',
  account_format:
    'kontonumret är ogiltigt (5-10 siffror, utan clearingnummer). Rätta bankuppgifterna.',
  bg_lb_account_too_long:
    'kontonumret ryms inte i Bankgirot LB-filen (femsiffrigt clearingnummer med tiosiffrigt kontonummer). Skapa betalfilen som ISO 20022 (pain.001) i stället.',
}

function formatProblem(
  resolved: DomesticBankAccountResolution,
  format: PayeeAccountFormat,
): PayeeAccountProblem | null {
  if (!resolved.ok) return resolved.problem
  if (format === 'bg_lb' && !resolved.fitsBgLb) return 'bg_lb_account_too_long'
  return null
}

/**
 * The problem, if any, that keeps a clearing/account pair out of a payment
 * file of the given format. null means the generator for that format carries
 * it. Callers use this to name every affected payee BEFORE generating; the
 * generators go through `payeeAccountParts`, which applies the same verdict,
 * so a precheck that passes means the generator passes.
 */
export function payeeAccountProblem(
  clearingInput: string | null | undefined,
  accountInput: string | null | undefined,
  format: PayeeAccountFormat,
): PayeeAccountProblem | null {
  return formatProblem(resolveDomesticBankAccount(clearingInput, accountInput), format)
}

/**
 * Thrown by a payment-file generator for a payee it cannot carry. Names the
 * payee and the fix; never the account number.
 */
export class PayeeAccountError extends Error {
  readonly payeeName: string
  readonly problem: PayeeAccountProblem

  constructor(payeeName: string, problem: PayeeAccountProblem) {
    super(describePayeeAccountProblems([{ name: payeeName, problem }]))
    this.name = 'PayeeAccountError'
    this.payeeName = payeeName
    this.problem = problem
  }
}

/**
 * One Swedish message for a list of payees a file cannot carry, grouped by
 * problem so ten employees with the same problem read as one sentence:
 * "Anna Ek, Bo Ek: kontonumret ryms inte ...". Names only, never numbers.
 */
export function describePayeeAccountProblems(
  payees: ReadonlyArray<{ name: string; problem: PayeeAccountProblem }>,
): string {
  const namesByProblem = new Map<PayeeAccountProblem, string[]>()
  for (const { name, problem } of payees) {
    const names = namesByProblem.get(problem)
    if (names) names.push(name)
    else namesByProblem.set(problem, [name])
  }
  return [...namesByProblem.entries()]
    .map(([problem, names]) => `${names.join(', ')}: ${PAYEE_ACCOUNT_PROBLEM_SV[problem]}`)
    .join(' ')
}

/**
 * The remark a salary run shows for one employee's bank details BEFORE the
 * payment step (approve guard, agent booking path), or null when the pair
 * names a payable account. Format-independent on purpose: which file the
 * company will create is not known yet, so the one format-specific limit (the
 * LB field width) is reported by the payment step, by name.
 */
export function employeeBankDetailsRemark(
  name: string,
  clearing: string | null | undefined,
  account: string | null | undefined,
): string | null {
  if (!clearing || !account) {
    return `${name}: Bankuppgifter saknas (clearingnummer och/eller kontonummer)`
  }
  const resolved = resolveDomesticBankAccount(clearing, account)
  return resolved.ok ? null : describePayeeAccountProblems([{ name, problem: resolved.problem }])
}

/**
 * Generator entry point: the routing parts for one payee in one format, or a
 * `PayeeAccountError` naming the payee.
 */
export function payeeAccountParts(
  payeeName: string,
  clearingInput: string | null | undefined,
  accountInput: string | null | undefined,
  format: PayeeAccountFormat,
): DomesticBankAccountParts {
  const resolved = resolveDomesticBankAccount(clearingInput, accountInput)
  if (!resolved.ok) throw new PayeeAccountError(payeeName, resolved.problem)
  const problem = formatProblem(resolved, format)
  if (problem) throw new PayeeAccountError(payeeName, problem)
  const { clearing4, accountDigits, fitsBgLb } = resolved
  return { clearing4, accountDigits, fitsBgLb }
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
