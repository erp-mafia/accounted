import { describe, expect, it } from 'vitest'
import {
  FULL_MAX_CHARS,
  SUMMARY_MAX_CHARS,
  SUMMARY_ROW_LIMIT,
  runAcrossCompanies,
  summarizeCompanyResult,
} from '../runner'

const companies = [
  { companyId: 'a', name: 'A AB' },
  { companyId: 'b', name: 'B AB' },
  { companyId: 'c', name: 'C AB' },
  { companyId: 'd', name: 'D AB' },
  { companyId: 'e', name: 'E AB' },
  { companyId: 'f', name: 'F AB' },
]

const tick = () => new Promise((resolve) => setTimeout(resolve, 5))

describe('runAcrossCompanies', () => {
  it('runs every company, keeps input order and counts outcomes', async () => {
    const seen: string[] = []
    const run = await runAcrossCompanies(companies, async (company) => {
      seen.push(company.companyId)
      await tick()
      if (company.companyId === 'c') throw Object.assign(new Error('boom'), { code: 'BOOM' })
      return { id: company.companyId.toUpperCase() }
    })

    expect(run.results.map((row) => row.company.companyId)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(run.succeeded).toBe(5)
    expect(run.failed).toBe(1)
    expect(run.skipped).toEqual([])
    const failed = run.results[2]
    expect(failed.ok).toBe(false)
    if (!failed.ok) expect(failed.error).toEqual({ code: 'BOOM', message: 'boom' })
    const ok = run.results[0]
    expect(ok.ok).toBe(true)
    if (ok.ok) expect(ok.data).toEqual({ id: 'A' })
    expect(seen.sort()).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('never runs more than the pool size at once and caps the pool at 4', async () => {
    let inFlight = 0
    let peak = 0
    await runAcrossCompanies(
      companies,
      async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await tick()
        inFlight -= 1
        return null
      },
      { concurrency: 2 }
    )
    expect(peak).toBe(2)

    inFlight = 0
    peak = 0
    await runAcrossCompanies(
      companies,
      async () => {
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await tick()
        inFlight -= 1
        return null
      },
      { concurrency: 99 }
    )
    expect(peak).toBe(4)
  })

  it('reports a company that exceeds its own budget as TIMEOUT and keeps the others', async () => {
    const run = await runAcrossCompanies(
      companies.slice(0, 2),
      (company) =>
        company.companyId === 'a'
          ? new Promise((resolve) => setTimeout(() => resolve('late'), 60))
          : Promise.resolve('fast'),
      { perCompanyTimeoutMs: 10 }
    )
    expect(run.results[0].ok).toBe(false)
    if (!run.results[0].ok) expect(run.results[0].error.code).toBe('TIMEOUT')
    expect(run.results[1].ok).toBe(true)
  })

  it('skips companies not started before the total budget runs out', async () => {
    let clock = 0
    const run = await runAcrossCompanies(
      companies.slice(0, 3),
      async () => {
        clock += 100
        return 'done'
      },
      { concurrency: 1, totalTimeoutMs: 150, now: () => clock }
    )
    // First company starts at t=0, second at t=100 (still inside), third at
    // t=200 (outside): skipped, never invoked.
    expect(run.results.map((row) => row.company.companyId)).toEqual(['a', 'b'])
    expect(run.skipped.map((company) => company.companyId)).toEqual(['c'])
  })

  it('handles an empty scope', async () => {
    const run = await runAcrossCompanies([], async () => 1)
    expect(run).toMatchObject({ results: [], skipped: [], succeeded: 0, failed: 0 })
  })
})

describe('summarizeCompanyResult', () => {
  it('summary mode keeps scalars, the summary object and the first rows of the first array', () => {
    const value = {
      period: { from: '2026-01-01', to: '2026-03-31' },
      summary: { total: 10 },
      transactions: Array.from({ length: 12 }, (_, i) => ({ id: i })),
      other: [1, 2, 3],
      count: 12,
      note: 'x',
      nested: { deep: true },
      next: { tool: 'x' },
    }
    const { data, truncated } = summarizeCompanyResult(value, 'summary')
    expect(truncated).toBe(false)
    expect(data).toEqual({
      period: value.period,
      summary: { total: 10 },
      transactions: value.transactions.slice(0, SUMMARY_ROW_LIMIT),
      transactions_count: 12,
      other_count: 3,
      count: 12,
      note: 'x',
    })
  })

  it('full mode returns the value unchanged inside the budget', () => {
    const value = { rows: [1, 2, 3], nested: { a: 1 } }
    expect(summarizeCompanyResult(value, 'full')).toEqual({ data: value, truncated: false })
  })

  it('trims an oversized payload and flags it', () => {
    const big = { text: 'x'.repeat(FULL_MAX_CHARS + 100) }
    const full = summarizeCompanyResult(big, 'full')
    expect(full.truncated).toBe(true)
    expect((full.data as { preview: string }).preview.length).toBe(FULL_MAX_CHARS)

    const summary = summarizeCompanyResult({ text: 'y'.repeat(SUMMARY_MAX_CHARS + 1) }, 'summary')
    expect(summary.truncated).toBe(true)
  })

  it('passes non-object values through', () => {
    expect(summarizeCompanyResult('ok', 'summary')).toEqual({ data: 'ok', truncated: false })
    expect(summarizeCompanyResult([1, 2], 'summary')).toEqual({ data: [1, 2], truncated: false })
  })
})
