import { randomUUID } from 'node:crypto'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertDraftJournalEntry, insertFiscalPeriod, seedCompany } from '@/tests/pg/fixtures'

// Migration 20261023093900_ledger_account_days.sql: ledger_account_days and
// ledger_dimension_days hold the posted ledger's sums per account and day
// (and per dimension value), ledger_account_entries locates each account's
// verifikat, all kept in step by triggers, and the report RPCs read them once
// a company is built. Migration 20261023093940_ledger_report_pages.sql pages
// the huvudbok and the grundbok on top of them.
//
//   1. every write path leaves all three equal to the journal
//      (ledger_account_days_drift is empty): posting, storno, inline
//      rättelse, a date change, a dimension retag, delete_last_voucher
//   2. a new company starts built; an existing one is built from its journal
//   3. every reader returns exactly what its line-level path returns:
//      get_trial_balance_aggregates (every closing mode, sub-ranges, the IB
//      exclusion, one and two dimension values), get_kpi_report_aggregates,
//      get_dimension_pnl_buckets, and latest_posted_vouchers against a plain
//      aggregate
//   4. the huvudbok pages, read to the end, are the account's lines in report
//      order with the right movement before each page, on both paths; the
//      line counts and the line export match the lines; the grundbok pages
//      are the verifikat in registration order
//   5. API roles can read their own company's rows and write none

type Q = Pick<PoolClient, 'query'>

interface Line {
  account: string
  debit?: number
  credit?: number
  dims?: Record<string, string>
}

