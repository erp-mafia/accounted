/**
 * Bank-driven repayment of utlägg: who is owed, and which unbooked bank
 * outflow is the transfer that pays them.
 *
 * Pure functions on plain rows so the inbox page (browser), the worklist
 * (server) and the ingest path can share one definition of "this bank line
 * repays that person" without a schema hint column. The match is
 * deliberately strict: an SEK outflow whose absolute amount equals ONE
 * person's outstanding total to the öre. Two people with the same total make
 * the amount ambiguous and produce no suggestion; the user then picks the
 * person in the payout dialog.
 */
import { roundOre } from '@/lib/money'
import type { ExpensePayoutDue } from '@/lib/worklist/types'

export interface ExpenseClaimRowForGrouping {
  id: string
  employee_id: string | null
  claimant_name: string
  liability_account: string
  amount_sek: number | string
  expense_date: string
}

/** Group registered claims into one item per person, oldest debt first. */
export function groupExpenseClaimsByPerson(rows: ExpenseClaimRowForGrouping[]): ExpensePayoutDue[] {
  const byPerson = new Map<string, ExpensePayoutDue>()
  for (const row of rows) {
    const key = row.employee_id ?? `owner:${row.claimant_name}`
    const amount = Number(row.amount_sek) || 0
    const existing = byPerson.get(key)
    if (existing) {
      existing.claim_count += 1
      existing.claim_ids.push(row.id)
      existing.total_sek = roundOre(existing.total_sek + amount)
      if (row.expense_date < existing.oldest_expense_date) {
        existing.oldest_expense_date = row.expense_date
      }
    } else {
      byPerson.set(key, {
        key,
        employee_id: row.employee_id,
        claimant_name: row.claimant_name,
        liability_account: row.liability_account,
        claim_count: 1,
        claim_ids: [row.id],
        total_sek: roundOre(amount),
        oldest_expense_date: row.expense_date,
      })
    }
  }
  return [...byPerson.values()].sort((a, b) =>
    a.oldest_expense_date < b.oldest_expense_date ? -1 : a.oldest_expense_date > b.oldest_expense_date ? 1 : 0,
  )
}

export interface MatchableOutflow {
  id: string
  amount: number
  currency?: string | null
  is_business?: boolean | null
  journal_entry_id?: string | null
}

/** A bank outflow that repays one person's registered utlägg in full. */
export interface ExpensePayoutMatch {
  transaction_id: string
  person: ExpensePayoutDue
}

/**
 * Pair unbooked SEK outflows with the person whose outstanding total they
 * equal. Amounts compared in öre. Totals shared by two or more people are
 * skipped (ambiguous), as are rows already booked or flagged is_business.
 */
export function matchTransactionsToExpensePayouts(
  transactions: MatchableOutflow[],
  people: ExpensePayoutDue[],
): Map<string, ExpensePayoutMatch> {
  const out = new Map<string, ExpensePayoutMatch>()
  if (people.length === 0 || transactions.length === 0) return out
  const byOre = new Map<number, ExpensePayoutDue | null>()
  for (const p of people) {
    const ore = Math.round(p.total_sek * 100)
    if (ore <= 0) continue
    // null marks an ambiguous total: two people owed the same amount.
    byOre.set(ore, byOre.has(ore) ? null : p)
  }
  for (const tx of transactions) {
    if (tx.journal_entry_id || tx.is_business !== null && tx.is_business !== undefined) continue
    if ((tx.currency ?? 'SEK').toUpperCase() !== 'SEK') continue
    if (!(tx.amount < 0)) continue
    const person = byOre.get(Math.round(-tx.amount * 100))
    if (person) out.set(tx.id, { transaction_id: tx.id, person })
  }
  return out
}
