import type { StoredAccount } from '../types'

/**
 * Account names an ASPSP uses for a card sub-account that only MIRRORS the
 * main account, never holds its own money.
 *
 * Svea Bank lists two accounts per customer: the företagskonto (IBAN + BBAN)
 * and a debit-card settlement account, `BOKIO_Debit_Business` for Bokio
 * Företagskonto customers and `SVEA_MQ_Debit_B2B` for Svea's own business
 * customers. It has no IBAN, no BBAN, and reports the main account's balance.
 * Every card purchase arrives on both: the real row on the main account and
 * an opposite-sign row with no description on the card account, which lands
 * as "Okänd transaktion" and can be neither booked meaningfully nor deleted
 * (feed rows are ignore-only). Prod 2026-09-13: 17 Svea companies, 547 such
 * rows, 543 with an opposite-sign twin on the main account, 0 ever booked
 * (issue #2565).
 *
 * The name alone is not enough: a bank could give a real account this label
 * too, so the identifier check is what makes the match safe. A card account
 * with its own IBAN or BBAN is a real account and syncs as before.
 */
export const MIRROR_CARD_ACCOUNT_NAMES: ReadonlySet<string> = new Set([
  'BOKIO_Debit_Business',
  'SVEA_MQ_Debit_B2B',
])

/**
 * True when the account is a known mirror card account: named as one AND
 * carrying neither IBAN nor BBAN. Name comparison is exact after trimming
 * (the label is a system identifier, not free text).
 */
export function isMirrorCardAccount(
  account: Pick<StoredAccount, 'name' | 'iban' | 'bban'>,
): boolean {
  const name = account.name?.trim()
  if (!name || !MIRROR_CARD_ACCOUNT_NAMES.has(name)) return false
  if (account.iban?.trim()) return false
  if (account.bban?.trim()) return false
  return true
}
