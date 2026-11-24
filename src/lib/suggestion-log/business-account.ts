/**
 * The business account of posted lines: the one account that is neither a
 * cash ledger (19xx), VAT (26xx) nor the row's own settlement ledger (a
 * company card's 2890, settlementLedgers). Null when the lines carry none or
 * several.
 *
 * In a file of its own, without imports, so the bank side can read an
 * earlier booking by the same rule the decision log reads a final booking by
 * (lib/transactions/booking-precedent.ts) without importing the log.
 */
export function businessAccountOfLines(
  lines: ReadonlyArray<{ account: string; debit: number; credit: number }>,
  settlementLedgers: readonly string[] = [],
): string | null {
  const accounts = new Set(
    lines
      .map((l) => l.account)
      .filter((a) => !a.startsWith('19') && !isMomsAccount(a) && !settlementLedgers.includes(a)),
  )
  return accounts.size === 1 ? [...accounts][0] : null
}

/** Whether the lines carry a moms line at all, by the account rule above. */
export function carriesMomsLine(lines: ReadonlyArray<{ account: string }>): boolean {
  return lines.some((l) => isMomsAccount(l.account))
}

/** A moms account as businessAccountOfLines leaves it out: the 26xx group. */
function isMomsAccount(account: string): boolean {
  return account.startsWith('26')
}
