/**
 * Which Enable Banking connections an Open Payments connection takes over
 * once its accounts are chosen (supersede_enable_banking_connection: the old
 * row hands over its transactions and cash-account claims and is revoked).
 *
 * The switch used to know only the row its door named: replace_connection_id,
 * carried from the Byt button through the attempt and finalize to the account
 * choice. Every door that does not name it (Koppla bank, a resumed flow
 * started over, an agent's start, a payments link) and every hop that drops
 * it left the old row live beside the new one: two connections reading the
 * same account, the old one still offering the switch. So the handover is
 * also read from the accounts themselves: an Enable Banking row whose every
 * account it reads is now read by the Open Payments row (same IBAN and
 * currency) has nothing left to do. A row that still reads an account the
 * new one does not, or an account without an IBAN, stays live, so no account
 * loses its feed unless the person chose the switch. The row a switch names
 * is handed over as before, whatever it reads.
 */
import { aggregatorOf } from '@/lib/bank-sync/aggregator'
import { normalizeIban, type BankFeedAccount } from './sync'

export interface HandoverCandidate {
  id: string
  aggregator?: string | null
  accounts_data?: BankFeedAccount[] | null
}

/** One physical account: the IBAN and the currency (SEK when the bank names none), as supersede_enable_banking_connection matches them. */
function accountKey(account: Pick<BankFeedAccount, 'iban' | 'currency'>): string | null {
  const iban = normalizeIban(account.iban)
  if (!iban) return null
  return `${iban}:${(account.currency || 'SEK').trim().toUpperCase()}`
}

export function enableBankingRowsTakenOver(input: {
  /** The accounts the Open Payments row reads after the choice. */
  reads: ReadonlyArray<Pick<BankFeedAccount, 'iban' | 'currency'>>
  /** The Enable Banking row a switch named, if any. */
  replaced: string | null
  /** The company's other live connections (any service). */
  live: readonly HandoverCandidate[]
}): string[] {
  const covered = new Set(input.reads.map(accountKey).filter((key): key is string => key !== null))
  return input.live
    .filter((row) => aggregatorOf(row) === 'enable_banking')
    .filter((row) => {
      if (input.replaced && row.id === input.replaced) return true
      const reads = (Array.isArray(row.accounts_data) ? row.accounts_data : []).filter((account) => account?.enabled === true)
      return reads.length > 0 && reads.every((account) => {
        const key = accountKey(account)
        return key !== null && covered.has(key)
      })
    })
    .map((row) => row.id)
}
