/**
 * The statement's own bank account, read from the file (crm#1204).
 *
 * The parsers call these helpers; which cash account an identity IS gets
 * decided in one place, matchFileAccount (lib/cash-accounts/file-account.ts).
 * Nothing here guesses: a file that names no account, or names more than one,
 * has no identity, and the import then works exactly as before.
 */

import { normalizeIban } from '@/lib/cash-accounts/ledger-slots'
import type { BankFileAccountIdentity } from './types'

/** Fewest digits (clearing included) a printed number must carry to name an account. */
const MIN_ACCOUNT_DIGITS = 7

const IBAN_RE = /^[A-Z]{2}\d{2}[A-Z0-9]{8,30}$/

function digits(value: string | null | undefined): string {
  return (value ?? '').replace(/\D/g, '')
}

/**
 * An identity from what a file printed, or null when the parts name nothing:
 * an IBAN that is not one, or a number too short to be an account number.
 * A printed value shaped like an IBAN is read as the IBAN.
 */
export function accountIdentity(parts: {
  iban?: string | null
  clearing?: string | null
  account_number?: string | null
}): BankFileAccountIdentity | null {
  const printed = parts.account_number?.trim() || null
  const printedIban = printed && /^[A-Z]{2}\d{2}/i.test(printed) ? normalizeIban(printed) : null
  const candidateIban = normalizeIban(parts.iban) ?? printedIban
  const iban = candidateIban && IBAN_RE.test(candidateIban) ? candidateIban : null

  const clearing = parts.clearing?.trim() || null
  const accountNumber = printedIban ? null : printed
  const hasNumber =
    accountNumber !== null && digits(clearing).length + digits(accountNumber).length >= MIN_ACCOUNT_DIGITS

  if (!iban && !hasNumber) return null
  return {
    iban,
    clearing: hasNumber ? clearing : null,
    account_number: hasNumber ? accountNumber : null,
  }
}

function identityKey(identity: BankFileAccountIdentity): string {
  return identity.iban ?? `${digits(identity.clearing)}|${digits(identity.account_number)}`
}

/**
 * The one account every part of a file names (each row of a Swedbank export,
 * each <Stmt> of a camt.053 file). Null as soon as one part names none or a
 * different one: rows of two accounts in one file have no single home.
 */
export function sharedAccountIdentity(
  identities: Array<BankFileAccountIdentity | null>,
): BankFileAccountIdentity | null {
  let shared: BankFileAccountIdentity | null = null
  for (const identity of identities) {
    if (!identity) return null
    if (shared && identityKey(shared) !== identityKey(identity)) return null
    shared ??= identity
  }
  return shared
}

/**
 * "Kontonummer;6789 123 456 789" (Handelsbanken), "Kontonummer: 1234 567 890"
 * (ICA Banken), "Kontonummer,9750-8770139" (Northmill): the account line some
 * exports print above the column header.
 */
const PREAMBLE_ACCOUNT_RE = /^\s*"?konto(?:nummer|nr)"?\s*[:;,]\s*"?([^";,]*\d[^";,]*)/i

/** The account named in the lines above the column header, if any. */
export function preambleAccountIdentity(lines: string[], headerIdx: number): BankFileAccountIdentity | null {
  for (const line of lines.slice(0, Math.max(headerIdx, 0))) {
    const match = PREAMBLE_ACCOUNT_RE.exec(line)
    if (match) return accountIdentity({ account_number: match[1] })
  }
  return null
}
