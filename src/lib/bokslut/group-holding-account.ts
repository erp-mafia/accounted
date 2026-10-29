/**
 * BAS: the finansiella anläggningstillgångar in 13xx carry a company's
 * holdings in and long-term claims on group and associated companies
 * (1310 andelar i koncernföretag, 1320 långfristiga fordringar hos
 * koncernföretag, 1330 andelar i intresseföretag, ...). A group link names
 * the account its holding is booked on, and only such an account.
 */
export const GROUP_HOLDING_ACCOUNT_RE = /^13[0-9]{2}$/

export function isGroupHoldingAccount(account: string): boolean {
  return GROUP_HOLDING_ACCOUNT_RE.test(account)
}
