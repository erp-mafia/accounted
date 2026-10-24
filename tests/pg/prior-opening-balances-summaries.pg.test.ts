import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool } from '@/tests/pg/setup'
import { insertAuthUser, insertDraftJournalEntry, insertFiscalPeriod, seedCompany } from '@/tests/pg/fixtures'

// Migration 20261024110000_prior_opening_balances_ledger_days.sql:
// compute_prior_opening_balances reads ledger_account_days /
// ledger_dimension_days once the company is built, less the lines of the
// reversed, storno and IB entries, and must return exactly what its line path
// (prior_opening_balance_lines) returns:
//
//   1. for every period start and filter, on a ledger with IB verifikat
//      (kept, dropped by earlier activity, superseded by a later one,
//      reversed), stornos before the start and across it, a storno of a
//      storno, tagged lines, a draft and a cancelled entry, an entry dated
//      outside its fiscal year and a zero-amount line
//   2. still after a storno, an inline rättelse and a date change
//   3. the caller's access: a member reads the rows, an outsider none

interface Line {
  account: string
  debit?: number
  credit?: number
  dims?: Record<string, string>
}

interface World {
  userId: string
  companyId: string
  periods: Record<string, string>
}

const ACCOUNTS = ['1229', '1510', '1930', '1940', '2081', '2099', '2440', '3001', '5010']

const STARTS = ['2023-01-01', '2023-06-02', '2023-06-03', '2024-01-01', '2024-02-15', '2024-03-02', '2025-01-01', '2025-05-03', '2026-01-01', '2026-06-01']

const FILTERS: Array<Record<string, string> | null> = [
  null, { '6': 'P1' }, { '6': 'P2' }, { '1': ' KS01 ' }, { '1': 'KS01' }, { '1': 'KS01', '6': 'P1' }, {}, { '6': 'saknas' },
]

async function ensureAccounts(companyId: string, userId: string): Promise<void> {
  for (const account of ACCOUNTS) {
    await getPool().query(
      `INSERT INTO public.chart_of_accounts
         (user_id, company_id, account_number, account_name, account_class, account_type, normal_balance)
       VALUES ($1, $2, $3, 'Konto ' || $3, left($3, 1)::int,
               CASE WHEN $3 < '2000' THEN 'asset' WHEN $3 < '3000' THEN 'liability'
                    WHEN $3 < '4000' THEN 'revenue' ELSE 'expense' END,
               CASE WHEN $3 < '2000' OR $3 >= '4000' THEN 'debit' ELSE 'credit' END)
       ON CONFLICT DO NOTHING`,
      [userId, companyId, account],
    )
  }
}

let voucher = 0

/** A draft with lines, then posted the way the fixtures post (draft -> posted UPDATE). */
async function post(
  w: World,
  params: { date: string; lines: Line[]; period?: string; sourceType?: string; status?: 'posted' | 'draft' | 'cancelled'; reversesId?: string },
): Promise<{ id: string; lineIds: string[] }> {
  voucher += 1
  const id = await insertDraftJournalEntry({
    userId: w.userId,
    companyId: w.companyId,
    fiscalPeriodId: w.periods[params.period ?? params.date.slice(0, 4)],
    entryDate: params.date,
    sourceType: params.sourceType ?? 'manual',
    status: 'draft',
    voucherNumber: voucher,
  })
  if (params.reversesId) {
    await getPool().query(`UPDATE public.journal_entries SET reverses_id = $2 WHERE id = $1`, [id, params.reversesId])
  }
  const lineIds: string[] = []
  for (const [i, line] of params.lines.entries()) {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.journal_entry_lines
         (journal_entry_id, account_number, debit_amount, credit_amount, sort_order, dimensions)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb) RETURNING id`,
      [id, line.account, line.debit ?? 0, line.credit ?? 0, i, JSON.stringify(line.dims ?? {})],
    )
    lineIds.push(rows[0].id)
  }
  const status = params.status ?? 'posted'
  if (status !== 'draft') {
    await getPool().query(`UPDATE public.journal_entries SET status = $2 WHERE id = $1`, [id, status])
  }
  return { id, lineIds }
}

async function storno(w: World, original: { id: string }, lines: Line[], date: string): Promise<{ id: string; lineIds: string[] }> {
  const mirrored = lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit, dims: l.dims }))
  const reversal = await post(w, { date, lines: mirrored, sourceType: 'storno', reversesId: original.id })
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2 WHERE id = $1`,
    [original.id, reversal.id],
  )
  return reversal
}

/**
 * FY2023-FY2026 without any linked IB verifikat (the shape of the large
 * companies on prod), every rule of prior_opening_balance_lines exercised.
 */
