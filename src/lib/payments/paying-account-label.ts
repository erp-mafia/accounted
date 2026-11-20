import type { PayingAccountSummary } from './paying-account'

/**
 * The paying account as the dashboard names it: "Företagskonto (1930)", or
 * "1930" for an account without a name. Language-neutral (a user-given name
 * and a BAS number), so both locales use it as is. Client-safe.
 */
export function payingAccountName(account: Pick<PayingAccountSummary, 'name' | 'ledger_account'>): string {
  return account.name ? `${account.name} (${account.ledger_account})` : account.ledger_account
}

/** The name followed by the last four characters of the IBAN the file pays from: "Företagskonto (1930) · …7466". */
export function payingAccountDisplay(account: PayingAccountSummary): string {
  const name = payingAccountName(account)
  return account.iban_last4 ? `${name} · …${account.iban_last4}` : name
}
