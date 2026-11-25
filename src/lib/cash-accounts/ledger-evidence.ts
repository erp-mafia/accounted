/**
 * Which 19xx ledger account a connected bank account should book on, decided
 * from what the books already say (crm#1066).
 *
 * A bank account gets its ledger account from a fixed rule when the bank is
 * connected (lib/cash-accounts/ledger-slots.ts): the currency default, then
 * the next free slot. A company that moved in with imported bookkeeping
 * already books each bank account on a number of its own choosing, and when
 * the connected account lands on another one, the sweep that links bank rows
 * to the imported verifikat finds nothing and every row reads as unbooked.
 *
 * public.cash_account_ledger_evidence (20261010210000) reads two kinds of
 * evidence per connected account and ledger account:
 *   transactions  how many of the account's unbooked bank rows have a posted
 *                 line there on the same date for the same signed amount, on
 *                 a verifikat no bank row is linked to yet (20261125130000);
 *   balance       the day on which the bank's balance, rolled back, equals
 *                 the ledger account's balance to the ore.
 * This module turns those rows into suggestions. It never applies one: a
 * change goes through the bank picker's own save (save_bank_account_selection).
 *
 * The rule, per account:
 *   - Transactions point at ledger account L when L is not the current one,
 *     has at least MIN_TRANSACTION_HITS rows, and at least HIT_DOMINANCE
 *     times the rows of every other 19xx account, the current one included
 *     (never less than HIT_DOMINANCE itself). They point at the current
 *     account by the same measure.
 *   - The balance points at L when L is the only ledger account it equals.
 *     One match is enough on its own: books that end the day before the bank
 *     feed starts share no row with it. Several matches say nothing.
 *   - Both kinds must not disagree: a balance that equals another account
 *     than the transactions point at, the current one included, means no
 *     suggestion.
 * And across accounts, when the ledger account A points at is held by a live
 * bank account H:
 *   - H points at A's ledger account: one swap, each on its own evidence
 *     ('swap'), also across two bank connections.
 *   - H is of the same bank connection, points nowhere, and nothing says it
 *     belongs where it is (no bank row of its own booked there, no balance
 *     match there): a one-sided swap ('one_sided_swap'). A takes the ledger
 *     account and H takes A's old one. H's placement carried no information,
 *     so trading places loses nothing, and it is one save. This is the common
 *     shape: the busy account got 1931 because a savings account with a
 *     handful of rows took 1930.
 *   - Otherwise nothing: H has evidence for where it is, which makes A's
 *     claim ambiguous; or H points at a third ledger account, and then its
 *     own suggestion comes first and frees the one A wants; or H is of
 *     another bank connection, where no single save can trade the two.
 * Two accounts pointing at the same ledger account are both left alone, and
 * so is A when another account points at the ledger account H would get.
 *
 * Pure: no Supabase, no logger, safe in the client bundle.
 */

/** Fewest matching bank rows that make transactions evidence. */
export const MIN_TRANSACTION_HITS = 5
/** How many times the rows of any other ledger account the winner needs. */
export const HIT_DOMINANCE = 3

/** One row of public.cash_account_ledger_evidence. */
export interface LedgerEvidenceRow {
  cash_account_id: string
  /** 'transactions' or 'balance'; anything else is ignored. */
  kind: string
  ledger_account: string
  hits: number | string | null
  balance_date: string | null
}

/** The part of a cash_accounts row, with its connection's status, the decision reads. */
export interface EvidenceCashAccount {
  id: string
  ledger_account: string
  bank_connection_id: string | null
  enabled: boolean | null
  /** bank_connections.status. A revoked connection syncs onto nothing. */
  connection_status?: string | null
}

export type LedgerEvidenceBasis = 'transactions' | 'balance'

/** One account's change of ledger account. */
export interface LedgerMove {
  cashAccountId: string
  connectionId: string
  /** The ledger account the bank account books on now. */
  from: string
  /** The ledger account the books say it belongs on. */
  to: string
  /**
   * What the move rests on. Transactions win when both agree. Null for the
   * account that only makes room in a one-sided swap.
   */
  basis: LedgerEvidenceBasis | null
  /** Unbooked bank rows of the account already booked on `to`. */
  hits: number
  /** The day the bank balance equals the balance of `to`, when it does. */
  balanceDate: string | null
}

export type LedgerSuggestionKind = 'move' | 'swap' | 'one_sided_swap'

export interface LedgerSuggestion {
  /**
   * 'swap': two accounts each sit on the ledger account the other's evidence
   * points at. 'one_sided_swap': one account's evidence points at a ledger
   * account whose holder has no evidence of its own, and they trade places.
   */
  kind: LedgerSuggestionKind
  /**
   * One move, or the two halves of a swap. In a one-sided swap the first is
   * the account with the evidence and the second the one that makes room.
   */
  moves: LedgerMove[]
}

interface AccountEvidence {
  hits: Map<string, number>
  balance: Map<string, string>
}

const BANK_LEDGER = /^19[0-9]{2}$/

/**
 * A bank connection syncs onto the row: the definition the bank picker and
 * the database use for a claim on a ledger account
 * (lib/onboarding-books/ledger.ts ledgerClaims, cash_account_refusal_detail).
 */
function isLive(account: EvidenceCashAccount): boolean {
  return account.bank_connection_id !== null && account.enabled !== false && account.connection_status !== 'revoked'
}