async function world(): Promise<World> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const periods: Record<string, string> = { '2026': fiscalPeriodId }
  for (const year of ['2023', '2024', '2025']) {
    periods[year] = await insertFiscalPeriod({ userId, companyId, name: year, periodStart: `${year}-01-01`, periodEnd: `${year}-12-31` })
  }
  await ensureAccounts(companyId, userId)
  const w: World = { userId, companyId, periods }

  // The earliest IB: kept for 1930 and 2081, a project's IB on its own line.
  await post(w, {
    date: '2023-01-01', sourceType: 'opening_balance',
    lines: [{ account: '1930', debit: 1000 }, { account: '1930', debit: 250.5, dims: { '6': 'P1' } }, { account: '2081', credit: 1250.5 }],
  })
  await post(w, {
    date: '2023-03-01',
    lines: [{ account: '1510', debit: 500, dims: { '1': ' KS01 ' } }, { account: '3001', credit: 500, dims: { '1': ' KS01 ' } }],
  })
  // A pair stornoed before every later start.
  const pairLines: Line[] = [{ account: '1930', debit: 200, dims: { '6': 'P1' } }, { account: '2440', credit: 200 }]
  const pair = await post(w, { date: '2023-06-01', lines: pairLines })
  await storno(w, pair, pairLines, '2023-06-02')
  // A later IB verifikat on accounts with an earlier one: never the earliest.
  await post(w, {
    date: '2024-01-01', sourceType: 'opening_balance',
    lines: [{ account: '1930', debit: 1300 }, { account: '2081', credit: 1300 }],
  })
  // 1229 is booked before its first IB, so that IB is dropped; 2099's is kept.
  await post(w, { date: '2024-02-01', lines: [{ account: '1930', debit: 50 }, { account: '1229', credit: 50 }] })
  await post(w, {
    date: '2024-03-01', sourceType: 'opening_balance',
    lines: [{ account: '1229', credit: 999, dims: { '6': 'P2' } }, { account: '2099', debit: 999, dims: { '6': 'P2' } }],
  })
  // An IB verifikat reversed by its storno: neither counts.
  const reversedIbLines: Line[] = [{ account: '1940', debit: 75 }, { account: '2081', credit: 75 }]
  const reversedIb = await post(w, { date: '2024-06-01', sourceType: 'opening_balance', lines: reversedIbLines })
  await storno(w, reversedIb, reversedIbLines, '2024-06-02')
  // A storno of a storno: the original, both stornos left out.
  const twiceLines: Line[] = [{ account: '1510', debit: 40, dims: { '1': 'KS01', '6': 'P1' } }, { account: '3001', credit: 40 }]
  const twice = await post(w, { date: '2025-05-01', lines: twiceLines })
  const firstStorno = await storno(w, twice, twiceLines, '2025-05-02')
  const mirrored: Line[] = twiceLines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit, dims: l.dims }))
  await storno(w, firstStorno, mirrored, '2025-05-03')
  // A pair across the 2026 start: the original reversed before it, its storno after.
  const acrossLines: Line[] = [{ account: '1930', debit: 70, dims: { '6': 'P2' } }, { account: '2440', credit: 70 }]
  const across = await post(w, { date: '2025-12-20', lines: acrossLines })
  await storno(w, across, acrossLines, '2026-01-05')
  // Booked in FY2026 but dated in 2025; a zero-amount line; a draft and a cancelled entry.
  await post(w, { date: '2025-12-31', period: '2026', lines: [{ account: '1510', debit: 30 }, { account: '2440', credit: 30 }] })
  await post(w, { date: '2025-07-01', lines: [{ account: '1940', debit: 0, credit: 0 }, { account: '1930', debit: 10 }, { account: '2081', credit: 10 }] })
  await post(w, { date: '2025-08-01', status: 'draft', lines: [{ account: '1930', debit: 9 }, { account: '2081', credit: 9 }] })
  await post(w, { date: '2025-08-02', status: 'cancelled', lines: [{ account: '1930', debit: 8 }, { account: '2081', credit: 8 }] })
  await post(w, { date: '2026-03-01', lines: [{ account: '5010', debit: 120, dims: { '6': 'P1' } }, { account: '1930', credit: 120, dims: { '6': 'P1' } }] })
  return w
}

/** Runs `fn` as `userId` (authenticated), with the summaries hidden (line path) or not. */
async function asUser<T>(w: World, userId: string, linePath: boolean, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    if (linePath) {
      await client.query(`DELETE FROM public.ledger_account_days_companies WHERE company_id = $1`, [w.companyId])
    }
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: userId, role: 'authenticated' })])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId])
    await client.query('SET LOCAL ROLE authenticated')
    return await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

async function priorIb(client: Pick<PoolClient, 'query'>, w: World, start: string, dims: Record<string, string> | null): Promise<string[]> {
  const { rows } = await client.query<{ row: string }>(
    `SELECT account_number || ' ' || trim_scale(debit)::text || ' ' || trim_scale(credit)::text AS row
     FROM public.compute_prior_opening_balances($1, $2::date, $3::jsonb)
     ORDER BY account_number`,
    [w.companyId, start, dims === null ? null : JSON.stringify(dims)],
  )
  return rows.map((r) => r.row)
}

