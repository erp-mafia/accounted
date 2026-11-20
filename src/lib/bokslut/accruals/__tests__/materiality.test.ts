/**
 * The accrual relief by the rules that apply to the company and the year:
 * K2 2.4/2.4A (BFNAR 2016:10, 7 000 kr from BFNAR 2025:2), K3 none, and the
 * förenklat årsbokslut forms (K1) 5 000 kr.
 */
import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import {
  accountingFrameworkForYear,
  accrualMateriality,
  bfnar20252Applies,
} from '../materiality'

const year = (start: string, end: string) => ({ period_start: start, period_end: end })

describe('bfnar20252Applies (BFNAR 2025:2 transition rule 1)', () => {
  it.each([
    { fy: year('2025-01-01', '2025-12-31'), applies: false },
    { fy: year('2025-07-01', '2026-06-30'), applies: false },
    { fy: year('2026-01-01', '2026-12-31'), applies: true },
    { fy: year('2026-05-01', '2027-04-30'), applies: true },
    // A förlängt first year beginning after 2025-06-30 that ends 2026-12-31 or later.
    { fy: year('2025-09-01', '2026-12-31'), applies: true },
    { fy: year('2025-07-01', '2026-12-31'), applies: true },
    // Begins after 2025-06-30 but ends before 2026-12-31: old rules.
    { fy: year('2025-09-01', '2026-08-31'), applies: false },
  ])('$fy.period_start..$fy.period_end: $applies', ({ fy, applies }) => {
    expect(bfnar20252Applies(fy)).toBe(applies)
  })
})

describe('accrualMateriality', () => {
  const FY_2025 = year('2025-01-01', '2025-12-31')
  const FY_2026 = year('2026-01-01', '2026-12-31')
  const FY_2027 = year('2027-01-01', '2027-12-31')

  it('K2 aktiebolag and ekonomisk förening: 5 000 kr, then 7 000 kr', () => {
    expect(accrualMateriality({ entityType: 'aktiebolag', framework: 'k2', fiscalYear: FY_2025 })).toEqual({ regelverk: 'K2', limitSek: 5_000 })
    expect(accrualMateriality({ entityType: 'aktiebolag', framework: 'k2', fiscalYear: FY_2026 })).toEqual({ regelverk: 'K2', limitSek: 7_000 })
    expect(accrualMateriality({ entityType: 'ekonomisk_forening', framework: 'k2', fiscalYear: FY_2026 })).toEqual({ regelverk: 'K2', limitSek: 7_000 })
  })

  it('K3: no blanket limit in any year', () => {
    for (const fiscalYear of [FY_2025, FY_2026]) {
      expect(accrualMateriality({ entityType: 'aktiebolag', framework: 'k3', fiscalYear })).toEqual({ regelverk: 'K3', limitSek: null })
    }
  })

  it('förenklat årsbokslut forms (K1): 5 000 kr in every year, whatever the framework column says', () => {
    for (const entityType of ['enskild_firma', 'ideell_forening'] as const) {
      for (const fiscalYear of [FY_2025, FY_2026, FY_2027]) {
        expect(accrualMateriality({ entityType, framework: 'k2', fiscalYear })).toEqual({ regelverk: 'K1', limitSek: 5_000 })
      }
    }
  })

  it('unknown form or framework falls back to K2', () => {
    expect(accrualMateriality({ entityType: null, framework: null, fiscalYear: FY_2026 })).toEqual({ regelverk: 'K2', limitSek: 7_000 })
  })
})

describe('accountingFrameworkForYear', () => {
  it('reads the company framework', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: { accounting_framework: 'k3' } })
    await expect(accountingFrameworkForYear(mock.supabase as never, 'co-1', 'fp-1')).resolves.toBe('k3')
    expect(mock.findCalls('companies', 'eq')).toEqual([['id', 'co-1']])
  })

  it('returns null on a read error or an unknown value', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ error: { message: 'boom' } })
    mock.enqueue({ data: { accounting_framework: 'ifrs' } })
    await expect(accountingFrameworkForYear(mock.supabase as never, 'co-1', 'fp-1')).resolves.toBeNull()
    await expect(accountingFrameworkForYear(mock.supabase as never, 'co-1', 'fp-1')).resolves.toBeNull()
  })
})
