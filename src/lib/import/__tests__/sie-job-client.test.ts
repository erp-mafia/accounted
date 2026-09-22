import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/client', () => ({ createClient: vi.fn() }))

import { SIEJobFailedError, waitForSIEJob } from '../sie-job-client'

const jobResponse = (job: Record<string, unknown>) =>
  new Response(JSON.stringify({ data: job }), { status: 200, headers: { 'Content-Type': 'application/json' } })

describe('waitForSIEJob', () => {
  const fetchMock = vi.fn()
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
  })
  afterEach(() => vi.unstubAllGlobals())

  it('throws a typed failure carrying the job reason, its errors and the import reference', async () => {
    fetchMock.mockResolvedValueOnce(jobResponse({
      id: 'imp-1', job_state: 'failed', chunks_done: 3, chunks_total: 9,
      error_message: 'SIE-verifikation LESSLIE2 (2025-01-02) ligger utanför räkenskapsåret.',
      job_result: { errors: ['Verifikation A 12 balanserar inte (differens: 1.00 kr)'] },
    }))
    const error = await waitForSIEJob('imp-1').catch((e: unknown) => e)
    expect(error).toBeInstanceOf(SIEJobFailedError)
    expect((error as SIEJobFailedError).message).toBe(
      'SIE-verifikation LESSLIE2 (2025-01-02) ligger utanför räkenskapsåret.\n' +
      '• Verifikation A 12 balanserar inte (differens: 1.00 kr)\n' +
      'Referens: import imp-1',
    )
    expect((error as SIEJobFailedError).job.chunks_done).toBe(3)
  })

  it('points a paused job at the import history', async () => {
    fetchMock.mockResolvedValueOnce(jobResponse({ id: 'imp-2', job_state: 'paused', error_message: null, job_result: null }))
    const error = await waitForSIEJob('imp-2').catch((e: unknown) => e)
    expect((error as SIEJobFailedError).failure.message).toBe('Importen behöver granskas. Fortsätt eller ångra under Importhistorik.')
  })

  it('returns the result of a completed job', async () => {
    fetchMock.mockResolvedValueOnce(jobResponse({ id: 'imp-3', job_state: 'completed', job_result: { success: true, errors: [] } }))
    await expect(waitForSIEJob('imp-3')).resolves.toMatchObject({ success: true })
  })
})
