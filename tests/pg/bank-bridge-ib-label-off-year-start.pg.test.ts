/**
 * A verifikat labelled opening_balance on an ordinary day is ledger-only
 * history in the bank bridge, not an ingående balans.
 *
 * Before 20261006121003, "Märk som IB" in bank reconciliation re-tagged
 * ordinary mid-year verifikat (bank fees, payments) as source_type
 * 'opening_balance'. The status counts an IB only on the floor
 * (account_ib_floor: a fiscal year's first day), so such a verifikat stays in
 * the ledger movement. The candidate predicates dropped every verifikat with
 * the label, so it was in no list either: the bridge kept its amount as an
 * unexplained difference while the bank and the ledger agreed to the öre.
 */
import { describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getPool } from './setup'
import { createPgRest } from './postgrest-over-pg'
import {
  insertAuthUser,
  insertCashAccount,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertPostedJournalEntry,
  insertTransaction,
} from './fixtures'
import { getReconciliationStatus, runReconciliation } from '@/lib/reconciliation/bank-reconciliation'
import { listAccountItems } from '@/lib/reconciliation/items'

class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

function clientFor(userId: string): SupabaseClient {
  const rest = createPgRest({ role: 'authenticated', userId })
  return createClient('http://pg-real.invalid', 'pg-real-anon', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: rest.fetch },
    realtime: { transport: UnusedRealtimeTransport as never },
  })
}

