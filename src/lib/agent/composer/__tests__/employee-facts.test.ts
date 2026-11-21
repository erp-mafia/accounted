import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  loadActiveEmployeeCount,
  resolveEmployeeFacts,
  type EmployeeFacts,
} from '../employee-facts'

/**
 * The first readers of this fact selected `company_settings.employee_count`
 * and `company_settings.has_employees`. Neither column exists: `employee_count`
 * is on `agi_declarations`, `has_employees` is in no migration at all. PostgREST
 * rejects a select whole on 42703, so they got `null` for the ENTIRE settings
 * row.
 *
 * tests/schema/no-phantom-columns.test.ts proves the column names are now real.
 * This file proves the replacement reads the RIGHT ones: that a live headcount
 * wins, that an attested employer registration settles the question in both
 * directions, and above all that `pays_salaries === false` (a NOT NULL DEFAULT
 * false column whose only writer is the tax settings form) is never laundered
 * into "this company has no employees".
 */

const NOTHING_KNOWN: EmployeeFacts = {
  activeEmployees: null,
  ticEmployeeRange: null,
  employerRegistered: null,
  paysSalaries: null,
}

describe('resolveEmployeeFacts', () => {
  it('reports unknown when nothing is actually known', () => {
    expect(resolveEmployeeFacts(NOTHING_KNOWN)).toEqual({ kind: 'unknown' })
  })

  it('prefers a live headcount over every weaker signal', () => {
    expect(
      resolveEmployeeFacts({
        activeEmployees: 3,
        ticEmployeeRange: '5-9',
        employerRegistered: true,
        paysSalaries: true,
      })
    ).toEqual({ kind: 'count', count: 3 })
  })

  it('falls back to the Bolagsverket interval when no employee rows exist yet', () => {
    // A company that has not opened the payroll module has zero employee rows,
    // so zero must fall through rather than answer the question.
    expect(
      resolveEmployeeFacts({ ...NOTHING_KNOWN, activeEmployees: 0, ticEmployeeRange: '5-9' })
    ).toEqual({ kind: 'range', range: '5-9' })
  })

  it('treats a zero headcount as no evidence, not as "nej"', () => {
    expect(resolveEmployeeFacts({ ...NOTHING_KNOWN, activeEmployees: 0 })).toEqual({
      kind: 'unknown',
    })
  })

  it('accepts an attested employer registration in both directions', () => {
    expect(resolveEmployeeFacts({ ...NOTHING_KNOWN, employerRegistered: true })).toEqual({
      kind: 'employer',
      isEmployer: true,
    })
    expect(resolveEmployeeFacts({ ...NOTHING_KNOWN, employerRegistered: false })).toEqual({
      kind: 'employer',
      isEmployer: false,
    })
  })

  it('reads pays_salaries=true as evidence but pays_salaries=false as none', () => {
    // The column is NOT NULL DEFAULT false and no onboarding step sets it, so a
    // false is indistinguishable from "never answered". Answering "Nej" from it
    // would state a fact nobody entered.
    expect(resolveEmployeeFacts({ ...NOTHING_KNOWN, paysSalaries: true })).toEqual({
      kind: 'employer',
      isEmployer: true,
    })
    expect(resolveEmployeeFacts({ ...NOTHING_KNOWN, paysSalaries: false })).toEqual({
      kind: 'unknown',
    })
  })

  it('lets an attested registration override the pays_salaries default', () => {
    expect(
      resolveEmployeeFacts({ ...NOTHING_KNOWN, employerRegistered: true, paysSalaries: false })
    ).toEqual({ kind: 'employer', isEmployer: true })
  })
})

describe('loadActiveEmployeeCount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function mockClient(result: { count: number | null; error: unknown }) {
    const eq = vi.fn()
    const chain = {
      select: vi.fn(() => chain),
      eq,
    }
    eq.mockReturnValueOnce(chain).mockReturnValueOnce(Promise.resolve(result))
    const from = vi.fn(() => chain)
    return { client: { from } as unknown as SupabaseClient, from, chain }
  }

  it('counts only active employees for the company', async () => {
    const { client, from, chain } = mockClient({ count: 3, error: null })
    await expect(loadActiveEmployeeCount(client, 'company-1')).resolves.toBe(3)
    expect(from).toHaveBeenCalledWith('employees')
    expect(chain.select).toHaveBeenCalledWith('id', { count: 'exact', head: true })
    expect(chain.eq).toHaveBeenNthCalledWith(1, 'company_id', 'company-1')
    expect(chain.eq).toHaveBeenNthCalledWith(2, 'is_active', true)
  })

  it('returns null (not 0) when the count cannot be read', async () => {
    const { client } = mockClient({ count: null, error: { message: 'boom' } })
    await expect(loadActiveEmployeeCount(client, 'company-1')).resolves.toBeNull()
  })
})
