import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCronRequest } from '@/tests/helpers'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => ({ rpc }) }))

import { GET } from '../route'

const PATH = '/api/reports/ledger-account-days/build/cron'

/** A pending company of `entries` verifikat (small unless said). */
type Pending = string | [string, number]

/** pending (then unfolded) answer the given batches in turn, then nothing. */
function serve(
  batches: Pending[][],
  errors: Record<string, { code: string; message: string }> = {},
  unfoldedBatches: string[][] = [],
) {
  const pending = batches.map((batch) =>
    batch.map((p) => (typeof p === 'string' ? { company_id: p, entry_count: 100 } : { company_id: p[0], entry_count: p[1] })),
  )
  const unfolded = [...unfoldedBatches]
  rpc.mockImplementation(async (fn: string, args: { p_company_id?: string }) => {
    if (fn === 'ledger_account_days_pending') return { data: pending.shift() ?? [], error: null }
    if (fn === 'ledger_account_days_unfolded') return { data: unfolded.shift() ?? [], error: null }
    if (fn === 'build_ledger_account_days' || fn === 'compact_ledger_account_days') {
      const error = errors[`${fn}:${args.p_company_id ?? ''}`]
      return error ? { data: null, error } : { data: 12, error: null }
    }
    return { data: null, error: { message: `unexpected rpc ${fn}` } }
  })
}

describe('GET /api/reports/ledger-account-days/build/cron', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('CRON_SECRET', 'cron-secret')
    // Midday in Stockholm unless a test says otherwise.
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-23T10:00:00Z'))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns 401 without the cron secret', async () => {
    const response = await GET(createCronRequest(PATH, 'Bearer wrong'))
    expect(response.status).toBe(401)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('builds every pending company, one call each, until none is left', async () => {
    serve([['c1', 'c2'], ['c3']])
    const response = await GET(createCronRequest(PATH, 'Bearer cron-secret'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { built: 3, compacted: 0, skipped: 0, deferred: 0 } })
    const builds = rpc.mock.calls.filter(([fn]) => fn === 'build_ledger_account_days').map(([, args]) => args)
    expect(builds).toEqual([{ p_company_id: 'c1' }, { p_company_id: 'c2' }, { p_company_id: 'c3' }])
  })

  it('skips a company whose build fails (a lock wait that timed out) and does not retry it in the same run', async () => {
    // The failed company is still pending, so the next pending read returns it again.
    serve([['c1', 'c2'], ['c2']], {
      'build_ledger_account_days:c2': { code: '55P03', message: 'canceling statement due to lock timeout' },
    })
    const response = await GET(createCronRequest(PATH, 'Bearer cron-secret'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { built: 1, compacted: 0, skipped: 1, deferred: 0 } })
    const builds = rpc.mock.calls.filter(([fn]) => fn === 'build_ledger_account_days')
    expect(builds).toHaveLength(2)
  })

  it('leaves a large company for the night: its postings wait for its build', async () => {
    serve([['c1', ['big1', 60_000], ['big2', 150_000]]])
    const response = await GET(createCronRequest(PATH, 'Bearer cron-secret'))
    expect(await response.json()).toEqual({ data: { built: 1, compacted: 0, skipped: 0, deferred: 2 } })
    const builds = rpc.mock.calls.filter(([fn]) => fn === 'build_ledger_account_days').map(([, args]) => args)
    expect(builds).toEqual([{ p_company_id: 'c1' }])
  })

  it('builds a large company between midnight and 05:00 Stockholm time', async () => {
    // 02:30 in Stockholm (CEST).
    vi.setSystemTime(new Date('2026-10-23T00:30:00Z'))
    serve([[['big1', 60_000]]])
    const response = await GET(createCronRequest(PATH, 'Bearer cron-secret'))
    expect(await response.json()).toEqual({ data: { built: 1, compacted: 0, skipped: 0, deferred: 0 } })
  })

  it('folds the slot rows of every company that has them', async () => {
    serve([], {}, [['c7', 'c8']])
    const response = await GET(createCronRequest(PATH, 'Bearer cron-secret'))
    expect(await response.json()).toEqual({ data: { built: 0, compacted: 2, skipped: 0, deferred: 0 } })
    const compactions = rpc.mock.calls.filter(([fn]) => fn === 'compact_ledger_account_days').map(([, args]) => args)
    expect(compactions).toEqual([{ p_company_id: 'c7' }, { p_company_id: 'c8' }])
  })

  it('does nothing when every company is built and folded', async () => {
    serve([])
    const response = await GET(createCronRequest(PATH, 'Bearer cron-secret'))
    expect(await response.json()).toEqual({ data: { built: 0, compacted: 0, skipped: 0, deferred: 0 } })
    expect(rpc).toHaveBeenCalledTimes(2)
  })
})