async function ensureAccounts(companyId: string, userId: string, accounts: string[]): Promise<void> {
  for (const account of accounts) {
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

/** A draft with lines, then posted the way the fixtures post (draft -> posted UPDATE). */
async function post(
  w: World,
  params: {
    date: string
    lines: Line[]
    sourceType?: string
    voucher: number
    /** null: no series at all (legacy rows); the reports read it as A. */
    series?: string | null
    periodId?: string
    reversesId?: string
    correctionOfId?: string
  },
): Promise<{ id: string; lineIds: string[] }> {
  const id = await insertDraftJournalEntry({
    userId: w.userId,
    companyId: w.companyId,
    fiscalPeriodId: params.periodId ?? w.periodId,
    entryDate: params.date,
    sourceType: params.sourceType ?? 'manual',
    status: 'draft',
    voucherNumber: params.voucher,
    voucherSeries: params.series ?? undefined,
  })
  if (params.series === null) {
    await getPool().query(`UPDATE public.journal_entries SET voucher_series = NULL WHERE id = $1`, [id])
  }
  if (params.reversesId || params.correctionOfId) {
    await getPool().query(
      `UPDATE public.journal_entries SET reverses_id = $2, correction_of_id = $3 WHERE id = $1`,
      [id, params.reversesId ?? null, params.correctionOfId ?? null],
    )
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
  await getPool().query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
  return { id, lineIds }
}

async function storno(w: World, original: { id: string }, lines: Line[], date: string, voucher: number, periodId?: string): Promise<string> {
  const mirrored = lines.map((l) => ({ account: l.account, debit: l.credit, credit: l.debit, dims: l.dims }))
  const { id } = await post(w, { date, lines: mirrored, sourceType: 'storno', voucher, periodId, reversesId: original.id })
  await getPool().query(
    `UPDATE public.journal_entries SET status = 'reversed', reversed_by_id = $2 WHERE id = $1`,
    [original.id, id],
  )
  return id
}

/** The registry rows a retag requires (retag_line_dimensions checks them). */
async function registerDimensionValues(companyId: string, values: Array<[number, string]>): Promise<void> {
  for (const [sieDimNo, code] of values) {
    const { rows } = await getPool().query<{ id: string }>(
      `INSERT INTO public.dimensions (company_id, sie_dim_no, name, resets_annually, is_system, is_active)
       VALUES ($1, $2::int, 'Dim ' || $2::text, true, false, true)
       ON CONFLICT (company_id, sie_dim_no) DO UPDATE SET is_active = true
       RETURNING id`,
      [companyId, sieDimNo],
    )
    await getPool().query(
      `INSERT INTO public.dimension_values (company_id, dimension_id, code, name, is_active)
       VALUES ($1, $2, $3, $3, true)
       ON CONFLICT (company_id, dimension_id, code) DO UPDATE SET is_active = true`,
      [companyId, rows[0].id, code],
    )
  }
}

async function drift(companyId: string, client: Q = getPool()): Promise<unknown[]> {
  const { rows } = await client.query(`SELECT * FROM public.ledger_account_days_drift($1)`, [companyId])
  return rows
}

interface World {
  userId: string
  companyId: string
  periodId: string
  priorPeriodId: string
  ibId: string
}

const ACCOUNTS = ['1229', '1510', '1930', '2081', '2099', '2611', '3001', '5010', '5420', '7832', '8310', '8410', '8990']

/**
 * One aktiebolag, FY2026 with an IB verifikat, sales and costs tagged on two
 * dimensions, class 8 lines on both sides, a year_end depreciation retagged
 * to KS01, a resultatavslut-shaped manual entry on the last day, and the
 * storno of last year's reversed year_end entry.
 */
async function world(): Promise<World> {
  const { userId, companyId, fiscalPeriodId } = await seedCompany()
  const priorPeriodId = await insertFiscalPeriod({
    userId, companyId, name: '2025', periodStart: '2025-01-01', periodEnd: '2025-12-31',
  })
  await ensureAccounts(companyId, userId, ACCOUNTS)
  const w: World = { userId, companyId, periodId: fiscalPeriodId, priorPeriodId, ibId: '' }

  const ib = await post(w, {
    date: '2026-01-01', sourceType: 'opening_balance', voucher: 1,
    lines: [{ account: '1930', debit: 5000 }, { account: '2081', credit: 5000 }],
  })
  w.ibId = ib.id
  await getPool().query(`UPDATE public.fiscal_periods SET opening_balance_entry_id = $2 WHERE id = $1`, [w.periodId, ib.id])

  await post(w, {
    date: '2026-03-10', voucher: 2,
    lines: [
      { account: '1510', debit: 1250 },
      { account: '3001', credit: 1000.5, dims: { '1': 'KS01' } },
      { account: '3001', debit: 0.5, dims: { '1': ' KS01 ' } },
      { account: '2611', credit: 250 },
    ],
  })
  await post(w, {
    date: '2026-04-02', voucher: 3,
    lines: [{ account: '5010', debit: 800, dims: { '1': 'KS02', '6': 'P1' } }, { account: '1930', credit: 800 }],
  })
  await post(w, {
    date: '2026-05-05', voucher: 4,
    lines: [
      { account: '8410', debit: 100 }, { account: '1930', credit: 100 },
      { account: '1930', debit: 30 }, { account: '8310', credit: 30 },
    ],
  })
  await post(w, {
    date: '2026-12-31', sourceType: 'year_end', voucher: 5,
    lines: [{ account: '7832', debit: 500, dims: { '1': 'KS01' } }, { account: '1229', credit: 500 }],
  })
  // Resultatavslut by shape: last day, only result accounts against 2099.
  await post(w, {
    date: '2026-12-31', voucher: 6,
    lines: [{ account: '3001', debit: 1000 }, { account: '2099', credit: 1000 }],
  })
  // An omföring through 8990 (Resultat), as some earlier systems book it:
  // årets resultat, left out of the KPI monthly buckets (20261023081500).
  await post(w, {
    date: '2026-11-30', voucher: 1, series: 'C',
    lines: [{ account: '8990', debit: 40 }, { account: '2099', credit: 40 }],
  })
  // Last year's year_end entry, reversed by a storno booked this year.
  const ye2025Lines: Line[] = [{ account: '7832', debit: 200, dims: { '1': 'KS01' } }, { account: '1229', credit: 200 }]
  const ye2025 = await post(w, { date: '2025-12-31', sourceType: 'year_end', voucher: 1, periodId: priorPeriodId, lines: ye2025Lines })
  await storno(w, ye2025, ye2025Lines, '2026-01-15', 7)
  return w
}

/** Run `fn` as the company's owner, with the summary hidden (raw path) or not. */
async function asOwner<T>(w: World, raw: boolean, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    if (raw) {
      await client.query(`DELETE FROM public.ledger_account_days_companies WHERE company_id = $1`, [w.companyId])
    }
    await client.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ sub: w.userId, role: 'authenticated' })])
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [w.userId])
    await client.query('SET LOCAL ROLE authenticated')
    return await fn(client)
  } finally {
    await client.query('ROLLBACK').catch(() => {})
    client.release()
  }
}

