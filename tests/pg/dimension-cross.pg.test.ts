import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { getPool, withUserContext } from '@/tests/pg/setup'
import { insertDraftJournalEntry, insertFiscalPeriod, seedCompany } from '@/tests/pg/fixtures'

// Migration 20261101121500_dimension_cross_report.sql (accounted#133):
// ledger_tagset_days holds the posted ledger's sums per account, day and the
// line's whole tag set, kept in step by ledger_days_apply_lines, built per
// company by build_ledger_tagset_days; get_dimension_cross_buckets reads two
// dimensions of the same line from it (or from the lines until the company
// is built) and get_dimension_cross_lines pages the lines behind one cell.
//
//   1. every write path leaves ledger_tagset_days equal to the journal
//      (ledger_tagset_days_drift is empty): posting, storno, inline
//      rättelse, a date change, a dimension retag, delete_last_voucher
//   2. a company is read from the rows only after its build; the build and
//      a rebuild leave no drift; compaction folds the slots, sums unchanged
//   3. the buckets are the same on all three paths (rows, locator, lines),
//      leave out what get_dimension_pnl_buckets leaves out (the IB entry,
//      the year-end chain, other periods, balance accounts), and summed
//      over one axis are get_dimension_pnl_buckets
//   4. the lines of a cell, paged to the end, are exactly the lines its
//      bucket sums, with the codes trimmed as JavaScript trims them and NULL
//      the untagged row or column (no key or only blanks; the bag CHECK
//      jel_dimensions_well_formed refuses non-string values on new rows)
//   5. API roles read only their own company and write nothing

type Q = Pick<PoolClient, 'query'>

interface Line {
  account: string
  debit?: number
  credit?: number
  dims?: Record<string, unknown>
}

interface World {
  userId: string
  companyId: string
  periodId: string
  priorPeriodId: string
  ibId: string
}

interface Bucket {
  account_number: string
  code_a: string | null
  code_b: string | null
  debit: number
  credit: number
}

interface CrossLine {
  line_id: string
  journal_entry_id: string
  entry_date: string
  voucher_number: number
  account_number: string
  debit_amount: number
  credit_amount: number
  dimensions: Record<string, unknown>
}

