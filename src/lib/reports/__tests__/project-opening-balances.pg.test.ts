import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertAuthUser, insertCompany, insertCompanyMember, insertFiscalPeriod, insertPostedJournalEntry } from '@/tests/pg/fixtures'

/**
 * Issue #3313: project opening balances. Migration 20261001213328 redefines
 * compute_prior_opening_balances with p_dimensions and adds
 * compute_object_closing_balances, both on prior_opening_balance_lines.
 *
 * The books: 2025 opens with an IB verifikat split per project (1470: P1
 * 1000, P2 500, untagged 200). During 2025 P1 books 300 more on 1470 (tagged
 * with a kostnadsställe too) and an untagged 100 lands on 1470. 2026 was a
 * continuation import: no IB entry, so its IB is derived from history.
 */
async function seedBooks() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const fy2025 = await insertFiscalPeriod({ userId, companyId, periodStart: '2025-01-01', periodEnd: '2025-12-31', name: '2025' })
  const fy2026 = await insertFiscalPeriod({ userId, companyId, periodStart: '2026-01-01', periodEnd: '2026-12-31', name: '2026' })

  const ibEntryId = await insertPostedJournalEntry({
    userId,
    companyId,
    fiscalPeriodId: fy2025,
    entryDate: '2025-01-01',
    sourceType: 'opening_balance',
    description: 'Ingående balans 2025',
    lines: [
      { accountNumber: '1470', debitAmount: 1000, creditAmount: 0, dimensions: { '6': 'P1' } },
      { accountNumber: '1470', debitAmount: 500, creditAmount: 0, dimensions: { '6': 'P2' } },
      { accountNumber: '1470', debitAmount: 200, creditAmount: 0 },
      { accountNumber: '2081', debitAmount: 0, creditAmount: 1700 },
    ],
  })
  await getPool().query('UPDATE public.fiscal_periods SET opening_balance_entry_id = $1 WHERE id = $2', [ibEntryId, fy2025])

  await insertPostedJournalEntry({
    userId,
    companyId,
    fiscalPeriodId: fy2025,
    entryDate: '2025-05-01',
    lines: [
      { accountNumber: '1470', debitAmount: 300, creditAmount: 0, dimensions: { '1': 'K1', '6': 'P1' } },
      { accountNumber: '4010', debitAmount: 0, creditAmount: 300, dimensions: { '1': 'K1', '6': 'P1' } },
    ],
  })
  await insertPostedJournalEntry({
    userId,
    companyId,
    fiscalPeriodId: fy2025,
    entryDate: '2025-06-01',
    lines: [
      { accountNumber: '1470', debitAmount: 100, creditAmount: 0 },
      { accountNumber: '1930', debitAmount: 0, creditAmount: 100 },
    ],
  })
  return { userId, companyId, fy2025, fy2026 }
}

type Row = { account_number: string; debit: string; credit: string }
const net = (rows: Row[], account: string) => {
  const row = rows.find((r) => r.account_number === account)
  return row ? Number(row.debit) - Number(row.credit) : 0
}

