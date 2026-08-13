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
import { eventBus } from '@/lib/events'
import { applyAccountOverride } from '../account-override'
import { buildMappingResultFromCategory } from '../category-mapping'
import { buildTransactionEntryLines } from '../transaction-entries'
import type { MappingResult, Transaction } from '@/types'

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
  eventBus.clear()
})

describe('applyAccountOverride', () => {
  it('replaces the DEBIT side when money goes out (amount < 0)', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: chartRow() })

    const result = await applyAccountOverride(supabase as never, 'company-1', '4020', -479, mapping(), true)

    expect(result.debit_account).toBe('4020')
    expect(result.credit_account).toBe('1930')
    expect(result.vat_lines).toHaveLength(1)
  })

  it('replaces the CREDIT side when money comes in (amount > 0)', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: chartRow({ account_number: '3021', account_class: 3 }) })

    const result = await applyAccountOverride(
      supabase as never, 'company-1', '3021', 479,
      mapping({ debit_account: '1930', credit_account: '3001' }), true,
    )

    expect(result.debit_account).toBe('1930')
    expect(result.credit_account).toBe('3021')
  })

  it('throws with an actionable message when the account is not in the chart', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: null })

    await expect(
      applyAccountOverride(supabase as never, 'company-1', '4020', -479, mapping(), true),
    ).rejects.toThrow(/finns inte i kontoplanen/)
  })

  it('throws with an activation hint when the account exists but is inactive', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: chartRow({ is_active: false }) })

    await expect(
      applyAccountOverride(supabase as never, 'company-1', '4020', -479, mapping(), true),
    ).rejects.toThrow(/inaktivt/)
  })

  it('drops auto-VAT lines for a class-2 override outside the moms-line range', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: chartRow({ account_number: '2894', account_class: 2 }) })

    const result = await applyAccountOverride(supabase as never, 'company-1', '2894', -479, mapping(), true)

    expect(result.debit_account).toBe('2894')
    expect(result.vat_lines).toEqual([])
  })

  it('keeps auto-VAT lines for a class-2 override inside 2610-2649 (moms-line accounts)', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: chartRow({ account_number: '2641', account_class: 2 }) })

    const result = await applyAccountOverride(supabase as never, 'company-1', '2641', -479, mapping(), true)

    expect(result.debit_account).toBe('2641')
    expect(result.vat_lines).toHaveLength(1)
  })

  it('drops auto-VAT for ANY override without explicit VAT intent (VMB class-3/4 hole)', async () => {
    // Swedish compliance review finding: VMB accounts live in class 3/4, so
    // the class-2 drop alone let a forgotten vat_treatment attach the
    // category-default standard_25 moms leg to a margin-scheme account: an
    // ingående-moms deduction the caller never asked for (ML 2023:200).
    // Without explicit VAT intent the override must book gross: forgetting
    // the flag under-deducts (lawful), never over-deducts.
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: chartRow() }) // 4020, class 4

    const result = await applyAccountOverride(supabase as never, 'company-1', '4020', -479, mapping(), false)

    expect(result.debit_account).toBe('4020')
    expect(result.vat_lines).toEqual([])
  })

  it('keeps the entry balanced at GROSS when a class-2 override clears the VAT lines', async () => {
    // The Swedish compliance review asked for this invariant explicitly: the
    // business-line amount is derived from vat_lines inside
    // buildTransactionEntryLines, so clearing them books gross, never an
    // unbalanced net + missing VAT leg (BFL 5 kap balanced-entry requirement).
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: chartRow({ account_number: '2894', account_class: 2 }) })

    const tx = {
      id: 'tx-1',
      company_id: 'company-1',
      date: '2026-07-10',
      amount: -479,
      currency: 'SEK',
      description: 'Second hand',
    } as Transaction

    let mr = buildMappingResultFromCategory('expense_other', tx, true, 'aktiebolag', 'standard_25')
    expect(mr.vat_lines).toHaveLength(1)
    mr = await applyAccountOverride(supabase as never, 'company-1', '2894', tx.amount, mr, true)

    const lines = buildTransactionEntryLines(tx, mr)
    const totalDebit = lines.reduce((s, l) => s + (l.debit_amount ?? 0), 0)
    const totalCredit = lines.reduce((s, l) => s + (l.credit_amount ?? 0), 0)
    expect(totalDebit).toBe(479)
    expect(totalCredit).toBe(479)
    expect(lines.find((l) => l.account_number === '2894')?.debit_amount).toBe(479)
    expect(lines.some((l) => l.account_number === '2641')).toBe(false)
  })

  it('refuses a degenerate entry where both sides land on the same account', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: chartRow({ account_number: '1930', account_class: 1 }) })

    await expect(
      applyAccountOverride(supabase as never, 'company-1', '1930', -479, mapping(), true),
    ).rejects.toThrow(/samma konto/)
  })
})
