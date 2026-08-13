/**
 * applyAccountOverride: the shared override semantics behind the v1 REST
 * account_override and the MCP gnubok_categorize_transaction parameter.
 * The override replaces the business side of a category-derived mapping;
 * these tests pin side selection, chart validation, the class-2 VAT drop
 * (with the 2610-2649 moms-line exception), and the degenerate same-account
 * guard.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createMockSupabase } from '@/tests/helpers'
import { applyAccountOverride } from '../account-override'
import type { MappingResult } from '@/types'

const mapping = (over: Partial<MappingResult> = {}): MappingResult =>
  ({
    rule: null,
    debit_account: '6991',
    credit_account: '1930',
    risk_level: 'LOW',
    confidence: 1.0,
    requires_review: false,
    default_private: false,
    vat_lines: [
      { account_number: '2641', debit_amount: 100, credit_amount: 0, description: 'Ingående moms 25%' },
    ],
    description: 'Övrig kostnad: test',
    ...over,
  }) as MappingResult

const chartRow = (over: Record<string, unknown> = {}) => ({
  account_number: '4020',
  account_class: 4,
  is_active: true,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
})

describe('applyAccountOverride', () => {
  it('replaces the DEBIT side when money goes out (amount < 0)', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: chartRow() })

    const result = await applyAccountOverride(supabase as never, 'company-1', '4020', -479, mapping())

    expect(result.debit_account).toBe('4020')
    expect(result.credit_account).toBe('1930')
    expect(result.vat_lines).toHaveLength(1)
  })

  it('replaces the CREDIT side when money comes in (amount > 0)', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: chartRow({ account_number: '3021', account_class: 3 }) })

    const result = await applyAccountOverride(
      supabase as never, 'company-1', '3021', 479,
      mapping({ debit_account: '1930', credit_account: '3001' }),
    )

    expect(result.debit_account).toBe('1930')
    expect(result.credit_account).toBe('3021')
  })

  it('throws with an actionable message when the account is not in the chart', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: null })

    await expect(
      applyAccountOverride(supabase as never, 'company-1', '4020', -479, mapping()),
    ).rejects.toThrow(/finns inte i kontoplanen/)
  })

  it('throws with an activation hint when the account exists but is inactive', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: chartRow({ is_active: false }) })

    await expect(
      applyAccountOverride(supabase as never, 'company-1', '4020', -479, mapping()),
    ).rejects.toThrow(/inaktivt/)
  })

  it('drops auto-VAT lines for a class-2 override outside the moms-line range', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: chartRow({ account_number: '2894', account_class: 2 }) })

    const result = await applyAccountOverride(supabase as never, 'company-1', '2894', -479, mapping())

    expect(result.debit_account).toBe('2894')
    expect(result.vat_lines).toEqual([])
  })

  it('keeps auto-VAT lines for a class-2 override inside 2610-2649 (moms-line accounts)', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: chartRow({ account_number: '2641', account_class: 2 }) })

    const result = await applyAccountOverride(supabase as never, 'company-1', '2641', -479, mapping())

    expect(result.debit_account).toBe('2641')
    expect(result.vat_lines).toHaveLength(1)
  })

  it('refuses a degenerate entry where both sides land on the same account', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: chartRow({ account_number: '1930', account_class: 1 }) })

    await expect(
      applyAccountOverride(supabase as never, 'company-1', '1930', -479, mapping()),
    ).rejects.toThrow(/samma konto/)
  })
})
