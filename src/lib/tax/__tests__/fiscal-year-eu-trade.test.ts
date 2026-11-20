import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  fiscalYearsWithEuTrade,
  needsEuTradeEvidence,
  readEuTradeChecks,
  readRecordedEuTradeYears,
  recordEuTradeChecks,
} from '../fiscal-year-eu-trade'
import { loadVatDeclarationLedger } from '@/lib/reports/vat-declaration'
import { createRowsMockSupabase, createTableMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/reports/vat-declaration', () => ({ loadVatDeclarationLedger: vi.fn() }))

const ledger = vi.mocked(loadVatDeclarationLedger)
const supabase = {} as SupabaseClient
const rutor = (over: Record<string, number> = {}) => ({ rutor: { ruta20: 0, ruta21: 0, ruta37: 0, ruta35: 0, ruta38: 0, ruta39: 0, ...over } })

beforeEach(() => {
  vi.clearAllMocks()
})

describe('fiscalYearsWithEuTrade', () => {
  it('reads each year from its start through the last day of its end month, and names the years with EU trade', async () => {
    ledger.mockImplementation(async (_s, _c, start) => (start === '2025-07-01' ? rutor({ ruta21: 448.41 }) : rutor()) as never)

    const found = await fiscalYearsWithEuTrade(
      supabase,
      'company-1',
      [
        { start: '2025-07-01', endYear: 2026, endMonth: 6 },
        { start: '2024-01-01', endYear: 2024, endMonth: 2 },
      ],
      '2026-11-14',
    )

    expect(found).toEqual(['2026-06'])
    expect(ledger.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      ['2025-07-01', '2026-06-30'],
      ['2024-01-01', '2024-02-29'],
    ])
  })

  it('does not read a year that has not started', async () => {
    ledger.mockResolvedValue(rutor({ ruta39: 1200 }) as never)

    expect(await fiscalYearsWithEuTrade(supabase, 'company-1', [{ start: '2027-01-01', endYear: 2027, endMonth: 12 }], '2026-11-14')).toEqual([])
    expect(ledger).not.toHaveBeenCalled()
  })

  it('throws on a failed read: the caller decides what it means', async () => {
    ledger.mockRejectedValue(new Error('statement timeout'))

    await expect(
      fiscalYearsWithEuTrade(supabase, 'company-1', [{ start: '2026-01-01', endYear: 2026, endMonth: 12 }], '2026-11-14'),
    ).rejects.toThrow(/statement timeout/)
  })
})

describe('needsEuTradeEvidence', () => {
  it('reads the books only for a VAT-registered yearly filer that has not said it trades within the EU', () => {
    expect(needsEuTradeEvidence({ vat_registered: true, moms_period: 'yearly', vat_has_eu_trade: false })).toBe(true)
    expect(needsEuTradeEvidence({ vat_registered: true, moms_period: 'yearly', vat_has_eu_trade: true })).toBe(false)
    expect(needsEuTradeEvidence({ vat_registered: true, moms_period: 'quarterly', vat_has_eu_trade: false })).toBe(false)
    expect(needsEuTradeEvidence({ vat_registered: false, moms_period: 'yearly', vat_has_eu_trade: false })).toBe(false)
  })
})

