/**
 * The accounts a bank connection offers, as the onboarding picker renders them.
 *
 * The callback's cross-company guard stores an account that another of the
 * user's companies already books as enabled:false with claimed_by_company_id
 * (app/api/extensions/enable-banking/callback/route.ts). That flag is a notice,
 * never a block: one bank account belongs to one legal entity, but the app
 * cannot know which of two companies is the right home for it, so the picker
 * shows every account the consent returned, names the company that books a
 * claimed one, and leaves the choice to the user (founder direction
 * 2026-09-15, issue #2647). Hiding claimed accounts, which is what the picker
 * did before, left a user whose whole consent was claimed on a blank page.
 */

/** One entry of bank_connections.accounts_data, as far as the picker reads it. */
export interface StoredPickerAccount {
  uid: string
  name?: string
  product?: string
  iban?: string
  bban?: string
  currency: string
  enabled?: boolean
  ledger_account?: string
  balance?: number
  claimed_by_company_id?: string
  claimed_by_company_name?: string
}

export interface PickerAccount {
  uid: string
  name: string
  /** Account number for the trailing label: BBAN when the bank gives one, else IBAN. */
  nr: string
  currency: string
  /** Ledger the account is already mirrored to, when it has one. */
  ledger: string | null
  balance: number | null
  /**
   * The company that already books this account, when one does. The name to
   * show, not the id: the picker only ever renders it.
   */
  claimedBy: string | null
}

export interface PickerLabels {
  /** Used when the bank names neither the account nor the product. */
  account: string
  /** Used when the claim carries an id but no company name. */
  otherCompany: string
}

/**
 * Map stored accounts to picker rows. Nothing is dropped; accounts another
 * company books sort last so the ones free to pick stay at the top, and the
 * order within each group is the bank's own.
 */
export function toPickerAccounts(
  stored: StoredPickerAccount[],
  labels: PickerLabels,
): PickerAccount[] {
  const rows = stored.map((a) => ({
    uid: a.uid,
    name: a.name || a.product || labels.account,
    nr: a.bban || a.iban || '',
    currency: (a.currency || 'SEK').toUpperCase(),
    ledger: a.ledger_account ?? null,
    balance: typeof a.balance === 'number' ? a.balance : null,
    // Flagged AND disabled here, the same conjunction partitionByClaim
    // requires (extensions/general/enable-banking/lib/claimed-accounts.ts;
    // core cannot import from extensions, so the rule is restated, not
    // shared). An account that syncs in THIS company must never be labelled
    // as belonging to another one, whatever a stale flag says.
    claimedBy: a.claimed_by_company_id && a.enabled === false
      ? a.claimed_by_company_name || labels.otherCompany
      : null,
  }))
  // Stable: only claimed accounts move, and only behind the free ones.
  return [...rows.filter((a) => !a.claimedBy), ...rows.filter((a) => a.claimedBy)]
}
