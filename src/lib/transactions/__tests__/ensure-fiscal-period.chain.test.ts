import { beforeEach, describe, expect, it } from 'vitest'
import { createRowsMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { ensureFiscalPeriod, resolveCategorizeContext } from '../categorize-core'

/**
 * The bank door's räkenskapsår: once a company has recorded years the next one
 * chains from them, and fiscal_year_start_month only fills what nothing
 * records. Some companies have a settings month out of step with their
 * recorded year.
 */
const COMPANY = 'company-1'
const USER = 'user-1'

const year = (id: string, start: string, end: string, overrides: Record<string, unknown> = {}) => ({
  id,
  company_id: COMPANY,
  name: id,
  period_start: start,
  period_end: end,
  is_closed: false,
  locked_at: null,
  previous_period_id: null,
  ...overrides,
})

type Written = { name: string; period_start: string; period_end: string; previous_period_id?: string | null }

async function minted(
  periods: ReturnType<typeof year>[],
  date: string,
  settingsMonth: number,
  entityType = 'aktiebolag',
) {
  const writes: { table: string; method: string; row: unknown }[] = []
  const { supabase } = createRowsMockSupabase({
    fiscal_periods: periods,
    companies: [{ id: COMPANY, entity_type: entityType }],
    company_settings: [{ company_id: COMPANY, bookkeeping_locked_through: null }],
  }, writes)
  const ok = await ensureFiscalPeriod(supabase as never, USER, COMPANY, date, settingsMonth)
  const created = writes.filter((w) => w.table === 'fiscal_periods' && (w.method === 'insert' || w.method === 'upsert'))
  return { ok, created: created.map((w) => w.row as Written), writes }
}

const dates = (rows: Written[]) => rows.map((row) => [row.period_start, row.period_end])

beforeEach(() => {
  eventBus.clear()
})

describe('ensureFiscalPeriod chains from the recorded years', () => {
  const brokenYear = year('fy', '2025-07-01', '2026-06-30')

  it('takes the next year from the latest one when the settings month is out of step', async () => {
    const { created } = await minted([{ ...brokenYear }], '2026-08-05', 1)
    expect(dates(created)).toEqual([['2026-07-01', '2027-06-30']])
    expect(created[0].previous_period_id).toBe('fy')
    expect(created[0].name).toBe('Räkenskapsår 2026/2027')
  })

  it('leaves no gap for a date past the calendar year the setting names', async () => {
    const { created } = await minted([{ ...brokenYear }], '2027-01-05', 1)
    expect(dates(created)).toEqual([['2026-07-01', '2027-06-30']])
  })

  it('reads a recorded calendar year over a settings month that says otherwise', async () => {
    const { created } = await minted([year('fy', '2026-01-01', '2026-12-31')], '2027-01-05', 9)
    expect(dates(created)).toEqual([['2027-01-01', '2027-12-31']])
  })

  it('follows a short first year with a whole one', async () => {
    const { created } = await minted([year('fy', '2025-03-10', '2026-01-31')], '2026-02-03', 1)
    expect(dates(created)).toEqual([['2026-02-01', '2027-01-31']])
  })

  it('creates every year up to the date, so the chain has no hole', async () => {
    const { created } = await minted([year('fy', '2023-01-01', '2023-12-31')], '2025-03-10', 1)
    expect(dates(created)).toEqual([
      ['2024-01-01', '2024-12-31'],
      ['2025-01-01', '2025-12-31'],
    ])
    expect(created[0].previous_period_id).toBe('fy')
    expect(created[1].previous_period_id).toBeTruthy()
  })

  it('fills a gap between two years, up to the next one', async () => {
    const { created, writes } = await minted(
      [year('fy2023', '2023-01-01', '2023-12-31'), year('fy2025', '2025-01-01', '2025-12-31')],
      '2024-05-05',
      7,
    )
    expect(dates(created)).toEqual([['2024-01-01', '2024-12-31']])
    // The year after it now follows it, as every other door leaves the chain.
    expect(writes.find((w) => w.method === 'update')?.row).toMatchObject({ previous_period_id: expect.any(String) })
  })

  it('writes nothing for a date in a closed year: the booking meets its lock', async () => {
    const { ok, created } = await minted([year('fy', '2025-07-01', '2026-06-30', { is_closed: true })], '2026-03-01', 1)
    expect(ok).toBe(true)
    expect(created).toEqual([])
  })

  it('never mints a year for a date before the first one', async () => {
    const { ok, created } = await minted([year('fy', '2026-05-12', '2026-12-31')], '2026-03-10', 1)
    expect(ok).toBe(true)
    expect(created).toEqual([])
  })

  it('stops at a date too far ahead to be a real one', async () => {
    const { ok, created } = await minted([year('fy', '2026-01-01', '2026-12-31')], '2099-03-10', 1)
    expect(ok).toBe(false)
    expect(created).toEqual([])
  })
})

describe('ensureFiscalPeriod with nothing recorded', () => {
  it('fills from the settings month', async () => {
    const { created } = await minted([], '2026-03-05', 7)
    expect(dates(created)).toEqual([['2025-07-01', '2026-06-30']])
    expect(created[0].previous_period_id ?? null).toBeNull()
  })

  it('gives a calendar year on a calendar setting', async () => {
    const { created } = await minted([], '2026-03-05', 1)
    expect(dates(created)).toEqual([['2026-01-01', '2026-12-31']])
  })

  it('does not take a day out of the first of a month in a zone west of Greenwich', async () => {
    const { created } = await minted([], '2026-07-01', 7)
    expect(dates(created)).toEqual([['2026-07-01', '2027-06-30']])
  })
})

describe('ensureFiscalPeriod in an enskild firma', () => {
  it('chains a calendar year onto a calendar year', async () => {
    const { created } = await minted([year('fy', '2026-01-01', '2026-12-31')], '2027-02-01', 1, 'enskild_firma')
    expect(dates(created)).toEqual([['2027-01-01', '2027-12-31']])
  })

  it('reads January whatever the settings month says', async () => {
    const { supabase } = createRowsMockSupabase({
      company_settings: [{ company_id: COMPANY, entity_type: 'enskild_firma', fiscal_year_start_month: 9, vat_registered: true }],
    })
    const resolved = await resolveCategorizeContext(supabase as never, COMPANY, { is_business: true, category: 'expense_other' })
    expect(resolved).toMatchObject({ ok: true, context: { fiscalYearStartMonth: 1 } })
  })
})

describe('ensureFiscalPeriod across a hole wider than a year', () => {
  it('fills from the left edge up to the date, the rest of the hole stays', async () => {
    const { created, writes } = await minted(
      [year('fy2022', '2022-01-01', '2022-12-31'), year('fy2026', '2026-01-01', '2026-12-31')],
      '2024-05-05',
      1,
    )
    expect(dates(created)).toEqual([
      ['2023-01-01', '2023-12-31'],
      ['2024-01-01', '2024-12-31'],
    ])
    expect(created[0].previous_period_id).toBe('fy2022')
    expect(writes.some((w) => w.method === 'update')).toBe(false)
  })

  it('caps the last year at the next recorded one', async () => {
    const { created, writes } = await minted(
      [year('fy2023', '2023-01-01', '2023-12-31'), year('fy2025', '2025-07-01', '2026-06-30')],
      '2025-03-01',
      1,
    )
    expect(dates(created)).toEqual([
      ['2024-01-01', '2024-12-31'],
      ['2025-01-01', '2025-06-30'],
    ])
    expect(writes.find((w) => w.method === 'update')?.row).toMatchObject({ previous_period_id: expect.any(String) })
  })
})
