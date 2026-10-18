import { eventBus } from '@/lib/events/bus'
import type { EventPayload } from '@/lib/events/types'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { proposeBankMatchesForArrivedRows } from '@/lib/operations/inbox-bank-match'

/**
 * Match on arrival, the bank's side: when bank rows arrive (a bank sync, a
 * bank file), the open inbox items one of them could pay are looked at again,
 * so an invoice that came in before its payment shows "Ser redan betald ut"
 * once the payment is in the bank. The bank feed's own matchers run first
 * (they hint or settle the row during the ingest), and a row they claimed is
 * never proposed. Best effort: a failure is logged and never fails the sync.
 */
export function registerInboxBankMatchHandler(): () => void {
  return eventBus.on('transaction.synced', proposeInboxBankMatches)
}

/** The transaction.synced handler; lib/init subscribes it through EVENT_CONSUMERS (lib/composition/event-consumers.ts). */
export async function proposeInboxBankMatches({ transactions, companyId }: EventPayload<'transaction.synced'>): Promise<void> {
  if (!companyId || !Array.isArray(transactions) || transactions.length === 0) return
  await proposeBankMatchesForArrivedRows(createServiceClientNoCookies(), companyId, transactions)
}