async function books() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  await getPool().query(
    `INSERT INTO public.user_preferences (user_id, active_company_id) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET active_company_id = $2`,
    [userId, companyId],
  )
  const periods: Record<string, string> = {}
  for (const year of ['2025', '2026']) {
    periods[year] = await insertFiscalPeriod({ userId, companyId, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31`, name: year })
  }
  const cash = await insertCashAccount({ companyId, ledgerAccount: '1930', currency: 'SEK', isPrimary: true })
  const client = clientFor(userId)
  const entry = (date: string, lines: Array<[string, number, number]>, sourceType = 'manual') =>
    insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId: periods[date.slice(0, 4)],
      entryDate: date,
      sourceType,
      lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })),
    })
  return { userId, companyId, cash, client, entry }
}

describe('an opening_balance label off a fiscal year start', () => {
  it('is ledger-only history in the bridge; the real IB stays out of every list', async () => {
    const { userId, companyId, cash, client, entry } = await books()

    // The real IB, on the year's first day.
    const ib = await entry('2026-01-01', [['1930', 1000, 0], ['2099', 0, 1000]], 'opening_balance')
    // A bank fee once marked as IB, and an ordinary one: both before the
    // bank's history starts, neither linked to a bank row.
    const labelled = await entry('2026-02-10', [['6570', 300, 0], ['1930', 0, 300]], 'opening_balance')
    const ordinary = await entry('2026-03-05', [['6570', 100, 0], ['1930', 0, 100]])
    // The bank's history starts in July, its one row booked.
    const july = await entry('2026-07-01', [['1930', 500, 0], ['3001', 0, 500]])
    await insertTransaction({ companyId, userId, date: '2026-07-01', amount: 500, cashAccountId: cash, journalEntryId: july })
    // The bank reports what the ledger says: 1000 - 300 - 100 + 500.
    await getPool().query(
      `UPDATE public.cash_accounts SET balance = 1100, balance_updated_at = '2026-08-01T10:00:00+02:00' WHERE id = $1`,
      [cash],
    )

    const status = await getReconciliationStatus(client, companyId, '2026-01-01', '2026-12-31', '1930', 'SEK', cash, true)
    // Softly: a broken door names every figure it moves.
    expect.soft(status.gl_1930_balance).toBe(1100)
    expect.soft(status.gl_1930_opening_balance).toBe(1000)
    expect.soft(status.history_start).toBe('2026-07-01')
    expect.soft(status.before_history_count).toBe(2)
    expect.soft(status.before_history_total).toBe(-400)
    expect.soft(status.difference).toBe(0)
    expect.soft(status.unexplained_difference).toBe(0)
    expect.soft(status.ledger_balance_before_start).toBe(600)
    expect.soft(status.saldo_at_start).toBe(600)
    expect.soft(status.opening_difference).toBe(0)

    // The two candidate RPCs agree: the labelled fee is a verifikat with no
    // bank row, the real IB is no candidate.
    const matching = await client.rpc('get_account_gl_lines_for_matching', {
      p_company_id: companyId,
      p_account_number: '1930',
      p_date_from: '2026-01-01',
      p_date_to: '2026-12-31',
    })
    expect.soft(matching.error).toBeNull()
    const matchingIds = (matching.data as Array<{ journal_entry_id: string }>).map((l) => l.journal_entry_id)
    expect.soft(matchingIds).toEqual(expect.arrayContaining([labelled, ordinary]))
    expect.soft(matchingIds).not.toContain(ib)

    const unlinked = await client.rpc('get_unlinked_gl_lines', {
      p_company_id: companyId,
      p_account_number: '1930',
      p_date_from: '2026-01-01',
      p_date_to: '2026-12-31',
    })
    expect.soft(unlinked.error).toBeNull()
    const unlinkedIds = (unlinked.data as Array<{ journal_entry_id: string }>).map((l) => l.journal_entry_id)
    expect.soft(unlinkedIds).toEqual(expect.arrayContaining([labelled, ordinary]))
    expect.soft(unlinkedIds).not.toContain(ib)
  }, 30000)

  it('inside the bank history: named by the bridge, offered to no link', async () => {
    const { userId, companyId, cash, client, entry } = await books()
    await entry('2026-01-01', [['1930', 1000, 0], ['2099', 0, 1000]], 'opening_balance')
    const july = await entry('2026-07-01', [['1930', 500, 0], ['3001', 0, 500]])
    await insertTransaction({ companyId, userId, date: '2026-07-01', amount: 500, cashAccountId: cash, journalEntryId: july })
    // A payment once marked as IB, and its bank row: same day, same amount.
    const labelled = await entry('2026-08-10', [['1930', 200, 0], ['3001', 0, 200]], 'opening_balance')
    const row = await insertTransaction({ companyId, userId, date: '2026-08-10', amount: 200, cashAccountId: cash })
    await getPool().query(`UPDATE public.transactions SET is_business = true WHERE company_id = $1`, [companyId])

    // The matcher must not pair them: every link to the label is refused at
    // the write, so a pair is an error on every run.
    const run = await runReconciliation(client, companyId, userId, {
      dateFrom: '2026-01-01',
      dateTo: '2026-12-31',
      accountNumber: '1930',
      cashAccountId: cash,
    })
    expect.soft(run.errors).toBe(0)
    expect.soft(run.matches.map((m) => m.glLine.journal_entry_id)).not.toContain(labelled)
    const { rows } = await getPool().query(`SELECT journal_entry_id FROM public.transactions WHERE id = $1`, [row])
    expect.soft(rows[0].journal_entry_id).toBeNull()

    const status = await getReconciliationStatus(client, companyId, '2026-01-01', '2026-12-31', '1930', 'SEK', cash, true)
    expect.soft(status.difference).toBe(0)
    expect.soft(status.unmatched_transaction_count).toBe(1)
    expect.soft(status.unmatched_gl_line_count).toBe(1)
    expect.soft(status.unexplained_difference).toBe(0)

    const list = await listAccountItems(client, companyId, `bank:${cash}`, { windowFrom: '2026-01-01', windowTo: '2026-12-31' })
    const item = list?.items.find((i) => i.item_id === labelled)
    expect.soft(item?.bucket).toBe('unmatched_ledger')
    expect.soft(item?.actions).toEqual(['review'])
  }, 30000)
})
