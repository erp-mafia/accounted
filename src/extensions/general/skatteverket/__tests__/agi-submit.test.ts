/**
 * submitAgiChain (lib/agi-submit.ts): the one AGI "skicka för signering"
 * chain behind the panel's one-click route and MCP approval. Skatteverket is
 * never called: the AGI client and the underlag builder are mocked.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@/lib/utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/utils')>()),
  sleep: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../lib/declaration-prep', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/declaration-prep')>()),
  buildAgiUnderlag: vi.fn(),
}))
vi.mock('../lib/agi-client', () => ({
  agiPostUnderlag: vi.fn(),
  agiGetKontrollresultat: vi.fn(),
  agiSkapaGranskningsunderlag: vi.fn(),
}))

import { submitAgiChain } from '../lib/agi-submit'
import { buildAgiUnderlag } from '../lib/declaration-prep'
import { agiGetKontrollresultat, agiPostUnderlag, agiSkapaGranskningsunderlag } from '../lib/agi-client'

const settings = { get: vi.fn(), set: vi.fn().mockResolvedValue(undefined), clear: vi.fn() } as never

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(buildAgiUnderlag).mockResolvedValue({
    arbetsgivare: '165560000000',
    period: '202606',
    xml: '<Skatteverket/>',
    periodYear: 2026,
    periodMonth: 6,
    salaryRunId: 'run-1',
  } as never)
  vi.mocked(agiPostUnderlag).mockResolvedValue({ ok: true, data: { inlamningId: 42 } } as never)
  vi.mocked(agiGetKontrollresultat).mockResolvedValue({ ok: true, data: { status: 'DONE_SUCCESS' } } as never)
  vi.mocked(agiSkapaGranskningsunderlag).mockResolvedValue({
    ok: true,
    data: { tillstand: 'LOCKED_FOR_SIGNING', link: 'https://skatteverket.se/sign', meddelande: null },
  } as never)
})

describe('submitAgiChain', () => {
  it('posts, checks and locks, then flips only this run\'s declaration to pending_signature', async () => {
    const { supabase, findCall, findCalls } = createQueuedMockSupabase()

    const result = await submitAgiChain(supabase as never, 'user-1', 'company-1', settings, 'run-1')

    expect(result).toEqual({
      ok: true,
      signingUrl: 'https://skatteverket.se/sign',
      arbetsgivare: '165560000000',
      period: '202606',
      inlamningId: 42,
      tillstand: 'LOCKED_FOR_SIGNING',
    })
    expect(agiSkapaGranskningsunderlag).toHaveBeenCalledWith(supabase, 'user-1', 'company-1', '165560000000', '202606', { lasPeriod: true })
    expect(findCall('agi_declarations', 'update')).toEqual([{ status: 'pending_signature' }])
    // Scoped by the run: a correction run in the same period keeps its row.
    expect(findCalls('agi_declarations', 'eq')).toContainEqual(['salary_run_id', 'run-1'])
    expect(findCalls('agi_declarations', 'in')).toEqual([['status', ['generated', 'rejected']]])
  })

  it('polls a processing kontroll as many times as the caller allows, then answers recoverable', async () => {
    const { supabase, findCall } = createQueuedMockSupabase()
    vi.mocked(agiGetKontrollresultat).mockResolvedValue({ ok: true, data: { status: 'PROCESSING' } } as never)

    const result = await submitAgiChain(supabase as never, 'user-1', 'company-1', settings, 'run-1', { extraPolls: 7 })

    expect(agiGetKontrollresultat).toHaveBeenCalledTimes(8)
    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_PROCESSING', recoverable: true })
    expect(agiSkapaGranskningsunderlag).not.toHaveBeenCalled()
    expect(findCall('agi_declarations', 'update')).toBeUndefined()
  })

  it('marks this run\'s declaration rejected on a refusal at kontroll, with the report', async () => {
    const { supabase, findCall, findCalls } = createQueuedMockSupabase()
    vi.mocked(agiGetKontrollresultat).mockResolvedValue({ ok: true, data: { status: 'DONE_REJECTED' } } as never)

    const result = await submitAgiChain(supabase as never, 'user-1', 'company-1', settings, 'run-1')

    expect(result).toMatchObject({ ok: false, code: 'AGI_KONTROLL_REJECTED', httpStatus: 422, recoverable: false })
    expect(result.ok === false && result.details?.kontrollrapport).toBeTruthy()
    expect(findCall('agi_declarations', 'update')).toEqual([{ status: 'rejected' }])
    expect(findCalls('agi_declarations', 'eq')).toContainEqual(['salary_run_id', 'run-1'])
    expect(agiSkapaGranskningsunderlag).not.toHaveBeenCalled()
  })

  it('refuses incorrect data at granskning without flipping the declaration', async () => {
    const { supabase, findCall } = createQueuedMockSupabase()
    vi.mocked(agiSkapaGranskningsunderlag).mockResolvedValue({
      ok: true,
      data: { tillstand: 'INCORRECT_DATA', link: '', meddelande: 'Fel i underlaget' },
    } as never)

    const result = await submitAgiChain(supabase as never, 'user-1', 'company-1', settings, 'run-1')

    expect(result).toMatchObject({ ok: false, code: 'AGI_GRANSKNING_INCORRECT', error: 'Fel i underlaget' })
    expect(findCall('agi_declarations', 'update')).toBeUndefined()
  })

  it('stops at a refused underlag, before any kontroll read', async () => {
    const { supabase } = createQueuedMockSupabase()
    vi.mocked(agiPostUnderlag).mockResolvedValue({ ok: false, status: 400, error: 'Ogiltig XML' } as never)

    const result = await submitAgiChain(supabase as never, 'user-1', 'company-1', settings, 'run-1')

    expect(result).toEqual({
      ok: false,
      code: 'SKATTEVERKET_SUBMIT_REJECTED',
      httpStatus: 400,
      recoverable: false,
      error: 'Ogiltig XML',
    })
    expect(agiGetKontrollresultat).not.toHaveBeenCalled()
  })
})