async function readerOutputs(w: World, client: Q): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {}
  const modes = ['include', 'exclude-final', 'exclude-all-year-end']
  const ranges: Array<[string | null, string | null]> = [
    [null, null], ['2026-03-01', '2026-06-30'], ['2026-01-01', '2026-03-31'], ['2026-12-31', '2026-12-31'],
  ]
  const filters = [null, { '1': 'KS01' }, { '1': ' KS01 ' }, { '6': 'P1' }, { '1': 'KS02', '6': 'P1' }, {}]
  for (const period of [w.periodId, w.priorPeriodId]) {
    for (const mode of modes) {
      for (const [from, to] of ranges) {
        for (const ob of [null, w.ibId]) {
          for (const dims of filters) {
            const key = `tb ${period} ${mode} ${from}-${to} ob=${ob} dims=${JSON.stringify(dims)}`
            const { rows } = await client.query(
              `SELECT public.get_trial_balance_aggregates($1, $2, $3, $4::date, $5::date, $6::uuid, $7::jsonb) AS r`,
              [w.companyId, period, mode, from, to, ob, dims === null ? null : JSON.stringify(dims)],
            )
            out[key] = rows[0].r
          }
        }
      }
    }
    for (const ob of [null, w.ibId]) {
      const { rows } = await client.query(`SELECT public.get_kpi_report_aggregates($1, $2, $3::uuid) AS r`, [w.companyId, period, ob])
      out[`kpi ${period} ob=${ob}`] = rows[0].r
    }
    for (const dim of ['1', '6', '9']) {
      for (const [from, to] of ranges) {
        const { rows } = await client.query(
          `SELECT public.get_dimension_pnl_buckets($1, $2, $3, $4::date, $5::date) AS r`,
          [w.companyId, period, dim, from, to],
        )
        out[`dimpnl ${period} ${dim} ${from}-${to}`] = rows[0].r
      }
    }
  }
  return out
}

