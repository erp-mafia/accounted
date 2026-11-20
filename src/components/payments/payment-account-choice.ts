/**
 * Which payable account a Betala via banken dialog opens on (PH 220). In
 * order: the dialog's own preferred account while it can pay (a salary run:
 * the account its verifikat credits the net pay on, the account its payment
 * file pays from), the account paid from last time in this browser while it
 * can still pay, else the first payable one. Without the preferred account a
 * salary run opened on whatever account the last supplier payment used, so
 * the salaries could leave from the savings account while the books credit
 * 1930. Pure, so the rule is tested without a browser.
 */

export interface ChoosableAccount {
  id: string
}

export function pickPaymentAccount<T extends ChoosableAccount>(
  payable: readonly T[],
  { preferred, remembered }: { preferred?: string | null; remembered?: string | null },
): T | undefined {
  const byId = (id: string | null | undefined) => (id ? payable.find((a) => a.id === id) : undefined)
  return byId(preferred) ?? byId(remembered) ?? payable[0]
}

/**
 * The company's primary bank account among a dialog's accounts, payable or
 * not; null when none is marked (or a server from before the flag). The
 * skattekonto dialog prefers it: a skattekonto inbetalning is booked against
 * it (the __PRIMARY_SEK__ rule) and the Skatteverket payment file pays from
 * it, so a tax payment opened on the account a supplier payment last used
 * left from one account while the books credited another.
 */
export function primaryPaymentAccount<T extends ChoosableAccount & { is_primary?: boolean }>(accounts: readonly T[]): T | null {
  return accounts.find((a) => a.is_primary === true) ?? null
}