function evidenceByAccount(rows: readonly LedgerEvidenceRow[]): Map<string, AccountEvidence> {
  const out = new Map<string, AccountEvidence>()
  for (const row of rows) {
    if (!BANK_LEDGER.test(row.ledger_account)) continue
    const entry = out.get(row.cash_account_id) ?? { hits: new Map<string, number>(), balance: new Map<string, string>() }
    if (row.kind === 'transactions') {
      const hits = Number(row.hits)
      if (Number.isFinite(hits) && hits > 0) entry.hits.set(row.ledger_account, hits)
    } else if (row.kind === 'balance' && row.balance_date) {
      entry.balance.set(row.ledger_account, row.balance_date)
    }
    out.set(row.cash_account_id, entry)
  }
  return out
}

/** The ledger account the transactions point at, or null when they point nowhere. */
function transactionsPointAt(hits: ReadonlyMap<string, number>): string | null {
  const ranked = [...hits.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const best = ranked[0]
  if (!best) return null
  const runnerUp = ranked[1]?.[1] ?? 0
  if (best[1] < MIN_TRANSACTION_HITS) return null
  if (best[1] < HIT_DOMINANCE * Math.max(runnerUp, 1)) return null
  return best[0]
}

/** Where one account's own evidence says it belongs, or null when it says nothing clear. */
function targetFor(account: EvidenceCashAccount, evidence: AccountEvidence | undefined): Omit<LedgerMove, 'cashAccountId' | 'connectionId'> | null {
  if (!evidence) return null
  const current = account.ledger_account
  const byTransactions = transactionsPointAt(evidence.hits)
  const balanceLedgers = [...evidence.balance.keys()]

  if (byTransactions !== null) {
    // The rows already agree with the mapping.
    if (byTransactions === current) return null
    // A balance that equals the current account, or only other accounts than
    // the one the rows point at, contradicts them.
    if (balanceLedgers.length > 0 && (balanceLedgers.includes(current) || !balanceLedgers.includes(byTransactions))) {
      return null
    }
    return {
      from: current,
      to: byTransactions,
      basis: 'transactions',
      hits: evidence.hits.get(byTransactions) ?? 0,
      balanceDate: evidence.balance.get(byTransactions) ?? null,
    }
  }

  // No clear word from the rows: the balance decides, when it names one account.
  if (balanceLedgers.length !== 1 || balanceLedgers[0] === current) return null
  const to = balanceLedgers[0]
  return {
    from: current,
    to,
    basis: 'balance',
    hits: evidence.hits.get(to) ?? 0,
    balanceDate: evidence.balance.get(to) ?? null,
  }
}

/**
 * Whether anything in the books says the account belongs on the ledger
 * account it holds: a bank row of its own booked there, or a balance match
 * there. Without either, its placement is the allocation rule's and nothing
 * else.
 */
function belongsWhereItIs(account: EvidenceCashAccount, evidence: AccountEvidence | undefined): boolean {
  if (!evidence) return false
  return (evidence.hits.get(account.ledger_account) ?? 0) > 0 || evidence.balance.has(account.ledger_account)
}

/**
 * The suggestions for a company: its cash accounts (every row, so that the
 * holder of a wanted ledger account is known) and the evidence rows.
 */
export function suggestLedgerChanges(
  accounts: readonly EvidenceCashAccount[],
  evidence: readonly LedgerEvidenceRow[],
): LedgerSuggestion[] {
  const byAccount = evidenceByAccount(evidence)
  const targets = new Map<string, LedgerMove>()
  for (const account of accounts) {
    if (!isLive(account) || account.bank_connection_id === null) continue
    const target = targetFor(account, byAccount.get(account.id))
    if (target) targets.set(account.id, { cashAccountId: account.id, connectionId: account.bank_connection_id, ...target })
  }

  // One ledger account cannot be the answer for two bank accounts.
  const wanted = new Map<string, number>()
  for (const move of targets.values()) wanted.set(move.to, (wanted.get(move.to) ?? 0) + 1)

  const holderOf = new Map(accounts.map((account) => [account.ledger_account, account]))
  const out: LedgerSuggestion[] = []
  const swapped = new Set<string>()
  const ordered = [...targets.values()].sort((a, b) => a.from.localeCompare(b.from) || a.cashAccountId.localeCompare(b.cashAccountId))
  for (const move of ordered) {
    if (swapped.has(move.cashAccountId)) continue
    if ((wanted.get(move.to) ?? 0) > 1) continue
    const holder = holderOf.get(move.to)
    if (!holder || holder.id === move.cashAccountId || !isLive(holder)) {
      // Free, or held by a row nothing syncs onto: the save adopts that row
      // or refuses by name (lib/cash-accounts/selection-refusal.ts).
      out.push({ kind: 'move', moves: [move] })
      continue
    }
    const counter = targets.get(holder.id)
    if (counter) {
      if (counter.to === move.from && (wanted.get(counter.to) ?? 0) === 1) {
        swapped.add(holder.id)
        out.push({ kind: 'swap', moves: [move, counter] })
      }
      // A holder that points at a third ledger account moves first.
      continue
    }
    if (
      holder.bank_connection_id === move.connectionId &&
      !belongsWhereItIs(holder, byAccount.get(holder.id)) &&
      !wanted.has(move.from)
    ) {
      out.push({
        kind: 'one_sided_swap',
        moves: [
          move,
          {
            cashAccountId: holder.id,
            connectionId: move.connectionId,
            from: move.to,
            to: move.from,
            basis: null,
            hits: 0,
            balanceDate: null,
          },
        ],
      })
    }
    // Otherwise the holder stays where it is: see the header.
  }
  return out
}
