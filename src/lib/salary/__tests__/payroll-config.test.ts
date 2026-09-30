import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { loadPayrollConfig, PayrollConfigMissingError } from '../payroll-config'

/** salary_payroll_config lookup answering one fixed maybeSingle() result. */
function mockConfigLookup(result: { data: Record<string, unknown> | null; error: unknown }) {
  const calls: Array<{ column: string; value: unknown }> = []
  const chain = {
    select: () => chain,
    eq: (column: string, value: unknown) => {
      calls.push({ column, value })
      return chain
    },
    maybeSingle: async () => result,
  }
  const supabase = { from: () => chain } as unknown as SupabaseClient
  return { supabase, calls }
}

describe('loadPayrollConfig', () => {
  it('maps the year row', async () => {
    const { supabase, calls } = mockConfigLookup({
      data: { config_year: 2026, prisbasbelopp: 59200, bilforman_slr: 0.0255, avgifter_total: 0.3142 },
      error: null,
    })
    const config = await loadPayrollConfig(supabase, 2026)
    expect(calls).toEqual([{ column: 'config_year', value: 2026 }])
    expect(config.configYear).toBe(2026)
    expect(config.prisbasbelopp).toBe(59200)
    expect(config.bilformanSlr).toBe(0.0255)
    expect(config.avgifterTotal).toBe(0.3142)
  })

  it('refuses a year without a row by name', async () => {
    const { supabase } = mockConfigLookup({ data: null, error: null })
    const failure = await loadPayrollConfig(supabase, 2027).catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(PayrollConfigMissingError)
    expect((failure as PayrollConfigMissingError).code).toBe('SALARY_PAYROLL_CONFIG_MISSING')
    expect((failure as PayrollConfigMissingError).year).toBe(2027)
  })

  it('propagates a failed read instead of calling it missing rates', async () => {
    const dbError = { code: '57014', message: 'canceling statement due to statement timeout' }
    const { supabase } = mockConfigLookup({ data: null, error: dbError })
    const failure = await loadPayrollConfig(supabase, 2026).catch((err: unknown) => err)
    expect(failure).toBe(dbError)
    expect(failure).not.toBeInstanceOf(PayrollConfigMissingError)
  })
})

describe('SALARY_PAYROLL_CONFIG_MISSING', () => {
  it('reaches agents by name, as a permanent failure with the registry text', () => {
    const structured = getStructuredError(new PayrollConfigMissingError(2027))
    expect(structured.code).toBe('SALARY_PAYROLL_CONFIG_MISSING')
    expect(structured.retryable).toBe(false)
    expect(structured.message_sv).toBe(getErrorEntry('SALARY_PAYROLL_CONFIG_MISSING')?.message_sv)
    expect(structured.message_en).toContain('2027')
    expect(structured.remediation?.description).toBeTruthy()
  })
})
