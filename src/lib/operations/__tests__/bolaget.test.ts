import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/bolaget/gate', () => ({ bolagetGate: vi.fn() }))
vi.mock('@/lib/bolaget/share-register', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/share-register')>()),
  loadShareRegisterData: vi.fn(),
  registerShareEvent: vi.fn(),
  createShareClass: vi.fn(),
  updateShareClass: vi.fn(),
}))
vi.mock('@/lib/bolaget/roles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/roles')>()),
  loadRoles: vi.fn(),
  addCompanyRole: vi.fn(),
  endCompanyRole: vi.fn(),
  setSignatoryRule: vi.fn(),
}))
vi.mock('@/lib/bolaget/beneficial-owners', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bolaget/beneficial-owners')>()),
  confirmBeneficialOwners: vi.fn(),
}))

import { bolagetGate } from '@/lib/bolaget/gate'
import { createShareClass, loadShareRegisterData, registerShareEvent, updateShareClass } from '@/lib/bolaget/share-register'
import { addCompanyRole, endCompanyRole, loadRoles, setSignatoryRule } from '@/lib/bolaget/roles'
import { confirmBeneficialOwners } from '@/lib/bolaget/beneficial-owners'
import { replayShareRegister, summarizeHoldings } from '@/lib/bolaget/register-state'
import { reconcileWithSettings } from '@/lib/bolaget/reconcile'
import { operationForPendingType } from '../registry'
import {
  beneficialOwnersConfirm,
  companyRolesCreate,
  companyRolesEnd,
  shareClassesCreate,
  shareClassesUpdate,
  shareRegisterEventsCreate,
  shareRegisterGet,
  signatoryRulesSet,
} from '../bolaget'
import type { OperationContext } from '../types'

// The caller's membership, read the way requireCompanyAdmin reads it (company_members.role).
const member = vi.hoisted(() => ({ role: 'owner' as string | null }))
const supabase = {
  from: vi.fn((table: string) => {
    if (table !== 'company_members') throw new Error(`unexpected table ${table}`)
    const chain = { select: () => chain, eq: () => chain, maybeSingle: async () => ({ data: member.role ? { role: member.role } : null, error: null }) }
    return chain
  }),
}
const ctx = { supabase, companyId: 'company-1', userId: 'user-1', log: { warn: vi.fn() } } as unknown as OperationContext

beforeEach(() => {
  vi.clearAllMocks()
  member.role = 'owner'
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

describe('the ownership and signatory registers are an owner\'s or admin\'s', () => {
  const ID = '22222222-2222-4222-8222-222222222222'
  const writes = [
    { op: shareRegisterEventsCreate, input: { kind: 'anteckning', event_date: '2026-01-01', note: 'x' }, lib: vi.mocked(registerShareEvent) },
    { op: shareClassesCreate, input: { code: 'B', votes_per_share: 1 }, lib: vi.mocked(createShareClass) },
    { op: shareClassesUpdate, input: { share_class_id: ID, votes_per_share: 10 }, lib: vi.mocked(updateShareClass) },
    { op: companyRolesCreate, input: { name: 'Bo Ek', role: 'styrelseledamot', valid_from: '2026-06-15' }, lib: vi.mocked(addCompanyRole) },
    { op: companyRolesEnd, input: { company_role_id: ID, valid_to: '2026-06-14' }, lib: vi.mocked(endCompanyRole) },
    { op: signatoryRulesSet, input: { rule_text: 'Firman tecknas av styrelsen', valid_from: '2026-06-15' }, lib: vi.mocked(setSignatoryRule) },
    {
      op: beneficialOwnersConfirm,
      input: { assessed_on: '2026-10-29', conclusion: 'owners_identified', owners: [{ party_id: ID }], family_aggregation_checked: true, control_agreements: false },
      lib: vi.mocked(confirmBeneficialOwners),
    },
  ]

  it.each(writes.map((w) => [w.op.id, w] as const))('%s refuses a member on a stage (dry run) and on an approval, before the register is touched', async (_id, w) => {
    member.role = 'member'
    const stage = await w.op.run(ctx, w.input as never, { dryRun: true })
    const approve = await w.op.run({ ...ctx, pendingOperationId: 'po-1' }, w.input as never, { dryRun: false })
    for (const outcome of [stage, approve]) {
      expect(outcome).toEqual({
        ok: false,
        code: 'FORBIDDEN',
        messageSv: 'Bara företagets ägare eller en administratör kan göra det här.',
        details: { required_roles: ['owner', 'admin'] },
      })
    }
    expect(w.lib).not.toHaveBeenCalled()
    expect(w.op.errorCodes).toContain('FORBIDDEN')
  })

  it.each(writes.map((w) => [w.op.id, w] as const))('%s lets an owner and an admin through to the register', async (_id, w) => {
    w.lib.mockResolvedValue({ ok: true, dryRun: true, preview: {} } as never)
    for (const role of ['owner', 'admin']) {
      member.role = role
      expect(await w.op.run(ctx, w.input as never, { dryRun: true })).toMatchObject({ ok: true })
    }
    expect(w.lib).toHaveBeenCalledTimes(2)
  })

  it('refuses a viewer and a caller without a membership the same way', async () => {
    for (const role of ['viewer', 'invoicer', null]) {
      member.role = role
      expect(await signatoryRulesSet.run(ctx, { rule_text: 'x', valid_from: '2026-06-15' } as never, { dryRun: true })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    }
    expect(setSignatoryRule).not.toHaveBeenCalled()
  })

  it('stays dark outside the rollout before it asks for the role', async () => {
    vi.mocked(bolagetGate).mockResolvedValueOnce('BOLAGET_DISABLED')
    member.role = 'member'
    expect(await companyRolesCreate.run(ctx, { name: 'Bo', role: 'styrelseledamot', valid_from: '2026-06-15' } as never, { dryRun: true })).toEqual({ ok: false, code: 'BOLAGET_DISABLED' })
    expect(supabase.from).not.toHaveBeenCalled()
  })
})