describe('ledger_account_days: kept equal to the journal', () => {
  it('a new company starts built, and the fixture ledger has no drift', async () => {
    const w = await world()
    const { rows } = await getPool().query(`SELECT 1 FROM public.ledger_account_days_companies WHERE company_id = $1`, [w.companyId])
    expect(rows).toHaveLength(1)
    expect(await drift(w.companyId)).toEqual([])
    const { rows: dims } = await getPool().query<{ n: string }>(
      `SELECT count(*)::text AS n FROM public.ledger_dimension_days WHERE company_id = $1 AND line_count > 0`,
      [w.companyId],
    )
    expect(Number(dims[0].n)).toBeGreaterThan(0)
  })

  it('stays equal through storno, inline rättelse, a date change and a dimension retag', async () => {
    const w = await world()
    const lines: Line[] = [{ account: '5010', debit: 300, dims: { '1': 'KS02' } }, { account: '1930', credit: 300 }]
    const entry = await post(w, { date: '2026-06-01', voucher: 8, lines })
    expect(await drift(w.companyId)).toEqual([])

    await storno(w, entry, lines, '2026-06-03', 9)
    expect(await drift(w.companyId)).toEqual([])

    const target = await post(w, {
      date: '2026-07-01', voucher: 10,
      lines: [{ account: '5010', debit: 1000, dims: { '6': 'P1' } }, { account: '1930', credit: 1000 }],
    })
    await getPool().query(
      `SELECT public.correct_entry_lines_inline($1::uuid, $2::uuid, $3::uuid[], $4::jsonb, $5::uuid)`,
      [w.companyId, target.id, [target.lineIds[0]],
        JSON.stringify([{ account_number: '5420', debit_amount: 1000, credit_amount: 0, line_description: 'Programvara' }]),
        w.userId],
    )
    expect(await drift(w.companyId)).toEqual([])

    await getPool().query(
      `SELECT public.correct_entry_metadata($1::uuid, $2::uuid, NULL, '2026-07-20'::date, $3::uuid)`,
      [w.companyId, target.id, w.userId],
    )
    expect(await drift(w.companyId)).toEqual([])

    const { rows: line } = await getPool().query<{ id: string }>(
      `SELECT id FROM public.journal_entry_lines WHERE journal_entry_id = $1 AND account_number = '5420'`,
      [target.id],
    )
    await registerDimensionValues(w.companyId, [[1, 'KS01']])
    await getPool().query(
      `SELECT public.retag_line_dimensions($1::uuid, $2::uuid, $3::jsonb, 'Fel projekt', $4::uuid)`,
      [w.companyId, line[0].id, JSON.stringify({ '1': 'KS01' }), w.userId],
    )
    expect(await drift(w.companyId)).toEqual([])
  })

  it('stays equal when the last verifikat is deleted', async () => {
    const w = await world()
    const last = await post(w, {
      date: '2026-09-01', voucher: 8,
      lines: [{ account: '5010', debit: 400, dims: { '1': 'KS01' } }, { account: '1930', credit: 400 }],
    })
    await getPool().query(
      `INSERT INTO public.voucher_sequences (user_id, company_id, fiscal_period_id, voucher_series, last_number)
       VALUES ($1, $2, $3, 'A', 8)
       ON CONFLICT (company_id, fiscal_period_id, voucher_series) DO UPDATE SET last_number = 8`,
      [w.userId, w.companyId, w.periodId],
    )
    await withUserContext(w.userId, async (client) => {
      const { rows } = await client.query<{ r: { deleted: boolean } }>(`SELECT public.delete_last_voucher($1, $2) AS r`, [w.companyId, last.id])
      expect(rows[0].r.deleted).toBe(true)
      await client.query('RESET ROLE')
      expect(await drift(w.companyId, client)).toEqual([])
    })
  })

  it('builds an existing company from its journal, and a rebuild changes nothing', async () => {
    const w = await world()
    await getPool().query(`DELETE FROM public.ledger_account_days_companies WHERE company_id = $1`, [w.companyId])
    await getPool().query(`DELETE FROM public.ledger_account_days WHERE company_id = $1`, [w.companyId])
    await getPool().query(`DELETE FROM public.ledger_dimension_days WHERE company_id = $1`, [w.companyId])
    await getPool().query(`DELETE FROM public.ledger_account_entries WHERE company_id = $1`, [w.companyId])
    expect((await drift(w.companyId)).length).toBeGreaterThan(0)
    // Pending, with its size, so the cron can leave a large company for the night.
    const { rows: pending } = await getPool().query<{ company_id: string; entry_count: string }>(
      `SELECT company_id, entry_count::text FROM public.ledger_account_days_pending(100000)`,
    )
    expect(pending.find((p) => p.company_id === w.companyId)?.entry_count).toBe('9')
    const counts = pending.map((p) => Number(p.entry_count))
    expect(counts).toEqual([...counts].sort((a, b) => a - b))

    await getPool().query(`SELECT public.build_ledger_account_days($1)`, [w.companyId])
    expect(await drift(w.companyId)).toEqual([])
    const { rows } = await getPool().query(`SELECT 1 FROM public.ledger_account_days_companies WHERE company_id = $1`, [w.companyId])
    expect(rows).toHaveLength(1)

    await getPool().query(`SELECT public.build_ledger_account_days($1)`, [w.companyId])
    expect(await drift(w.companyId)).toEqual([])
  })
})

describe('ledger_account_entries: one row per verifikat and account', () => {
  it('counts each verifikat\'s lines per account, and drift sees a missing or extra row', async () => {
    const w = await world()
    const entry = await post(w, {
      date: '2026-06-01', voucher: 8,
      lines: [{ account: '5010', debit: 300 }, { account: '5010', debit: 200 }, { account: '1930', credit: 500 }],
    })
    const { rows } = await getPool().query<{ account_number: string; line_count: number; voucher_number: number }>(
      `SELECT account_number, line_count, voucher_number FROM public.ledger_account_entries
        WHERE journal_entry_id = $1 ORDER BY account_number`,
      [entry.id],
    )
    expect(rows).toEqual([
      { account_number: '1930', line_count: 1, voucher_number: 8 },
      { account_number: '5010', line_count: 2, voucher_number: 8 },
    ])

    await getPool().query(`DELETE FROM public.ledger_account_entries WHERE journal_entry_id = $1 AND account_number = '1930'`, [entry.id])
    expect(await drift(w.companyId)).toEqual([
      expect.objectContaining({ journal_entry_id: entry.id, account_number: '1930', stored_line_count: null, journal_line_count: 1 }),
    ])

    await getPool().query(`SELECT public.build_ledger_account_days($1)`, [w.companyId])
    expect(await drift(w.companyId)).toEqual([])
  })
})

