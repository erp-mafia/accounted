/**
 * Failing loudly: a measure that cannot be computed answers a typed refusal
 * with a Swedish sentence, never a zero. A transient database failure is
 * rethrown for the door to answer as retryable.
 */
import { describe, expect, it } from 'vitest'
import { explainMeasure, getMeasure, listMeasures } from '../registry'
import { MEASURE_IDS } from '../types'
import { MEASURE_ID_LIST } from '@/lib/operations/measures'
import { generateARLedger } from '@/lib/reports/ar-ledger'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { ACCOUNT_RUTA, RUTA_49_TERMS, rutorFromTotals } from '@/lib/reports/vat-declaration'
import { createFakeLedger, type FakeFailures } from './fake-ledger'
import { CO, FP, fixtureData } from './fixtures'

function ctxFor(overrides: Parameters<typeof fixtureData>[0] = {}, failures: FakeFailures = {}) {
  const ledger = createFakeLedger(fixtureData(overrides), failures)
  return { supabase: ledger.supabase, companyId: CO }
}

async function refusal(promise: ReturnType<typeof getMeasure>) {
  const outcome = await promise
  expect(outcome.ok).toBe(false)
  if (outcome.ok) throw new Error('expected a refusal')
  // Every code is registered with a Swedish message, and the runtime sentence is Swedish too.
  expect(getErrorEntry(outcome.code)?.thrown_message_sv).toBe(true)
  expect(outcome.messageSv.length).toBeGreaterThan(10)
  return outcome
}

describe('refusals', () => {
  it('an unknown measure lists the valid ids', async () => {
    const r = await refusal(getMeasure(ctxFor(), 'cash', {}))
    expect(r.code).toBe('MEASURE_NOT_FOUND')
    expect(r.details.valid).toEqual([...MEASURE_IDS])
  })

  it('vat_payable without a momsperiod asks for one instead of guessing', async () => {
    const r = await refusal(getMeasure(ctxFor(), 'vat_payable', {}))
    expect(r.code).toBe('MEASURE_PERIOD_REQUIRED')
    expect(r.messageSv).toContain('period_type')
  })

  it('a quarter that does not exist is refused', async () => {
    const r = await refusal(getMeasure(ctxFor(), 'vat_payable', { period_type: 'quarterly', year: 2026, period: 5 }))
    expect(r.code).toBe('MEASURE_RANGE_INVALID')
  })

  it('period_id is only for helårsmoms', async () => {
    const r = await refusal(getMeasure(ctxFor(), 'vat_payable', { period_type: 'monthly', year: 2026, period: 1, period_id: FP }))
    expect(r.code).toBe('MEASURE_PARAMETER_NOT_ACCEPTED')
  })

  it('a parameter the measure does not take is refused, not ignored', async () => {
    const r = await refusal(getMeasure(ctxFor(), 'accounts_receivable', { from_date: '2026-01-01' }))
    expect(r.code).toBe('MEASURE_PARAMETER_NOT_ACCEPTED')
    expect(r.details).toMatchObject({ refused: ['from_date'], accepted: ['as_of_date'] })
  })

  it('a date no fiscal period covers is refused, not answered as zero', async () => {
    const r = await refusal(getMeasure(ctxFor(), 'accounts_receivable', { as_of_date: '2024-06-30' }))
    expect(r.code).toBe('MEASURE_PERIOD_NOT_FOUND')
    expect(r.messageSv).toContain('2024-06-30')
  })

  it('a default date outside every fiscal period is refused too', async () => {
    const r = await refusal(getMeasure(ctxFor(), 'net_revenue', {}, { today: '2027-02-01' }))
    expect(r.code).toBe('MEASURE_PERIOD_NOT_FOUND')
  })

  it('a period_id that is not the company\'s is refused', async () => {
    const r = await refusal(getMeasure(ctxFor(), 'net_revenue', { period_id: 'f0000000-0000-4000-8000-000000009999' }))
    expect(r.code).toBe('MEASURE_PERIOD_NOT_FOUND')
  })

  it('a range outside the fiscal year is refused with the report\'s own sentence', async () => {
    const r = await refusal(getMeasure(ctxFor(), 'net_revenue', { period_id: FP, from_date: '2025-12-01' }))
    expect(r.code).toBe('MEASURE_RANGE_INVALID')
    expect(r.messageSv).toContain('räkenskapsåret')
  })

  it('a malformed as_of_date is refused', async () => {
    const r = await refusal(getMeasure(ctxFor(), 'unpaid_customer_invoices', { as_of_date: '2026-02-30' }))
    expect(r.code).toBe('MEASURE_RANGE_INVALID')
  })

  it('a country whose pack has no account for the role is refused, never read off BAS', async () => {
    for (const id of ['accounts_receivable', 'accounts_payable', 'bank_balance'] as const) {
      const r = await refusal(getMeasure(ctxFor({ jurisdiction: 'NO' }), id, { as_of_date: '2026-06-30' }))
      expect(r.code).toBe('MEASURE_ACCOUNT_ROLE_UNAVAILABLE')
      expect(r.details).toMatchObject({ jurisdiction: 'NO' })
    }
  })

  it('an unreadable reskontra refuses where the report shows an empty one', async () => {
    const failures = { tables: { invoices: { message: 'permission denied for table invoices', code: '42501' } } }
    const ctx = ctxFor({}, failures)
    const r = await refusal(getMeasure(ctx, 'unpaid_customer_invoices', {}))
    expect(r.code).toBe('MEASURE_SOURCE_FAILED')
    // The report, on the same failure, answers the plausible wrong number the measure refuses.
    expect((await generateARLedger(ctx.supabase, CO)).total_outstanding).toBe(0)
  })

  it('an unreadable momsdeklaration refuses', async () => {
    const failures = { rpcs: { get_vat_declaration_totals: { message: 'function does not exist', code: '42883' } } }
    const r = await refusal(getMeasure(ctxFor({}, failures), 'vat_payable', { period_type: 'quarterly', year: 2026, period: 1 }))
    expect(r.code).toBe('MEASURE_SOURCE_FAILED')
    expect(r.details).toMatchObject({ report: 'Momsdeklaration (SKV 4700)' })
  })

  it('a transient failure is rethrown, so the door answers it as retryable', async () => {
    const failures = { rpcs: { get_trial_balance_aggregates: { message: 'canceling statement due to statement timeout', code: '57014' } } }
    await expect(getMeasure(ctxFor({}, failures), 'accounts_receivable', { as_of_date: '2026-06-30' })).rejects.toThrow(/statement timeout/)
  })

  it('explain refuses the same way', async () => {
    const outcome = await explainMeasure(ctxFor(), 'vat_payable', {})
    expect(outcome.ok === false && outcome.code).toBe('MEASURE_PERIOD_REQUIRED')
  })
})

