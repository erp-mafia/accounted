/**
 * A rättelse booked in a later open period is no bank work there.
 *
 * A verifikat whose year is locked is corrected with a storno and a corrected
 * verifikat dated in the first open period (lib/core/bookkeeping/
 * storno-target.ts). The original stays posted with its bank row in its own
 * year; the pair carries the bank leg in the open year and cancels there.
 * The candidate predicates left the storno out and kept the corrected
 * verifikat, so its bank leg was a ledger-only verifikat with nothing to
 * match and an unexplained difference in the bridge
 * (20261124150000_bank_candidates_skip_moved_correction).
 */
import { randomUUID } from 'node:crypto'
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
  insertTransaction,
} from './fixtures'
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'

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

  /** A verifikat posted through commit_journal_entry, as the storno service posts its two. */
  const post = async (
    date: string,
    lines: Array<[string, number, number]>,
    sourceType = 'manual',
    links: { reversesId?: string; correctionOfId?: string } = {},
  ) => {
    const id = randomUUID()
    await getPool().query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, reverses_id, correction_of_id)
       VALUES ($1, $2, $3, $4, 0, 'A', $5, 'Bankavgift', $6, 'draft', $7, $8)`,
      [id, userId, companyId, periods[date.slice(0, 4)], date, sourceType, links.reversesId ?? null, links.correctionOfId ?? null],
    )
    for (const [index, [account, debit, credit]] of lines.entries()) {
      await getPool().query(
        `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, account, debit, credit, index],
      )
    }
    await getPool().query(`SELECT public.commit_journal_entry($1::uuid, $2::uuid)`, [companyId, id])
    return id
  }

  /** A bank fee in 2025 with its bank row, then 2025 locked. */
  const lockedOriginal = async (amount: number) => {
    const original = await post('2025-11-15', [['6570', amount, 0], ['1930', 0, amount]])
    await insertTransaction({ companyId, userId, date: '2025-11-15', amount: -amount, cashAccountId: cash, journalEntryId: original })
    await getPool().query(`UPDATE public.fiscal_periods SET locked_at = now() WHERE id = $1`, [periods['2025']])
    return original
  }

  const candidates = async (rpc: 'get_unlinked_gl_lines' | 'get_account_gl_lines_for_matching') => {
    const { data, error } = await clientFor(userId).rpc(rpc, {
      p_company_id: companyId,
      p_account_number: '1930',
      p_date_from: '2026-01-01',
      p_date_to: '2026-12-31',
    })
    expect(error).toBeNull()
    return (data as Array<{ journal_entry_id: string }>).map((l) => l.journal_entry_id)
  }

  return { userId, companyId, cash, post, lockedOriginal, candidates, client: clientFor(userId) }
}

describe('a rättelse booked in a later open period, in the bank bridge', () => {
  it('leaves the open-year storno and corrected verifikat out of the bank work when they cancel on the account', async () => {
    const { companyId, cash, post, lockedOriginal, candidates, client } = await books()
    const original = await lockedOriginal(300)
    // The fee belonged on 6110: storno and corrected verifikat, same day in 2026.
    const storno = await post('2026-11-24', [['1930', 300, 0], ['6570', 0, 300]], 'storno', { reversesId: original })
    const corrected = await post('2026-11-24', [['6110', 300, 0], ['1930', 0, 300]], 'correction', { correctionOfId: original })

    for (const rpc of ['get_unlinked_gl_lines', 'get_account_gl_lines_for_matching'] as const) {
      const ids = await candidates(rpc)
      expect(ids).not.toContain(storno)
      expect(ids).not.toContain(corrected)
    }

    // The bank reports what the ledger says: -300 since the 2025 fee.
    await getPool().query(
      `UPDATE public.cash_accounts SET balance = -300, balance_updated_at = '2026-12-01T10:00:00+01:00' WHERE id = $1`,
      [cash],
    )
    const status = await getReconciliationStatus(client, companyId, '2026-01-01', '2026-12-31', '1930', 'SEK', cash, true)
    expect.soft(status.unmatched_gl_line_count).toBe(0)
    expect.soft(status.unexplained_difference).toBe(0)
  }, 30000)

  it('keeps a corrected verifikat that moves money on the account a candidate', async () => {
    const { post, lockedOriginal, candidates } = await books()
    const original = await lockedOriginal(100)
    await post('2026-11-24', [['1930', 100, 0], ['6570', 0, 100]], 'storno', { reversesId: original })
    // The rättelse takes 150 off the bank account: 50 of it is new money out.
    const corrected = await post(
      '2026-11-24',
      [['6570', 100, 0], ['2893', 50, 0], ['1930', 0, 150]],
      'correction',
      { correctionOfId: original },
    )

    expect(await candidates('get_unlinked_gl_lines')).toContain(corrected)
    expect(await candidates('get_account_gl_lines_for_matching')).toContain(corrected)
  }, 30000)
})
