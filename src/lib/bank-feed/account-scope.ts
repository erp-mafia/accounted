import { normalizeIban } from '@/lib/cash-accounts/ledger-slots'

/**
 * The dedup scope of an account: the one it was first ingested under, else
 * the IBAN, else the provider uid. It is the middle part of every stored key
 * of the account's rows (`eb_{scope}_...`, lib/transactions/external-id.ts),
 * so the sync builds the keys with it and the first import finds the rows an
 * account has stored by it (feed.ts). A module of its own so both read the
 * one rule.
 */
export function accountDedupScope(account: { dedup_scope?: string | null; iban?: string | null; uid: string }): string {
  return account.dedup_scope || normalizeIban(account.iban) || account.uid
}
