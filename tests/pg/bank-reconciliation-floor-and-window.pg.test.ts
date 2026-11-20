/**
 * The bank status and the bank list read one floor and one window.
 *
 * public.account_ib_floor is the opening-balance floor of every balance: the
 * latest posted opening_balance verifikat dated on a fiscal year's first day,
 * skipping a date whose IB entries cancel on the account. The status took the
 * latest verifikat labelled opening_balance on any date, so a payment an
 * import labelled opening_balance dropped months of movement from both sides.
 *
 * A linked row counts once, in the window of its verifikat: the status and
 * the list read the same anchor.
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
  insertPostedJournalEntry,
  insertTransaction,
} from './fixtures'
import { getReconciliationStatus } from '@/lib/reconciliation/bank-reconciliation'
import { findOpeningBalanceFloor } from '@/lib/reconciliation/gl-balance'
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

interface Books {
  userId: string
  companyId: string
  periods: Record<string, string>
  cash: string
  client: SupabaseClient
}

async function books(): Promise<Books> {
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
  return { userId, companyId, periods, cash, client: clientFor(userId) }
}

function entry(
  b: Books,
  date: string,
  lines: Array<[string, number, number]>,
  extra: Partial<Parameters<typeof insertPostedJournalEntry>[0]> = {},
) {
  return insertPostedJournalEntry({
    userId: b.userId,
    companyId: b.companyId,
    fiscalPeriodId: b.periods[date.slice(0, 4)],
    entryDate: date,
    lines: lines.map(([accountNumber, debitAmount, creditAmount]) => ({ accountNumber, debitAmount, creditAmount })),
    ...extra,
  })
}

const facts = async (b: Books, from: string | null, to: string | null) =>
  (await b.client.rpc('get_bank_reconciliation_facts', {
    p_company_id: b.companyId,
    p_account_number: '1930',
    p_currency: 'SEK',
    p_cash_account_id: b.cash,
    p_include_unassigned: true,
    p_date_from: from,
    p_date_to: to,
  })).data as { ib_floor: string | null; effective_from: string | null }

describe('the opening balance floor', () => {
  it('a verifikat labelled opening_balance in mid-year floors nothing', async () => {
    const b = await books()
    await entry(b, '2026-02-10', [['1930', 1000, 0], ['3001', 0, 1000]])
    const february = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: '2026-02-10', amount: 1000, cashAccountId: b.cash })
    await entry(b, '2026-06-15', [['1930', 200, 0], ['3001', 0, 200]], { sourceType: 'opening_balance' })
    const june = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: '2026-06-15', amount: 200, cashAccountId: b.cash })

    // Softly: a broken floor names every door it breaks.
    expect.soft(await findOpeningBalanceFloor(b.client, b.companyId, '1930', '2026-12-31')).toBeNull()
    expect.soft((await facts(b, '2026-01-01', '2026-12-31')).ib_floor).toBeNull()

    const status = await getReconciliationStatus(b.client, b.companyId, '2026-01-01', '2026-12-31', '1930', 'SEK', b.cash, true)
    expect.soft(status.gl_1930_balance).toBe(1200)
    expect.soft(status.bank_transaction_count).toBe(2)
    expect.soft(status.difference).toBe(0)

    const list = await listAccountItems(b.client, b.companyId, `bank:${b.cash}`, { windowFrom: '2026-01-01', windowTo: '2026-12-31' })
    expect.soft(list?.items.map((i) => i.item_id)).toEqual(expect.arrayContaining([february, june]))
  }, 30000)

  it('a date whose IB entries cancel on the account is skipped, and the earlier years count', async () => {
    const b = await books()
    await entry(b, '2025-05-01', [['1930', 700, 0], ['3001', 0, 700]])
    await insertTransaction({ companyId: b.companyId, userId: b.userId, date: '2025-05-01', amount: 700, cashAccountId: b.cash })
    await entry(b, '2026-01-01', [['1930', 300, 0], ['2099', 0, 300]], { sourceType: 'opening_balance' })
    await entry(b, '2026-01-01', [['1930', 0, 300], ['2099', 300, 0]], { sourceType: 'opening_balance' })

    expect(await findOpeningBalanceFloor(b.client, b.companyId, '1930', '2026-12-31')).toBeNull()
    expect((await facts(b, null, '2026-12-31')).ib_floor).toBeNull()

    const status = await getReconciliationStatus(b.client, b.companyId, undefined, '2026-12-31', '1930', 'SEK', b.cash, true)
    expect(status.gl_1930_balance).toBe(700)
    expect(status.bank_transaction_count).toBe(1)
  }, 30000)

  it('walks past a cancelling date to the latest real IB below it', async () => {
    const b = await books()
    const real = await entry(b, '2025-01-01', [['1930', 1200.5, 0], ['2099', 0, 1200.5]], { sourceType: 'opening_balance' })
    await entry(b, '2026-01-01', [['1930', 4000, 0], ['2099', 0, 4000]], { sourceType: 'opening_balance' })
    await entry(b, '2026-01-01', [['1930', 0, 4000], ['2099', 4000, 0]], { sourceType: 'opening_balance' })

    expect(await findOpeningBalanceFloor(b.client, b.companyId, '1930', '2026-12-31')).toEqual({
      date: '2025-01-01',
      amount: 1200.5,
      entryIds: [real],
    })
  }, 30000)

  it('one IB verifikat is a floor even when it nets to zero on the account', async () => {
    const b = await books()
    const lone = await entry(b, '2026-01-01', [['1930', 100, 0], ['1930', 0, 100]], { sourceType: 'opening_balance' })

    expect(await findOpeningBalanceFloor(b.client, b.companyId, '1930', '2026-12-31')).toEqual({
      date: '2026-01-01',
      amount: 0,
      entryIds: [lone],
    })
  }, 30000)

  it('two IB verifikat on one date that do not cancel floor together, on their sum', async () => {
    const b = await books()
    const first = await entry(b, '2026-01-01', [['1930', 500, 0], ['2099', 0, 500]], { sourceType: 'opening_balance' })
    const second = await entry(b, '2026-01-01', [['1930', 0, 499.99], ['2099', 499.99, 0]], { sourceType: 'opening_balance' })

    const floor = await findOpeningBalanceFloor(b.client, b.companyId, '1930', '2026-12-31')
    expect(floor?.date).toBe('2026-01-01')
    expect(floor?.amount).toBe(0.01)
    expect(floor?.entryIds.sort()).toEqual([first, second].sort())
  }, 30000)

  it('a real IB floors the status and the list alike, and names its amount and verifikat', async () => {
    const b = await books()
    await entry(b, '2025-05-01', [['1930', 700, 0], ['3001', 0, 700]])
    const before = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: '2025-12-01', amount: 700, cashAccountId: b.cash })
    const ib = await entry(b, '2026-01-01', [['1930', 700, 0], ['2099', 0, 700]], { sourceType: 'opening_balance' })
    const after = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: '2026-02-01', amount: 50, cashAccountId: b.cash })

    expect(await findOpeningBalanceFloor(b.client, b.companyId, '1930', '2026-12-31')).toEqual({ date: '2026-01-01', amount: 700, entryIds: [ib] })
    expect(await findOpeningBalanceFloor(b.client, b.companyId, '1930', '2025-12-31')).toBeNull()

    const f = await facts(b, '2025-01-01', '2026-12-31')
    expect(f).toMatchObject({ ib_floor: '2026-01-01', effective_from: '2026-01-01' })

    const status = await getReconciliationStatus(b.client, b.companyId, '2025-01-01', '2026-12-31', '1930', 'SEK', b.cash, true)
    expect(status.bank_transaction_count).toBe(1)

    const list = await listAccountItems(b.client, b.companyId, `bank:${b.cash}`, { windowFrom: '2025-01-01', windowTo: '2026-12-31' })
    const ids = list?.items.map((i) => i.item_id) ?? []
    expect(ids).toContain(after)
    expect(ids).not.toContain(before)
  }, 30000)

  it('a floor before the window is no floor of the window', async () => {
    const b = await books()
    await entry(b, '2026-01-01', [['1930', 700, 0], ['2099', 0, 700]], { sourceType: 'opening_balance' })
    const f = await facts(b, '2026-03-01', '2026-03-31')
    expect(f).toMatchObject({ ib_floor: null, effective_from: '2026-03-01' })
  }, 30000)
})

describe('a linked row counts once, in the window of its verifikat', () => {
  it('a row with a pointer and a later residual link is in April in the status and in the list', async () => {
    const b = await books()
    const main = await entry(b, '2026-03-20', [['1930', 1000, 0], ['3001', 0, 1000]])
    const residual = await entry(b, '2026-04-02', [['1930', 5, 0], ['3740', 0, 5]])
    const tx = await insertTransaction({ companyId: b.companyId, userId: b.userId, date: '2026-03-20', amount: 1000, cashAccountId: b.cash, journalEntryId: main })
    await getPool().query(`UPDATE public.transactions SET is_business = true WHERE id = $1`, [tx])
    await getPool().query(
      `INSERT INTO public.transaction_voucher_links (id, user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
       VALUES ($1, $2, $3, $4, $5, 5, 'other')`,
      [randomUUID(), b.userId, b.companyId, tx, residual],
    )
    const key = `bank:${b.cash}`
    const status = async (from: string, to: string) =>
      (await getReconciliationStatus(b.client, b.companyId, from, to, '1930', 'SEK', b.cash, true)).bank_transaction_count
    const listed = async (from: string, to: string) =>
      (await listAccountItems(b.client, b.companyId, key, { bucket: 'matched', windowFrom: from, windowTo: to }))?.total_count

    expect({ status: await status('2026-03-01', '2026-03-31'), list: await listed('2026-03-01', '2026-03-31') }).toEqual({ status: 0, list: 0 })
    expect({ status: await status('2026-04-01', '2026-04-30'), list: await listed('2026-04-01', '2026-04-30') }).toEqual({ status: 1, list: 1 })
  }, 30000)
})
