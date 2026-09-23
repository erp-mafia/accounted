import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { sweep, init } = vi.hoisted(() => ({ sweep: vi.fn(), init: vi.fn() }))
vi.mock('@/lib/reconciliation/unattended-sweep', async (load) => ({
  ...(await load<typeof import('@/lib/reconciliation/unattended-sweep')>()),
  runUnattendedReconciliationSweep: sweep,
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: init }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn() }))

import {
  runPendingSIEBankSweeps,
  sweepBankRowsAfterSIEImport,
  type SIEBankSweepJob,
} from '../sie-post-import-sweep'

const COMPANY = '11111111-1111-4111-8111-111111111111'
const IMPORT = '22222222-2222-4222-8222-222222222222'
const OWNER = '33333333-3333-4333-8333-333333333333'
const ACTOR = '44444444-4444-4444-8444-444444444444'

function job(overrides: Partial<SIEBankSweepJob> = {}): SIEBankSweepJob {
  return {
    id: IMPORT,
    company_id: COMPANY,
    user_id: OWNER,
    execution_actor_id: ACTOR,
    job_state: 'completed',
    job_kind: 'import',
    manifest: {},
    fiscal_year_start: '2026-01-01',
    fiscal_year_end: '2026-12-31',
    ...overrides,
  }
}

const sweepResult = {
  accounts: [],
  applied: 3,
  errors: 0,
  skippedBelowThreshold: 1,
  suggested: 1,
  unmatched: 2,
}

