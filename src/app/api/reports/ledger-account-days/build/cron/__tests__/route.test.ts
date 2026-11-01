import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createCronRequest } from '@/tests/helpers'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => ({ rpc }) }))

// The run's warn/error lines (accounted#115): only those two levels are
// swapped, every other export of the logger stays real.
const { logWarn, logError } = vi.hoisted(() => ({ logWarn: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return {
    ...actual,
    createLogger: (module: string, base?: Parameters<typeof actual.createLogger>[1]) => ({
      ...actual.createLogger(module, base),
      warn: logWarn,
      error: logError,
    }),
  }
})

import { GET } from '../route'

const PATH = '/api/reports/ledger-account-days/build/cron'

/** A pending company of `entries` verifikat (small unless said). */
type Pending = string | [string, number]

/** pending (then unfolded) answer the given batches in turn, then nothing. */
function serve(
  batches: Pending[][],
  errors: Record<string, { code: string; message: string }> = {},
  unfoldedBatches: string[][] = [],
  tagsets: { pending?: string[][]; unfolded?: string[][]; missing?: boolean } = {},
) {
  const pending = batches.map((batch) =>
    batch.map((p) => (typeof p === 'string' ? { company_id: p, entry_count: 100 } : { company_id: p[0], entry_count: p[1] })),
  )
  const unfolded = [...unfoldedBatches]
  const tagsetPending = [...(tagsets.pending ?? [])]
  const tagsetUnfolded = [...(tagsets.unfolded ?? [])]
  rpc.mockImplementation(async (fn: string, args: { p_company_id?: string }) => {
    if (fn === 'ledger_account_days_pending') return { data: pending.shift() ?? [], error: null }
    if (fn === 'ledger_account_days_unfolded') return { data: unfolded.shift() ?? [], error: null }
    if (fn === 'ledger_tagset_days_pending' || fn === 'ledger_tagset_days_unfolded') {
      // Before the migration reaches the database: PostgREST knows no such function.
      if (tagsets.missing) return { data: null, error: { code: 'PGRST202', message: `Could not find the function public.${fn}` } }
      return { data: (fn === 'ledger_tagset_days_pending' ? tagsetPending : tagsetUnfolded).shift() ?? [], error: null }
    }
    if (
      fn === 'build_ledger_account_days' ||
      fn === 'compact_ledger_account_days' ||
      fn === 'build_ledger_tagset_days' ||
      fn === 'compact_ledger_tagset_days'
    ) {
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
    expect(await response.json()).toEqual({ data: { built: 3, compacted: 0, skipped: 0, deferred: 0, tagsets_built: 0, tagsets_compacted: 0 } })
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
    expect(await response.json()).toEqual({ data: { built: 1, compacted: 0, skipped: 1, deferred: 0, tagsets_built: 0, tagsets_compacted: 0 } })
    const builds = rpc.mock.calls.filter(([fn]) => fn === 'build_ledger_account_days')
    expect(builds).toHaveLength(2)
    // The next run fixes a lock wait by itself: a warning, not an error.
    expect(logWarn).toHaveBeenCalledWith('ledger_account_days build skipped', { companyId: 'c2', code: '55P03' })
    expect(logError).not.toHaveBeenCalled()
  })

  it('logs a build that fails for any other reason as an error: it fails the same way every run (accounted#115)', async () => {
    serve([['c1', 'c2'], ['c2']], {
      'build_ledger_account_days:c2': { code: '57014', message: 'canceling statement due to statement timeout' },
    })
    const response = await GET(createCronRequest(PATH, 'Bearer cron-secret'))
    expect(await response.json()).toEqual({ data: { built: 1, compacted: 0, skipped: 1, deferred: 0, tagsets_built: 0, tagsets_compacted: 0 } })
    expect(logError).toHaveBeenCalledWith('ledger_account_days build failed', {
      companyId: 'c2',
      code: '57014',
      reason: 'canceling statement due to statement timeout',
    })
    expect(logWarn).not.toHaveBeenCalledWith('ledger_account_days build skipped', expect.anything())
  })

  it('leaves a large company for the night: its postings wait for its build', async () => {
    serve([['c1', ['big1', 60_000], ['big2', 150_000]]])
    const response = await GET(createCronRequest(PATH, 'Bearer cron-secret'))
    expect(await response.json()).toEqual({ data: { built: 1, compacted: 0, skipped: 0, deferred: 2, tagsets_built: 0, tagsets_compacted: 0 } })
    const builds = rpc.mock.calls.filter(([fn]) => fn === 'build_ledger_account_days').map(([, args]) => args)
    expect(builds).toEqual([{ p_company_id: 'c1' }])
  })

  it('builds a large company between midnight and 05:00 Stockholm time', async () => {
    // 02:30 in Stockholm (CEST).
    vi.setSystemTime(new Date('2026-10-23T00:30:00Z'))
    serve([[['big1', 60_000]]])
    const response = await GET(createCronRequest(PATH, 'Bearer cron-secret'))
    expect(await response.json()).toEqual({ data: { built: 1, compacted: 0, skipped: 0, deferred: 0, tagsets_built: 0, tagsets_compacted: 0 } })
  })

  it('folds the slot rows of every company that has them', async () => {
    serve([], {}, [['c7', 'c8']])
    const response = await GET(createCronRequest(PATH, 'Bearer cron-secret'))
    expect(await response.json()).toEqual({ data: { built: 0, compacted: 2, skipped: 0, deferred: 0, tagsets_built: 0, tagsets_compacted: 0 } })
    const compactions = rpc.mock.calls.filter(([fn]) => fn === 'compact_ledger_account_days').map(([, args]) => args)
    expect(compactions).toEqual([{ p_company_id: 'c7' }, { p_company_id: 'c8' }])
  })

  it('does nothing when every company is built and folded', async () => {
    serve([])
    const response = await GET(createCronRequest(PATH, 'Bearer cron-secret'))
    expect(await response.json()).toEqual({ data: { built: 0, compacted: 0, skipped: 0, deferred: 0, tagsets_built: 0, tagsets_compacted: 0 } })
    // Four listings: pending and unfolded, for the summaries and the tag sets.
    expect(rpc).toHaveBeenCalledTimes(4)
  })

  it('builds the tag sets of every listed company once, then folds their slots', async () => {
    serve([], {}, [], { pending: [['c1', 'c2'], ['c3']], unfolded: [['c2']] })
    const response = await GET(createCronRequest(PATH, 'Bearer cron-secret'))
    expect(await response.json()).toEqual({
      data: { built: 0, compacted: 0, skipped: 0, deferred: 0, tagsets_built: 3, tagsets_compacted: 1 },
    })
    const calls = rpc.mock.calls
      .filter(([fn]) => fn === 'build_ledger_tagset_days' || fn === 'compact_ledger_tagset_days')
      .map(([fn, args]) => [fn, args.p_company_id])
    expect(calls).toEqual([
      ['build_ledger_tagset_days', 'c1'],
      ['build_ledger_tagset_days', 'c2'],
      ['build_ledger_tagset_days', 'c3'],
      ['compact_ledger_tagset_days', 'c2'],
    ])
  })

  it('skips a tag set build that fails without failing the run', async () => {
    serve([], { 'build_ledger_tagset_days:c2': { code: '55P03', message: 'lock timeout' } }, [], { pending: [['c1', 'c2'], ['c2']] })
    const response = await GET(createCronRequest(PATH, 'Bearer cron-secret'))
    expect(await response.json()).toEqual({
      data: { built: 0, compacted: 0, skipped: 1, deferred: 0, tagsets_built: 1, tagsets_compacted: 0 },
    })
  })

  it('leaves the tag sets for a later run while their migration is not applied', async () => {
    serve([['c1']], {}, [], { missing: true })
    const response = await GET(createCronRequest(PATH, 'Bearer cron-secret'))
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      data: { built: 1, compacted: 0, skipped: 0, deferred: 0, tagsets_built: 0, tagsets_compacted: 0 },
    })
    expect(rpc.mock.calls.filter(([fn]) => fn === 'ledger_tagset_days_unfolded')).toHaveLength(0)
  })
})
