/**
 * What the nightly helårsmoms pass writes (recordEuTradeChecks) and what the
 * deadline generator and the pass read back (readRecordedEuTradeYears,
 * readEuTradeChecks), through a real supabase-js client and a real PostgREST:
 * the upsert and the guarded update are PostgREST requests, so a mocked client
 * cannot show that a no never overwrites a yes. The table's own rules are in
 * tests/pg/vat-eu-trade-fiscal-years.pg.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { seedCompany } from '@/tests/pg/fixtures'
import { getPool } from '@/tests/pg/setup'
import { readEuTradeChecks, readRecordedEuTradeYears, recordEuTradeChecks } from '@/lib/tax/fiscal-year-eu-trade'
import { createToolPgClient } from './client'

const answers = async (companyId: string) =>
  (
    await getPool().query(
      'SELECT fiscal_year_end, has_eu_trade, checked_at FROM public.vat_eu_trade_fiscal_years WHERE company_id = $1 ORDER BY fiscal_year_end',
      [companyId],
    )
  ).rows as Array<{ fiscal_year_end: string; has_eu_trade: boolean; checked_at: Date }>

describe('helårsmoms EU-trade reads over PostgREST', () => {
  it('writes each read, turns a no into a yes and never a yes into a no', async () => {
    const { companyId } = await seedCompany()
    const supabase = createToolPgClient()

    await recordEuTradeChecks(supabase, companyId, [
      { key: '2025-12', hasEuTrade: false },
      { key: '2026-12', hasEuTrade: false },
    ], new Date('2026-11-15T00:01:00Z'))
    await recordEuTradeChecks(supabase, companyId, [{ key: '2026-12', hasEuTrade: true }], new Date('2026-11-16T00:01:00Z'))
    await recordEuTradeChecks(supabase, companyId, [
      { key: '2025-12', hasEuTrade: false },
      { key: '2026-12', hasEuTrade: false },
    ], new Date('2026-11-17T00:01:00Z'))

    const rows = await answers(companyId)
    expect(rows.map((row) => [row.fiscal_year_end, row.has_eu_trade, row.checked_at.toISOString()])).toEqual([
      // A no read again gets the new read time.
      ['2025-12', false, '2026-11-17T00:01:00.000Z'],
      // A yes keeps its answer and the time it was found.
      ['2026-12', true, '2026-11-16T00:01:00.000Z'],
    ])

    expect((await readRecordedEuTradeYears(supabase, companyId)).byCompany.get(companyId)).toEqual(['2026-12'])
    const checks = await readEuTradeChecks(supabase)
    expect(checks.recorded.get(companyId)).toEqual(['2026-12'])
    expect(checks.checkedAt.get(companyId)?.get('2025-12')).toMatch(/^2026-11-17T00:01:00/)
  })
})