/** Every start and filter, on both paths, as the company's owner. */
async function bothPaths(w: World): Promise<{ summary: Record<string, string[]>; lines: Record<string, string[]> }> {
  const read = (linePath: boolean) =>
    asUser(w, w.userId, linePath, async (client) => {
      const out: Record<string, string[]> = {}
      for (const start of STARTS) {
        for (const dims of FILTERS) {
          out[`${start} ${JSON.stringify(dims)}`] = await priorIb(client, w, start, dims)
        }
      }
      return out
    })
  return { summary: await read(false), lines: await read(true) }
}

describe('compute_prior_opening_balances on the summaries', () => {
  it('returns exactly the line path for every start and filter', async () => {
    const w = await world()
    const { rows: ready } = await getPool().query(`SELECT public.ledger_account_days_ready($1) AS r`, [w.companyId])
    expect(ready[0].r).toBe(true)

    const { summary, lines } = await bothPaths(w)
    expect(summary).toEqual(lines)

    // The fixture means what it says: 1229's IB is dropped (booked before
    // it), 2099's kept, the later 1930 IB and the reversed 1940 IB ignored.
    expect(summary['2025-01-01 null']).toEqual([
      '1229 0 50', '1510 500 0', '1930 1300.5 0', '2081 0 1250.5', '2099 999 0',
    ])
    // Across the start: the original is reversed, so it is left out.
    expect(summary['2026-01-01 {"6":"P2"}']).toEqual(['2099 999 0'])
    expect(summary['2026-01-01 {"6":"P1"}']).toEqual(['1930 250.5 0'])
  })

  it('stays exact after a storno, an inline rättelse and a date change', async () => {
    const w = await world()
    const lines: Line[] = [{ account: '1930', debit: 333, dims: { '6': 'P1' } }, { account: '2440', credit: 333 }]
    const entry = await post(w, { date: '2025-09-01', lines })
    await storno(w, entry, lines, '2025-09-02')

    const target = await post(w, { date: '2025-10-01', lines: [{ account: '1510', debit: 1000 }, { account: '2440', credit: 1000 }] })
    await getPool().query(
      `SELECT public.correct_entry_lines_inline($1::uuid, $2::uuid, $3::uuid[], $4::jsonb, $5::uuid)`,
      [w.companyId, target.id, [target.lineIds[0]],
        JSON.stringify([{ account_number: '1930', debit_amount: 1000, credit_amount: 0, line_description: 'Omföring' }]),
        w.userId],
    )
    await getPool().query(
      `SELECT public.correct_entry_metadata($1::uuid, $2::uuid, NULL, '2025-11-15'::date, $3::uuid)`,
      [w.companyId, target.id, w.userId],
    )
    const { rows: drift } = await getPool().query(`SELECT * FROM public.ledger_account_days_drift($1)`, [w.companyId])
    expect(drift).toEqual([])

    const { summary, lines: linePath } = await bothPaths(w)
    expect(summary).toEqual(linePath)
  })

  it('reads the summaries once the company is built', async () => {
    const w = await world()
    const client = await getPool().connect()
    try {
      await client.query('BEGIN')
      // A summary row nudged by one krona shows on the summary path only.
      await client.query(
        `UPDATE public.ledger_account_days SET debit = debit + 1
         WHERE ctid = (SELECT ctid FROM public.ledger_account_days
                       WHERE company_id = $1 AND account_number = '1510' AND entry_date = '2023-03-01' LIMIT 1)`,
        [w.companyId],
      )
      expect(await priorIb(client, w, '2025-01-01', null)).toContain('1510 501 0')
      await client.query(`DELETE FROM public.ledger_account_days_companies WHERE company_id = $1`, [w.companyId])
      expect(await priorIb(client, w, '2025-01-01', null)).toContain('1510 500 0')
    } finally {
      await client.query('ROLLBACK').catch(() => {})
      client.release()
    }
  })

  it('reads the rows for a member and none for an outsider', async () => {
    const w = await world()
    const member = await asUser(w, w.userId, false, (c) => priorIb(c, w, '2026-01-01', null))
    expect(member.length).toBeGreaterThan(0)

    const outsider = await insertAuthUser()
    expect(await asUser(w, outsider, false, (c) => priorIb(c, w, '2026-01-01', null))).toEqual([])
    expect(await asUser(w, outsider, true, (c) => priorIb(c, w, '2026-01-01', null))).toEqual([])

    // Without API claims (the service role, other functions) nothing is checked.
    expect(await priorIb(getPool(), w, '2026-01-01', null)).toEqual(member)
  })
})
