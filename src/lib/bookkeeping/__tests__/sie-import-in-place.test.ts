import { describe, expect, it, vi } from 'vitest'
import { SIE_IMPORT_IN_PLACE_JOB_FILTER, whereSieImportInPlace } from '../sie-import-in-place'

function builder() {
  const b = { eq: vi.fn(), or: vi.fn(), limit: vi.fn() }
  b.eq.mockReturnValue(b)
  b.or.mockReturnValue(b)
  b.limit.mockReturnValue(b)
  return b
}

describe('whereSieImportInPlace', () => {
  it('asks for status completed and no job or a completed import job', () => {
    const query = builder()
    const result = whereSieImportInPlace(query)
    expect(result).toBe(query)
    expect(query.eq.mock.calls).toEqual([['status', 'completed']])
    expect(query.or.mock.calls).toEqual([['job_state.is.null,and(job_state.eq.completed,job_kind.eq.import)']])
  })

  it('leaves an undoing import, a failed or undone job and a duplicate repair out of the job half', () => {
    // The job half names the one job that is an import in place; every other
    // job_state, and job_kind duplicate_repair, falls outside it.
    expect(SIE_IMPORT_IN_PLACE_JOB_FILTER).toBe('job_state.is.null,and(job_state.eq.completed,job_kind.eq.import)')
    for (const excluded of ['undoing', 'undone', 'failed', 'duplicate_repair']) {
      expect(SIE_IMPORT_IN_PLACE_JOB_FILTER).not.toContain(excluded)
    }
  })

  it('keeps the query chainable for the caller', () => {
    const query = builder()
    whereSieImportInPlace(query).limit(1)
    expect(query.limit).toHaveBeenCalledWith(1)
  })
})
