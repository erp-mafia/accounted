/**
 * Decide the line description to show when a correction line's account changes.
 *
 * The correction dialog pre-fills each line's description from the original
 * entry. If the user then switches the account (e.g. from 2393 "Lån från
 * närstående personer, långfristig del" to 2893, the kortfristig account), the
 * carried-over description would otherwise stay stale on the new account. We
 * refresh it to the newly chosen account's name, but only when the current
 * description is empty or still equals the previously selected account's name:
 * a memo the user typed themselves is preserved.
 */
export interface AccountNameLookup {
  account_number: string
  account_name: string
}

export function nextLineDescriptionForAccountChange(
  currentDescription: string,
  previousAccountNumber: string,
  newAccountNumber: string,
  accounts: AccountNameLookup[],
): string {
  if (!newAccountNumber) return currentDescription

  const newAccount = accounts.find((a) => a.account_number === newAccountNumber)
  if (!newAccount) return currentDescription

  const previousAccount = accounts.find((a) => a.account_number === previousAccountNumber)
  const isAutoFilled = !currentDescription || currentDescription === previousAccount?.account_name

  return isAutoFilled ? newAccount.account_name : currentDescription
}