describe('ledger_account_days: writers never queue on each other', () => {
  it('posts two verifikat on the same account and day in two open transactions without waiting', async () => {
    const w = await world()
    const a = await getPool().connect()
    const b = await getPool().connect()
    const ids: string[] = []
    try {
      for (const [client, voucher] of [[a, 20], [b, 21]] as const) {
        await client.query('BEGIN')
        await client.query("SET LOCAL lock_timeout = '500ms'")
        const id = randomUUID()
        ids.push(id)
        await client.query(
          `INSERT INTO public.journal_entries (id, company_id, user_id, fiscal_period_id, voucher_series, voucher_number,
             source_type, entry_date, description, status)
           VALUES ($1, $2, $3, $4, 'A', $5, 'manual', '2026-08-01', 'Samma dag', 'draft')`,
          [id, w.companyId, w.userId, w.periodId, voucher],
        )
        await client.query(
          `INSERT INTO public.journal_entry_lines (journal_entry_id, account_number, debit_amount, credit_amount)
           VALUES ($1, '5010', 100, 0), ($1, '1930', 0, 100)`,
          [id],
        )
        await client.query(`UPDATE public.journal_entries SET status = 'posted' WHERE id = $1`, [id])
      }
      await a.query('COMMIT')
      await b.query('COMMIT')
    } finally {
      await a.query('ROLLBACK').catch(() => {})
      await b.query('ROLLBACK').catch(() => {})
      a.release()
      b.release()
    }
    expect(await drift(w.companyId)).toEqual([])
    const { rows } = await getPool().query<{ slots: string }>(
      `SELECT count(DISTINCT slot)::text AS slots FROM public.ledger_account_days
        WHERE company_id = $1 AND account_number = '5010' AND entry_date = '2026-08-01'`,
      [w.companyId],
    )
    expect(Number(rows[0].slots)).toBe(2)
  })

  it('compaction folds the slots into one row per key without changing a sum', async () => {
    const w = await world()
    const before = await asOwner(w, false, (c) => readerOutputs(w, c))
    await getPool().query(`SELECT public.compact_ledger_account_days($1)`, [w.companyId])
    const { rows } = await getPool().query<{ n: string }>(
      `SELECT (SELECT count(*) FROM public.ledger_account_days WHERE company_id = $1 AND slot <> 0)
            + (SELECT count(*) FROM public.ledger_dimension_days WHERE company_id = $1 AND slot <> 0) AS n`,
      [w.companyId],
    )
    expect(Number(rows[0].n)).toBe(0)
    expect(await drift(w.companyId)).toEqual([])
    expect(await asOwner(w, false, (c) => readerOutputs(w, c))).toEqual(before)
  })
})

describe('ledger_account_days: readers equal their line-level paths', () => {
  it('trial balance, KPI and dimension P&L read the same numbers from the summaries as from the lines', async () => {
    const w = await world()
    const summary = await asOwner(w, false, (c) => readerOutputs(w, c))
    const raw = await asOwner(w, true, (c) => readerOutputs(w, c))
    expect(Object.keys(summary).length).toBe(316)
    expect(summary).toEqual(raw)
    // The fixture is not trivially empty: the year has activity on every path.
    const fullYear = summary[`tb ${w.periodId} exclude-all-year-end null-null ob=${w.ibId} dims=null`] as unknown[]
    expect(fullYear.length).toBeGreaterThan(5)
    expect(summary[`dimpnl ${w.periodId} 1 null-null`]).not.toEqual([])
  })

  it('latest_posted_vouchers is the max per series of the posted window', async () => {
    const w = await world()
    await post(w, { date: '2026-02-01', voucher: 40, series: 'B', lines: [{ account: '5010', debit: 1 }, { account: '1930', credit: 1 }] })
    await asOwner(w, false, async (c) => {
      for (const [from, to] of [[null, '2026-12-31'], ['2026-03-01', '2026-06-30'], [null, '2026-01-31'], ['2026-11-01', '2026-11-30']]) {
        const { rows: fn } = await c.query(
          `SELECT voucher_series, last_number FROM public.latest_posted_vouchers($1, $2, $3::date, $4::date) ORDER BY 1`,
          [w.companyId, w.periodId, from, to],
        )
        const { rows: agg } = await c.query(
          `SELECT coalesce(nullif(voucher_series, ''), 'A') AS voucher_series, max(voucher_number) AS last_number
             FROM public.journal_entries
            WHERE company_id = $1 AND fiscal_period_id = $2 AND status IN ('posted', 'reversed')
              AND voucher_number > 0 AND entry_date <= $4::date AND ($3::date IS NULL OR entry_date >= $3::date)
            GROUP BY 1 ORDER BY 1`,
          [w.companyId, w.periodId, from, to],
        )
        expect(fn).toEqual(agg)
      }
    })
  })
})

