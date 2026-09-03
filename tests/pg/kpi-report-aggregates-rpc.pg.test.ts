/**
 * pg-real test for get_kpi_report_aggregates.
 *
 * The RPC backs the KPI report's no-dimension hot path: one SQL pass
 * returns the per-account trial-balance sums (with and without the
 * year-end chain), the opening-balance entry's sums, and per-month
 * income/expenses. The exclusion semantics used to live in JS
 * (lib/reports/trial-balance.ts + monthly-breakdown.ts) behind PostgREST
 * filters; this suite pins them against real Postgres:
 *
 *   - tb covers posted AND reversed entries, excluding ONLY the
 *     opening-balance entry (p_ob_entry_id);
 *   - tb_ex_year_end additionally drops source_type year_end entries and
 *     the stornos/corrections of REVERSED year-end entries (the undone
 *     year-end chain), mirroring excludeYearEndClosing;
 *   - ob sums the OB entry's lines with NO status filter (mirrors
 *     getOpeningBalances) but is company-guarded;
 *   - monthly shares tb_ex_year_end's entry set VERBATIM (posted AND
 *     reversed, minus the undone year-end chain; since 20260903160000, issue
 *     #2201: a reversed original and its storno cancel within the year so
 *     sum(months) = Nettoresultat), classes 3-8, 8999 excluded, class 8
 *     split per line by the sign of credit - debit, and (since
 *     20260730090000) year-end entries stay out so the resultatavslut cannot
 *     chart the whole year's revenue as negative income in the
 *     fiscal-year-end month;
 *   - SECURITY INVOKER: a non-member gets empty sections under RLS.
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

interface AccountSums {
  account_number: string
  debit: number
  credit: number
}

interface RpcPayload {
  tb: AccountSums[]
  tb_ex_year_end: AccountSums[]
  ob: AccountSums[]
  monthly: Array<{ year: number; month: number; income: number; expenses: number }>
}

async function callRpc(
  companyId: string,
  fiscalPeriodId: string,
  obEntryId: string | null = null,
): Promise<RpcPayload> {
  const { rows } = await getPool().query(
    `SELECT public.get_kpi_report_aggregates($1, $2, $3) AS payload`,
    [companyId, fiscalPeriodId, obEntryId],
  )
  return rows[0].payload as RpcPayload
}

function byAccount(section: AccountSums[]) {
  return new Map(section.map((t) => [t.account_number, t]))
}

function monthOf(payload: RpcPayload, year: number, month: number) {
  return payload.monthly.find((m) => m.year === year && m.month === month)
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
  lines: Array<{ account: string; debit: number; credit: number }>
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
       VALUES ($1, $2, $3, $4, $5, 'A', $6, 'KPI RPC test', $7, $8, $9, $10)`,
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
           (journal_entry_id, account_number, debit_amount, credit_amount)
         VALUES ($1, $2, $3, $4)`,
        [id, line.account, line.debit, line.credit],
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

async function seedCompany() {
  const userId = await insertAuthUser()
  const companyId = await insertCompany({ createdBy: userId })
  await insertCompanyMember({ companyId, userId, role: 'owner' })
  const fiscalPeriodId = await insertFiscalPeriod({ userId, companyId })
  return { userId, companyId, fiscalPeriodId }
}

/**
 * Full scenario: posted entries across three months, a reversed manual
 * entry, an undone year-end chain (reversed year_end + storno +
 * correction), a still-posted year_end entry with 8999 and 8910, and a
 * linked OB entry.
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
  // February: expense, plus a REVERSED entry (in tb AND in monthly: the
  // monthly section shares tb_ex_year_end's entry set, issue #2201)
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
  // March: mixed-sign class 8 lines in the same entry
  await insertJournalEntry({
    ...ctx, voucherNumber: 5, entryDate: '2026-03-05',
    lines: [
      { account: '8310', debit: 0, credit: 200 },
      { account: '8410', debit: 500, credit: 0 },
      // Balance outside classes 3-8 so the monthly assertions stay focused.
      { account: '2999', debit: 0, credit: 300 },
    ],
  })

  // December: posted year_end entry (8999 + 8910)
  await insertJournalEntry({
    ...ctx, voucherNumber: 6, sourceType: 'year_end', entryDate: '2026-12-31',
    lines: [
      { account: '8910', debit: 1000, credit: 0 },
      { account: '2512', debit: 0, credit: 1000 },
      { account: '8999', debit: 5000, credit: 0 },
      { account: '2099', debit: 0, credit: 5000 },
    ],
  })
  // Undone year-end chain: reversed year_end + its storno + a correction
  const reversedYearEndId = await insertJournalEntry({
    ...ctx, voucherNumber: 7, sourceType: 'year_end', status: 'reversed', entryDate: '2026-12-31',
    lines: [
      { account: '8999', debit: 400, credit: 0 },
      { account: '2099', debit: 0, credit: 400 },
    ],
  })
  await insertJournalEntry({
    ...ctx, voucherNumber: 8, sourceType: 'storno', entryDate: '2026-12-31',
    reversesId: reversedYearEndId,
    lines: [
      { account: '8999', debit: 0, credit: 400 },
      { account: '2099', debit: 400, credit: 0 },
    ],
  })
  await insertJournalEntry({
    ...ctx, voucherNumber: 9, sourceType: 'correction', entryDate: '2026-12-31',
    correctionOfId: reversedYearEndId,
    lines: [
      { account: '6200', debit: 250, credit: 0 },
      { account: '1930', debit: 0, credit: 250 },
    ],
  })

  return { ...ctx, obEntryId }
}

describe('get_kpi_report_aggregates RPC', () => {
  it('tb covers posted and reversed period entries, excluding only the OB entry', async () => {
    const ctx = await seedFullScenario()
    const payload = await callRpc(ctx.companyId, ctx.fiscalPeriodId, ctx.obEntryId)
    const tb = byAccount(payload.tb)

    // OB entry excluded: 1930 period debit is 12500, not 17500; 2010 absent.
    expect(tb.get('1930')).toMatchObject({ debit: 12500, credit: 3250 })
    expect(tb.has('2010')).toBe(false)
    // Reversed manual entry included (posted + reversed base filter).
    expect(tb.get('3001')).toMatchObject({ debit: 0, credit: 10700 })
    expect(tb.get('2611')).toMatchObject({ debit: 0, credit: 2500 })
    expect(tb.get('5010')).toMatchObject({ debit: 3000, credit: 0 })
    // Year-end chain present in the plain tb.
    expect(tb.get('8999')).toMatchObject({ debit: 5400, credit: 400 })
    expect(tb.get('2099')).toMatchObject({ debit: 400, credit: 5400 })
    expect(tb.get('8910')).toMatchObject({ debit: 1000, credit: 0 })
    expect(tb.get('6200')).toMatchObject({ debit: 250, credit: 0 })
  })

  it('tb includes the OB entry when p_ob_entry_id is NULL, and ob is empty', async () => {
    const ctx = await seedFullScenario()
    const payload = await callRpc(ctx.companyId, ctx.fiscalPeriodId, null)

    expect(byAccount(payload.tb).get('1930')).toMatchObject({ debit: 17500, credit: 3250 })
    expect(byAccount(payload.tb).get('2010')).toMatchObject({ debit: 0, credit: 5000 })
    expect(payload.ob).toEqual([])
  })

  it('tb_ex_year_end drops year_end entries plus stornos/corrections of reversed year-ends', async () => {
    const ctx = await seedFullScenario()
    const payload = await callRpc(ctx.companyId, ctx.fiscalPeriodId, ctx.obEntryId)
    const tb = byAccount(payload.tb_ex_year_end)

    // Ordinary activity retained...
    expect(tb.get('3001')).toMatchObject({ debit: 0, credit: 10700 })
    expect(tb.get('5010')).toMatchObject({ debit: 3000, credit: 0 })
    expect(tb.get('8310')).toMatchObject({ debit: 0, credit: 200 })
    expect(tb.get('8410')).toMatchObject({ debit: 500, credit: 0 })
    // ...the whole year-end chain gone: year_end entries, the storno that
    // reverses one, and the correction that corrects one.
    expect(tb.has('8999')).toBe(false)
    expect(tb.has('2099')).toBe(false)
    expect(tb.has('8910')).toBe(false)
    expect(tb.has('2512')).toBe(false)
    expect(tb.has('6200')).toBe(false)
    // The correction's 1930 credit (250) disappears with it.
    expect(tb.get('1930')).toMatchObject({ debit: 12500, credit: 3000 })
  })

  it('keeps stornos/corrections that do not point at a reversed year-end', async () => {
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
        // Keep the posted storno balanced without changing the asserted P&L account.
        { account: '2999', debit: 100, credit: 0 },
      ],
    })

    const payload = await callRpc(ctx.companyId, ctx.fiscalPeriodId)
    // Only reversals of REVERSED year_end entries are chained out.
    expect(byAccount(payload.tb_ex_year_end).get('5010')).toMatchObject({
      debit: 100,
      credit: 100,
    })
  })

  it('ob sums the OB entry regardless of status, guarded by company', async () => {
    const ctx = await seedCompany()
    // Draft OB entry: getOpeningBalances has no status filter, neither may we.
    const draftOb = await insertJournalEntry({
      ...ctx, voucherNumber: 1, status: 'draft', sourceType: 'opening_balance',
      entryDate: '2026-01-01',
      lines: [
        { account: '1930', debit: 800, credit: 0 },
        { account: '2081', debit: 0, credit: 800 },
      ],
    })

    const payload = await callRpc(ctx.companyId, ctx.fiscalPeriodId, draftOb)
    expect(byAccount(payload.ob).get('1930')).toMatchObject({ debit: 800, credit: 0 })
    expect(byAccount(payload.ob).get('2081')).toMatchObject({ debit: 0, credit: 800 })
    // Draft entries never enter tb.
    expect(payload.tb).toEqual([])

    // Another company's entry id yields nothing (defense in depth for
    // service-role callers that bypass RLS).
    const other = await seedCompany()
    const foreign = await callRpc(other.companyId, other.fiscalPeriodId, draftOb)
    expect(foreign.ob).toEqual([])
  })

  it('monthly counts posted and reversed originals, 8999 excluded, class 8 sign-split per line', async () => {
    const ctx = await seedFullScenario()
    const payload = await callRpc(ctx.companyId, ctx.fiscalPeriodId, ctx.obEntryId)

    // January: revenue only (class 2 VAT line ignored).
    expect(monthOf(payload, 2026, 1)).toMatchObject({ income: 10000, expenses: 0 })
    // February: the reversed 3001 entry (700) IS counted, exactly as it is in
    // tb_ex_year_end (3001 credit 10700). Before 20260903160000 the monthly
    // section dropped reversed originals while keeping their stornos, so the
    // months stopped summing to the year total (issue #2201).
    expect(monthOf(payload, 2026, 2)).toMatchObject({ income: 700, expenses: 3000 })
    // March: 8310 credit 200 -> income; 8410 debit 500 -> expenses.
    expect(monthOf(payload, 2026, 3)).toMatchObject({ income: 200, expenses: 500 })
    // December: year_end entries ARE excluded from monthly as of migration
    // 20260730090000. Previously this month reported expenses 1250 (8910 debit
    // 1000 from the posted year_end entry plus the correction's 6200 debit
    // 250). Including them meant the resultatavslut charted the whole year's
    // revenue as NEGATIVE income in the fiscal-year-end month: measured on
    // production as 28 companies, worst case -10 347 459,81 kr in one month.
    // This fixture's December holds ONLY year-end-chain entries, so the month
    // disappears from the chart entirely, which is the correct operational
    // view: a month whose only activity is bokslut has no operating result.
    expect(monthOf(payload, 2026, 12)).toBeUndefined()
    // No phantom months, and no bokslut-only months.
    expect(payload.monthly.map((m) => m.month).sort((a, b) => a - b)).toEqual([1, 2, 3])
  })

  it('a same-year storno cancels within the year: sum(months) equals the tb_ex_year_end net result', async () => {
    const ctx = await seedCompany()
    // Ver 12 (March): 10 000 kr revenue on 3041, later reversed by storno in
    // April. The year total nets to 0; the months must do the same.
    const original = await insertJournalEntry({
      ...ctx, voucherNumber: 12, status: 'reversed', entryDate: '2026-03-10',
      lines: [
        { account: '3041', debit: 0, credit: 10000 },
        { account: '1930', debit: 10000, credit: 0 },
      ],
    })
    await insertJournalEntry({
      ...ctx, voucherNumber: 13, sourceType: 'storno', entryDate: '2026-04-02',
      reversesId: original,
      lines: [
        { account: '3041', debit: 10000, credit: 0 },
        { account: '1930', debit: 0, credit: 10000 },
      ],
    })

    const payload = await callRpc(ctx.companyId, ctx.fiscalPeriodId)

    // Year total: the original and the storno both count, netting to 0.
    expect(byAccount(payload.tb_ex_year_end).get('3041')).toMatchObject({ debit: 10000, credit: 10000 })
    // Months: March carries the revenue, April carries the reversal.
    expect(monthOf(payload, 2026, 3)).toMatchObject({ income: 10000, expenses: 0 })
    expect(monthOf(payload, 2026, 4)).toMatchObject({ income: -10000, expenses: 0 })
    const monthsNet = payload.monthly.reduce((sum, m) => sum + m.income - m.expenses, 0)
    const yearNet = payload.tb_ex_year_end
      .filter((t) => /^[3-8]/.test(t.account_number))
      .reduce((sum, t) => sum + t.credit - t.debit, 0)
    expect(monthsNet).toBe(0)
    expect(monthsNet).toBe(yearNet)
  })

  it('scopes to the requested company and returns empty sections for an empty one', async () => {
    const a = await seedFullScenario()
    const b = await seedCompany()

    const payload = await callRpc(b.companyId, b.fiscalPeriodId)
    expect(payload.tb).toEqual([])
    expect(payload.tb_ex_year_end).toEqual([])
    expect(payload.ob).toEqual([])
    expect(payload.monthly).toEqual([])

    // And company A's data is intact when asked for correctly.
    const payloadA = await callRpc(a.companyId, a.fiscalPeriodId, a.obEntryId)
    expect(payloadA.tb.length).toBeGreaterThan(0)
  })

  it('SECURITY INVOKER: a member reads sums, a non-member gets empty sections under RLS', async () => {
    const ctx = await seedFullScenario()
    const outsider = await seedCompany() // member of their own company only

    const asMember = await withUserContext(ctx.userId, async (client) => {
      const { rows } = await client.query(
        `SELECT public.get_kpi_report_aggregates($1, $2, $3) AS payload`,
        [ctx.companyId, ctx.fiscalPeriodId, ctx.obEntryId],
      )
      return rows[0].payload as RpcPayload
    })
    expect(byAccount(asMember.tb).get('3001')).toMatchObject({ debit: 0, credit: 10700 })
    expect(byAccount(asMember.ob).get('1930')).toMatchObject({ debit: 5000, credit: 0 })

    const asOutsider = await withUserContext(outsider.userId, async (client) => {
      const { rows } = await client.query(
        `SELECT public.get_kpi_report_aggregates($1, $2, $3) AS payload`,
        [ctx.companyId, ctx.fiscalPeriodId, ctx.obEntryId],
      )
      return rows[0].payload as RpcPayload
    })
    expect(asOutsider.tb).toEqual([])
    expect(asOutsider.tb_ex_year_end).toEqual([])
    expect(asOutsider.ob).toEqual([])
    expect(asOutsider.monthly).toEqual([])
  })
})
