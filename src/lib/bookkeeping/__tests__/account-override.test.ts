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
import { reconcileRcBasisWithCostLines } from '../rc-basis-reconcile'
import { chartVatTreatmentsOf } from '../vat-entries'
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

  // Coded as the v1 categorize route answers for the same account_override,
  // so an MCP agent gets a refusal it can dispatch on, not UNKNOWN_ERROR.
  it('throws with an actionable message when the account is not in the chart', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: null })

    await expect(
      applyAccountOverride(supabase as never, 'company-1', '4020', -479, mapping(), true),
    ).rejects.toMatchObject({ code: 'TX_CATEGORIZE_INVALID_ACCOUNT', message: expect.stringMatching(/finns inte i kontoplanen/) })
  })

  it('throws with an activation hint when the account exists but is inactive', async () => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: chartRow({ is_active: false }) })

    await expect(
      applyAccountOverride(supabase as never, 'company-1', '4020', -479, mapping(), true),
    ).rejects.toMatchObject({ code: 'TX_CATEGORIZE_INVALID_ACCOUNT', message: expect.stringMatching(/inaktivt/) })
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

// #2919 / crm#1096: the category path books the 45xx/4598 basis pair for its
// own default cost account. applyAccountOverride leaves it as booked; the door
// then settles it on the account the cost line landed on, with the company's
// momskoder (reconcileRcBasisWithCostLines): an account that reports ruta
// 20-24 by itself loses the pair, or the declaration counts the purchase twice
// (RC_OUTPUT_MISSING); any other account keeps it.
describe('applyAccountOverride: reverse-charge basis pair', () => {
  const rcTx = { amount: -250, amount_sek: -250, currency: 'SEK', exchange_rate: 1, description: 'GOOGLE PLAY' } as Transaction
  const rcMapping = () => buildMappingResultFromCategory('expense_software', rcTx, true, 'aktiebolag', 'reverse_charge')

  const overridden = async (row: Record<string, unknown>, override: string) => {
    const { supabase, mockResult } = createMockSupabase()
    mockResult({ data: chartRow({ account_number: override, ...row }) })
    return applyAccountOverride(supabase as never, 'company-1', override, -250, rcMapping(), true)
  }
  const accountsAfter = async (row: Record<string, unknown>, override: string, treatment: string | null = null) =>
    reconcileRcBasisWithCostLines(
      await overridden(row, override),
      chartVatTreatmentsOf([{ account_number: override, default_vat_treatment: treatment }]),
    )
      .vat_lines.map((l) => l.account_number)

  it('leaves the pair as the category booked it: the door settles it on the final account', async () => {
    const result = await overridden({ account_class: 4 }, '4535')
    expect(result.debit_account).toBe('4535')
    expect(result.vat_lines.map((l) => l.account_number)).toEqual(['2645', '2614', '4535', '4598'])
  })

  it('keeps the pair on an ordinary cost account (the issue case, 6540)', async () => {
    expect(await accountsAfter({ account_class: 6 }, '6540'))
      .toEqual(['2645', '2614', '4535', '4598'])
  })

  it('drops the pair on a BAS basis account (4535 already reports ruta 21)', async () => {
    expect(await accountsAfter({ account_class: 4 }, '4535'))
      .toEqual(['2645', '2614'])
  })

  it('drops the pair on a cost account configured with a reverse_charge_* treatment', async () => {
    expect(await accountsAfter({ account_class: 6 }, '6541', 'reverse_charge_non_eu_services'))
      .toEqual(['2645', '2614'])
  })

  it('keeps the pair on a company 45xx account with no treatment (it reports no box)', async () => {
    expect(await accountsAfter({ account_class: 4 }, '4538'))
      .toEqual(['2645', '2614', '4535', '4598'])
  })

  it('the resulting verifikat balances with the pair dropped', async () => {
    const result = reconcileRcBasisWithCostLines(await overridden({ account_class: 4 }, '4531'), new Map())
    const lines = buildTransactionEntryLines(rcTx, result)
    const debit = lines.reduce((s, l) => s + l.debit_amount, 0)
    const credit = lines.reduce((s, l) => s + l.credit_amount, 0)
    expect(Math.round(debit * 100) / 100).toBe(Math.round(credit * 100) / 100)
    expect(lines.find((l) => l.account_number === '4531')?.debit_amount).toBe(250)
    expect(lines.some((l) => l.account_number === '4598')).toBe(false)
  })
})
