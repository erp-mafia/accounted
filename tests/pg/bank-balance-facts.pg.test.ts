/**
 * pg-real coverage for 20261026235930_bank_balance_facts.sql:
 *
 *   - get_bank_balance_facts sums a cash account's rows through a day, leaves
 *     ignored rows out of the sum and counts them apart, and counts the rows
 *     without a verifikat by lib/transactions/unbooked.ts's definition (not
 *     ignored, not private, anchored nowhere);
 *   - it scopes rows as get_bank_reconciliation_facts does: the account's own
 *     rows in its currency, plus the rows without a cash account on the
 *     primary account only;
 *   - it tells a signed-in user outside the company nothing;
 *   - checkBankBalance over the real books splits the bank's difference from
 *     the balance sheet into its parts to the öre.
 *
 * Reads run on a real supabase-js client over the pool (postgrest-over-pg.ts),
 * signed in as the company's owner, so RLS, the grant and the JSON shape are
 * the production ones.
 */
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { getPool } from './setup'
import { createPgRest } from './postgrest-over-pg'
import { mainTreeScans, nestedPlans } from './nested-plans'
import {
  insertAuthUser,
  insertCashAccount,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
  insertTransaction,
} from './fixtures'
import { checkBankBalance } from '@/lib/reconciliation/bank-balance-check'

/** supabase-js resolves a WebSocket constructor eagerly; nothing here subscribes. */
class UnusedRealtimeTransport {
  constructor() {
    throw new Error('pg-real: realtime is not used')
  }
}

function authenticatedClient(userId: string): SupabaseClient {
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
  const periods: Record<string, string> = {}
  for (const year of ['2025', '2026']) {
    periods[year] = await insertFiscalPeriod({
      userId,
      companyId,
      periodStart: `${year}-01-01`,
      periodEnd: `${year}-12-31`,
      name: year,
    })
  }
  const cash = await insertCashAccount({ companyId, ledgerAccount: '1930', isPrimary: true })
  return { userId, companyId, periods, cash, client: authenticatedClient(userId) }
}

/** A posted verifikat with the given lines, as the fixtures post one (draft, lines, posted). */
async function verifikat(
  b: Books,
  date: string,
  lines: Array<{ account: string; debit?: number; credit?: number }>,
): Promise<string> {
  const id = randomUUID()
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series, entry_date,
          description, source_type, status)
       VALUES ($1, $2, $3, $4, 0, 'A', $5, $6, 'manual', 'draft')`,
      [id, b.userId, b.companyId, b.periods[date.slice(0, 4)], date, `Verifikat ${date}`],
    )
    for (const [i, l] of lines.entries()) {
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount, sort_order)
         VALUES ($1, $2, $3, $4, $5)`,
        [id, l.account, l.debit ?? 0, l.credit ?? 0, i],
      )
    }
    await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
    await client.query('COMMIT')
    return id
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    throw err
  } finally {
    client.release()
  }
}

/** A verifikat that moves 1930 by `amount` (+ in, - out) against 3001. */
function onBank(b: Books, date: string, amount: number) {
  return verifikat(
    b,
    date,
    amount >= 0
      ? [{ account: '1930', debit: amount }, { account: '3001', credit: amount }]
      : [{ account: '1930', credit: -amount }, { account: '3001', debit: -amount }],
  )
}

function bankRow(
  b: Books,
  date: string,
  amount: number,
  options: { entry?: string; ignored?: boolean; cash?: string | null; currency?: string } = {},
) {
  return insertTransaction({
    companyId: b.companyId,
    userId: b.userId,
    date,
    amount,
    currency: options.currency ?? 'SEK',
    journalEntryId: options.entry ?? null,
    cashAccountId: options.cash === undefined ? b.cash : options.cash,
    isIgnored: options.ignored ?? false,
  })
}

async function facts(client: SupabaseClient, b: Books, through: string, includeUnassigned = true) {
  const { data, error } = await client.rpc('get_bank_balance_facts', {
    p_company_id: b.companyId,
    p_cash_account_id: b.cash,
    p_include_unassigned: includeUnassigned,
    p_currency: 'SEK',
    p_through: through,
  })
  if (error) throw new Error(error.message)
  return data as Record<string, unknown>
}

