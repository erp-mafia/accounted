import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it, expect } from 'vitest'
import { buildCases, POST_CASE_ID, type BenchContext } from '../perf/bench/cases'
import { checkBudgets, percentile, type Budgets, type CaseResult } from '../perf/bench/results'

const budgets = JSON.parse(
  readFileSync(path.join(__dirname, '../perf/bench/budgets.json'), 'utf8'),
) as Budgets

const period = (year: number) => ({
  id: `00000000-0000-4000-8000-00000000${year}`,
  start: `${year}-01-01`,
  end: `${year}-12-31`,
  obEntryId: null,
})

const ctx: BenchContext = {
  companyId: 'c0000000-0000-4000-8000-000000000001',
  userId: 'a0000000-0000-4000-8000-000000000001',
  today: '2026-10-22',
  periods: { '2024': period(2024), '2025': period(2025), '2026': period(2026) },
  cashAccountId: 'ca000000-0000-4000-8000-000000000001',
  accountPageCursor: { afterDate: '2026-08-01', afterVoucher: 30000, afterLineId: 'l0000000-0000-4000-8000-000000000001' },
  registerCursor: { afterSeries: 'A', afterNumber: 35000, afterId: 'e0000000-0000-4000-8000-000000000001' },
  drilldownAccount: '6212',
  ownVatAccounts: ['3041'],
  openBankRows: { ids: ['t0000000-0000-4000-8000-000000000001'], low: '2026-09-24', high: '2026-10-29' },
}

const result = (id: string, p95: number, extra: Partial<CaseResult> = {}): CaseResult => ({
  id, rpc: 'rpc', usedBy: '', n: 30, p50: p95 / 2, p95, max: p95, kB: 0, errors: 0, retried: 0, ...extra,
})

describe('report benchmark cases and budgets', () => {
  const cases = buildCases(ctx)

  it('gives every case a unique id', () => {
    const ids = cases.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).not.toContain(POST_CASE_ID)
  })

  it('budgets every case it runs, warm always and mixed unless the case is heavy', () => {
    const missing = cases.flatMap((c) => [
      ...(budgets.cases[c.id]?.warm === undefined ? [`${c.id}: warm`] : []),
      ...(!c.heavy && budgets.cases[c.id]?.mixed === undefined ? [`${c.id}: mixed`] : []),
    ])
    expect(missing).toEqual([])
    expect(budgets.cases[POST_CASE_ID]).toMatchObject({ warm: expect.any(Number), mixed: expect.any(Number) })
  })

  it('has no budget for a case that no longer exists', () => {
    const known = new Set([...cases.map((c) => c.id), POST_CASE_ID])
    expect(Object.keys(budgets.cases).filter((id) => !known.has(id))).toEqual([])
  })

  it('names only arguments the call sites pass, without undefined values', () => {
    for (const c of cases) {
      for (const [name, value] of Object.entries(c.args)) {
        expect(name, c.id).toMatch(/^p_[a-z0-9_]+$/)
        expect(value, `${c.id} ${name}`).not.toBeUndefined()
      }
    }
  })
})

describe('checkBudgets', () => {
  const b: Budgets = { cases: { fast: { warm: 10, mixed: 20 }, slow: { warm: 100 } } }

  it('passes a p95 at or under its budget', () => {
    expect(checkBudgets('warm', [result('fast', 10), result('slow', 99.9)], b)).toEqual([])
  })

  it('fails a p95 over its budget, and a case without one', () => {
    expect(checkBudgets('mixed', [result('fast', 20.1), result('slow', 1)], b)).toEqual([
      'fast: p95 20.1 ms is over its mixed budget of 20 ms',
      'slow: no mixed budget in budgets.json',
    ])
  })

  it('fails a case whose calls failed, whatever its times', () => {
    expect(checkBudgets('warm', [result('fast', 1, { errors: 1, error: 'canceling statement due to statement timeout' })], b))
      .toEqual(['fast: 1 call(s) failed: canceling statement due to statement timeout'])
  })
})

describe('percentile', () => {
  it('is nearest-rank', () => {
    const thirty = Array.from({ length: 30 }, (_, i) => i + 1)
    expect(percentile(thirty, 0.5)).toBe(15)
    expect(percentile(thirty, 0.95)).toBe(29)
    expect(percentile([7], 0.95)).toBe(7)
  })
})
