/**
 * pg-real test for get_trial_balance_aggregates (migration 20260910160147,
 * issue #2470).
 *
 * The RPC is the SQL side of generateTrialBalance: per-account debit/credit
 * sums for one fiscal period under one ClosingEntryMode, split into a
 * 'period' bucket and (for a sub-range) a 'rollforward' bucket. The
 * exclusion semantics used to live in JS behind PostgREST filters
 * (lib/reports/trial-balance.ts); this suite pins them against real
 * Postgres, mirroring the closing-mode cases of the unit suite on real rows:
 *
 *   - the base set is posted AND reversed entries of the period, minus
 *     p_exclude_entry_id (the opening-balance entry);
 *   - 'include' keeps the year-end chain;
 *   - 'exclude-final' drops ONLY fiscal_periods.closing_entry_id, and only
 *     while it is posted (a reversed closing stays with its storno), keeps
 *     tax/appropriation year_end entries, and fails closed on a closed period
 *     without the link unless closed_externally;
 *   - 'exclude-all-year-end' drops every year_end entry plus stornos and
 *     corrections of REVERSED year-end entries, company-wide, and keeps
 *     stornos of ordinary reversed entries;
 *   - a from/to range buckets [period_start, from) as 'rollforward' and
 *     [from, to] as 'period', and drops entries after to;
 *   - p_dimensions is jsonb containment on the line;
 *   - SECURITY INVOKER: a non-member gets no rows under RLS, a member gets
 *     the same rows as the superuser.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'node:crypto'
import { getPool, withUserContext } from './setup'
import {
  insertAuthUser,
  insertCompany,
  insertCompanyMember,
  insertFiscalPeriod,
} from './fixtures'

type ClosingMode = 'include' | 'exclude-final' | 'exclude-all-year-end'

interface AggRow {
  bucket: 'period' | 'rollforward'
  account_number: string
  debit: string
  credit: string
}

interface CallOptions {
  fromDate?: string | null
  toDate?: string | null
  excludeEntryId?: string | null
  dimensions?: Record<string, string> | null
}

const CALL_SQL = `SELECT bucket, account_number, debit, credit
     FROM public.get_trial_balance_aggregates($1, $2, $3, $4, $5, $6, $7::jsonb)`

function callParams(
  companyId: string,
  fiscalPeriodId: string,
  mode: ClosingMode,
  opts: CallOptions = {},
): unknown[] {
  return [
    companyId,
    fiscalPeriodId,
    mode,
    opts.fromDate ?? null,
    opts.toDate ?? null,
    opts.excludeEntryId ?? null,
    opts.dimensions ? JSON.stringify(opts.dimensions) : null,
  ]
}

async function callRpc(
  companyId: string,
  fiscalPeriodId: string,
  mode: ClosingMode,
  opts: CallOptions = {},
): Promise<AggRow[]> {
  const { rows } = await getPool().query<AggRow>(CALL_SQL, callParams(companyId, fiscalPeriodId, mode, opts))
  return rows
}

/** Map of account -> {debit, credit} for one bucket, amounts as numbers. */
function bucket(rows: AggRow[], name: 'period' | 'rollforward') {
  return new Map(
    rows
      .filter((r) => r.bucket === name)
      .map((r) => [r.account_number, { debit: Number(r.debit), credit: Number(r.credit) }]),
  )
}