describe('readRecordedEuTradeYears', () => {
  it('reads the periods recorded with EU trade, grouped by company, or one company\'s', async () => {
    const { supabase, findCalls } = createTableMockSupabase({
      vat_eu_trade_fiscal_years: {
        data: [
          { company_id: 'company-1', fiscal_year_end: '2025-12', has_eu_trade: true, checked_at: '2026-01-02T02:00:00Z' },
          { company_id: 'company-2', fiscal_year_end: '2026-06', has_eu_trade: true, checked_at: '2026-07-02T02:00:00Z' },
          { company_id: 'company-1', fiscal_year_end: '2026-12', has_eu_trade: true, checked_at: '2026-11-02T02:00:00Z' },
        ],
      },
    })

    const all = await readRecordedEuTradeYears(supabase as unknown as SupabaseClient)
    expect(all.available).toBe(true)
    expect(Object.fromEntries(all.byCompany)).toEqual({ 'company-1': ['2025-12', '2026-12'], 'company-2': ['2026-06'] })
    expect(findCalls('vat_eu_trade_fiscal_years', 'eq')).toEqual([['has_eu_trade', true]])

    await readRecordedEuTradeYears(supabase as unknown as SupabaseClient, 'company-1')
    expect(findCalls('vat_eu_trade_fiscal_years', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('reads a missing table as nothing recorded: code deployed before its migration', async () => {
    for (const code of ['42P01', 'PGRST205']) {
      const { supabase } = createTableMockSupabase({
        vat_eu_trade_fiscal_years: { error: { code, message: 'no such table' } },
      })
      const read = await readRecordedEuTradeYears(supabase as unknown as SupabaseClient)
      expect(read.available).toBe(false)
      expect(read.byCompany.size).toBe(0)
    }
  })

  it('throws on any other failure: no date is placed on a guess', async () => {
    const { supabase } = createTableMockSupabase({
      vat_eu_trade_fiscal_years: { error: { code: '57014', message: 'canceling statement due to statement timeout' } },
    })
    await expect(readRecordedEuTradeYears(supabase as unknown as SupabaseClient)).rejects.toThrow(/statement timeout/)
  })
})

describe('readEuTradeChecks', () => {
  it('gives the pass every period read, with and without EU trade, and when', async () => {
    const { supabase, findCalls } = createTableMockSupabase({
      vat_eu_trade_fiscal_years: {
        data: [
          { company_id: 'company-1', fiscal_year_end: '2026-12', has_eu_trade: false, checked_at: '2026-11-13T02:00:00Z' },
          { company_id: 'company-2', fiscal_year_end: '2026-12', has_eu_trade: true, checked_at: '2026-11-01T02:00:00Z' },
        ],
      },
    })

    const checks = await readEuTradeChecks(supabase as unknown as SupabaseClient)

    expect(checks.available).toBe(true)
    expect(Object.fromEntries(checks.recorded)).toEqual({ 'company-2': ['2026-12'] })
    expect(checks.checkedAt.get('company-1')?.get('2026-12')).toBe('2026-11-13T02:00:00Z')
    expect(findCalls('vat_eu_trade_fiscal_years', 'eq')).toEqual([])
  })
})

describe('recordEuTradeChecks', () => {
  const NOW = new Date('2026-11-14T02:00:00.000Z')

  it('records a period with EU trade for good, over an earlier no', async () => {
    const { supabase, findCalls } = createTableMockSupabase({ vat_eu_trade_fiscal_years: { data: null } })

    await recordEuTradeChecks(supabase as unknown as SupabaseClient, 'company-1', [{ key: '2026-12', hasEuTrade: true }], NOW)

    expect(findCalls('vat_eu_trade_fiscal_years', 'upsert')).toEqual([
      [
        [{ company_id: 'company-1', fiscal_year_end: '2026-12', has_eu_trade: true, checked_at: NOW.toISOString() }],
        { onConflict: 'company_id,fiscal_year_end' },
      ],
    ])
    expect(findCalls('vat_eu_trade_fiscal_years', 'update')).toEqual([])
  })

  it('writes a period without EU trade as read, and never over a yes', async () => {
    const { supabase, findCalls } = createTableMockSupabase({ vat_eu_trade_fiscal_years: { data: null } })

    await recordEuTradeChecks(supabase as unknown as SupabaseClient, 'company-1', [{ key: '2026-12', hasEuTrade: false }], NOW)

    // A new period is inserted; an existing row keeps its answer.
    expect(findCalls('vat_eu_trade_fiscal_years', 'upsert')).toEqual([
      [
        [{ company_id: 'company-1', fiscal_year_end: '2026-12', has_eu_trade: false, checked_at: NOW.toISOString() }],
        { onConflict: 'company_id,fiscal_year_end', ignoreDuplicates: true },
      ],
    ])
    // Only a row that says no gets the new read time.
    expect(findCalls('vat_eu_trade_fiscal_years', 'update')).toEqual([[{ checked_at: NOW.toISOString() }]])
    expect(findCalls('vat_eu_trade_fiscal_years', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['has_eu_trade', false],
    ])
    expect(findCalls('vat_eu_trade_fiscal_years', 'in')).toEqual([['fiscal_year_end', ['2026-12']]])
  })

  it('writes nothing for no periods', async () => {
    const writes: { table: string; method: string; row: unknown }[] = []
    const { supabase } = createRowsMockSupabase({ vat_eu_trade_fiscal_years: [] }, writes)

    await recordEuTradeChecks(supabase as unknown as SupabaseClient, 'company-1', [])

    expect(writes).toEqual([])
  })

  it('throws on a failed write', async () => {
    const { supabase } = createTableMockSupabase({
      vat_eu_trade_fiscal_years: { error: { code: '23503', message: 'violates foreign key constraint' } },
    })
    await expect(
      recordEuTradeChecks(supabase as unknown as SupabaseClient, 'company-1', [{ key: '2026-12', hasEuTrade: true }]),
    ).rejects.toThrow(/foreign key/)
  })
})
