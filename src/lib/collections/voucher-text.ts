/**
 * A voucher row's account as the payout and kundförlust dialogs show it:
 * the number and its name ("1930 Företagskonto"), the company's chart first
 * and the BAS standard name for an account the chart does not hold yet
 * (6062 or 6351 are often first used by these vouchers), the number alone
 * while neither is loaded. Pure and client-safe.
 */
export function accountWithName(
  accountNumber: string,
  chart: ReadonlyArray<{ account_number: string; account_name: string | null }>,
  referenceName?: string | null,
): string {
  const name = chart.find((account) => account.account_number === accountNumber)?.account_name?.trim() || referenceName?.trim()
  return name ? `${accountNumber} ${name}` : accountNumber
}
