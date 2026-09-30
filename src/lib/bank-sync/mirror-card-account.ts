/**
 * Account names an ASPSP uses for a card sub-account that only MIRRORS the
 * main account, never holds its own money.
 *
 * Svea Bank lists two accounts per customer: the företagskonto (IBAN + BBAN)
 * and a debit-card settlement account, `BOKIO_Debit_Business` for Bokio
 * Företagskonto customers and `SVEA_MQ_Debit_B2B` for Svea's own business
 * customers. It has no IBAN, no BBAN, and reports the main account's balance.
 * Every card purchase arrives on both: the real row on the main account and
 * an opposite-sign row on the card account, which can be neither booked
 * meaningfully nor deleted (feed rows are ignore-only). Prod 2026-09-13: 17
 * Svea companies, 547 such rows, 543 with an opposite-sign twin on the main
 * account, 0 ever booked (issue #2565).
 *
 * Such an account is never an account of its own, whether it is on or off:
 * the OAuth callback stores it off and unmirrored, the selection save never
 * switches it on (and turns off one switched on before this rule), and
 * neither picker (settings, onboarding) offers it as a choice. An unticked
 * choice was not enough: 6 of 22 connects after #2577 ticked it anyway.
 *
 * The name alone is not enough: a bank could give a real account this label
 * too, so the identifier check is what makes the match safe. A card account
 * with its own IBAN or BBAN is a real account and syncs as before.
 *
 * Lives in core, not in the enable-banking extension, because the onboarding
 * picker applies the same rule and core must not import from extensions.
 */
export const MIRROR_CARD_ACCOUNT_NAMES: ReadonlySet<string> = new Set([
  'BOKIO_Debit_Business',
  'SVEA_MQ_Debit_B2B',
])

/** The fields of a bank_connections.accounts_data entry the rule reads. */
export interface MirrorCardCandidate {
  name?: string | null
  iban?: string | null
  bban?: string | null
}

/**
 * True when the account is a known mirror card account: named as one AND
 * carrying neither IBAN nor BBAN. Name comparison is exact after trimming
 * (the label is a system identifier, not free text).
 */
export function isMirrorCardAccount(account: MirrorCardCandidate): boolean {
  const name = account.name?.trim()
  if (!name || !MIRROR_CARD_ACCOUNT_NAMES.has(name)) return false
  if (account.iban?.trim()) return false
  if (account.bban?.trim()) return false
  return true
}
