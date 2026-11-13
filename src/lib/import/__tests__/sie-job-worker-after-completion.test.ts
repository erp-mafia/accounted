import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const steps = vi.hoisted(() => ({ sweep: vi.fn(), learn: vi.fn(), order: [] as string[] }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn() }))
vi.mock('../sie-post-import-sweep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sie-post-import-sweep')>()),
  sweepBankRowsAfterSIEImport: steps.sweep,
}))
vi.mock('../sie-import-learning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sie-import-learning')>()),
  learnFromCompletedSIEImport: steps.learn,
}))

import {
  finishCompletedSIEImport,
  SIE_AFTER_COMPLETION_GRACE_MS,
  SIE_AFTER_COMPLETION_MIN_MS,
} from '../sie-job-worker'
import type { SIEJob } from '../sie-job-contract'
import type { SIEVoucher } from '../types'

/**
 * The bank sweep and the learning that follow a completed import ran after
 * the job loop with no deadline: one invocation reached 274 s of its 300.
 * They now run inside the invocation's time, the one nothing can rerun first.
 */

const supabase = {} as SupabaseClient
const job = { id: 'import-1', company_id: 'company-1', job_state: 'completed', job_kind: 'import' } as SIEJob
const vouchers = [{ series: 'A', number: 1 }] as unknown as SIEVoucher[]
const learning = { completed: true, vouchers }

const NOW = new Date('2026-11-12T08:00:00.000Z').getTime()

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
  steps.order.length = 0
  steps.sweep.mockImplementation(async () => { steps.order.push('sweep'); return null })
  steps.learn.mockImplementation(async () => { steps.order.push('learn'); return { templates: 0, parties: null } })
})
afterEach(() => vi.useRealTimers())

describe('finishCompletedSIEImport', () => {
  it('with time left, learns first (nothing reruns it) and then sweeps the bank rows', async () => {
    const logger = { info: vi.fn(), error: vi.fn() }
    const deadline = NOW + 120_000

    const done = await finishCompletedSIEImport(supabase, job, learning, deadline, logger)

    expect(steps.order).toEqual(['learn', 'sweep'])
    expect(steps.learn).toHaveBeenCalledWith(supabase, job, vouchers, deadline + SIE_AFTER_COMPLETION_GRACE_MS)
    expect(done).toEqual({ learned: true, swept: true })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('near the end of the budget, still learns but leaves the sweep to the cron, which runs any import without a receipt', async () => {
    const logger = { info: vi.fn(), error: vi.fn() }

    const done = await finishCompletedSIEImport(supabase, job, learning, NOW + SIE_AFTER_COMPLETION_MIN_MS - 1, logger)

    expect(steps.order).toEqual(['learn'])
    expect(done).toEqual({ learned: true, swept: false })
    expect(logger.info).toHaveBeenCalledWith('post-import bank sweep left to the next cron run',
      { companyId: 'company-1', importId: 'import-1' })
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('past the deadline and most of the grace, skips the learning too and reports it: it is lost for good', async () => {
    const logger = { info: vi.fn(), error: vi.fn() }
    // The job loop overran: 15 s past the deadline, 25 s of grace left.
    const done = await finishCompletedSIEImport(supabase, job, learning, NOW - 15_000, logger)

    expect(steps.order).toEqual([])
    expect(done).toEqual({ learned: false, swept: false })
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error).toHaveBeenCalledWith(
      'SIE import learning skipped: the run was out of time, and nothing runs it later',
      { alert: true, companyId: 'company-1', importId: 'import-1', vouchers: 1 })
  })

  it('does neither for a job this invocation did not complete', async () => {
    const logger = { info: vi.fn(), error: vi.fn() }
    const running = { ...job, job_state: 'running' } as SIEJob

    expect(await finishCompletedSIEImport(supabase, running, {}, NOW + 120_000, logger)).toEqual({ learned: false, swept: false })
    expect(steps.order).toEqual([])
  })
})