/** world() plus what paging has to get right: two series sharing a number on one day, a busy stretch, tags, no series. */
async function pagesWorld(): Promise<World> {
  const w = await world()
  // Same day, same number, two series: their 1930 lines interleave by line id.
  for (const series of ['A', 'B']) {
    await post(w, {
      date: '2026-08-10', voucher: 20, series,
      lines: [
        { account: '1930', debit: 10 }, { account: '1930', debit: 20, dims: { '1': 'KS01' } },
        { account: '1930', credit: 5 }, { account: '3001', credit: 25 },
      ],
    })
  }
  for (let i = 0; i < 24; i++) {
    await post(w, {
      date: `2026-08-${String(11 + Math.floor(i / 3)).padStart(2, '0')}`, voucher: 30 + i,
      lines: [
        { account: '1930', debit: 100 + i, dims: i % 4 === 0 ? { '1': 'KS01' } : undefined },
        { account: '3001', credit: 100 + i, dims: i % 2 === 0 ? { '1': 'KS01' } : undefined },
      ],
    })
  }
  await post(w, {
    date: '2026-09-01', voucher: 60, series: null,
    lines: [{ account: '1930', debit: 7 }, { account: '3001', credit: 7 }],
  })
  return w
}

interface PageLine {
  line_id: string
  entry_date: string
  voucher_number: number
  debit_amount: number
  credit_amount: number
}

interface Page {
  before_debit: number
  before_credit: number
  lines: PageLine[]
}

const PAGE_WINDOWS: Array<[string | null, string | null]> = [[null, null], ['2026-03-01', '2026-08-12'], ['2026-08-10', '2026-08-10']]
const PAGE_FILTERS = [null, {}, { '1': 'KS01' }, { '1': ' KS01 ' }, { '6': 'P1' }, { '1': 'KS02', '6': 'P1' }]

/** The account's window lines in report order, straight from the journal. */
async function referenceLines(
  c: Q, w: World, account: string, from: string | null, to: string | null, exclude: string | null, dims: object | null,
): Promise<PageLine[]> {
  const { rows } = await c.query(
    `SELECT coalesce(jsonb_agg(jsonb_build_object(
              'line_id', l.id, 'account_number', l.account_number, 'debit_amount', l.debit_amount,
              'credit_amount', l.credit_amount, 'dimensions', l.dimensions, 'journal_entry_id', e.id,
              'entry_date', e.entry_date, 'voucher_series', e.voucher_series, 'voucher_number', e.voucher_number,
              'description', e.description, 'source_type', e.source_type)
            ORDER BY e.entry_date, e.voucher_number, l.id), '[]'::jsonb) AS r
       FROM public.journal_entries e
       JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
      WHERE e.company_id = $1 AND e.fiscal_period_id = $2 AND e.status IN ('posted', 'reversed')
        AND l.account_number = $3
        AND ($4::date IS NULL OR e.entry_date >= $4::date) AND ($5::date IS NULL OR e.entry_date <= $5::date)
        AND ($6::uuid IS NULL OR e.id <> $6::uuid)
        AND ($7::jsonb IS NULL OR l.dimensions @> $7::jsonb)`,
    [w.companyId, w.periodId, account, from, to, exclude, dims === null ? null : JSON.stringify(dims)],
  )
  return rows[0].r
}

/** Whether `a` comes after `b` in report order (date, voucher number, line id). */
function linesAfter(a: PageLine, b: PageLine): boolean {
  if (a.entry_date !== b.entry_date) return a.entry_date > b.entry_date
  if (a.voucher_number !== b.voucher_number) return a.voucher_number > b.voucher_number
  return a.line_id > b.line_id
}

