import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => supabase }))
vi.mock('@/lib/dates/iso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dates/iso')>()),
  todayIsoStockholm: () => '2026-10-29',
}))

import { registerShareEvent } from '../share-register'
import { addCompanyRole, seedRolesFromSnapshot } from '../roles'
import { confirmBeneficialOwners } from '../beneficial-owners'
import type { OperationContext } from '@/lib/operations/types'

const ANNA = '11111111-1111-4111-8111-111111111111'
const BO = '22222222-2222-4222-8222-222222222222'
const CLASS_A = '33333333-3333-4333-8333-333333333333'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const ctx = { supabase, companyId: 'company-1', userId: 'user-1', log } as unknown as OperationContext

const classA = {
  id: CLASS_A, code: 'A', name: null, votes_per_share: '1', forbehall_samtycke: false, forbehall_forkop: false, forbehall_hembud: true,
  forbehall_omvandling: false, forbehall_inlosen: false, forbehall_text: null, bolagsordning_reference: null,
}
const founding = {
  id: 'e1', event_number: 1, event_date: '2020-01-10', kind: 'bildande', share_class_id: CLASS_A, to_share_class_id: null, from_party_id: null,
  to_party_id: ANNA, range_start: '1', range_end: '100', transfer_reason: null, price_total: null, ratio: null, aktiebrev_number: null,
  aktiebrev_action: null, counterparty_party_id: null, note_status: null, corrects_event_id: null, registered_on: null, decision_id: null,
  document_id: null, journal_entry_id: null, note: null, created_at: '2020-01-10T10:00:00Z', created_via: 'app',
}

function enqueueRegister(events: unknown[] = [founding], avstamning = false) {
  enqueue({ data: { is_avstamningsbolag: avstamning } }) // share_register_settings
  enqueue({ data: [classA] }) // share_classes
  enqueue({ data: events }) // share_register_events
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
})

describe('registerShareEvent', () => {
  it('refuses an entry dated in the future before reading anything', async () => {
    const outcome = await registerShareEvent(ctx, { kind: 'anteckning', event_date: '2027-01-01', note: 'x' }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'BOLAGET_DATES_INVALID' })
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('takes no entries for an avstämningsbolag', async () => {
    enqueueRegister([], true)
    const outcome = await registerShareEvent(ctx, { kind: 'anteckning', event_date: '2026-01-01', note: 'x' }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'SHARE_REGISTER_AVSTAMNINGSBOLAG' })
  })

  it('previews a gift of the holder\'s lowest block with holdings before and after and the förbehåll warning', async () => {
    enqueueRegister()
    enqueue({ data: [{ id: ANNA, display_name: 'Anna', kind: 'person', org_number: null }] }) // parties in company
    const outcome = await registerShareEvent(
      ctx,
      { kind: 'overlatelse', event_date: '2026-10-01', from_party_id: ANNA, to_name: 'Bo Ek', share_count: 30, transfer_reason: 'gava' },
      { dryRun: true },
    )
    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview).toMatchObject({
      kind: 'overlatelse',
      range_start: 1,
      range_end: 30,
      share_count: 30,
      total_shares_before: 100,
      total_shares_after: 100,
      holders_changed: [
        { party_id: ANNA, new_party: false, shares_before: 100, shares_after: 70 },
        { party_id: null, new_party: true, shares_before: 0, shares_after: 30 },
      ],
    })
    const warnings = outcome.preview.warnings as string[]
    expect(warnings.some((w) => w.includes('förbehåll'))).toBe(true)
    expect(warnings.some((w) => w.includes('personnummer'))).toBe(true)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })

  it('refuses a transfer of shares the holder does not have, in Swedish', async () => {
    enqueueRegister()
    enqueue({ data: [{ id: ANNA, display_name: 'Anna', kind: 'person', org_number: null }, { id: BO, display_name: 'Bo', kind: 'person', org_number: null }] })
    const outcome = await registerShareEvent(
      ctx,
      { kind: 'overlatelse', event_date: '2026-10-01', from_party_id: ANNA, to_party_id: BO, range_start: 90, range_end: 120, transfer_reason: 'kop' },
      { dryRun: true },
    )
    expect(outcome).toMatchObject({ ok: false, code: 'SHARE_REGISTER_NOT_HELD' })
    if (!outcome.ok) expect(outcome.messageSv).toMatch(/ägs inte/)
  })

  it('refuses a personnummer sent as a holder\'s org number', async () => {
    enqueueRegister()
    const outcome = await registerShareEvent(
      ctx,
      { kind: 'nyemission', event_date: '2026-10-01', to_name: 'Cia', to_kind: 'company', to_org_number: '19800101-1234', share_count: 10 },
      { dryRun: true },
    )
    expect(outcome).toMatchObject({ ok: false, code: 'BOLAGET_PERSONNUMMER_IN_APP_ONLY' })
  })

  it('enters an issue on the next free numbers to an existing holder', async () => {
    enqueueRegister()
    enqueue({ data: [{ id: ANNA, display_name: 'Anna', kind: 'person', org_number: null }] }) // assert in company
    enqueue({ data: [{ id: ANNA, display_name: 'Anna', kind: 'person', org_number: null }] }) // ensureRegisterParty
    enqueue({ data: { id: 'e2', event_number: 2 } }) // insert
    const outcome = await registerShareEvent(
      ctx,
      { kind: 'nyemission', event_date: '2026-10-01', to_party_id: ANNA, share_count: 50, price_total: 5000 },
      { dryRun: false },
    )
    expect(outcome).toMatchObject({ ok: true, data: { share_register_event_id: 'e2', event_number: 2, range_start: 101, range_end: 150 } })
    expect(findCall('share_register_events', 'insert')?.[0]).toMatchObject({
      company_id: 'company-1',
      kind: 'nyemission',
      share_class_id: CLASS_A,
      to_party_id: ANNA,
      range_start: 101,
      range_end: 150,
      price_total: 5000,
      created_by: 'user-1',
    })
  })

  it('answers the database\'s refusal by its code', async () => {
    enqueueRegister()
    enqueue({ data: [{ id: ANNA, display_name: 'Anna', kind: 'person', org_number: null }] })
    enqueue({ data: [{ id: ANNA, display_name: 'Anna', kind: 'person', org_number: null }] })
    enqueue({ data: null, error: { message: 'SHARE_REGISTER_RANGE_TAKEN: shares 101 to 150 are already held (entry 3)', code: '23514' } })
    const outcome = await registerShareEvent(ctx, { kind: 'nyemission', event_date: '2026-10-01', to_party_id: ANNA, share_count: 50 }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: false, code: 'SHARE_REGISTER_RANGE_TAKEN' })
  })
})

