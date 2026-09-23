import { describe, expect, it } from 'vitest'
import { importPercent, jobProgress } from '@/components/onboarding/books/lib/job-progress'

describe('onboarding import progress', () => {
  it('uses committed entries, not the committed count multiplied by chunk progress', () => {
    const progress = jobProgress({ job_state: 'running', transactions_count: 6000, chunks_done: 30, chunks_total: 76 })
    expect(progress).toEqual({ written: 6000, phase: 'writing' })
    expect(importPercent(progress.written, 15012)).toBe(39)
  })

  it('shows preparation until the worker starts writing', () => {
    expect(jobProgress({ job_state: 'preparing', transactions_count: 0, chunks_done: 0, chunks_total: 0 }))
      .toEqual({ written: 0, phase: 'preparing' })
  })

  it.each(['reconciling', 'finalizing', 'completed'] as const)('keeps %s out of the preparation phase', (job_state) => {
    expect(jobProgress({ job_state, transactions_count: 15012, chunks_done: 76, chunks_total: 76 }))
      .toEqual({ written: 15012, phase: 'checking' })
  })

  it('includes previous files in the visible progress', () => {
    const nextFile = jobProgress({ job_state: 'running', transactions_count: 3000, chunks_done: 15, chunks_total: 50 })
    expect(importPercent(5000 + nextFile.written, 15000)).toBe(53)
  })

  it('reserves completion for success, including extra opening balance entries', () => {
    expect(importPercent(15012, 15012)).toBe(99)
    expect(importPercent(15015, 15012)).toBe(99)
    expect(importPercent(15015, 15012, true)).toBe(100)
  })

  it('handles an unknown or empty total without invalid percentages', () => {
    expect(importPercent(0, 0)).toBeNull()
    expect(importPercent(0, 0, true)).toBe(100)
    expect(importPercent(-1, 100)).toBe(0)
  })
})
