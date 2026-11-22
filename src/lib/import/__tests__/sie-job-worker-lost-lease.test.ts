import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * A run that lost its lease is a hand-over, not a failure: the lease lapsed
 * or another run claimed the job, and that run (or the next claim) carries it
 * on. lock_sie_execution refuses every later step of the old run with "SIE
 * worker lease or attempt is stale" (55000), and the worker reported each as
 * an alerting "SIE job requires recovery" plus "SIE recovery recording failed"
 * (record_sie_job_failure takes the same lease and is refused the same way):
 * two error events in PostHog for a normal hand-over (2026-11-10, 2026-11-16).
 */

const logger = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => logger }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn() }))

import { runSIEWorker } from '../sie-job-worker'

const LOST_LEASE = { message: 'SIE worker lease or attempt is stale', code: '55000' }

const job = (over: Record<string, unknown> = {}) => ({
  id: 'import-1',
  company_id: 'company-1',
  job_kind: 'import',
  job_state: 'importing',
  job_phase: 'vouchers',
  job_attempt: 3,
  worker_id: 'worker-1',
  consecutive_failures: 0,
  chunks_done: 4,
  chunks_total: 10,
  manifest: {},
  ...over,
})

function client(answers: Record<string, { data?: unknown; error?: { message: string; code?: string } | null }>) {
  const rpc = vi.fn(async (name: string) => ({ data: null, error: null, ...answers[name] }))
  return { supabase: { rpc } as unknown as SupabaseClient, rpc }
}

describe('runSIEWorker: a lost lease', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.SIE_IMPORT_WORKER_PAUSED
  })

  it('is a warning without an alert, and records no failure: the database would refuse the same lease', async () => {
    const { supabase, rpc } = client({
      claim_sie_import_job: { data: job() },
      import_sie_chunk: { error: LOST_LEASE },
      record_sie_job_failure: { error: LOST_LEASE },
    })

    await runSIEWorker({ supabase, importId: 'import-1' })

    expect(logger.error).not.toHaveBeenCalled()
    expect(logger.warn).toHaveBeenCalledTimes(1)
    const [message, context] = logger.warn.mock.calls[0]
    expect(message).toMatch(/lease/)
    expect(context).toEqual({ companyId: 'company-1', importId: 'import-1', phase: 'vouchers' })
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['claim_sie_import_job', 'import_sie_chunk'])
  })

  it('is a warning too where the refusal arrives with its SQLSTATE (a step through sieJobRPC)', async () => {
    // set_sie_import_audit_mode is the first step of a prepare run with chunk audit on.
    process.env.SIE_IMPORT_CHUNK_AUDIT = 'true'
    try {
      const { supabase, rpc } = client({
        claim_sie_import_job: { data: job({ job_state: 'preparing', job_phase: 'prepare', chunks_done: 0 }) },
        set_sie_import_audit_mode: { error: LOST_LEASE },
        record_sie_job_failure: { error: LOST_LEASE },
      })

      await runSIEWorker({ supabase, importId: 'import-1' })

      expect(logger.error).not.toHaveBeenCalled()
      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(logger.warn.mock.calls[0][1]).toEqual({ companyId: 'company-1', importId: 'import-1', phase: 'prepare' })
      expect(rpc.mock.calls.map(([name]) => name)).toEqual(['claim_sie_import_job', 'set_sie_import_audit_mode'])
    } finally {
      delete process.env.SIE_IMPORT_CHUNK_AUDIT
    }
  })

  it('any other failure still alerts and is recorded', async () => {
    const { supabase, rpc } = client({
      claim_sie_import_job: { data: job() },
      import_sie_chunk: { error: { message: 'canceling statement due to statement timeout', code: '57014' } },
    })

    await runSIEWorker({ supabase, importId: 'import-1' })

    expect(logger.error).toHaveBeenCalledWith('SIE job requires recovery', expect.any(Error),
      { alert: true, companyId: 'company-1', importId: 'import-1', phase: 'vouchers' })
    expect(rpc.mock.calls.map(([name]) => name)).toEqual(['claim_sie_import_job', 'import_sie_chunk', 'record_sie_job_failure'])
  })
})