describe('roles', () => {
  it('refuses the same role twice at once', async () => {
    enqueue({ data: [{ id: 'r1', valid_from: '2020-01-01', valid_to: null }] })
    const outcome = await addCompanyRole(ctx, { party: { party_id: ANNA }, role: 'styrelseledamot', valid_from: '2026-01-01' }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'COMPANY_ROLE_DUPLICATE' })
  })

  it('seeds the roles once from the registry snapshot, without a registry call', async () => {
    enqueue({ data: null, count: 0 }) // company_roles count
    enqueue({
      data: {
        tic_snapshot: {
          representatives: [{ name: 'Anna Ek', positionType: 'boardMember', positionDescription: 'Styrelseledamot', positionStart: '2020-01-10T00:00:00' }],
          signatory: [{ description: 'Firman tecknas av styrelsen' }],
        },
      },
    })
    enqueue({ data: null }) // settings upsert
    enqueue({ data: [{ company_id: 'company-1' }] }) // claim
    enqueue({ data: [] }) // person by name
    enqueue({ data: ANNA }) // ensure_party
    enqueue({ data: null }) // company_roles insert
    enqueue({ data: null }) // company_signatory_rules insert
    expect(await seedRolesFromSnapshot(ctx)).toBe(1)
    expect(supabase.rpc).toHaveBeenCalledWith('ensure_party', expect.objectContaining({ p_name: 'Anna Ek', p_kind: 'person', p_origin: 'bolaget' }))
    expect(findCall('company_roles', 'insert')?.[0]).toEqual(
      expect.objectContaining({ party_id: ANNA, role: 'styrelseledamot', valid_from: '2020-01-10', source: 'registry_tic' }),
    )
    expect(findCall('company_signatory_rules', 'insert')?.[0]).toEqual({
      company_id: 'company-1',
      rule_text: 'Firman tecknas av styrelsen',
      source: 'registry_tic',
    })
  })

  it('does not seed when another read already claimed it', async () => {
    enqueue({ data: null, count: 0 })
    enqueue({ data: { tic_snapshot: { representatives: [{ name: 'Anna', positionDescription: 'VD' }] } } })
    enqueue({ data: null })
    enqueue({ data: [] }) // claim lost
    expect(await seedRolesFromSnapshot(ctx)).toBe(0)
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})

describe('confirmBeneficialOwners', () => {
  it('refuses a company as a verklig huvudman', async () => {
    enqueueRegister([])
    enqueue({ data: { aktiekapital: null, antal_aktier: null } }) // company_settings
    enqueue({ data: [{ id: BO, display_name: 'Bo Holding AB', kind: 'company', org_number: '5560000001' }] })
    enqueue({ data: [] })
    const outcome = await confirmBeneficialOwners(
      ctx,
      { assessed_on: '2026-10-29', conclusion: 'owners_identified', owners: [{ party_id: BO }], family_aggregation_checked: true, control_agreements: false },
      { dryRun: true },
    )
    expect(outcome).toMatchObject({ ok: false, code: 'BENEFICIAL_OWNER_INVALID' })
  })

  it('refuses owners with the conclusion that there is none', async () => {
    const outcome = await confirmBeneficialOwners(
      ctx,
      { assessed_on: '2026-10-29', conclusion: 'no_beneficial_owner', owners: [{ party_id: ANNA }], family_aggregation_checked: false, control_agreements: false },
      { dryRun: true },
    )
    expect(outcome).toMatchObject({ ok: false, code: 'BENEFICIAL_OWNER_INVALID' })
  })
})
