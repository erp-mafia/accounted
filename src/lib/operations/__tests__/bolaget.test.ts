import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bolaget/gate', () => ({ bolagetGate: vi.fn() }))
vi.mock('@/lib/bolaget/share-register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/share-register')>()),
  loadShareRegisterData: vi.fn(),
  registerShareEvent: vi.fn(),
  createShareClass: vi.fn(),
}))
vi.mock('@/lib/bolaget/roles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/roles')>()),
  loadRoles: vi.fn(),
}))

import { bolagetGate } from '@/lib/bolaget/gate'
import { createShareClass, loadShareRegisterData, registerShareEvent } from '@/lib/bolaget/share-register'
import { loadRoles } from '@/lib/bolaget/roles'
import { replayShareRegister, summarizeHoldings } from '@/lib/bolaget/register-state'
import { reconcileWithSettings } from '@/lib/bolaget/reconcile'
import { operationForPendingType } from '../registry'
import { shareClassesCreate, shareRegisterEventsCreate, shareRegisterGet } from '../bolaget'
import type { OperationContext } from '../types'

const ctx = { supabase: {}, companyId: 'company-1', userId: 'user-1', log: { warn: vi.fn() } } as unknown as OperationContext

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(bolagetGate).mockResolvedValue(null)
})

describe('Bolaget operations', () => {
  it('are dark outside the rollout and for a form without an aktiebok', async () => {
    vi.mocked(bolagetGate).mockResolvedValueOnce('BOLAGET_DISABLED')
    expect(await shareRegisterGet.run(ctx, {}, { dryRun: false })).toEqual({ ok: false, code: 'BOLAGET_DISABLED' })
    vi.mocked(bolagetGate).mockResolvedValueOnce('BOLAGET_NOT_FOR_LEGAL_FORM')
    expect(await shareRegisterEventsCreate.run(ctx, { kind: 'anteckning', event_date: '2026-01-01', note: 'x' }, { dryRun: true })).toEqual({
      ok: false,
      code: 'BOLAGET_NOT_FOR_LEGAL_FORM',
    })
    expect(registerShareEvent).not.toHaveBeenCalled()
  })

  it('reads the register as of a date with masked identities', async () => {
    const replay = replayShareRegister([])
    vi.mocked(loadShareRegisterData).mockResolvedValue({
      as_of: '2026-06-30',
      is_avstamningsbolag: false,
      classes: [],
      events: [],
      replay,
      summary: summarizeHoldings(replay.ranges, []),
      parties: new Map(),
      reconciliation: reconcileWithSettings(0, { aktiekapital: null, antal_aktier: null }),
    })
    vi.mocked(loadRoles).mockResolvedValue({ as_of: '2026-06-30', signatory_rule: null, roles: [], signatory_rules: [], board: [], ceo: null })
    const outcome = await shareRegisterGet.run(ctx, { as_of: '2026-06-30' }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { as_of: '2026-06-30', total_shares: 0, holders: [], reconciliation: { status: 'both_empty' } } })
    expect(shareRegisterGet.output.safeParse((outcome as { data: unknown }).data).success).toBe(true)
  })

  it('never takes a personnummer: the event input is strict', () => {
    expect(shareRegisterEventsCreate.input.safeParse({ kind: 'overlatelse', event_date: '2026-01-01', personnummer: '198001011234' }).success).toBe(false)
    expect(shareRegisterEventsCreate.input.safeParse({ kind: 'overlatelse', event_date: '2026-01-01', to_name: 'Bo', share_count: 10 }).success).toBe(true)
  })

  it('stages its writes with a Swedish title and commits them through the same run', async () => {
    expect(shareRegisterEventsCreate.mcp?.stage?.title({ kind: 'overlatelse', event_date: '2026-10-01' })).toBe('Aktiebok: överlåtelse 2026-10-01')
    expect(operationForPendingType('register_share_event')).toBe(shareRegisterEventsCreate)
    vi.mocked(registerShareEvent).mockResolvedValueOnce({ ok: true, dryRun: true, preview: {} })
    await shareRegisterEventsCreate.run({ ...ctx, pendingOperationId: 'po-1' }, { kind: 'anteckning', event_date: '2026-01-01', note: 'x' }, { dryRun: true })
    expect(vi.mocked(registerShareEvent).mock.calls[0]![1]).toMatchObject({ created_via: 'mcp' })
  })

  it('answers a share class with a qualified id', async () => {
    vi.mocked(createShareClass).mockResolvedValueOnce({
      ok: true,
      data: { id: 'c1', code: 'B', name: null, votes_per_share: 1, forbehall_samtycke: false, forbehall_forkop: false, forbehall_hembud: false, forbehall_omvandling: false, forbehall_inlosen: false, forbehall_text: null, bolagsordning_reference: null },
      created: true,
    })
    const outcome = await shareClassesCreate.run(ctx, { code: 'B', votes_per_share: 1 }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { share_class_id: 'c1', code: 'B' } })
    expect((outcome as { data: Record<string, unknown> }).data.id).toBeUndefined()
  })
})
