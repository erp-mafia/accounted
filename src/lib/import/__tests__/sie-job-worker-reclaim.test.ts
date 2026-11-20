import { describe, expect, it, vi } from 'vitest'
import { reportRepeatedReclaim, SIE_RECLAIM_ALERT_ATTEMPTS, sieReclaimAlertAttempts } from '../sie-job-worker'
import type { SIEJob } from '../sie-job-contract'

const job = (over: Partial<SIEJob> = {}) => ({
  id: 'import-1',
  company_id: 'company-1',
  job_state: 'finalizing',
  job_phase: 'finalize',
  job_attempt: 1,
  consecutive_failures: 0,
  chunks_done: 3,
  chunks_total: 3,
  ...over,
}) as SIEJob

describe('reportRepeatedReclaim (accounted#115)', () => {
  it('stays quiet for a job claimed as often as a finished import is', () => {
    const logger = { error: vi.fn() }
    reportRepeatedReclaim(job({ job_attempt: 4 }), logger)
    reportRepeatedReclaim(job({ job_attempt: SIE_RECLAIM_ALERT_ATTEMPTS - 1 }), logger)
    expect(logger.error).not.toHaveBeenCalled()
  })

  // A 150 000-voucher year posts about 750 chunks, about 15 claims at the
  // observed 50 chunks a claim: no loop, so no alert at 20.
  it('allows a large year more claims before it counts as looping', () => {
    const logger = { error: vi.fn() }
    const large = { chunks_done: 400, chunks_total: 750 }
    expect(sieReclaimAlertAttempts(job(large))).toBe(SIE_RECLAIM_ALERT_ATTEMPTS + 30)
    reportRepeatedReclaim(job({ ...large, job_attempt: SIE_RECLAIM_ALERT_ATTEMPTS }), logger)
    expect(logger.error).not.toHaveBeenCalled()
    reportRepeatedReclaim(job({ ...large, job_attempt: SIE_RECLAIM_ALERT_ATTEMPTS + 30 }), logger)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  // A duplicate repair counts its items in chunks_total, up to 5 000.
  it('keeps the flat threshold for a duplicate repair', () => {
    const logger = { error: vi.fn() }
    const repair = { job_kind: 'duplicate_repair' as const, chunks_done: 10, chunks_total: 5000 }
    expect(sieReclaimAlertAttempts(job(repair))).toBe(SIE_RECLAIM_ALERT_ATTEMPTS)
    reportRepeatedReclaim(job({ ...repair, job_attempt: SIE_RECLAIM_ALERT_ATTEMPTS }), logger)
    expect(logger.error).toHaveBeenCalledTimes(1)
  })

  it('logs a job that keeps being claimed without finishing, though no failure was counted', () => {
    // A run killed at 300 s or a step that only yields never reaches record_sie_job_failure.
    const logger = { error: vi.fn() }
    reportRepeatedReclaim(job({ job_attempt: SIE_RECLAIM_ALERT_ATTEMPTS }), logger)
    expect(logger.error).toHaveBeenCalledWith('SIE job reclaimed repeatedly without finishing', {
      alert: true,
      companyId: 'company-1',
      importId: 'import-1',
      state: 'finalizing',
      phase: 'finalize',
      attempt: SIE_RECLAIM_ALERT_ATTEMPTS,
      consecutiveFailures: 0,
      chunksDone: 3,
      chunksTotal: 3,
    })
  })
})
