import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn() }))

import { runSIEWorker, sweepStalledSIEJobs, type SIEStalledJob } from '../sie-job-worker'

const stalled = (over: Partial<SIEStalledJob> = {}): SIEStalledJob => ({
  importId: 'import-1',
  companyId: 'company-1',
  jobKind: 'import',
  phase: 'vouchers',
  state: 'reconciling',
  outcome: 'retrying',
  reason: 'lease_lapsed',
  consecutiveFailures: 1,
  attempt: 4,
  holdReleased: false,
  ...over,
})

function client(answers: Record<string, { data?: unknown; error?: { message: string; code?: string } | null }>) {
  const rpc = vi.fn(async (name: string) => ({ data: null, error: null, ...answers[name] }))
  return { supabase: { rpc } as unknown as SupabaseClient, rpc }
}

describe('sweepStalledSIEJobs (accounted#115)', () => {
  beforeEach(() => vi.clearAllMocks())

  it('logs every counted job as an error with its context', async () => {
    const jobs = [
      stalled(),
      stalled({ importId: 'import-2', outcome: 'failed', reason: 'actor_not_member', state: 'failed', holdReleased: true }),
      stalled({ importId: 'import-3', outcome: 'paused', reason: 'yielded_without_progress', state: 'paused', consecutiveFailures: 32 }),
    ]
    const { supabase, rpc } = client({ sweep_stalled_sie_import_jobs: { data: jobs } })
    const logger = { warn: vi.fn(), error: vi.fn() }

    expect(await sweepStalledSIEJobs(supabase, logger)).toEqual(jobs)

    expect(rpc).toHaveBeenCalledWith('sweep_stalled_sie_import_jobs')
    expect(logger.error).toHaveBeenNthCalledWith(1, 'SIE job run ended without progress; counted as a failure', {
      alert: true, companyId: 'company-1', importId: 'import-1', jobKind: 'import', outcome: 'retrying',
      reason: 'lease_lapsed', state: 'reconciling', phase: 'vouchers', consecutiveFailures: 1, attempt: 4, holdReleased: false,
    })
    expect(logger.error).toHaveBeenNthCalledWith(2, 'SIE job actor can no longer write in the company; the job is stopped',
      expect.objectContaining({ alert: true, importId: 'import-2', outcome: 'failed', holdReleased: true }))
    expect(logger.error).toHaveBeenNthCalledWith(3, 'SIE job kept ending without progress; the job is stopped',
      expect.objectContaining({ alert: true, importId: 'import-3', outcome: 'paused', consecutiveFailures: 32 }))
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('stays quiet when nothing stalled', async () => {
    const { supabase } = client({ sweep_stalled_sie_import_jobs: { data: [] } })
    const logger = { warn: vi.fn(), error: vi.fn() }
    expect(await sweepStalledSIEJobs(supabase, logger)).toEqual([])
    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it.each(['PGRST202', '42883'])('only warns while the migration is not applied yet (%s)', async (code) => {
    const { supabase } = client({ sweep_stalled_sie_import_jobs: { error: { message: 'function not found', code } } })
    const logger = { warn: vi.fn(), error: vi.fn() }
    expect(await sweepStalledSIEJobs(supabase, logger)).toEqual([])
    expect(logger.warn).toHaveBeenCalledWith('SIE stall sweep is not installed yet; stalled jobs are not counted', { code })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('reports any other failure as an error and never throws', async () => {
    const { supabase } = client({ sweep_stalled_sie_import_jobs: { error: { message: 'canceling statement due to statement timeout', code: '57014' } } })
    const logger = { warn: vi.fn(), error: vi.fn() }
    expect(await sweepStalledSIEJobs(supabase, logger)).toEqual([])
    expect(logger.error).toHaveBeenCalledWith('SIE stall sweep failed; stalled jobs are judged on the next run',
      expect.objectContaining({ message: 'canceling statement due to statement timeout' }), { code: '57014' })

    const broken = { rpc: vi.fn().mockRejectedValue(new TypeError('fetch failed')) } as unknown as SupabaseClient
    await expect(sweepStalledSIEJobs(broken, logger)).resolves.toEqual([])
    expect(logger.error).toHaveBeenLastCalledWith('SIE stall sweep failed; stalled jobs are judged on the next run', expect.any(TypeError))
  })
})

describe('runSIEWorker and the stall sweep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.SIE_IMPORT_WORKER_PAUSED
  })

  it('sweeps before the first claim when the cron runs it', async () => {
    const { supabase, rpc } = client({ sweep_stalled_sie_import_jobs: { data: [] }, claim_sie_import_job: { data: null } })
    expect(await runSIEWorker({ supabase })).toEqual({ jobs: 0, chunks: 0 })
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['sweep_stalled_sie_import_jobs', 'claim_sie_import_job'])
  })

  it('claims a named job without sweeping (the after() fast path)', async () => {
    const { supabase, rpc } = client({ claim_sie_import_job: { data: null } })
    await runSIEWorker({ supabase, importId: 'import-1' })
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['claim_sie_import_job'])
  })

  it('still claims when the sweep fails', async () => {
    const { supabase, rpc } = client({
      sweep_stalled_sie_import_jobs: { error: { message: 'boom', code: 'XX000' } },
      claim_sie_import_job: { data: null },
    })
    await runSIEWorker({ supabase })
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['sweep_stalled_sie_import_jobs', 'claim_sie_import_job'])
  })
})
