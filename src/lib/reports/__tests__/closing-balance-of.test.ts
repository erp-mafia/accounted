/**
 * closingBalanceOf: an account set's UB as the balance sheet reads it, on the
 * in-memory company of the measure tests (the real generateTrialBalance and
 * getOpeningBalances, the ledger RPCs computed from the same entries).
 */
import { describe, expect, it } from 'vitest'
import { createFakeLedger } from '@/lib/measures/__tests__/fake-ledger'
import { CO, FP, OB, fixtureData } from '@/lib/measures/__tests__/fixtures'
import { withCarriedForwardIb } from '@/lib/unexplained/__tests__/fixtures'
import { generateBalanceSheet } from '../balance-sheet'
import { closingBalanceOf } from '../trial-balance'

async function sheetAmount(l: ReturnType<typeof createFakeLedger>, account: string) {
  const bs = await generateBalanceSheet(l.supabase, CO, FP)
  return [...bs.asset_sections, ...bs.equity_liability_sections].flatMap((s) => s.rows).find((r) => r.account_number === account)!.amount
}

describe('closingBalanceOf', () => {
  it('counts a linked IB verifikat in the year once: IB 12 000 + 12 500 - 12 000', async () => {
    const l = createFakeLedger(fixtureData())
    expect(await closingBalanceOf(l.supabase, CO, FP, ['1510'])).toBe(12500)
    expect(await sheetAmount(l, '1510')).toBe(12500)
  })

  it('carries an IB from earlier years\' verifikat when the year has no IB verifikat (crm#1296)', async () => {
    const l = createFakeLedger(withCarriedForwardIb(fixtureData()))
    expect(await closingBalanceOf(l.supabase, CO, FP, ['1510'])).toBe(12500)
    expect(await sheetAmount(l, '1510')).toBe(12500)
  })

  it('a first year without any IB is the year\'s own lines', async () => {
    const base = fixtureData()
    const l = createFakeLedger({
      ...base,
      fiscalPeriods: base.fiscalPeriods.map((p) => ({ ...p, opening_balance_entry_id: null })),
      entries: base.entries.filter((e) => e.id !== OB),
    })
    expect(await closingBalanceOf(l.supabase, CO, FP, ['1510'])).toBe(500)
  })

  it('sums the accounts asked for, debit minus credit, and nothing else', async () => {
    const l = createFakeLedger(fixtureData())
    // 1513 has no IB or activity: it adds 0.
    expect(await closingBalanceOf(l.supabase, CO, FP, ['1510', '1513'])).toBe(12500)
    // A liability reads negative: credit-normal.
    expect(await closingBalanceOf(l.supabase, CO, FP, ['2440'])).toBe(-(await sheetAmount(l, '2440')))
  })
})