describe('sweepBankRowsAfterSIEImport', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>
  let supabase: SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.SIE_IMPORT_WORKER_PAUSED
    mock = createQueuedMockSupabase()
    supabase = mock.supabase as unknown as SupabaseClient
    sweep.mockResolvedValue(sweepResult)
  })

  it('claims, runs the matcher over the fiscal year as the executing user, and records the receipt', async () => {
    mock.enqueueMany([
      { data: true }, // claim_sie_import_bank_sweep
      { count: 7 }, // unlinked bank rows in the year
      { data: true }, // record_sie_import_bank_sweep
    ])

    const receipt = await sweepBankRowsAfterSIEImport(supabase, job())

    expect(mock.supabase.rpc).toHaveBeenNthCalledWith(1, 'claim_sie_import_bank_sweep', {
      p_company_id: COMPANY,
      p_import_id: IMPORT,
    })
    expect(init).toHaveBeenCalledTimes(1)
    expect(sweep).toHaveBeenCalledWith(supabase, COMPANY, ACTOR, {
      dateFrom: '2026-01-01',
      dateTo: '2026-12-31',
    })
    expect(receipt).toMatchObject({
      auto_linked: 3,
      suggested: 1,
      unmatched: 2,
      errors: 0,
      date_from: '2026-01-01',
      date_to: '2026-12-31',
    })
    expect(mock.supabase.rpc).toHaveBeenNthCalledWith(2, 'record_sie_import_bank_sweep', {
      p_company_id: COMPANY,
      p_import_id: IMPORT,
      p_summary: receipt,
    })
  })

  it('counts only rows the matcher would consider: unlinked, not ignored, dated in the year', async () => {
    mock.enqueueMany([{ data: true }, { count: 1 }, { data: true }])

    await sweepBankRowsAfterSIEImport(supabase, job())

    expect(mock.findCall('transactions', 'select')).toEqual(['id', { count: 'exact', head: true }])
    expect(mock.findCalls('transactions', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['is_ignored', false],
    ])
    expect(mock.findCall('transactions', 'is')).toEqual(['journal_entry_id', null])
    expect(mock.findCall('transactions', 'gte')).toEqual(['date', '2026-01-01'])
    expect(mock.findCall('transactions', 'lte')).toEqual(['date', '2026-12-31'])
  })

  it('skips the matcher, and still records a receipt, when the year holds no unlinked bank rows', async () => {
    mock.enqueueMany([{ data: true }, { count: 0 }, { data: true }])

    const receipt = await sweepBankRowsAfterSIEImport(supabase, job())

    expect(sweep).not.toHaveBeenCalled()
    expect(init).not.toHaveBeenCalled()
    expect(receipt).toMatchObject({ skipped: 'no_unlinked_bank_rows', auto_linked: 0, suggested: 0 })
    expect(mock.supabase.rpc).toHaveBeenLastCalledWith(
      'record_sie_import_bank_sweep',
      expect.objectContaining({ p_summary: receipt }),
    )
  })

  it('falls back to the import user and to the sealed manifest year', async () => {
    mock.enqueueMany([{ data: true }, { count: 2 }, { data: true }])

    await sweepBankRowsAfterSIEImport(
      supabase,
      job({
        execution_actor_id: null,
        fiscal_year_start: null,
        fiscal_year_end: null,
        manifest: { input: { fiscalYear: { start: '2025-07-01', end: '2026-06-30' } } },
      }),
    )

    expect(sweep).toHaveBeenCalledWith(supabase, COMPANY, OWNER, {
      dateFrom: '2025-07-01',
      dateTo: '2026-06-30',
    })
  })

  it('does nothing when another caller holds the claim', async () => {
    mock.enqueue({ data: false })

    expect(await sweepBankRowsAfterSIEImport(supabase, job())).toBeNull()

    expect(mock.supabase.rpc).toHaveBeenCalledTimes(1)
    expect(mock.supabase.from).not.toHaveBeenCalled()
    expect(sweep).not.toHaveBeenCalled()
  })

  it.each([
    ['an import that is not completed', { job_state: 'undone' as const }],
    ['a duplicate-repair job', { job_kind: 'duplicate_repair' as const }],
  ])('never touches the database for %s', async (_label, overrides) => {
    expect(await sweepBankRowsAfterSIEImport(supabase, job(overrides))).toBeNull()
    expect(mock.supabase.rpc).not.toHaveBeenCalled()
  })

  it('swallows a matcher failure and leaves the claim for the cron to retry', async () => {
    mock.enqueueMany([{ data: true }, { count: 4 }])
    sweep.mockRejectedValue(new Error('Kunde inte hämta kassakonton för avstämningssvepet'))

    await expect(sweepBankRowsAfterSIEImport(supabase, job())).resolves.toBeNull()

    // No receipt: state stays "running", which goes stale and is retried.
    expect(mock.supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('swallows a failed claim, a failed count and a client that throws', async () => {
    mock.enqueue({ error: { message: 'permission denied' } })
    await expect(sweepBankRowsAfterSIEImport(supabase, job())).resolves.toBeNull()

    mock.reset()
    mock.enqueueMany([{ data: true }, { error: { message: 'statement timeout' } }])
    await expect(sweepBankRowsAfterSIEImport(supabase, job())).resolves.toBeNull()
    expect(sweep).not.toHaveBeenCalled()

    const broken = {
      rpc: vi.fn().mockRejectedValue(new TypeError('fetch failed')),
    } as unknown as SupabaseClient
    await expect(sweepBankRowsAfterSIEImport(broken, job())).resolves.toBeNull()
  })

  it('still returns the receipt when only the recording fails', async () => {
    mock.enqueueMany([{ data: true }, { count: 3 }, { error: { message: 'connection reset' } }])

    expect(await sweepBankRowsAfterSIEImport(supabase, job())).toMatchObject({ auto_linked: 3 })
  })
})

describe('runPendingSIEBankSweeps', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>
  let supabase: SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.SIE_IMPORT_WORKER_PAUSED
    mock = createQueuedMockSupabase()
    supabase = mock.supabase as unknown as SupabaseClient
    sweep.mockResolvedValue(sweepResult)
  })

  it('nominates recent completed imports with no finished receipt and lets the claim decide', async () => {
    const done = { ...job({ id: '66666666-6666-4666-8666-666666666666' }), bank_sweep: { state: 'done' } }
    const unswept = { ...job(), bank_sweep: null }
    const stale = { ...job({ id: '55555555-5555-4555-8555-555555555555' }), bank_sweep: { state: 'running' } }
    mock.enqueueMany([
      { data: [done, unswept, stale] },
      { data: true }, // unswept: claimed
      { count: 0 },
      { data: true },
      { data: false }, // running: the claim RPC says it is not stale yet
    ])

    const result = await runPendingSIEBankSweeps({ supabase })

    expect(result).toEqual({ considered: 2, swept: 1 })
    expect(mock.supabase.rpc).not.toHaveBeenCalledWith(
      'claim_sie_import_bank_sweep',
      expect.objectContaining({ p_import_id: done.id }),
    )
    expect(mock.findCalls('sie_imports', 'eq')).toEqual([
      ['job_state', 'completed'],
      ['job_kind', 'import'],
    ])
    const since = mock.findCall('sie_imports', 'gte') as [string, string]
    expect(since[0]).toBe('imported_at')
    const ageMs = Date.now() - new Date(since[1]).getTime()
    expect(ageMs).toBeGreaterThan(23.9 * 3_600_000)
    expect(ageMs).toBeLessThan(24.1 * 3_600_000)
  })

  it('honours the worker pause switch', async () => {
    process.env.SIE_IMPORT_WORKER_PAUSED = 'true'

    expect(await runPendingSIEBankSweeps({ supabase })).toEqual({ considered: 0, swept: 0 })
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('never throws when the listing fails', async () => {
    mock.enqueue({ error: { message: 'boom' } })

    await expect(runPendingSIEBankSweeps({ supabase })).resolves.toEqual({ considered: 0, swept: 0 })
  })
})
