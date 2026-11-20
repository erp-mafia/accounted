/**
 * gnubok_vat_close_check: a yearly deadline follows the period's own EU
 * trade (crm#1171, crm#1139).
 *
 * The reported company: aktiebolag, räkenskapsår 2025-10-19..2026-09-30,
 * helårsmoms, "Handel med andra EU-länder" off, and EU service purchases in
 * ruta 21. With EU trade helårsmoms is due the 26th of the second month after
 * the year end (26 November 2026), not on the inkomstdeklaration schedule
 * (17 August 2027). The setting is a statement about the books, so the
 * period's rutor answer it; the stored deadline rows still follow the
 * setting, which the eu_trade_setting_off finding says.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('@/lib/reconciliation/bank-reconciliation', () => ({
  getReconciliationStatus: vi.fn(async () => ({
    is_reconciled: true,
    difference: 0,
    unmatched_transaction_count: 0,
    unmatched_gl_line_count: 0,
  })),
}))

import { computeVatCloseCheck } from '@/lib/reports/vat-close-check'
import { euTradeInRutor, formatEuTradeBoxes, hasEuTrade } from '@/lib/vat/eu-trade'
import type { VatDeclarationRutor } from '@/types'

type Totals = Array<{ account_number: string; debit: number; credit: number }>

const EU_SERVICES = [
  { account_number: '2614', debit: 0, credit: 112.1 },
  { account_number: '2645', debit: 112.1, credit: 0 },
  { account_number: '4535', debit: 448.41, credit: 0 },
]
const NON_EU_SERVICES = [
  { account_number: '2614', debit: 0, credit: 4015.26 },
  { account_number: '2645', debit: 4015.26, credit: 0 },
  { account_number: '4531', debit: 16061.04, credit: 0 },
]

function mockSupabase(settings: Record<string, unknown>, totals: Totals) {
  const makeChain = (rows: unknown[]): Record<string, unknown> => {
    const chain: Record<string, unknown> = {}
    const settled = { data: rows, error: null, count: rows.length }
    chain.range = () => settled
    chain.single = async () => ({ data: rows[0] ?? null, error: null })
    chain.maybeSingle = async () => ({ data: rows[0] ?? null, error: null })
    chain.then = (resolve: (v: unknown) => void) => resolve(settled)
    for (const m of [
      'order', 'lte', 'gte', 'neq', 'in', 'eq', 'is', 'select',
      'limit', 'contains', 'filter', 'not', 'or',
    ]) {
      chain[m] = () => chain
    }
    return chain
  }
  return {
    from: (table: string) => {
      if (table === 'company_settings') return makeChain([settings])
      if (table === 'fiscal_periods') return makeChain([{ period_start: '2025-10-19', period_end: '2026-09-30' }])
      return makeChain([])
    },
    rpc: (fn: string) => {
      if (fn === 'get_vat_declaration_totals') {
        return Promise.resolve({
          data: { totals, settlement_shaped_entries: [], source_type_counts: {} },
          error: null,
        })
      }
      if (fn === 'verifikat_without_documents') {
        return Promise.resolve({ data: { ok: true, total_count: 0, verifikat: [] }, error: null })
      }
      return makeChain([])
    },
  } as never
}

const SETTINGS = {
  moms_period: 'yearly',
  vat_taxable_base_over_40m: false,
  entity_type: 'aktiebolag',
  fiscal_year_start_month: 10,
  vat_has_eu_trade: false,
  vat_filing_method: 'electronic',
}
const ARGS = { period_type: 'yearly', year: 2026, period: 1 }

describe('gnubok_vat_close_check: yearly deadline and EU trade in the books', () => {
  it('EU purchases in ruta 21 give the EU-trade deadline although the setting is off', async () => {
    const result = await computeVatCloseCheck(ARGS, 'company-1', mockSupabase(SETTINGS, [...EU_SERVICES, ...NON_EU_SERVICES]))

    expect(result.payment.deadline).toBe('2026-11-26')
    const finding = result.blockers.find((b) => b.kind === 'eu_trade_setting_off')
    expect(finding).toMatchObject({ severity: 'medium', count: 1 })
    expect(finding?.message).toContain('ruta 21: 448,41 kr')
    expect(finding?.message).toContain('26 november 2026')
    expect(finding?.hint).toContain('vat_has_eu_trade')
  })

  it('services bought outside the EU (ruta 22) keep the later deadline and raise nothing', async () => {
    const result = await computeVatCloseCheck(ARGS, 'company-1', mockSupabase(SETTINGS, NON_EU_SERVICES))

    expect(result.payment.deadline).toBe('2027-08-17')
    expect(result.blockers.find((b) => b.kind === 'eu_trade_setting_off')).toBeUndefined()
  })

  it('raises nothing when the setting already says EU trade', async () => {
    const result = await computeVatCloseCheck(
      ARGS, 'company-1', mockSupabase({ ...SETTINGS, vat_has_eu_trade: true }, EU_SERVICES),
    )

    expect(result.payment.deadline).toBe('2026-11-26')
    expect(result.blockers.find((b) => b.kind === 'eu_trade_setting_off')).toBeUndefined()
  })

  it('EU trade in the books makes the deadline known even without a filing method', async () => {
    const result = await computeVatCloseCheck(
      ARGS, 'company-1', mockSupabase({ ...SETTINGS, vat_has_eu_trade: null, vat_filing_method: null }, EU_SERVICES),
    )

    expect(result.payment.deadline).toBe('2026-11-26')
    expect(result.blockers.find((b) => b.kind === 'deadline_unavailable')).toBeUndefined()
  })
})

describe('euTradeInRutor', () => {
  const rutor = (values: Partial<VatDeclarationRutor>) => ({
    ruta20: 0, ruta21: 0, ruta37: 0, ruta35: 0, ruta38: 0, ruta39: 0, ...values,
  })

  it('splits purchases (20, 21, 37) from sales (35, 38, 39)', () => {
    expect(euTradeInRutor(rutor({ ruta20: 10, ruta21: 20, ruta37: 30, ruta35: 40, ruta38: 50, ruta39: 60 }))).toEqual({
      purchases: [{ ruta: '20', amount: 10 }, { ruta: '21', amount: 20 }, { ruta: '37', amount: 30 }],
      sales: [{ ruta: '35', amount: 40 }, { ruta: '38', amount: 50 }, { ruta: '39', amount: 60 }],
    })
  })

  it('counts a credit-note-negative box and ignores empty ones', () => {
    expect(hasEuTrade(rutor({}))).toBe(false)
    expect(hasEuTrade(rutor({ ruta39: -200 }))).toBe(true)
  })

  it('formats the boxes for a message', () => {
    expect(formatEuTradeBoxes(euTradeInRutor(rutor({ ruta39: 1200, ruta21: 448.41 }))))
      .toBe('ruta 21: 448,41 kr, ruta 39: 1 200,00 kr')
  })
})
