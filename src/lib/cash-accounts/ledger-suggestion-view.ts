/**
 * A ledger-account suggestion as the API answers it and the UI reads it
 * (crm#1066): GET /api/cash-accounts/ledger-suggestions, the notice on
 * Transaktioner and on the bank settings, and the bank picker's preselection.
 *
 * The decision is lib/cash-accounts/ledger-evidence.ts; the reads are
 * lib/cash-accounts/ledger-suggestions.ts. This file is the shape between
 * them and the sentence a suggestion is shown as (message keys in the
 * bank_ledger_suggestion namespace, sv and en).
 *
 * Pure: no Supabase, no logger, safe in the client bundle.
 */

import type { LedgerEvidenceBasis, LedgerSuggestionKind } from '@/lib/cash-accounts/ledger-evidence'

/** One bank account of a suggestion. */
export interface LedgerSuggestionAccount {
  cash_account_id: string
  connection_id: string
  /**
   * The account's uid in its bank connection's account list, which the bank
   * picker and its save key on. Null when the account is not in that list.
   */
  uid: string | null
  /** "••4417": the IBAN tail, or the account's name when it has no IBAN. */
  label: string
  /** The ledger account the bank account books on now. */
  from_ledger: string
  from_ledger_name: string | null
  /** The ledger account the books say it belongs on. */
  to_ledger: string
  to_ledger_name: string | null
  /** Null for the account that only makes room in a one-sided swap. */
  basis: LedgerEvidenceBasis | null
  /** Unbooked bank transactions of the account already booked on to_ledger. */
  hits: number
  /** The day the bank balance equals the balance of to_ledger, when it does. */
  balance_date: string | null
  /** Bank transactions already booked on from_ledger: those verifikat stay there. */
  booked_rows: number
}

/** The body the bank picker sends to PATCH /api/extensions/ext/enable-banking/accounts. */
export interface LedgerSelectionRequest {
  connection_id: string
  enabled_uids: string[]
  account_mappings: Array<{ uid: string; ledger_account: string }>
}

export interface LedgerSuggestionView {
  /** Stable for the same change, so a fresh read can find it again. */
  id: string
  /**
   * 'swap': each of two accounts belongs on the other's ledger account by its
   * own evidence. 'one_sided_swap': the first account belongs on the ledger
   * account the second one holds, and nothing says the second belongs there.
   */
  kind: LedgerSuggestionKind
  /**
   * One account, or the two of a swap. In a one-sided swap the first is the
   * account with the evidence, the second the one that makes room.
   */
  accounts: LedgerSuggestionAccount[]
  /**
   * The picker's save request that makes the change, every other account of
   * the connection left as it is. Null when one save cannot make it: the two
   * accounts of a swap come from different bank connections, or an account is
   * missing from its connection's list.
   */
  selection: LedgerSelectionRequest | null
  /** The connection is active and `selection` exists: one click applies it. */
  one_click: boolean
  /**
   * A swap whose two accounts come from different bank connections. No save
   * can make it in one step, so it is shown with the way there instead of a
   * button.
   */
  two_connections: boolean
}

export interface LedgerSuggestionMessage {
  key: string
  values: Record<string, string | number>
}

/** "1920 PlusGiro", or the number alone when the chart has no name for it. */
export function ledgerWithName(ledger: string, name: string | null): string {
  return name ? `${ledger} ${name}` : ledger
}

