import { foldText } from './account-search'

interface NamedAccount {
  account_number: string
  account_name: string
}

interface CompanyAccount extends NamedAccount {
  is_active: boolean
}

interface CorrectionLineAccountFields {
  account_number: string
  line_description: string
}

function findAccountName(accountNumber: string, accounts: NamedAccount[]): string | undefined {
  return accounts.find((account) => account.account_number === accountNumber)?.account_name
}

function namesMatch(left: string, right: string): boolean {
  return foldText(left.trim()) === foldText(right.trim())
}

/**
 * Keep deliberately deactivated company accounts out of catalogue-backed
 * picker results. The correction service will seed missing BAS accounts, but
 * it intentionally refuses to reactivate accounts the company disabled.
 */
export function getSelectableCorrectionCatalog<T extends NamedAccount>(
  companyAccounts: CompanyAccount[],
  catalog: T[],
): T[] {
  const inactiveNumbers = new Set(
    companyAccounts
      .filter((account) => !account.is_active)
      .map((account) => account.account_number),
  )
  return catalog.filter((account) => !inactiveNumbers.has(account.account_number))
}

/**
 * Change the account on a correction line without carrying a stale account
 * name into the posted replacement entry. Descriptions that do not match the
 * previous account name are user-authored voucher text and stay untouched.
 */
export function changeCorrectionLineAccount<T extends CorrectionLineAccountFields>(
  line: T,
  nextAccountNumber: string,
  accounts: NamedAccount[],
): T {
  const currentDescription = line.line_description.trim()
  const previousNames = accounts
    .filter((account) => account.account_number === line.account_number)
    .map((account) => account.account_name)

  const descriptionIsAccountName = currentDescription.length === 0
    || previousNames.some((name) => namesMatch(currentDescription, name))

  return {
    ...line,
    account_number: nextAccountNumber,
    line_description: descriptionIsAccountName
      ? findAccountName(nextAccountNumber, accounts) ?? ''
      : line.line_description,
  }
}