describe('the registry', () => {
  it('lists every measure with a definition, parameters and the report it equals', () => {
    const list = listMeasures()
    expect(list.map((m) => m.measure_id)).toEqual([...MEASURE_IDS])
    for (const m of list) {
      expect(m.definition.length, m.measure_id).toBeGreaterThan(80)
      expect(m.definition_sv.length, m.measure_id).toBeGreaterThan(80)
      expect(m.parameters.length, m.measure_id).toBeGreaterThan(0)
      expect(m.equals.mcp_tool, m.measure_id).toMatch(/^gnubok_/)
      expect(m.equals.v1_path, m.measure_id).toMatch(/^\/reports\//)
      expect(`${m.definition}${m.definition_sv}${m.name_sv}`, m.measure_id).not.toMatch(/[\u2013\u2014]/)
    }
  })

  it('keeps the id list the operation documents in step with the registry', () => {
    expect(MEASURE_ID_LIST).toBe(MEASURE_IDS.join(', '))
  })

  it('RUTA_49_TERMS is the sum rutorFromTotals files as ruta 49', () => {
    const totals = new Map(
      Object.keys(ACCOUNT_RUTA).map((account, i) => [account, { debit: (i * 37) % 101, credit: (i * 53) % 97 }]),
    )
    const rutor = rutorFromTotals(totals)
    const fromTerms = RUTA_49_TERMS.reduce((acc, term) => acc + term.sign * rutor[term.box], 0)
    expect(Math.round(fromTerms * 100) / 100).toBe(rutor.ruta49)
  })
})
