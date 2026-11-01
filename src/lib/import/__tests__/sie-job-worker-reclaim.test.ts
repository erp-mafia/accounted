import { describe, expect, it, vi } from 'vitest'
import { reportRepeatedReclaim, SIE_RECLAIM_ALERT_ATTEMPTS } from '../sie-job-worker'
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
