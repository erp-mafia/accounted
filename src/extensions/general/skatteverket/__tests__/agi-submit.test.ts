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
  refreshAgiUnderlag: vi.fn(),
}))
vi.mock('../lib/agi-client', () => ({
  agiPostUnderlag: vi.fn(),
  agiGetKontrollresultat: vi.fn(),
  agiSkapaGranskningsunderlag: vi.fn(),
}))

import { createAgiSigningLink, submitAgiChain, submitAgiUnderlag } from '../lib/agi-submit'
import { buildAgiUnderlag, refreshAgiUnderlag } from '../lib/declaration-prep'
import { agiGetKontrollresultat, agiPostUnderlag, agiSkapaGranskningsunderlag } from '../lib/agi-client'

const settings = { get: vi.fn(), set: vi.fn().mockResolvedValue(undefined), clear: vi.fn() } as never

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(refreshAgiUnderlag).mockResolvedValue({ ok: true, outcome: 'unchanged' })
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

describe('submitAgiUnderlag: a fresh underlag, never a stale stored one (issue #69)', () => {
  it('regenerates the run\'s underlag before it reads and posts it', async () => {
    const { supabase } = createQueuedMockSupabase()
    vi.mocked(refreshAgiUnderlag).mockResolvedValue({ ok: true, outcome: 'replaced' })
    vi.mocked(buildAgiUnderlag).mockResolvedValue({
      arbetsgivare: '165560000000',
      period: '202606',
      xml: '<Skatteverket>fresh</Skatteverket>',
      periodYear: 2026,
      periodMonth: 6,
      salaryRunId: 'run-1',
    } as never)

    const result = await submitAgiUnderlag(supabase as never, 'user-1', 'company-1', settings, 'run-1')

    expect(result.ok).toBe(true)
    expect(refreshAgiUnderlag).toHaveBeenCalledWith(supabase, 'company-1', 'user-1', 'run-1')
    const refreshedAt = vi.mocked(refreshAgiUnderlag).mock.invocationCallOrder[0]
    expect(refreshedAt).toBeLessThan(vi.mocked(buildAgiUnderlag).mock.invocationCallOrder[0])
    expect(refreshedAt).toBeLessThan(vi.mocked(agiPostUnderlag).mock.invocationCallOrder[0])
    expect(agiPostUnderlag).toHaveBeenCalledWith(
      supabase, 'user-1', 'company-1', '<Skatteverket>fresh</Skatteverket>',
      { agRegistreradId: '165560000000', redovisningsperiod: '202606' },
    )
  })

  it('stops at a refused regeneration: nothing posted, nothing flipped, no settings written', async () => {
    const { supabase, findCall } = createQueuedMockSupabase()
    vi.mocked(refreshAgiUnderlag).mockResolvedValue({
      ok: false,
      code: 'AGI_INCOMPLETE_DATA',
      httpStatus: 400,
      error: 'AGI kräver telefon.',
      details: { missing_fields: ['telefon'] },
    })

    const result = await submitAgiChain(supabase as never, 'user-1', 'company-1', settings, 'run-1')

    expect(result).toEqual({
      ok: false,
      code: 'AGI_INCOMPLETE_DATA',
      httpStatus: 400,
      recoverable: false,
      error: 'AGI kräver telefon.',
      details: { missing_fields: ['telefon'] },
    })
    expect(buildAgiUnderlag).not.toHaveBeenCalled()
    expect(agiPostUnderlag).not.toHaveBeenCalled()
    expect(findCall('agi_declarations', 'update')).toBeUndefined()
    expect((settings as unknown as { set: ReturnType<typeof vi.fn> }).set).not.toHaveBeenCalled()
  })
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

describe('the chain\'s steps on their own', () => {
  const target = { salaryRunId: 'run-1', arbetsgivare: '165560000000', period: '202606', periodYear: 2026, periodMonth: 6 }

  it('submitAgiUnderlag stops after kontroll, with the run it posted for', async () => {
    const { supabase, findCall } = createQueuedMockSupabase()

    const result = await submitAgiUnderlag(supabase as never, 'user-1', 'company-1', settings, 'run-1')

    expect(result).toEqual({ ok: true, target, inlamningId: 42, kontrollrapport: null })
    expect(agiSkapaGranskningsunderlag).not.toHaveBeenCalled()
    expect(findCall('agi_declarations', 'update')).toBeUndefined()
  })

  it('submitAgiUnderlag carries Skatteverket\'s felkod for the route\'s log, outside details', async () => {
    const { supabase } = createQueuedMockSupabase()
    vi.mocked(agiPostUnderlag).mockResolvedValue({ ok: false, status: 400, error: 'Ogiltig XML', body: { kod: 12 } } as never)

    const result = await submitAgiUnderlag(supabase as never, 'user-1', 'company-1', settings, 'run-1')

    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_SUBMIT_REJECTED', skvKod: 12 })
    expect(result.ok === false && result.details).toBeUndefined()
  })

  it('createAgiSigningLink answers a draft still being received as recoverable, without a flip', async () => {
    const { supabase, findCall } = createQueuedMockSupabase()
    vi.mocked(agiSkapaGranskningsunderlag).mockResolvedValue({
      ok: true,
      data: { tillstand: 'RECEIVING', link: '', meddelande: null },
    } as never)

    const result = await createAgiSigningLink(supabase as never, 'user-1', 'company-1', settings, target)

    expect(result).toMatchObject({ ok: false, code: 'SKATTEVERKET_PROCESSING', recoverable: true })
    expect(findCall('agi_declarations', 'update')).toBeUndefined()
  })
})
