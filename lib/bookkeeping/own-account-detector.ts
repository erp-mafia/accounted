import type { SupabaseClient } from '@supabase/supabase-js'
import type { Transaction } from '@/types'
import { findByIban } from '@/lib/cash-accounts/service'
import { createLogger } from '@/lib/logger'

const log = createLogger('own-account-detector')

export interface OwnAccountTransfer {
  /** The cash account the OTHER leg of this transfer belongs to. */
  counterCashAccountId: string
  /** BAS ledger account of the counter account (debit/credit target). */
  counterLedgerAccount: string
  /** Currency of the counter account (informational: pairing key was IBAN). */
  counterCurrency: string
  /**
   * Paired transaction id when the other leg has already been ingested.
   * Null when only this leg is present so far: the categorizer still books
   * the correct transfer entry on this side; the other leg will match when
   * it arrives.
   */
  pairTransactionId: string | null
}

/**
 * Detect that this transaction is a transfer between two of the company's own
 * cash accounts. Resolution is IBAN-based: we look up `transaction.counterparty_iban`
 * in `cash_accounts` for the same company. When it matches another account,
 * return the ledger account of the other side so the categorizer can book
 * the transfer leg.
 *
 * Returns null when:
 *   - the transaction has no counterparty IBAN (manual entries, SIE imports,
 *     older PSD2 rows before counterparty_iban capture)
 *   - the counterparty IBAN doesn't match any cash account for this company
 *
 * No amount-only heuristic fallback: silent false positives at FX boundaries
 * would mis-book legitimate external transfers as own-account moves.
 */
export async function detectOwnAccountTransfer(
  supabase: SupabaseClient,
  companyId: string,
  transaction: Transaction,
): Promise<OwnAccountTransfer | null> {
  const cpIban = transaction.counterparty_iban?.trim()
  if (!cpIban) return null

  const counterAccount = await findByIban(supabase, companyId, cpIban)
  if (!counterAccount) return null

  // Defense-in-depth: refuse to route to a non-cash BAS account. cash_accounts
  // is constrained to BAS class 19 today but a future migration could relax it.
  if (!/^19[0-9]{2}$/.test(counterAccount.ledger_account)) {
    log.warn('counter account has non-cash ledger code: refusing to pair', {
      companyId,
      counterLedger: counterAccount.ledger_account,
    })
    return null
  }

  // Find the paired transaction on the other side, if it's already been
  // ingested. Match on (company_id, bank_connection_id of counter account,
  // opposite sign, ±2 days, unmatched).
  //
  // Within the date window the same account may carry several unrelated rows
  // of the opposite sign (a supplier payment, a payroll batch, ...). Without
  // an amount constraint the first one wins, and pairTransactionId can point
  // at a completely unrelated row. For same-currency transfers we tighten the
  // filter to the exact opposite amount. For cross-currency we can't: FX
  // converts the figure: so we fall back to the loose window and then pick
  // the candidate whose magnitude is closest to the original.
  const dateFrom = addDays(transaction.date, -2)
  const dateTo = addDays(transaction.date, 2)
  const oppositeSign = transaction.amount > 0 ? 'lt' : 'gt'
  const sameCurrency =
    transaction.currency?.toUpperCase() === counterAccount.currency?.toUpperCase()

  let q = supabase
    .from('transactions')
    .select('id, amount, date')
    .eq('company_id', companyId)
    .is('journal_entry_id', null)
    .gte('date', dateFrom)
    .lte('date', dateTo)
    .neq('id', transaction.id)

  if (counterAccount.bank_connection_id) {
    q = q.eq('bank_connection_id', counterAccount.bank_connection_id)
  }

  if (sameCurrency) {
    // Exact opposite amount. Postgres numeric comparison handles trailing
    // zeroes consistently; bank PSD2 amounts are stored at <= 2 decimals so
    // an equality match is the right primitive here.
    q = q.eq('amount', -transaction.amount)
  } else {
    q = oppositeSign === 'lt' ? q.lt('amount', 0) : q.gt('amount', 0)
  }

  const { data: pairCandidates, error } = await q.limit(5)
  if (error) {
    log.warn('pair candidate lookup failed', {
      companyId,
      transactionId: transaction.id,
      error: error.message,
    })
  }

  // Same-currency lookup is already amount-equal so any returned row is a
  // legitimate pair. Cross-currency: pick the row whose magnitude is closest
  // to the original, which beats taking whatever DB ordering returns first
  // when multiple unrelated rows fall inside the window.
  type PairCandidate = { id: string; amount: number | string; date: string }
  const candidates = ((pairCandidates ?? []) as PairCandidate[]).filter(p => p.id !== transaction.id)
  let pair: PairCandidate | null = null
  if (candidates.length > 0) {
    if (sameCurrency) {
      pair = candidates[0]
    } else {
      const target = Math.abs(transaction.amount)
      pair = candidates.reduce<PairCandidate | null>((best, c) => {
        if (best === null) return c
        const cAbs = Math.abs(Number(c.amount) || 0)
        const bestAbs = Math.abs(Number(best.amount) || 0)
        return Math.abs(cAbs - target) < Math.abs(bestAbs - target) ? c : best
      }, null)
    }
  }

  return {
    counterCashAccountId: counterAccount.id,
    counterLedgerAccount: counterAccount.ledger_account,
    counterCurrency: counterAccount.currency,
    pairTransactionId: pair?.id ?? null,
  }
}

function addDays(iso: string, days: number): string {
  const d = new Date(iso + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
