/**
 * Which dates a VAT period covers (resolvePeriodDates). Helårsmoms is declared
 * per räkenskapsår (SFL 26 kap. 10-11 §§) and named by the year it ends, so a
 * yearly period is the recorded räkenskapsår ending in `year`. A year no
 * recorded räkenskapsår ends in has no helårsmoms period: it is refused,
 * naming the years that exist, instead of being computed as January to
 * December. Only a company with no räkenskapsår recorded at all keeps the
 * calendar year (it has no verifikat either). Monthly and quarterly periods
 * are calendar periods by law and never read the räkenskapsår.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createRowsMockSupabase } from '@/tests/helpers'
import { resolvePeriodDates } from '../vat-declaration'
import { buildVatSettlementProposal } from '../vat-settlement'

type Year = { id: string; company_id: string; period_start: string; period_end: string }

function books(years: Omit<Year, 'company_id'>[]) {
  const rows: Year[] = years.map((year) => ({ company_id: 'c', ...year }))
  // Another company's year, so a filter left off would show.
  rows.push({ id: 'other', company_id: 'c-other', period_start: '2025-01-01', period_end: '2025-12-31' })
  return createRowsMockSupabase({ fiscal_periods: rows }).supabase as never
}

/** An aktiebolag whose first räkenskapsår is extended: it starts mid-year and ends 31 December the next year. */
const EXTENDED_FIRST_YEAR = [{ id: 'fy-first', period_start: '2025-07-17', period_end: '2026-12-31' }]

afterEach(() => {
  vi.useRealTimers()
})

describe('resolvePeriodDates: helårsmoms follows the räkenskapsår', () => {
  it('refuses a year no räkenskapsår ends in, for an extended first year starting mid-year, naming the year that exists', async () => {
    const result = resolvePeriodDates(books(EXTENDED_FIRST_YEAR), 'c', 'yearly', 2025, 1)

    await expect(result).rejects.toMatchObject({
      code: 'VAT_REPORT_FISCAL_YEAR_NOT_FOUND',
      message: expect.stringContaining('2025-07-17..2026-12-31 (year 2026)'),
    })
    await expect(result).rejects.not.toMatchObject({ message: expect.stringContaining('2025-01-01') })
  })

  it('resolves the extended first year in full under the year it ends', async () => {
    await expect(resolvePeriodDates(books(EXTENDED_FIRST_YEAR), 'c', 'yearly', 2026, 1)).resolves.toEqual({
      start: '2025-07-17',
      end: '2026-12-31',
      source: 'fiscal_period',
    })
  })

  it('resolves a calendar räkenskapsår to January to December, as before', async () => {
    const supabase = books([
      { id: 'fy-2025', period_start: '2025-01-01', period_end: '2025-12-31' },
      { id: 'fy-2026', period_start: '2026-01-01', period_end: '2026-12-31' },
    ])

    await expect(resolvePeriodDates(supabase, 'c', 'yearly', 2025, 1)).resolves.toEqual({
      start: '2025-01-01',
      end: '2025-12-31',
      source: 'fiscal_period',
    })
  })

  it('resolves a broken räkenskapsår (April to March) by the year it ends, and refuses one not recorded', async () => {
    const supabase = books([
      { id: 'fy-2025', period_start: '2024-04-01', period_end: '2025-03-31' },
      { id: 'fy-2026', period_start: '2025-04-01', period_end: '2026-03-31' },
    ])

    await expect(resolvePeriodDates(supabase, 'c', 'yearly', 2026, 1)).resolves.toEqual({
      start: '2025-04-01',
      end: '2026-03-31',
      source: 'fiscal_period',
    })
    await expect(resolvePeriodDates(supabase, 'c', 'yearly', 2027, 1)).rejects.toMatchObject({
      code: 'VAT_REPORT_FISCAL_YEAR_NOT_FOUND',
      message: expect.stringContaining('2024-04-01..2025-03-31 (year 2025), 2025-04-01..2026-03-31 (year 2026)'),
    })
  })

  it('keeps the calendar year for a company with no räkenskapsår recorded at all', async () => {
    await expect(resolvePeriodDates(books([]), 'c', 'yearly', 2026, 1)).resolves.toEqual({
      start: '2026-01-01',
      end: '2026-12-31',
      source: 'calendar_fallback',
    })
  })

  it('resolves by the year when the fiscal period given is not one of the company\'s', async () => {
    const supabase = books(EXTENDED_FIRST_YEAR)

    await expect(resolvePeriodDates(supabase, 'c', 'yearly', 2026, 1, 'other')).resolves.toMatchObject({
      start: '2025-07-17',
      end: '2026-12-31',
    })
    await expect(resolvePeriodDates(supabase, 'c', 'yearly', 2025, 1, 'other')).rejects.toMatchObject({
      code: 'VAT_REPORT_FISCAL_YEAR_NOT_FOUND',
    })
  })

  it('throws on a failed read instead of answering the calendar year', async () => {
    const supabase = {
      from: () => {
        const chain: Record<string, unknown> = {}
        for (const m of ['select', 'eq', 'order']) chain[m] = () => chain
        chain.then = (resolve: (v: unknown) => void) => resolve({ data: null, error: { message: 'boom' } })
        return chain
      },
    } as never

    await expect(resolvePeriodDates(supabase, 'c', 'yearly', 2026, 1)).rejects.toThrow('fiscal_periods read failed: boom')
  })

  it.each([
    ['quarterly', 3, { start: '2025-07-01', end: '2025-09-30' }],
    ['monthly', 7, { start: '2025-07-01', end: '2025-07-31' }],
  ] as const)('keeps a %s period the calendar period, whatever the räkenskapsår', async (periodType, period, dates) => {
    await expect(resolvePeriodDates(books(EXTENDED_FIRST_YEAR), 'c', periodType, 2025, period)).resolves.toEqual({
      ...dates,
      source: 'calendar',
    })
  })
})

describe('buildVatSettlementProposal: no momsredovisning for a year that has no helårsmoms period', () => {
  it('refuses before reading the ledger', async () => {
    await expect(buildVatSettlementProposal(books(EXTENDED_FIRST_YEAR), 'c', 'yearly', 2025, 1)).rejects.toMatchObject({
      code: 'VAT_REPORT_FISCAL_YEAR_NOT_FOUND',
    })
  })
})