async function insertJournalEntry(params: {
  userId: string
  companyId: string
  fiscalPeriodId: string
  voucherNumber: number
  status?: 'draft' | 'posted' | 'reversed'
  sourceType?: string
  entryDate?: string
  reversesId?: string | null
  correctionOfId?: string | null
  lines: Array<{ account: string; debit: number; credit: number; dimensions?: Record<string, string> }>
}): Promise<string> {
  const id = randomUUID()
  const status = params.status ?? 'posted'
  const client = await getPool().connect()
  // Insert directly, bypassing commit_journal_entry's voucher sequencing:
  // fine for a read-side RPC that only aggregates line/account references.
  try {
    await client.query('BEGIN')
    await client.query(
      `INSERT INTO public.journal_entries
         (id, user_id, company_id, fiscal_period_id, voucher_number, voucher_series,
          entry_date, description, source_type, status, reverses_id, correction_of_id)
       VALUES ($1, $2, $3, $4, $5, 'A', $6, 'TB RPC test', $7, $8, $9, $10)`,
      [
        id,
        params.userId,
        params.companyId,
        params.fiscalPeriodId,
        params.voucherNumber,
        params.entryDate ?? '2026-03-15',
        params.sourceType ?? 'manual',
        status,
        params.reversesId ?? null,
        params.correctionOfId ?? null,
      ],
    )
    for (const line of params.lines) {
      await client.query(
        `INSERT INTO public.journal_entry_lines
           (journal_entry_id, account_number, debit_amount, credit_amount, dimensions)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [id, line.account, line.debit, line.credit, JSON.stringify(line.dimensions ?? {})],
      )
    }
    if (status === 'posted') {
      await client.query('SET CONSTRAINTS check_balance_on_posted_insert IMMEDIATE')
    }
    await client.query('COMMIT')
    return id
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

async function seedCompany(period: { isClosed?: boolean } = {}) {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId, isClosed: period.isClosed })
  return { userId, companyId, fiscalPeriodId }
}

/**
 * Full scenario, the unit suite's closing-mode cases on real rows: a linked
 * OB entry, posted activity across three months, a reversed manual entry, a
 * posted tax year_end entry, the posted final closing entry (linked as
 * fiscal_periods.closing_entry_id), and an undone year-end chain (reversed
 * year_end + its storno + a correction).
 */
async function seedFullScenario() {
  const ctx = await seedCompany()

  const obEntryId = await insertJournalEntry({
    ...ctx, voucherNumber: 1, sourceType: 'opening_balance', entryDate: '2026-01-01',
    lines: [
      { account: '1930', debit: 5000, credit: 0 },
      { account: '2010', debit: 0, credit: 5000 },
    ],
  })
  await getPool().query(
    `UPDATE public.fiscal_periods SET opening_balance_entry_id = $1 WHERE id = $2`,
    [obEntryId, ctx.fiscalPeriodId],
  )

  // January: revenue
  await insertJournalEntry({
    ...ctx, voucherNumber: 2, entryDate: '2026-01-15',
    lines: [
      { account: '3001', debit: 0, credit: 10000 },
      { account: '2611', debit: 0, credit: 2500 },
      { account: '1930', debit: 12500, credit: 0 },
    ],
  })
  // February: expense, plus a REVERSED manual entry (in the base set)
  await insertJournalEntry({
    ...ctx, voucherNumber: 3, entryDate: '2026-02-10',
    lines: [
      { account: '5010', debit: 3000, credit: 0 },
      { account: '1930', debit: 0, credit: 3000 },
    ],
  })
  await insertJournalEntry({
    ...ctx, voucherNumber: 4, status: 'reversed', entryDate: '2026-02-20',
    lines: [{ account: '3001', debit: 0, credit: 700 }],
  })
  // June: a draft never enters the base set
  await insertJournalEntry({
    ...ctx, voucherNumber: 5, status: 'draft', entryDate: '2026-06-01',
    lines: [{ account: '5010', debit: 99999, credit: 0 }],
  })

  // December: posted tax year_end entry (kept by exclude-final)
  await insertJournalEntry({
    ...ctx, voucherNumber: 6, sourceType: 'year_end', entryDate: '2026-12-31',
    lines: [
      { account: '8910', debit: 1000, credit: 0 },
      { account: '2512', debit: 0, credit: 1000 },
    ],
  })
  // December: the posted final closing entry, linked on the period
  const closingEntryId = await insertJournalEntry({
    ...ctx, voucherNumber: 7, sourceType: 'year_end', entryDate: '2026-12-31',
    lines: [
      { account: '8999', debit: 5000, credit: 0 },
      { account: '2099', debit: 0, credit: 5000 },
    ],
  })
  await getPool().query(
    `UPDATE public.fiscal_periods SET closing_entry_id = $1 WHERE id = $2`,
    [closingEntryId, ctx.fiscalPeriodId],
  )
  // Undone year-end chain: reversed year_end + its storno + a correction
  const reversedYearEndId = await insertJournalEntry({
    ...ctx, voucherNumber: 8, sourceType: 'year_end', status: 'reversed', entryDate: '2026-12-31',
    lines: [
      { account: '8999', debit: 400, credit: 0 },
      { account: '2099', debit: 0, credit: 400 },
    ],
  })
  await insertJournalEntry({
    ...ctx, voucherNumber: 9, sourceType: 'storno', entryDate: '2026-12-31',
    reversesId: reversedYearEndId,
    lines: [
      { account: '8999', debit: 0, credit: 400 },
      { account: '2099', debit: 400, credit: 0 },
    ],
  })
  await insertJournalEntry({
    ...ctx, voucherNumber: 10, sourceType: 'correction', entryDate: '2026-12-31',
    correctionOfId: reversedYearEndId,
    lines: [
      { account: '6200', debit: 250, credit: 0 },
      { account: '1930', debit: 0, credit: 250 },
    ],
  })

  return { ...ctx, obEntryId, closingEntryId }
}

describe('get_trial_balance_aggregates RPC', () => {
  it("'include' covers posted and reversed entries, drops only the excluded OB entry", async () => {
    const ctx = await seedFullScenario()
    const rows = await callRpc(ctx.companyId, ctx.fiscalPeriodId, 'include', { excludeEntryId: ctx.obEntryId })

    expect(rows.every((r) => r.bucket === 'period')).toBe(true)
    const tb = bucket(rows, 'period')
    // OB entry excluded: 1930 period debit is 12500, not 17500; 2010 absent.
    expect(tb.get('1930')).toEqual({ debit: 12500, credit: 3250 })
    expect(tb.has('2010')).toBe(false)
    // Reversed manual entry included; draft never.
    expect(tb.get('3001')).toEqual({ debit: 0, credit: 10700 })
    expect(tb.get('5010')).toEqual({ debit: 3000, credit: 0 })
    // Whole year-end chain present.
    expect(tb.get('8999')).toEqual({ debit: 5400, credit: 400 })
    expect(tb.get('2099')).toEqual({ debit: 400, credit: 5400 })
    expect(tb.get('8910')).toEqual({ debit: 1000, credit: 0 })
    expect(tb.get('6200')).toEqual({ debit: 250, credit: 0 })
  })

  it('includes the OB entry when p_exclude_entry_id is NULL', async () => {
    const ctx = await seedFullScenario()
    const tb = bucket(await callRpc(ctx.companyId, ctx.fiscalPeriodId, 'include'), 'period')

    expect(tb.get('1930')).toEqual({ debit: 17500, credit: 3250 })
    expect(tb.get('2010')).toEqual({ debit: 0, credit: 5000 })
  })

  it("'exclude-final' drops only the linked posted closing entry and keeps other year_end entries", async () => {
    const ctx = await seedFullScenario()
    const tb = bucket(
      await callRpc(ctx.companyId, ctx.fiscalPeriodId, 'exclude-final', { excludeEntryId: ctx.obEntryId }),
      'period',
    )

    // The final closing (8999 5000 / 2099 5000) is gone; the undone chain
    // (reversed year_end 400 + storno 400) and the tax entry stay.
    expect(tb.get('8999')).toEqual({ debit: 400, credit: 400 })
    expect(tb.get('2099')).toEqual({ debit: 400, credit: 400 })
    expect(tb.get('8910')).toEqual({ debit: 1000, credit: 0 })
    expect(tb.get('2512')).toEqual({ debit: 0, credit: 1000 })
    expect(tb.get('6200')).toEqual({ debit: 250, credit: 0 })
    expect(tb.get('3001')).toEqual({ debit: 0, credit: 10700 })
  })

  it("'exclude-final' keeps a REVERSED closing entry together with its storno", async () => {
    const ctx = await seedFullScenario()
    await getPool().query(`UPDATE public.journal_entries SET status = 'reversed' WHERE id = $1`, [
      ctx.closingEntryId,
    ])
    await insertJournalEntry({
      ...ctx, voucherNumber: 11, sourceType: 'storno', entryDate: '2026-12-31',
      reversesId: ctx.closingEntryId,
      lines: [
        { account: '8999', debit: 0, credit: 5000 },
        { account: '2099', debit: 5000, credit: 0 },
      ],
    })

    const tb = bucket(
      await callRpc(ctx.companyId, ctx.fiscalPeriodId, 'exclude-final', { excludeEntryId: ctx.obEntryId }),
      'period',
    )
    // Closing 5000 + undone chain 400 on each side: the pairs net to zero.
    expect(tb.get('8999')).toEqual({ debit: 5400, credit: 5400 })
    expect(tb.get('2099')).toEqual({ debit: 5400, credit: 5400 })
  })

  it("'exclude-final' fails closed on a closed period without closing_entry_id", async () => {
    const ctx = await seedCompany({ isClosed: true })

    await expect(callRpc(ctx.companyId, ctx.fiscalPeriodId, 'exclude-final')).rejects.toThrow(
      /missing closing_entry_id/,
    )
    // The other modes are unaffected.
    await expect(callRpc(ctx.companyId, ctx.fiscalPeriodId, 'include')).resolves.toEqual([])
  })

  it("'exclude-final' does not fail closed for a period closed_externally", async () => {
    // Book first, then klarmarkera: the period-lock trigger refuses writes
    // into a closed period.
    const ctx = await seedCompany()
    await insertJournalEntry({
      ...ctx, voucherNumber: 1, entryDate: '2026-03-01',
      lines: [
        { account: '1930', debit: 10, credit: 0 },
        { account: '3001', debit: 0, credit: 10 },
      ],
    })
    await getPool().query(
      `UPDATE public.fiscal_periods
          SET is_closed = true, closed_at = now(), closed_externally = true
        WHERE id = $1`,
      [ctx.fiscalPeriodId],
    )

    const tb = bucket(await callRpc(ctx.companyId, ctx.fiscalPeriodId, 'exclude-final'), 'period')
    expect(tb.get('3001')).toEqual({ debit: 0, credit: 10 })
  })

  it("'exclude-all-year-end' drops year_end entries plus stornos/corrections of reversed year-ends", async () => {
    const ctx = await seedFullScenario()
    const tb = bucket(
      await callRpc(ctx.companyId, ctx.fiscalPeriodId, 'exclude-all-year-end', { excludeEntryId: ctx.obEntryId }),
      'period',
    )

    expect(tb.get('3001')).toEqual({ debit: 0, credit: 10700 })
    expect(tb.get('5010')).toEqual({ debit: 3000, credit: 0 })
    expect(tb.has('8999')).toBe(false)
    expect(tb.has('2099')).toBe(false)
    expect(tb.has('8910')).toBe(false)
    expect(tb.has('2512')).toBe(false)
    expect(tb.has('6200')).toBe(false)
    // The correction's 1930 credit (250) disappears with it.
    expect(tb.get('1930')).toEqual({ debit: 12500, credit: 3000 })
  })

  it("'exclude-all-year-end' keeps stornos of ordinary reversed entries", async () => {
    const ctx = await seedCompany()
    const plainReversed = await insertJournalEntry({
      ...ctx, voucherNumber: 1, status: 'reversed', entryDate: '2026-04-01',
      lines: [{ account: '5010', debit: 100, credit: 0 }],
    })
    await insertJournalEntry({
      ...ctx, voucherNumber: 2, sourceType: 'storno', entryDate: '2026-04-02',
      reversesId: plainReversed,
      lines: [
        { account: '5010', debit: 0, credit: 100 },
        { account: '2999', debit: 100, credit: 0 },
      ],
    })

    const tb = bucket(await callRpc(ctx.companyId, ctx.fiscalPeriodId, 'exclude-all-year-end'), 'period')
    expect(tb.get('5010')).toEqual({ debit: 100, credit: 100 })
  })

  it("'exclude-all-year-end' chains out a storno of a year-end reversed in ANOTHER period", async () => {
    const ctx = await seedCompany()
    const priorPeriodId = await insertFiscalPeriod({
      userId: ctx.userId,
      companyId: ctx.companyId,
      name: '2025',
      periodStart: '2025-01-01',
      periodEnd: '2025-12-31',
    })
    const reversedYearEnd = await insertJournalEntry({
      ...ctx, fiscalPeriodId: priorPeriodId, voucherNumber: 1, sourceType: 'year_end', status: 'reversed',
      entryDate: '2025-12-31',
      lines: [{ account: '8999', debit: 300, credit: 0 }],
    })
    await insertJournalEntry({
      ...ctx, voucherNumber: 2, sourceType: 'storno', entryDate: '2026-01-02',
      reversesId: reversedYearEnd,
      lines: [
        { account: '8999', debit: 0, credit: 300 },
        { account: '2099', debit: 300, credit: 0 },
      ],
    })

    const rows = await callRpc(ctx.companyId, ctx.fiscalPeriodId, 'exclude-all-year-end')
    expect(rows).toEqual([])
    // ...while 'include' still sees it.
    expect(bucket(await callRpc(ctx.companyId, ctx.fiscalPeriodId, 'include'), 'period').get('8999')).toEqual({
      debit: 0,
      credit: 300,
    })
  })

  it('buckets [period_start, from) as rollforward and [from, to] as period, drops entries after to', async () => {
    const ctx = await seedFullScenario()
    const rows = await callRpc(ctx.companyId, ctx.fiscalPeriodId, 'include', {
      fromDate: '2026-02-01',
      toDate: '2026-06-30',
      excludeEntryId: ctx.obEntryId,
    })

    const roll = bucket(rows, 'rollforward')
    const period = bucket(rows, 'period')
    // January lands in rollforward.
    expect(roll.get('3001')).toEqual({ debit: 0, credit: 10000 })
    expect(roll.get('1930')).toEqual({ debit: 12500, credit: 0 })
    // February in period.
    expect(period.get('5010')).toEqual({ debit: 3000, credit: 0 })
    expect(period.get('3001')).toEqual({ debit: 0, credit: 700 })
    expect(period.get('1930')).toEqual({ debit: 0, credit: 3000 })
    // December is after to_date: in neither bucket.
    expect(roll.has('8999')).toBe(false)
    expect(period.has('8999')).toBe(false)
  })

  it('emits no rollforward bucket when from equals period_start, and honours to alone', async () => {
    const ctx = await seedFullScenario()
    const fromStart = await callRpc(ctx.companyId, ctx.fiscalPeriodId, 'include', {
      fromDate: '2026-01-01',
      excludeEntryId: ctx.obEntryId,
    })
    expect(fromStart.some((r) => r.bucket === 'rollforward')).toBe(false)
    expect(bucket(fromStart, 'period').get('8999')).toEqual({ debit: 5400, credit: 400 })

    const toOnly = await callRpc(ctx.companyId, ctx.fiscalPeriodId, 'include', {
      toDate: '2026-01-31',
      excludeEntryId: ctx.obEntryId,
    })
    expect(toOnly.some((r) => r.bucket === 'rollforward')).toBe(false)
    expect(bucket(toOnly, 'period').get('3001')).toEqual({ debit: 0, credit: 10000 })
    expect(bucket(toOnly, 'period').has('5010')).toBe(false)
  })

  it('applies the closing mode inside the rollforward bucket too', async () => {
    const ctx = await seedCompany()
    // A year_end entry dated before the requested window (an early
    // depreciation booking, say) must be chained out of the rollforward
    // under 'exclude-all-year-end' exactly as it is out of the period.
    await insertJournalEntry({
      ...ctx, voucherNumber: 1, sourceType: 'year_end', entryDate: '2026-02-01',
      lines: [
        { account: '7832', debit: 500, credit: 0 },
        { account: '1229', debit: 0, credit: 500 },
      ],
    })
    await insertJournalEntry({
      ...ctx, voucherNumber: 2, entryDate: '2026-02-02',
      lines: [
        { account: '5010', debit: 70, credit: 0 },
        { account: '1930', debit: 0, credit: 70 },
      ],
    })

    const rows = await callRpc(ctx.companyId, ctx.fiscalPeriodId, 'exclude-all-year-end', {
      fromDate: '2026-03-01',
      toDate: '2026-03-31',
    })
    const roll = bucket(rows, 'rollforward')
    expect(roll.has('7832')).toBe(false)
    expect(roll.get('5010')).toEqual({ debit: 70, credit: 0 })
  })

  it('filters lines by jsonb containment when p_dimensions is given', async () => {
    const ctx = await seedCompany()
    await insertJournalEntry({
      ...ctx, voucherNumber: 1, entryDate: '2026-03-01',
      lines: [
        { account: '3001', debit: 0, credit: 100, dimensions: { '6': 'P001' } },
        { account: '3001', debit: 0, credit: 40, dimensions: { '6': 'P002' } },
        { account: '3001', debit: 0, credit: 7, dimensions: { '6': 'P001', '1': 'KS01' } },
        { account: '1930', debit: 147, credit: 0 },
      ],
    })

    const p001 = bucket(
      await callRpc(ctx.companyId, ctx.fiscalPeriodId, 'include', { dimensions: { '6': 'P001' } }),
      'period',
    )
    expect(p001.get('3001')).toEqual({ debit: 0, credit: 107 })
    expect(p001.has('1930')).toBe(false)

    // AND across keys.
    const both = bucket(
      await callRpc(ctx.companyId, ctx.fiscalPeriodId, 'include', { dimensions: { '6': 'P001', '1': 'KS01' } }),
      'period',
    )
    expect(both.get('3001')).toEqual({ debit: 0, credit: 7 })

    // An empty object matches every line, like no filter.
    const none = bucket(await callRpc(ctx.companyId, ctx.fiscalPeriodId, 'include', { dimensions: {} }), 'period')
    expect(none.get('3001')).toEqual({ debit: 0, credit: 147 })
    expect(none.get('1930')).toEqual({ debit: 147, credit: 0 })
  })

  it('sums öre exactly (numeric, not float)', async () => {
    const ctx = await seedCompany()
    await insertJournalEntry({
      ...ctx, voucherNumber: 1, entryDate: '2026-03-01',
      lines: [
        { account: '1930', debit: 0.1, credit: 0 },
        { account: '1930', debit: 0.2, credit: 0 },
        { account: '1930', debit: 33.33, credit: 0 },
        { account: '3001', debit: 0, credit: 33.63 },
      ],
    })

    const rows = await callRpc(ctx.companyId, ctx.fiscalPeriodId, 'include')
    const line = rows.find((r) => r.account_number === '1930')!
    expect(line.debit).toBe('33.63')
  })

  it('rejects an unknown closing mode', async () => {
    const ctx = await seedCompany()
    await expect(callRpc(ctx.companyId, ctx.fiscalPeriodId, 'exclude-closing' as ClosingMode)).rejects.toThrow(
      /unknown closing mode/,
    )
  })

  it('is SECURITY INVOKER: a member sees the rows, a non-member sees none', async () => {
    const ctx = await seedFullScenario()
    const params = callParams(ctx.companyId, ctx.fiscalPeriodId, 'include', { excludeEntryId: ctx.obEntryId })

    const asMember = await withUserContext(ctx.userId, async (client) => {
      const { rows } = await client.query<AggRow>(CALL_SQL, params)
      return rows
    })
    expect(bucket(asMember, 'period').get('1930')).toEqual({ debit: 12500, credit: 3250 })

    const stranger = await insertAuthUser()
    const asStranger = await withUserContext(stranger, async (client) => {
      const { rows } = await client.query<AggRow>(CALL_SQL, params)
      return rows
    })
    expect(asStranger).toEqual([])
  })
})