/** Every page of one account, each from the last line of the one before. */
async function readPages(
  c: Q, w: World, account: string, from: string | null, to: string | null, exclude: string | null, dims: object | null, limit: number,
): Promise<Page[]> {
  const pages: Page[] = []
  let cursor: [string | null, number | null, string | null] = [null, null, null]
  for (let guard = 0; guard < 100; guard++) {
    const { rows } = await c.query(
      `SELECT public.get_general_ledger_account_page($1, $2, $3, $4::date, $5::date, $6::uuid, $7::jsonb,
                $8::date, $9::integer, $10::uuid, $11::integer) AS r`,
      [w.companyId, w.periodId, account, from, to, exclude, dims === null ? null : JSON.stringify(dims), ...cursor, limit],
    )
    const page = rows[0].r as Page
    pages.push(page)
    if (page.lines.length < limit) return pages
    const last = page.lines[page.lines.length - 1]
    cursor = [last.entry_date, last.voucher_number, last.line_id]
  }
  throw new Error('the pages never ended')
}

describe('huvudbok and grundbok pages', () => {
  it('pages through each account to the end in report order, with the movement before each page, on both paths', async () => {
    const w = await pagesWorld()
    const cases: Array<[string, string | null, string | null, string | null, object | null, number]> = []
    for (const account of ['1930', '3001', '5010', '9999']) {
      for (const [from, to] of PAGE_WINDOWS) {
        for (const exclude of [null, w.ibId]) {
          for (const dims of PAGE_FILTERS) {
            for (const limit of [1, 4, 500]) cases.push([account, from, to, exclude, dims, limit])
          }
        }
      }
    }
    for (const raw of [false, true]) {
      await asOwner(w, raw, async (c) => {
        for (const [account, from, to, exclude, dims, limit] of cases) {
          const label = `${raw ? 'raw' : 'summary'} ${account} ${from}-${to} ex=${exclude} dims=${JSON.stringify(dims)} limit=${limit}`
          const reference = await referenceLines(c, w, account, from, to, exclude, dims)
          const pages = await readPages(c, w, account, from, to, exclude, dims, limit)
          expect(pages.flatMap((p) => p.lines), label).toEqual(reference)
          // Before a page: every period line before its first line, the
          // window's start included (up to the cursor, or before `from`).
          const period = await referenceLines(c, w, account, null, null, exclude, dims)
          for (const [k, page] of pages.entries()) {
            const cursor = k === 0 ? null : pages[k - 1].lines[pages[k - 1].lines.length - 1]
            const before = period.filter((l) => (cursor ? !linesAfter(l, cursor) : from !== null && l.entry_date < from))
            expect(page.before_debit, label).toBeCloseTo(before.reduce((sum, l) => sum + l.debit_amount, 0), 2)
            expect(page.before_credit, label).toBeCloseTo(before.reduce((sum, l) => sum + l.credit_amount, 0), 2)
          }
        }
      })
    }
    // Not vacuous: the busy account spans many pages, through both series on 2026-08-10.
    const busy = await asOwner(w, false, (c) => readPages(c, w, '1930', null, null, w.ibId, null, 4))
    expect(busy.length).toBeGreaterThan(8)
  }, 120_000)

  it('line counts and the line export equal their line-level paths', async () => {
    const w = await pagesWorld()
    const read = (c: Q) => async () => {
      const out: Record<string, unknown> = {}
      for (const [from, to] of PAGE_WINDOWS) {
        for (const exclude of [null, w.ibId]) {
          for (const dims of PAGE_FILTERS) {
            const d = dims === null ? null : JSON.stringify(dims)
            const { rows: counts } = await c.query(
              `SELECT public.get_ledger_line_counts($1, $2, $3::date, $4::date, $5::uuid, $6::jsonb) AS r`,
              [w.companyId, w.periodId, from, to, exclude, d],
            )
            out[`counts ${from}-${to} ${exclude} ${d}`] = counts[0].r
            for (const [accountFrom, accountTo] of [[null, null], ['1930', '1930'], ['1500', '3001'], ['3001', null], [null, '1930']]) {
              const { rows: lines } = await c.query(
                `SELECT public.get_general_ledger_lines($1, $2, $3, $4, $5::date, $6::date, $7::uuid, $8::jsonb) AS r`,
                [w.companyId, w.periodId, accountFrom, accountTo, from, to, exclude, d],
              )
              out[`lines ${accountFrom}-${accountTo} ${from}-${to} ${exclude} ${d}`] = lines[0].r
            }
          }
        }
      }
      return out
    }
    const summary = await asOwner(w, false, (c) => read(c)())
    const raw = await asOwner(w, true, (c) => read(c)())
    expect(summary).toEqual(raw)
    expect(summary[`lines 1930-1930 null-null null null`]).toHaveLength(
      (await asOwner(w, false, (c) => referenceLines(c, w, '1930', null, null, null, null))).length,
    )
  })

  it('pages the grundbok in registration order, a missing series read as A', async () => {
    const w = await pagesWorld()
    await asOwner(w, false, async (c) => {
      const { rows: ref } = await c.query(
        `SELECT coalesce(jsonb_agg(jsonb_build_object('id', e.id, 'voucher_series', coalesce(nullif(e.voucher_series, ''), 'A'),
                  'voucher_number', e.voucher_number)
                ORDER BY coalesce(nullif(e.voucher_series, ''), 'A'), e.voucher_number, e.id), '[]'::jsonb) AS r
           FROM public.journal_entries e
          WHERE e.company_id = $1 AND e.fiscal_period_id = $2 AND e.status IN ('posted', 'reversed')`,
        [w.companyId, w.periodId],
      )
      const reference = ref[0].r as Array<{ id: string; voucher_series: string; voucher_number: number }>
      expect(reference.map((r) => `${r.voucher_series}${r.voucher_number}`)).toContain('A60')
      for (const limit of [1, 3, 500]) {
        const seen: Array<{ id: string; voucher_series: string; voucher_number: number; lines: Array<{ account_number: string }> }> = []
        let cursor: [string | null, number | null, string | null] = [null, null, null]
        for (let guard = 0; guard < 100; guard++) {
          const { rows } = await c.query(
            `SELECT public.get_journal_register_page($1, $2, $3, $4::integer, $5::uuid, $6::integer) AS r`,
            [w.companyId, w.periodId, ...cursor, limit],
          )
          const page = rows[0].r as typeof seen
          seen.push(...page)
          if (page.length < limit) break
          const last = page[page.length - 1]
          cursor = [last.voucher_series, last.voucher_number, last.id]
        }
        expect(seen.map(({ id, voucher_series, voucher_number }) => ({ id, voucher_series, voucher_number })), `limit=${limit}`).toEqual(reference)
        const first = seen.find((e) => e.voucher_series === 'A' && e.voucher_number === 2)
        expect(first?.lines.map((l) => l.account_number)).toEqual(['1510', '2611', '3001', '3001'])
      }

      const { rows: totals } = await c.query(`SELECT public.get_journal_register_totals($1, $2) AS r`, [w.companyId, w.periodId])
      const { rows: sums } = await c.query(
        `SELECT count(DISTINCT e.id)::int AS n, sum(l.debit_amount)::float AS d, sum(l.credit_amount)::float AS k
           FROM public.journal_entries e JOIN public.journal_entry_lines l ON l.journal_entry_id = e.id
          WHERE e.company_id = $1 AND e.fiscal_period_id = $2 AND e.status IN ('posted', 'reversed')`,
        [w.companyId, w.periodId],
      )
      expect(totals[0].r).toEqual({ total_entries: sums[0].n, total_debit: sums[0].d, total_credit: sums[0].k })
    })
  })
})

describe('ledger_account_days: access', () => {
  it('lets a member read the own company and nobody write', async () => {
    const w = await world()
    const other = await seedCompany()
    await withUserContext(other.userId, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM public.ledger_account_days WHERE company_id = $1`, [w.companyId])
      expect(rows).toEqual([])
      const { rows: located } = await client.query(`SELECT 1 FROM public.ledger_account_entries WHERE company_id = $1`, [w.companyId])
      expect(located).toEqual([])
    })
    await withUserContext(w.userId, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM public.ledger_account_days WHERE company_id = $1 LIMIT 1`, [w.companyId])
      expect(rows).toHaveLength(1)
      await expect(
        client.query(
          `INSERT INTO public.ledger_account_days (company_id, fiscal_period_id, account_number, entry_date, debit)
           VALUES ($1, $2, '1930', '2026-01-01', 1)`,
          [w.companyId, w.periodId],
        ),
      ).rejects.toThrow(/permission denied/)
    })
    await withUserContext(w.userId, async (client) => {
      await expect(client.query(`SELECT public.build_ledger_account_days($1)`, [w.companyId])).rejects.toThrow(/permission denied/)
    })
  })
})