const ACCOUNTS = ['1229', '1510', '1930', '2081', '2099', '2611', '3001', '3041', '5010', '5420', '7832']

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
  params: { date: string; lines: Line[]; sourceType?: string; voucher: number; periodId?: string; reversesId?: string },
): Promise<{ id: string; lineIds: string[] }> {
  const id = await insertDraftJournalEntry({
    userId: w.userId,
    companyId: w.companyId,
    fiscalPeriodId: params.periodId ?? w.periodId,
    entryDate: params.date,
    sourceType: params.sourceType ?? 'manual',
    status: 'draft',
    voucherNumber: params.voucher,
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
  const { rows } = await client.query(`SELECT * FROM public.ledger_tagset_days_drift($1)`, [companyId])
  return rows
}

async function build(companyId: string): Promise<void> {
  await getPool().query(`SELECT public.build_ledger_tagset_days($1)`, [companyId])
}

/**
 * One aktiebolag, FY2026 with an IB verifikat (one tagged result line, to
 * prove it stays out), lines tagged on dimensions 1 and 6 in every
 * combination, a blank-padded code, a blank code, a tagged balance line,
 * a year_end entry, the storno of last year's year_end entry, a reversed
 * verifikat and its storno, and a tagged line in last year's period.
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
    lines: [{ account: '1930', debit: 77 }, { account: '3001', credit: 77, dims: { '1': 'KS01', '6': 'P1' } }],
  })
  w.ibId = ib.id
  await getPool().query(`UPDATE public.fiscal_periods SET opening_balance_entry_id = $2 WHERE id = $1`, [w.periodId, ib.id])

  await post(w, {
    date: '2026-03-10', voucher: 2,
    lines: [
      { account: '1510', debit: 1250 },
      { account: '3001', credit: 1000.5, dims: { '1': 'KS01', '6': 'P1' } },
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
    lines: [{ account: '5010', debit: 300, dims: { '6': 'P2' } }, { account: '1930', credit: 300 }],
  })
  await post(w, {
    date: '2026-05-20', voucher: 5,
    lines: [
      { account: '5010', debit: 50 },
      // Blanks pass the bag CHECK (jel_dimensions_well_formed) but are no code:
      // stored as a tag set, read by every report as untagged.
      { account: '5420', debit: 40, dims: { '1': '  ' } },
      { account: '1930', credit: 90, dims: { '1': 'KS01' } },
    ],
  })
  const reversedLines: Line[] = [{ account: '5010', debit: 200, dims: { '1': 'KS01', '6': 'P2' } }, { account: '1930', credit: 200 }]
  const reversed = await post(w, { date: '2026-07-01', voucher: 6, lines: reversedLines })
  await storno(w, reversed, reversedLines, '2026-07-03', 7)
  await post(w, {
    date: '2026-12-31', sourceType: 'year_end', voucher: 8,
    lines: [{ account: '7832', debit: 500, dims: { '1': 'KS01', '6': 'P1' } }, { account: '1229', credit: 500 }],
  })
  // Last year's year_end entry, reversed by a storno booked this year.
  const ye2025Lines: Line[] = [{ account: '7832', debit: 200, dims: { '1': 'KS01' } }, { account: '1229', credit: 200 }]
  const ye2025 = await post(w, { date: '2025-12-31', sourceType: 'year_end', voucher: 1, periodId: priorPeriodId, lines: ye2025Lines })
  await storno(w, ye2025, ye2025Lines, '2026-01-15', 9)
  await post(w, {
    date: '2025-06-01', voucher: 2, periodId: priorPeriodId,
    lines: [{ account: '1930', debit: 100 }, { account: '3001', credit: 100, dims: { '1': 'KS01', '6': 'P1' } }],
  })
  return w
}

type Path = 'rows' | 'locator' | 'lines'

/** Run `fn` as the company's owner, reading the rows, or hiding them so the RPC takes a line path. */
async function asOwner<T>(w: World, path: Path, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    if (path === 'rows') {
      await client.query(
        `INSERT INTO public.ledger_tagset_days_companies (company_id) VALUES ($1) ON CONFLICT DO NOTHING`,
        [w.companyId],
      )
    } else {
      await client.query(`DELETE FROM public.ledger_tagset_days_companies WHERE company_id = $1`, [w.companyId])
    }
    if (path === 'lines') {
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

async function buckets(c: Q, w: World, a: string, b: string, from: string | null = null, to: string | null = null, period = w.periodId): Promise<Bucket[]> {
  const { rows } = await c.query<{ r: Bucket[] }>(
    `SELECT public.get_dimension_cross_buckets($1, $2, $3, $4, $5::date, $6::date) AS r`,
    [w.companyId, period, a, b, from, to],
  )
  return rows[0].r
}

const RANGES: Array<[string | null, string | null]> = [
  [null, null], ['2026-03-01', '2026-06-30'], ['2026-01-01', '2026-03-31'], ['2026-12-31', '2026-12-31'], ['2026-07-01', '2026-07-02'],
]

async function allBuckets(w: World, c: Q): Promise<Record<string, Bucket[]>> {
  const out: Record<string, Bucket[]> = {}
  for (const period of [w.periodId, w.priorPeriodId]) {
    for (const [a, b] of [['1', '6'], ['6', '1'], ['1', '9'], ['9', '6']]) {
      for (const [from, to] of RANGES) {
        out[`${period} ${a}x${b} ${from}-${to}`] = await buckets(c, w, a, b, from, to, period)
      }
    }
  }
  return out
}

/** Every line of a cell, read page by page. */
async function cellLines(
  c: Q,
  w: World,
  cell: { a: string; codeA: string | null; b: string; codeB: string | null },
  opts: { from?: string | null; to?: string | null; accountFrom?: string | null; accountTo?: string | null; limit?: number } = {},
): Promise<{ lines: CrossLine[]; pages: number }> {
  const lines: CrossLine[] = []
  let after = null as CrossLine | null
  let pages = 0
  for (;;) {
    const { rows }: { rows: { r: { lines: CrossLine[]; has_more: boolean } }[] } = await c.query<{ r: { lines: CrossLine[]; has_more: boolean } }>(
      `SELECT public.get_dimension_cross_lines($1, $2, $3, $4, $5, $6, $7, $8, $9::date, $10::date, $11::date, $12::int, $13::uuid, $14::int) AS r`,
      [
        w.companyId, w.periodId, cell.a, cell.codeA, cell.b, cell.codeB,
        opts.accountFrom ?? null, opts.accountTo ?? null, opts.from ?? null, opts.to ?? null,
        after?.entry_date ?? null, after?.voucher_number ?? null, after?.line_id ?? null, opts.limit ?? 200,
      ],
    )
    pages++
    lines.push(...rows[0].r.lines)
    if (!rows[0].r.has_more) break
    after = rows[0].r.lines[rows[0].r.lines.length - 1]
    if (pages > 50) throw new Error('paging does not end')
  }
  return { lines, pages }
}

/** Order-free comparison: the RPC orders by the database's collation. */
const sorted = (b: Bucket[]): string[] =>
  b.map((r) => [r.account_number, r.code_a, r.code_b, Number(r.debit), Number(r.credit)].join('|')).sort()

const trimmed = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

describe('ledger_tagset_days: kept equal to the journal', () => {
  it('holds every tagged line by its whole tag set, and nothing else', async () => {
    const w = await world()
    expect(await drift(w.companyId)).toEqual([])
    const { rows } = await getPool().query<{ account_number: string; tags: Record<string, string>; n: number }>(
      `SELECT account_number, tags, sum(line_count)::int AS n FROM public.ledger_tagset_days
        WHERE company_id = $1 AND fiscal_period_id = $2 AND entry_date = '2026-05-20'
        GROUP BY 1, 2 ORDER BY 1`,
      [w.companyId, w.periodId],
    )
    // The untagged 5010 line has no row; the blank 5420 code is a stored tag set.
    expect(rows).toEqual([
      { account_number: '1930', tags: { '1': 'KS01' }, n: 1 },
      { account_number: '5420', tags: { '1': '  ' }, n: 1 },
    ])
  })

  it('stays equal through storno, inline rättelse, a date change, a retag and delete_last_voucher', async () => {
    const w = await world()
    const lines: Line[] = [{ account: '5010', debit: 300, dims: { '1': 'KS02', '6': 'P3' } }, { account: '1930', credit: 300 }]
    const entry = await post(w, { date: '2026-06-01', voucher: 20, lines })
    expect(await drift(w.companyId)).toEqual([])

    await storno(w, entry, lines, '2026-06-03', 21)
    expect(await drift(w.companyId)).toEqual([])

    const target = await post(w, {
      date: '2026-07-10', voucher: 22,
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
    await registerDimensionValues(w.companyId, [[1, 'KS01'], [6, 'P2']])
    await getPool().query(
      `SELECT public.retag_line_dimensions($1::uuid, $2::uuid, $3::jsonb, 'Fel projekt', $4::uuid)`,
      [w.companyId, line[0].id, JSON.stringify({ '1': 'KS01', '6': 'P2' }), w.userId],
    )
    expect(await drift(w.companyId)).toEqual([])

    const last = await post(w, {
      date: '2026-09-01', voucher: 23,
      lines: [{ account: '5010', debit: 400, dims: { '1': 'KS01' } }, { account: '1930', credit: 400 }],
    })
    await getPool().query(
      `INSERT INTO public.voucher_sequences (user_id, company_id, fiscal_period_id, voucher_series, last_number)
       VALUES ($1, $2, $3, 'A', 23)
       ON CONFLICT (company_id, fiscal_period_id, voucher_series) DO UPDATE SET last_number = 23`,
      [w.userId, w.companyId, w.periodId],
    )
    await withUserContext(w.userId, async (client) => {
      const { rows } = await client.query<{ r: { deleted: boolean } }>(`SELECT public.delete_last_voucher($1, $2) AS r`, [w.companyId, last.id])
      expect(rows[0].r.deleted).toBe(true)
      await client.query('RESET ROLE')
      expect(await drift(w.companyId, client)).toEqual([])
    })
  })

  it('reads a company from its rows only after the build; build, rebuild and compaction change no sum', async () => {
    const w = await world()
    // Not listed until built, and the cron finds it.
    const ready = async () =>
      (await getPool().query(`SELECT public.ledger_tagset_days_ready($1) AS r`, [w.companyId])).rows[0].r as boolean
    expect(await ready()).toBe(false)
    const { rows: pending } = await getPool().query<{ id: string }>(
      `SELECT p AS id FROM public.ledger_tagset_days_pending(100000) p`,
    )
    expect(pending.map((p) => p.id)).toContain(w.companyId)

    // A company whose rows were lost is rebuilt from its journal.
    await getPool().query(`DELETE FROM public.ledger_tagset_days WHERE company_id = $1`, [w.companyId])
    expect((await drift(w.companyId)).length).toBeGreaterThan(0)
    await build(w.companyId)
    expect(await ready()).toBe(true)
    expect(await drift(w.companyId)).toEqual([])
    const before = await asOwner(w, 'rows', (c) => allBuckets(w, c))
    await build(w.companyId)
    expect(await drift(w.companyId)).toEqual([])

    // Writers add to their own slot; compaction folds them into slot 0.
    await post(w, {
      date: '2026-03-10', voucher: 30,
      lines: [{ account: '3001', credit: 10, dims: { '1': 'KS01', '6': 'P1' } }, { account: '1930', debit: 10 }],
    })
    const { rows: unfolded } = await getPool().query<{ id: string }>(`SELECT u AS id FROM public.ledger_tagset_days_unfolded(100000) u`)
    expect(unfolded.map((u) => u.id)).toContain(w.companyId)
    const withPost = await asOwner(w, 'rows', (c) => allBuckets(w, c))
    expect(withPost).not.toEqual(before)
    await getPool().query(`SELECT public.compact_ledger_tagset_days($1)`, [w.companyId])
    const { rows: slots } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM public.ledger_tagset_days WHERE company_id = $1 AND slot <> 0`,
      [w.companyId],
    )
    expect(slots[0].n).toBe(0)
    expect(await drift(w.companyId)).toEqual([])
    expect(await asOwner(w, 'rows', (c) => allBuckets(w, c))).toEqual(withPost)
  })
})

describe('get_dimension_cross_buckets', () => {
  it('answers the same on the rows, the locator and the lines', async () => {
    const w = await world()
    await build(w.companyId)
    const rows = await asOwner(w, 'rows', (c) => allBuckets(w, c))
    const located = await asOwner(w, 'locator', (c) => allBuckets(w, c))
    const lines = await asOwner(w, 'lines', (c) => allBuckets(w, c))
    expect(Object.keys(rows)).toHaveLength(40)
    expect(rows).toEqual(located)
    expect(rows).toEqual(lines)
  })

  it('is the tagged result lines of the period, the IB entry, the year-end chain and balance lines left out', async () => {
    const w = await world()
    await build(w.companyId)
    const full = await asOwner(w, 'rows', (c) => buckets(c, w, '1', '6'))
    expect(sorted(full)).toEqual(sorted([
      { account_number: '3001', code_a: ' KS01 ', code_b: null, debit: 0.5, credit: 0 },
      { account_number: '3001', code_a: 'KS01', code_b: 'P1', debit: 0, credit: 1000.5 },
      { account_number: '5010', code_a: 'KS01', code_b: 'P2', debit: 200, credit: 200 },
      { account_number: '5010', code_a: 'KS02', code_b: 'P1', debit: 800, credit: 0 },
      { account_number: '5010', code_a: null, code_b: 'P2', debit: 300, credit: 0 },
      // As stored: the report trims it away and counts it in the remainder.
      { account_number: '5420', code_a: '  ', code_b: null, debit: 40, credit: 0 },
    ]))
    // Swapping the axes swaps the codes, nothing else.
    const swapped = await asOwner(w, 'rows', (c) => buckets(c, w, '6', '1'))
    const transpose = (b: Bucket[]) =>
      b.map((r) => `${r.account_number}|${r.code_b}|${r.code_a}|${r.debit}|${r.credit}`).sort()
    expect(swapped.map((r) => `${r.account_number}|${r.code_a}|${r.code_b}|${r.debit}|${r.credit}`).sort()).toEqual(transpose(full))
    // Last year's tagged line is in last year only.
    expect(await asOwner(w, 'rows', (c) => buckets(c, w, '1', '6', null, null, w.priorPeriodId))).toEqual([
      { account_number: '3001', code_a: 'KS01', code_b: 'P1', debit: 0, credit: 100 },
    ])
  })

  it('summed over the other axis is get_dimension_pnl_buckets for every result account', async () => {
    const w = await world()
    await build(w.companyId)
    await asOwner(w, 'rows', async (c) => {
      for (const [from, to] of RANGES) {
        for (const [a, b] of [['1', '6'], ['6', '1']]) {
          const cross = await buckets(c, w, a, b, from, to)
          const summed = new Map<string, { debit: number; credit: number }>()
          for (const r of cross) {
            if (r.code_a === null) continue
            const key = `${r.account_number}|${r.code_a}`
            const agg = summed.get(key) ?? { debit: 0, credit: 0 }
            agg.debit += r.debit
            agg.credit += r.credit
            summed.set(key, agg)
          }
          const { rows } = await c.query<{ r: Array<{ account_number: string; code: string; debit: number; credit: number }> }>(
            `SELECT public.get_dimension_pnl_buckets($1, $2, $3, $4::date, $5::date) AS r`,
            [w.companyId, w.periodId, a, from, to],
          )
          const pnl = new Map(
            rows[0].r
              .filter((r) => r.account_number >= '3000' && r.account_number < '9000')
              .map((r) => [`${r.account_number}|${r.code}`, { debit: Number(r.debit), credit: Number(r.credit) }]),
          )
          expect(summed, `${a}x${b} ${from}-${to}`).toEqual(pnl)
        }
      }
    })
  })

  it('refuses one dimension on both axes', async () => {
    const w = await world()
    await asOwner(w, 'rows', async (c) => {
      await expect(buckets(c, w, '1', '1')).rejects.toMatchObject({ code: '22023' })
    })
  })
})

describe('get_dimension_cross_lines', () => {
  it('pages each cell to its end, and the lines sum to its bucket on every path', async () => {
    const w = await world()
    // A busy cell, so paging has something to do: eight verifikat of KS03 x P3 on three days.
    for (let i = 0; i < 7; i++) {
      await post(w, {
        date: i < 4 ? '2026-08-10' : '2026-08-11', voucher: 40 + i,
        lines: [{ account: '3041', credit: 10 + i, dims: { '1': 'KS03', '6': 'P3' } }, { account: '1930', debit: 10 + i }],
      })
    }
    // A code padded with a no-break space, as an import can leave it: the
    // report merges it into KS03 (JavaScript trim), so the cell's lines must too.
    await post(w, {
      date: '2026-08-12', voucher: 47,
      lines: [{ account: '3041', credit: 5, dims: { '1': 'KS03\u00a0', '6': 'P3' } }, { account: '1930', debit: 5 }],
    })
    await build(w.companyId)
    for (const path of ['rows', 'lines'] as const) {
      await asOwner(w, path, async (c) => {
        const all = await buckets(c, w, '1', '6')
        // The report's cells: codes trimmed, the untagged row and column NULL.
        const cells = new Map<string, { a: string | null; b: string | null; debit: number; credit: number }>()
        for (const r of all) {
          const a = trimmed(r.code_a)
          const b = trimmed(r.code_b)
          // Neither code after trimming: the generator's remainder, not a cell of its own.
          if (a === null && b === null) continue
          const key = `${a}|${b}`
          const cell = cells.get(key) ?? { a, b, debit: 0, credit: 0 }
          cell.debit += r.debit
          cell.credit += r.credit
          cells.set(key, cell)
        }
        expect(cells.size).toBe(6)
        for (const cell of cells.values()) {
          const { lines, pages } = await cellLines(c, w, { a: '1', codeA: cell.a, b: '6', codeB: cell.b }, { limit: 3 })
          const sum = (k: 'debit_amount' | 'credit_amount') => Math.round(lines.reduce((s, l) => s + Number(l[k]), 0) * 100)
          expect(sum('debit_amount'), `${path} ${cell.a}x${cell.b}`).toBe(Math.round(cell.debit * 100))
          expect(sum('credit_amount'), `${path} ${cell.a}x${cell.b}`).toBe(Math.round(cell.credit * 100))
          // In report order, no line twice.
          const order = lines.map((l) => `${l.entry_date}|${String(l.voucher_number).padStart(6, '0')}|${l.line_id}`)
          expect(order).toEqual([...order].sort())
          expect(new Set(lines.map((l) => l.line_id)).size).toBe(lines.length)
          expect(pages).toBe(Math.max(1, Math.ceil(lines.length / 3)))
        }
        const busy = await cellLines(c, w, { a: '1', codeA: 'KS03', b: '6', codeB: 'P3' }, { limit: 3 })
        expect(busy.lines).toHaveLength(8)
        expect(busy.pages).toBe(3)
      })
    }
  })

  it('reads the untagged cell as the result lines with neither tag, blank codes included', async () => {
    const w = await world()
    await build(w.companyId)
    await asOwner(w, 'rows', async (c) => {
      const { lines } = await cellLines(c, w, { a: '1', codeA: null, b: '6', codeB: null })
      expect(lines.map((l) => [l.account_number, Number(l.debit_amount), Number(l.credit_amount)]).sort()).toEqual([
        ['5010', 50, 0],
        ['5420', 40, 0],
      ])
      // A blank-padded code is its trimmed value; an account range narrows.
      const padded = await cellLines(c, w, { a: '1', codeA: 'KS01', b: '6', codeB: null })
      expect(padded.lines.map((l) => [l.account_number, Number(l.debit_amount)])).toEqual([['3001', 0.5]])
      const costs = await cellLines(c, w, { a: '1', codeA: 'KS01', b: '6', codeB: 'P2' }, { accountFrom: '4000', accountTo: '7999' })
      expect(costs.lines).toHaveLength(2)
      const revenue = await cellLines(c, w, { a: '1', codeA: 'KS01', b: '6', codeB: 'P2' }, { accountFrom: '3000', accountTo: '3999' })
      expect(revenue.lines).toHaveLength(0)
      // The window and the exclusions hold here too: no IB line, no year_end line.
      const q1 = await cellLines(c, w, { a: '1', codeA: 'KS01', b: '6', codeB: 'P1' }, { from: '2026-01-01', to: '2026-03-31' })
      expect(q1.lines.map((l) => Number(l.credit_amount))).toEqual([1000.5])
      const dec = await cellLines(c, w, { a: '1', codeA: 'KS01', b: '6', codeB: 'P1' }, { from: '2026-12-01', to: '2026-12-31' })
      expect(dec.lines).toEqual([])
    })
  })
})

describe('dimension cross: API roles', () => {
  it('another company\'s member reads nothing, and no API role writes the rows or builds them', async () => {
    const w = await world()
    await build(w.companyId)
    const stranger = await seedCompany()
    await withUserContext(stranger.userId, async (client) => {
      const { rows } = await client.query<{ r: Bucket[] }>(
        `SELECT public.get_dimension_cross_buckets($1, $2, '1', '6', NULL, NULL) AS r`,
        [w.companyId, w.periodId],
      )
      expect(rows[0].r).toEqual([])
      const { rows: lines } = await client.query<{ r: { lines: unknown[] } }>(
        `SELECT public.get_dimension_cross_lines($1, $2, '1', 'KS01', '6', 'P1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 50) AS r`,
        [w.companyId, w.periodId],
      )
      expect(lines[0].r.lines).toEqual([])
      const { rows: seen } = await client.query(`SELECT 1 FROM public.ledger_tagset_days WHERE company_id = $1`, [w.companyId])
      expect(seen).toEqual([])
    })
    await withUserContext(w.userId, async (client) => {
      const { rows } = await client.query(`SELECT 1 FROM public.ledger_tagset_days WHERE company_id = $1`, [w.companyId])
      expect(rows.length).toBeGreaterThan(0)
      await client.query('SAVEPOINT s')
      await expect(
        client.query(
          `INSERT INTO public.ledger_tagset_days (company_id, fiscal_period_id, account_number, entry_date, tags)
           VALUES ($1, $2, '3001', '2026-01-02', '{"1":"X"}')`,
          [w.companyId, w.periodId],
        ),
      ).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT s')
      await expect(client.query(`SELECT public.build_ledger_tagset_days($1)`, [w.companyId])).rejects.toMatchObject({ code: '42501' })
      await client.query('ROLLBACK TO SAVEPOINT s')
      await expect(
        client.query(`INSERT INTO public.ledger_tagset_days_companies (company_id) VALUES ($1)`, [w.companyId]),
      ).rejects.toMatchObject({ code: '42501' })
    })
  })
})
