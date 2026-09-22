import type { SIEJob } from '@/lib/import/sie-job-contract'

/** What the theatre's "Verifikaten skrivs" line says while a job runs. */
export type JobPhase = 'preparing' | 'writing' | 'checking'

/**
 * transactions_count is the committed entry count, incremented by the
 * chunk writer. It is not the file total and must not be scaled again
 * by the chunk ratio. Keep the visible count independent of animation.
 */
export function jobProgress(job: Pick<SIEJob, 'job_state' | 'chunks_total' | 'chunks_done' | 'transactions_count'>): {
  written: number
  phase: JobPhase
} {
  const written = Math.max(0, job.transactions_count ?? 0)
  const phase: JobPhase =
    job.job_state === 'reconciling' || job.job_state === 'finalizing' || job.job_state === 'completed'
      ? 'checking'
      : job.job_state === 'running'
        ? 'writing'
        : 'preparing'
  return { written, phase }
}

/** Leave room for final checks; only a successful import reaches 100%. */
export function importPercent(written: number, total: number, complete = false): number | null {
  if (complete) return 100
  if (total <= 0) return null
  return Math.min(99, Math.max(0, Math.floor((written / total) * 100)))
}