describe('compute_prior_opening_balances (issue #3313)', () => {
  it('has one overload, and the two-argument call still resolves (positional and named)', async () => {
    const { rows } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
        WHERE ns.nspname = 'public' AND p.proname = 'compute_prior_opening_balances'`,
    )
    expect(rows[0].n).toBe(1)

    const { companyId } = await seedBooks()
    const positional = await getPool().query<Row>(
      'SELECT * FROM public.compute_prior_opening_balances($1::uuid, $2::date)',
      [companyId, '2026-01-01'],
    )
    const named = await getPool().query<Row>(
      'SELECT * FROM public.compute_prior_opening_balances(p_company_id => $1::uuid, p_period_start => $2::date)',
      [companyId, '2026-01-01'],
    )
    // Every line of the split IB counts (the old ROW_NUMBER kept one of the
    // three 1470 lines): 1000 + 500 + 200 + 300 + 100.
    expect(net(positional.rows, '1470')).toBe(2100)
    expect(net(positional.rows, '2081')).toBe(-1700)
    expect(net(named.rows, '1470')).toBe(2100)
  })

  it('scopes the derived IB to a project with p_dimensions', async () => {
    const { companyId } = await seedBooks()
    const byFilter = async (filter: Record<string, string>) =>
      (
        await getPool().query<Row>('SELECT * FROM public.compute_prior_opening_balances($1, $2, $3::jsonb)', [
          companyId,
          '2026-01-01',
          JSON.stringify(filter),
        ])
      ).rows

    expect(net(await byFilter({ '6': 'P1' }), '1470')).toBe(1300)
    expect(net(await byFilter({ '6': 'P2' }), '1470')).toBe(500)
    // The RPC is plain containment: a kostnadsställe tag rides along on P1's
    // 2025 line. It is never asked with a key that resets annually, though:
    // getOpeningBalances opens such a filter at 0 on both IB paths before it
    // reaches here (unit-tested in opening-balances.test.ts).
    expect(net(await byFilter({ '1': 'K1' }), '1470')).toBe(300)
    expect(net(await byFilter({ '1': 'K1', '6': 'P1' }), '1470')).toBe(300)
    expect(await byFilter({ '6': 'P9' })).toEqual([])
  })

  it('runs for an authenticated member and honours RLS', async () => {
    const { userId, companyId } = await seedBooks()
    const own = await withUserContext(userId, async (client) =>
      (await client.query<Row>('SELECT * FROM public.compute_prior_opening_balances($1, $2, $3::jsonb)', [
        companyId, '2026-01-01', JSON.stringify({ '6': 'P1' }),
      ])).rows,
    )
    expect(net(own, '1470')).toBe(1300)

    const stranger = await insertAuthUser()
    const foreign = await withUserContext(stranger, async (client) =>
      (await client.query<Row>('SELECT * FROM public.compute_prior_opening_balances($1, $2)', [companyId, '2026-01-01'])).rows,
    )
    expect(foreign).toEqual([])
  })
})

describe('compute_object_closing_balances (issue #3313)', () => {
  type ObjectRow = { account_number: string; dimensions: Record<string, string>; net: number | string }
  const call = async (companyId: string, periodId: string, dimNos: string[]) =>
    (
      await getPool().query<{ result: ObjectRow[] }>(
        'SELECT public.compute_object_closing_balances($1, $2, $3::text[]) AS result',
        [companyId, periodId, dimNos],
      )
    ).rows[0].result

  it('sums the linked IB entry and the year per project, projecting away resetting dimensions', async () => {
    const { companyId, fy2025 } = await seedBooks()
    const rows = await call(companyId, fy2025, ['6'])
    expect(rows.map((r) => ({ ...r, net: Number(r.net) }))).toEqual([
      { account_number: '1470', dimensions: { '6': 'P1' }, net: 1300 },
      { account_number: '1470', dimensions: { '6': 'P2' }, net: 500 },
    ])
  })

  it('reads the prior-history fallback when the year has no IB entry (continuation import)', async () => {
    const { userId, companyId, fy2026 } = await seedBooks()
    await insertPostedJournalEntry({
      userId,
      companyId,
      fiscalPeriodId: fy2026,
      entryDate: '2026-03-01',
      lines: [
        { accountNumber: '1930', debitAmount: 1300, creditAmount: 0 },
        { accountNumber: '1470', debitAmount: 0, creditAmount: 1300, dimensions: { '6': 'P1' } },
      ],
    })
    const rows = await call(companyId, fy2026, ['6'])
    // P1 is settled to zero and drops out; P2 carries its 500.
    expect(rows.map((r) => ({ ...r, net: Number(r.net) }))).toEqual([
      { account_number: '1470', dimensions: { '6': 'P2' }, net: 500 },
    ])
  })

  it('returns [] when no dimension accumulates, and refuses an unknown period', async () => {
    const { companyId, fy2025 } = await seedBooks()
    expect(await call(companyId, fy2025, [])).toEqual([])
    await expect(call(companyId, '00000000-0000-0000-0000-000000000000', ['6'])).rejects.toThrow(/not found/)
  })

  it('is executable by authenticated and service_role only', async () => {
    const { rows } = await getPool().query<{ anon: boolean; auth: boolean; service: boolean }>(
      `SELECT has_function_privilege('anon', 'public.compute_object_closing_balances(uuid, uuid, text[])', 'EXECUTE') AS anon,
              has_function_privilege('authenticated', 'public.compute_object_closing_balances(uuid, uuid, text[])', 'EXECUTE') AS auth,
              has_function_privilege('service_role', 'public.compute_object_closing_balances(uuid, uuid, text[])', 'EXECUTE') AS service`,
    )
    expect(rows[0]).toEqual({ anon: false, auth: true, service: true })
  })
})