/** The sentence that says what is wrong and which ledger account is right. */
export function ledgerSuggestionBody(suggestion: LedgerSuggestionView): LedgerSuggestionMessage {
  const [first, second] = suggestion.accounts
  if (suggestion.kind === 'one_sided_swap' && second) {
    const values = {
      accountA: first.label,
      fromA: first.from_ledger,
      toA: ledgerWithName(first.to_ledger, first.to_ledger_name),
      toNumber: first.to_ledger,
      accountB: second.label,
      // "which has no transactions booked there" is only said when it is true.
      holderBooked: second.booked_rows > 0 ? 'yes' : 'no',
    }
    if (first.basis === 'balance' && first.balance_date) {
      return { key: 'one_sided_swap_balance', values: { ...values, date: first.balance_date } }
    }
    return { key: 'one_sided_swap_transactions', values: { ...values, hits: first.hits } }
  }
  if (suggestion.kind === 'swap' && second) {
    return {
      key: 'swap',
      values: {
        accountA: first.label,
        fromA: first.from_ledger,
        toA: ledgerWithName(first.to_ledger, first.to_ledger_name),
        accountB: second.label,
        fromB: second.from_ledger,
        toB: ledgerWithName(second.to_ledger, second.to_ledger_name),
      },
    }
  }
  const common = {
    account: first.label,
    from: first.from_ledger,
    to: ledgerWithName(first.to_ledger, first.to_ledger_name),
    toNumber: first.to_ledger,
  }
  if (first.basis === 'balance' && first.balance_date) {
    return { key: 'move_balance', values: { ...common, date: first.balance_date } }
  }
  return { key: 'move_transactions', values: { ...common, hits: first.hits } }
}

/**
 * The sentence about transactions already booked under the current mapping,
 * or null when there are none: their verifikat are not moved by the change.
 */
export function ledgerSuggestionBookedNote(suggestion: LedgerSuggestionView): LedgerSuggestionMessage | null {
  const count = suggestion.accounts.reduce((sum, account) => sum + account.booked_rows, 0)
  return count > 0 ? { key: 'booked_rows', values: { count } } : null
}

/** The label of the one button. */
export function ledgerSuggestionAction(suggestion: LedgerSuggestionView): LedgerSuggestionMessage {
  const [first, second] = suggestion.accounts
  if (suggestion.kind !== 'move' && second) {
    const [a, b] = [first.to_ledger, second.to_ledger].sort()
    return { key: 'action_swap', values: { a, b } }
  }
  return { key: 'action_move', values: { to: first.to_ledger } }
}

/** One account of a suggestion the bank picker can preselect, with the suggestion it belongs to. */
export interface PickerPreselectedAccount {
  account: LedgerSuggestionAccount
  suggestion: LedgerSuggestionView
}

/** The one line beside an account in the bank picker that got a preselected ledger account. */
export function ledgerSuggestionPickerReason({ account, suggestion }: PickerPreselectedAccount): LedgerSuggestionMessage {
  const to = ledgerWithName(account.to_ledger, account.to_ledger_name)
  if (account.basis === null) {
    // The account that makes room in a one-sided swap: say who it trades with.
    const other = suggestion.accounts.find((candidate) => candidate.cash_account_id !== account.cash_account_id)
    return {
      key: 'picker_trades_places',
      values: {
        to,
        other: other?.label ?? '',
        from: ledgerWithName(account.from_ledger, account.from_ledger_name),
      },
    }
  }
  if (account.basis === 'balance' && account.balance_date) {
    return { key: 'picker_balance', values: { to, date: account.balance_date } }
  }
  return { key: 'picker_transactions', values: { to, hits: account.hits } }
}

/**
 * The suggestions the picker of `connectionId` can preselect: those one save
 * of that connection makes, with every account's uid known. A swap is
 * preselected whole or not at all: one half would put two accounts on one
 * ledger account, which the save refuses.
 */
export function pickerSuggestions(
  suggestions: readonly LedgerSuggestionView[],
  connectionId: string,
): LedgerSuggestionView[] {
  return suggestions.filter(
    (suggestion) =>
      suggestion.selection?.connection_id === connectionId && suggestion.accounts.every((account) => account.uid !== null),
  )
}

/** The same suggestions keyed by account uid, for the line beside each account. */
export function pickerPreselection(
  suggestions: readonly LedgerSuggestionView[],
  connectionId: string,
): Map<string, PickerPreselectedAccount> {
  const out = new Map<string, PickerPreselectedAccount>()
  for (const suggestion of pickerSuggestions(suggestions, connectionId)) {
    for (const account of suggestion.accounts) {
      if (account.uid) out.set(account.uid, { account, suggestion })
    }
  }
  return out
}
