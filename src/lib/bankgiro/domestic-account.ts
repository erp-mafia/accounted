/**
 * Swedish domestic bank account numbers (clearing + kontonummer): how a
 * clearing/account pair resolves into the 4-digit clearing and the account
 * digits every payout format carries. Pure, no database.
 *
 * Lives in the kernel (next to the clearing table in account-number.ts) so the
 * ledger's cash accounts and the payments block read the same rule.
 * `lib/payments/bank-account.ts` re-exports it and documents the contract the
 * payment-file generators rely on.
 */

/** Strip spaces and hyphens so "8327-9" / "1234 5678" become plain digits. */
export function normalizeBankNumber(input: string | null | undefined): string {
  return (input ?? '').replace(/[\s-]/g, '')
}

/** 4-digit clearing, or a 5-digit Swedbank/Sparbanken clearing starting with 8. */
export function isValidClearing(clearing: string): boolean {
  return /^(\d{4}|8\d{4})$/.test(clearing)
}

/** Why a clearing/account pair names no payable account. */
export type DomesticAccountProblem = 'clearing_format' | 'account_format'

export interface DomesticBankAccountParts {
  /** 4-digit clearing: the Bankgirot LB clearing field and the pain.001 SESBA member id. */
  clearing4: string
  /** Account digits without the clearing prefix (see the special cases below). */
  accountDigits: string
}

export type DomesticBankAccountResolution =
  | ({ ok: true } & DomesticBankAccountParts)
  | { ok: false; problem: DomesticAccountProblem }

/**
 * Account-field verdict for a given (already normalized) clearing: 5-10
 * digits, or the 11-digit form that repeats a 4-digit clearing as its prefix.
 */
export function isPayableAccountFor(clearing: string, account: string): boolean {
  if (/^\d{5,10}$/.test(account)) return true
  return /^\d{11}$/.test(account) && clearing.length === 4 && account.startsWith(clearing)
}

/**
 * Resolve a clearing/account pair into the 4-digit clearing and the account
 * digits used by EVERY payout format, or say why it names no payable account.
 * This is the single source of truth: the Bankgirot LB file (fixed 4-digit
 * clearing field, TK40) and the pain.001 files (CdtrAgt ClrSysMmbId SESBA +
 * CdtrAcct BBAN, written by lib/payments/creditor-account.ts from these same
 * parts) must present identical routing for the same payee, or one format
 * pays a different account than the other.
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

  return { ok: true, clearing4, accountDigits }
}
