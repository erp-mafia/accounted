/**
 * The removal refusals that archiving answers (PH 222): the account's rows
 * must stay, so it is turned off instead of removed. archive_cash_account
 * (20261027051317) decides; this list only tells the dialog when to offer it.
 */
export const CASH_ACCOUNT_ARCHIVABLE_REMOVAL_CODES: readonly string[] = [
  'CASH_ACCOUNT_REMOVE_BOOKED',
  'CASH_ACCOUNT_REMOVE_IGNORED',
  'CASH_ACCOUNT_REMOVE_MATCH_HISTORY',
  'CASH_ACCOUNT_REMOVE_IN_USE',
  'CASH_ACCOUNT_REMOVE_LEDGER_HISTORY',
]