describe('get_bank_balance_facts', () => {
  async function seeded() {
    const b = await books()
    await bankRow(b, '2026-03-01', 1000)
    await bankRow(b, '2026-03-05', -200, { entry: await onBank(b, '2026-03-05', -200) })
    await bankRow(b, '2026-03-07', 50, { ignored: true })
    // Booked through the 1:N door: anchored, though journal_entry_id stays NULL.
    const linked = await bankRow(b, '2026-03-08', -30)
    await getPool().query(
      `INSERT INTO public.transaction_voucher_links
         (id, user_id, company_id, transaction_id, journal_entry_id, allocated_amount, role)
       VALUES ($1, $2, $3, $4, $5, -30, 'bank_line')`,
      [randomUUID(), b.userId, b.companyId, linked, await onBank(b, '2026-03-08', -30)],
    )
    // Marked private: nothing to book in this company.
    const privateRow = await bankRow(b, '2026-03-09', 80)
    await getPool().query('UPDATE public.transactions SET is_business = false WHERE id = $1', [privateRow])
    await bankRow(b, '2026-04-01', 500)
    // No cash account: the primary account's row.
    await bankRow(b, '2026-03-10', 70, { cash: null })
    // Another bank account, another currency: never this account's.
    const other = await insertCashAccount({ companyId: b.companyId, ledgerAccount: '1931' })
    await bankRow(b, '2026-03-02', 999, { cash: other })
    await bankRow(b, '2026-03-03', 5, { currency: 'EUR' })
    return b
  }

  it('reads the open rows once, not once per bank row', async () => {
    // The function body runs on a generic plan. Joined to open_bank_rows, that
    // plan was a nested loop that ran the whole view again for every bank row
    // (seen 2026-11-12: 1 071 rows took 1.5 s, 4 657 rows timed out). The rows
    // being summed must be scanned on their own, with no join above them.
    const b = await seeded()
    const plans = await nestedPlans(b.userId, `SELECT public.get_bank_balance_facts($1, $2, true, 'SEK', '2026-12-31'::date)`, [b.companyId, b.cash])
    const own = plans.filter((p) => p.query.includes('open_rows AS MATERIALIZED'))
    expect(own).toHaveLength(1)
    const scans = mainTreeScans(own[0].plan, 'transactions')
    expect(scans.length).toBeGreaterThan(0)
    expect(scans.filter((scan) => scan.underJoin)).toEqual([])
  })

  it('sums the rows through the day, ignored rows apart, and counts the ones without a verifikat', async () => {
    const b = await seeded()
    expect(await facts(b.client, b, '2026-03-31')).toEqual({
      history_start: '2026-03-01',
      rows_count: 5,
      rows_total: 920,
      unbooked_count: 2,
      unbooked_total: 1070,
      ignored_count: 1,
      ignored_total: 50,
    })
    expect(await facts(b.client, b, '2026-04-30')).toMatchObject({ rows_total: 1420, unbooked_count: 3, unbooked_total: 1570 })
    expect(await facts(b.client, b, '2026-02-28')).toEqual({
      history_start: null,
      rows_count: 0,
      rows_total: 0,
      unbooked_count: 0,
      unbooked_total: 0,
      ignored_count: 0,
      ignored_total: 0,
    })
  })

  it('claims the rows without a cash account only for the primary account', async () => {
    const b = await seeded()
    expect(await facts(b.client, b, '2026-03-31', false)).toMatchObject({
      rows_count: 4,
      rows_total: 850,
      unbooked_count: 1,
      unbooked_total: 1000,
    })
  })

  it('tells a signed-in user outside the company nothing', async () => {
    const b = await seeded()
    const stranger = authenticatedClient(await insertAuthUser())
    expect(await facts(stranger, b, '2026-03-31')).toMatchObject({ history_start: null, rows_count: 0, rows_total: 0 })
  })
})

describe('checkBankBalance over the real books', () => {
  it('splits the difference from the balance sheet into its parts to the öre', async () => {
    const b = await books()
    // The books carry 5 000 into 2026: the derived opening balance.
    await verifikat(b, '2025-12-15', [{ account: '1930', debit: 5000 }, { account: '2081', credit: 5000 }])
    // The bank's rows: a booked deposit, an unbooked payment, and a real
    // deposit the user ignored.
    await bankRow(b, '2026-02-01', 3000, { entry: await onBank(b, '2026-02-01', 3000) })
    await bankRow(b, '2026-02-10', -500)
    await bankRow(b, '2026-02-15', 800, { ignored: true })
    // A verifikat on 1930 with no bank row behind it.
    await onBank(b, '2026-03-01', 200)
    await getPool().query(
      `UPDATE public.cash_accounts SET balance = 9000, balance_updated_at = '2026-03-31T10:00:00Z' WHERE id = $1`,
      [b.cash],
    )
    const { data: account } = await b.client
      .from('cash_accounts')
      .select('id, ledger_account, currency, is_primary, balance, balance_updated_at')
      .eq('id', b.cash)
      .single()

    const result = await checkBankBalance(b.client, b.companyId, account as never)

    expect(result.refusal).toBeNull()
    expect(result.check).toMatchObject({
      as_of: '2026-03-31',
      bank_balance: 9000,
      // 5 000 carried in + 3 000 + 200.
      booked_balance: 8200,
      difference: 800,
      unbooked: { count: 1, total: -500 },
      // The bank held 9 000 - 2 500 = 6 500 before its first row (the ignored
      // 800 counts there), the books 5 000 on the day before.
      before_history: { history_start: '2026-02-01', bank_balance: 6500, booked_balance: 5000, difference: 1500 },
      ignored: { count: 1, total: 800 },
      // The 200 on 1930 that no bank row carries.
      rest: -200,
    })
  })
})
