import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => supabase }))
vi.mock('@/lib/dates/iso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dates/iso')>()),
  todayIsoStockholm: () => '2026-10-29',
}))

import { completeShareRegisterSetup, registerShareEvent } from '../share-register'
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

/** What registerShareEvent reads first: the caller's role, then the register. */
function enqueueEntry(events: unknown[] = [founding], avstamning = false, role = 'owner') {
  enqueue({ data: { role } }) // company_members
  enqueueRegister(events, avstamning)
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
    enqueueEntry([], true)
    const outcome = await registerShareEvent(ctx, { kind: 'anteckning', event_date: '2026-01-01', note: 'x' }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'SHARE_REGISTER_AVSTAMNINGSBOLAG' })
  })

  it('previews a gift of the holder\'s lowest block with holdings before and after and the förbehåll warning', async () => {
    enqueueEntry()
    enqueue({ data: [] }) // register person by name: nobody
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
    enqueueEntry()
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
    enqueueEntry()
    const outcome = await registerShareEvent(
      ctx,
      { kind: 'nyemission', event_date: '2026-10-01', to_name: 'Cia', to_kind: 'company', to_org_number: '19800101-1234', share_count: 10 },
      { dryRun: true },
    )
    expect(outcome).toMatchObject({ ok: false, code: 'BOLAGET_PERSONNUMMER_IN_APP_ONLY' })
  })

  it('enters an issue on the next free numbers to an existing holder', async () => {
    enqueueEntry()
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
      based_on_event_number: 1,
    })
  })

  it('answers the database\'s refusal by its code', async () => {
    enqueueEntry()
    enqueue({ data: [{ id: ANNA, display_name: 'Anna', kind: 'person', org_number: null }] })
    enqueue({ data: [{ id: ANNA, display_name: 'Anna', kind: 'person', org_number: null }] })
    enqueue({ data: null, error: { message: 'SHARE_REGISTER_RANGE_TAKEN: shares 101 to 150 are already held (entry 3)', code: '23514' } })
    const outcome = await registerShareEvent(ctx, { kind: 'nyemission', event_date: '2026-10-01', to_party_id: ANNA, share_count: 50 }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: false, code: 'SHARE_REGISTER_RANGE_TAKEN' })
  })

  it('refuses a member before reading the register: the board keeps the aktiebok', async () => {
    enqueue({ data: { role: 'member' } }) // company_members
    const outcome = await registerShareEvent(ctx, { kind: 'nyemission', event_date: '2026-10-01', to_party_id: ANNA, share_count: 10 }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'FORBIDDEN', details: { required_roles: ['owner', 'admin'] } })
    expect(findCall('share_register_events', 'select')).toBeUndefined()
  })

  it('refuses an entry checked against a register that has moved on', async () => {
    enqueueEntry()
    const outcome = await registerShareEvent(
      ctx,
      { kind: 'anteckning', event_date: '2026-10-01', note: 'x', expected_last_event_number: 0 },
      { dryRun: false },
    )
    expect(outcome).toMatchObject({ ok: false, code: 'SHARE_REGISTER_STALE', details: { last_event_number: 1 } })
    expect(findCall('share_register_events', 'insert')).toBeUndefined()
  })

  it('reads a first share number with a count as the whole block, and refuses a count that contradicts the numbers', async () => {
    enqueueEntry()
    enqueue({ data: [{ id: ANNA, display_name: 'Anna', kind: 'person', org_number: null }] })
    const block = await registerShareEvent(ctx, { kind: 'nyemission', event_date: '2026-10-01', to_party_id: ANNA, range_start: 101, share_count: 500 }, { dryRun: true })
    expect(block.ok && block.dryRun && block.preview).toMatchObject({ range_start: 101, range_end: 600, share_count: 500 })

    enqueueEntry()
    enqueue({ data: [{ id: ANNA, display_name: 'Anna', kind: 'person', org_number: null }] })
    const clash = await registerShareEvent(ctx, { kind: 'nyemission', event_date: '2026-10-01', to_party_id: ANNA, range_start: 101, range_end: 110, share_count: 500 }, { dryRun: true })
    expect(clash).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
    if (!clash.ok) expect(clash.messageSv).toMatch(/500.*101-110/)
  })

  it('refuses a transfer to the transferor, in Swedish', async () => {
    enqueueEntry()
    enqueue({ data: [{ id: ANNA, display_name: 'Anna', kind: 'person', org_number: null }] })
    const outcome = await registerShareEvent(
      ctx,
      { kind: 'overlatelse', event_date: '2026-10-01', from_party_id: ANNA, to_party_id: ANNA, share_count: 10, transfer_reason: 'kop' },
      { dryRun: true },
    )
    expect(outcome).toMatchObject({ ok: false, code: 'BOLAGET_PARTY_INVALID' })
    if (!outcome.ok) expect(outcome.messageSv).toMatch(/samma/)
  })

  it('makes the entry for the register person a name already belongs to, and says so in the preview', async () => {
    enqueueEntry()
    enqueue({ data: [{ id: BO, display_name: 'Bo Ek' }] }) // register person by name: one
    enqueue({ data: [{ id: ANNA, display_name: 'Anna', kind: 'person', org_number: null }, { id: BO, display_name: 'Bo Ek', kind: 'person', org_number: null }] })
    const outcome = await registerShareEvent(
      ctx,
      { kind: 'overlatelse', event_date: '2026-10-01', from_party_id: ANNA, to_name: 'bo ek', share_count: 30, transfer_reason: 'gava', forbehall_cleared: true },
      { dryRun: true },
    )
    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview).toMatchObject({
      to: { party_id: BO },
      matched_parties: [{ field: 'to', party_id: BO, name: 'Bo Ek' }],
      last_event_number: 1,
      holders_changed: [
        { party_id: ANNA, new_party: false, shares_before: 100, shares_after: 70 },
        { party_id: BO, new_party: false, shares_before: 0, shares_after: 30 },
      ],
    })
    expect((outcome.preview.warnings as string[]).some((w) => w.includes('finns redan i bolagets register'))).toBe(true)
    expect(outcome.preview.warning_codes).toEqual(['BOLAGET_PARTY_MATCHED_EXISTING'])
    // Only register people are looked among: never a customer with the same name.
    expect(findCalls('parties', 'eq')).toContainEqual(['origin', 'bolaget'])
  })

  it('enters somebody new with a name the registers already hold when told so', async () => {
    enqueueEntry()
    enqueue({ data: [{ id: ANNA, display_name: 'Anna', kind: 'person', org_number: null }] }) // parties in company
    enqueue({ data: 'new-party' }) // ensure_party
    enqueue({ data: { id: 'e2', event_number: 2 } }) // insert
    const outcome = await registerShareEvent(
      ctx,
      { kind: 'overlatelse', event_date: '2026-10-01', from_party_id: ANNA, to_name: 'Bo Ek', to_is_new: true, share_count: 30, transfer_reason: 'gava', forbehall_cleared: true },
      { dryRun: false },
    )
    expect(outcome).toMatchObject({ ok: true, data: { to_party_id: 'new-party', range_start: 1, range_end: 30 } })
    expect(supabase.rpc).toHaveBeenCalledWith('ensure_party', expect.objectContaining({ p_name: 'Bo Ek', p_kind: 'person', p_origin: 'bolaget' }))
  })

  it('previews a rättelse with the holders of the entry it voids', async () => {
    const transfer = { ...founding, id: 'e2', event_number: 2, event_date: '2021-01-01', kind: 'overlatelse', from_party_id: ANNA, to_party_id: BO, range_start: '1', range_end: '40', transfer_reason: 'kop' }
    enqueueEntry([founding, transfer])
    const outcome = await registerShareEvent(ctx, { kind: 'rattelse', event_date: '2026-10-01', corrects_event_id: 'e2', note: 'Fel mottagare' }, { dryRun: true })
    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview).toMatchObject({
      corrects_event_id: 'e2',
      corrects_event_number: 2,
      holders_changed: [
        { party_id: ANNA, shares_before: 60, shares_after: 100 },
        { party_id: BO, shares_before: 40, shares_after: 0 },
      ],
    })
  })

  it('lets a rättelse void one of two stored aktiebrev entries that collide', async () => {
    const brev = { ...founding, kind: 'aktiebrev', share_class_id: null, to_party_id: null, range_start: '1', range_end: '100', aktiebrev_number: '1', aktiebrev_action: 'issued' }
    const stored = [founding, { ...brev, id: 'e2', event_number: 2, event_date: '2020-02-01' }, { ...brev, id: 'e3', event_number: 3, event_date: '2020-02-01' }]
    enqueueEntry(stored)
    const fix = await registerShareEvent(ctx, { kind: 'rattelse', event_date: '2026-10-01', corrects_event_id: 'e3', note: 'Införd två gånger' }, { dryRun: true })
    expect(fix).toMatchObject({ ok: true, dryRun: true })

    // Any other entry still goes in: the stored collision is not its doing.
    enqueueEntry(stored)
    const note = await registerShareEvent(ctx, { kind: 'anteckning', event_date: '2026-10-01', note: 'x' }, { dryRun: true })
    expect(note).toMatchObject({ ok: true, dryRun: true })

    // A third aktiebrev on the same shares is this entry's doing, and refused.
    enqueueEntry(stored)
    const third = await registerShareEvent(
      ctx,
      { kind: 'aktiebrev', event_date: '2026-10-01', range_start: 1, range_end: 100, aktiebrev_number: '2', aktiebrev_action: 'issued' },
      { dryRun: true },
    )
    expect(third).toMatchObject({ ok: false, code: 'SHARE_REGISTER_NOTE_INVALID' })
  })
})

/** The register as registerShareEvent reads it once its setup is completed. */
function enqueueEntryInUse(events: unknown[] = [founding]) {
  enqueue({ data: { role: 'owner' } }) // company_members
  enqueue({ data: { is_avstamningsbolag: false, setup_completed_at: '2026-06-01T08:00:00Z' } }) // share_register_settings
  enqueue({ data: [classA] }) // share_classes
  enqueue({ data: events }) // share_register_events
}

const annaParty = { id: ANNA, display_name: 'Anna', kind: 'person', org_number: null }

describe('the two phases of the register', () => {
  it('takes a holding carried over from an earlier register while it is set up, and says the earlier one is kept', async () => {
    enqueueEntry([])
    enqueue({ data: [annaParty] }) // parties in company
    const outcome = await registerShareEvent(ctx, { kind: 'ingaende', event_date: '2026-01-01', to_party_id: ANNA, share_count: 500 }, { dryRun: true })
    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview).toMatchObject({ kind: 'ingaende', event_date: '2026-01-01', occurred_on: null, register_in_use: false, range_start: 1, range_end: 500, total_shares_after: 500 })
    expect(outcome.preview.warning_codes).toContain('SHARE_REGISTER_KEEP_EARLIER_REGISTER')
  })

  it('refuses a carried-over holding once the register is in use', async () => {
    enqueueEntryInUse()
    const outcome = await registerShareEvent(ctx, { kind: 'ingaende', event_date: '2026-01-01', to_party_id: ANNA, share_count: 10 }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'SHARE_REGISTER_SETUP_COMPLETE' })
  })

  it('dates an entry the day it is made once the register is in use, and keeps the day of the event', async () => {
    enqueueEntryInUse()
    enqueue({ data: [annaParty] }) // assert in company
    enqueue({ data: [annaParty] }) // ensureRegisterParty
    enqueue({ data: { id: 'e2', event_number: 2, event_date: '2026-10-29', occurred_on: '2026-10-01' } }) // insert
    const outcome = await registerShareEvent(ctx, { kind: 'nyemission', event_date: '2026-10-01', to_party_id: ANNA, share_count: 50 }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { event_number: 2, event_date: '2026-10-29', occurred_on: '2026-10-01' } })
    expect(findCall('share_register_events', 'insert')?.[0]).toMatchObject({ event_date: '2026-10-29', occurred_on: '2026-10-01' })
    if (outcome.ok && !outcome.dryRun) expect(outcome.warnings?.map((w) => w.code)).toContain('SHARE_REGISTER_DATED_ENTRY_DAY')
  })

  it('previews the day the entry will carry in use: today, with the day of the event beside it', async () => {
    enqueueEntryInUse()
    enqueue({ data: [annaParty] }) // parties in company
    const outcome = await registerShareEvent(ctx, { kind: 'nyemission', occurred_on: '2026-09-15', to_party_id: ANNA, share_count: 50 }, { dryRun: true })
    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview).toMatchObject({ event_date: '2026-10-29', occurred_on: '2026-09-15', register_in_use: true })
    // The day was given as the day of the event: nothing was moved, so nothing is explained.
    expect(outcome.preview.warning_codes).not.toContain('SHARE_REGISTER_DATED_ENTRY_DAY')
  })

  it('keeps the day of the event as the entry\'s own while the register is set up', async () => {
    enqueueEntry()
    enqueue({ data: [annaParty] })
    enqueue({ data: [annaParty] })
    enqueue({ data: { id: 'e2', event_number: 2 } })
    const outcome = await registerShareEvent(ctx, { kind: 'nyemission', event_date: '2026-10-01', to_party_id: ANNA, share_count: 50 }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { event_date: '2026-10-01', occurred_on: null } })
    expect(findCall('share_register_events', 'insert')?.[0]).toMatchObject({ event_date: '2026-10-01', occurred_on: null })
  })

  it('refuses a day of the event later than the entry\'s date', async () => {
    const outcome = await registerShareEvent(ctx, { kind: 'anteckning', event_date: '2026-10-01', occurred_on: '2026-10-05', note: 'x' }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'BOLAGET_DATES_INVALID' })
  })

  it('says before the write that an entry completes the setup, and completes it once the entry is in', async () => {
    const opening = { ...founding, kind: 'ingaende', event_date: '2026-10-29' }
    enqueueEntry([])
    enqueue({ data: [annaParty] })
    const preview = await registerShareEvent(ctx, { kind: 'ingaende', to_party_id: ANNA, share_count: 100, completes_setup: true }, { dryRun: true })
    expect(preview.ok && preview.dryRun).toBe(true)
    if (!preview.ok || !preview.dryRun) return
    expect(preview.preview).toMatchObject({ completes_setup: true })
    expect(preview.preview.warning_codes).toContain('SHARE_REGISTER_SETUP_COMPLETES')
    expect(findCall('share_register_settings', 'upsert')).toBeUndefined()

    reset()
    enqueueEntry([])
    enqueue({ data: [annaParty] }) // assert in company
    enqueue({ data: [annaParty] }) // ensureRegisterParty
    enqueue({ data: { id: 'e1', event_number: 1 } }) // insert
    enqueue({ data: { role: 'owner' } }) // completeShareRegisterSetup: company_members
    enqueue({ data: { is_avstamningsbolag: false, setup_completed_at: null } }) // share_register_settings
    enqueue({ data: [classA] }) // share_classes
    enqueue({ data: [opening] }) // share_register_events, the new entry in it
    enqueue({ data: { aktiekapital: 25000, antal_aktier: 100 } }) // company_settings
    enqueue({ data: { setup_completed_at: '2026-10-29T09:00:00Z' } }) // upsert
    const outcome = await registerShareEvent(ctx, { kind: 'ingaende', to_party_id: ANNA, share_count: 100, completes_setup: true }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { event_number: 1, setup_completed_at: '2026-10-29T09:00:00Z' } })
    expect(findCall('share_register_settings', 'upsert')?.[0]).toMatchObject({ company_id: 'company-1', setup_completed_by: 'user-1' })
  })

  it('refuses to complete a setup with an entry that leaves the register without shares, and one that is already complete', async () => {
    enqueueEntry([])
    const empty = await registerShareEvent(ctx, { kind: 'anteckning', note: 'Kontrollerad', completes_setup: true }, { dryRun: true })
    expect(empty).toMatchObject({ ok: false, code: 'SHARE_REGISTER_EMPTY' })

    reset()
    enqueueEntryInUse()
    const again = await registerShareEvent(ctx, { kind: 'anteckning', note: 'Kontrollerad', completes_setup: true }, { dryRun: true })
    expect(again).toMatchObject({ ok: false, code: 'SHARE_REGISTER_SETUP_COMPLETE' })
  })

  it('completes a register that needs no further entry with the register\'s own note, and no other', async () => {
    enqueueEntry()
    const preview = await registerShareEvent(ctx, { kind: 'anteckning', completes_setup: true }, { dryRun: true })
    expect(preview.ok && preview.dryRun).toBe(true)
    if (!preview.ok || !preview.dryRun) return
    expect(preview.preview).toMatchObject({ kind: 'anteckning', completes_setup: true, last_event_number: 1 })
    expect(preview.preview.warning_codes).toContain('SHARE_REGISTER_SETUP_COMPLETES')

    reset()
    const completionNote = { ...founding, id: 'e2', event_number: 2, event_date: '2026-10-29', kind: 'anteckning', share_class_id: null, to_party_id: null, range_start: null, range_end: null, note: 'Aktieboken är upplagd.', created_at: '2026-10-29T09:00:00Z' }
    // A note somebody made right after the completion: not the one that is answered.
    const laterNote = { ...completionNote, id: 'e3', event_number: 3, note: 'Kontrollerad', created_at: '2026-10-29T09:00:02Z' }
    enqueueEntry()
    enqueue({ data: { role: 'owner' } }) // completeShareRegisterSetup: company_members
    enqueue({ data: { is_avstamningsbolag: false, setup_completed_at: null } }) // share_register_settings
    enqueue({ data: [classA] }) // share_classes
    enqueue({ data: [founding] }) // share_register_events
    enqueue({ data: { aktiekapital: 25000, antal_aktier: 100 } }) // company_settings
    enqueue({ data: { setup_completed_at: '2026-10-29T09:00:00Z' } }) // upsert
    enqueue({ data: [founding, completionNote, laterNote] }) // share_register_events, the note the database wrote in it
    const outcome = await registerShareEvent(ctx, { kind: 'anteckning', completes_setup: true }, { dryRun: false })
    expect(outcome).toMatchObject({
      ok: true,
      data: { share_register_event_id: 'e2', event_number: 2, kind: 'anteckning', event_date: '2026-10-29', setup_completed_at: '2026-10-29T09:00:00Z' },
    })
    expect(findCall('share_register_events', 'insert')).toBeUndefined()
    expect(findCall('share_register_settings', 'upsert')?.[0]).toMatchObject({ company_id: 'company-1', setup_completed_by: 'user-1' })
  })

  it('still asks for the text of a note that completes nothing, and of a rättelse', async () => {
    enqueueEntry()
    expect(await registerShareEvent(ctx, { kind: 'anteckning' }, { dryRun: true })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR', messageSv: 'Skriv anteckningen.' })
    reset()
    enqueueEntry()
    expect(await registerShareEvent(ctx, { kind: 'rattelse', corrects_event_id: 'e1', completes_setup: true }, { dryRun: true })).toMatchObject({ ok: false, code: 'VALIDATION_ERROR' })
  })

  it('leaves the register as it was when the completion is refused because it has moved on', async () => {
    enqueueEntry()
    enqueue({ data: { role: 'owner' } }) // completeShareRegisterSetup: company_members
    enqueue({ data: { is_avstamningsbolag: false, setup_completed_at: null } }) // share_register_settings
    enqueue({ data: [classA] }) // share_classes
    enqueue({ data: [founding, { ...founding, id: 'e2', event_number: 2, kind: 'anteckning', share_class_id: null, to_party_id: null, range_start: null, range_end: null, note: 'Kontrollerad' }] }) // an entry got in between
    enqueue({ data: { aktiekapital: 25000, antal_aktier: 100 } }) // company_settings
    const outcome = await registerShareEvent(ctx, { kind: 'anteckning', completes_setup: true }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: false, code: 'SHARE_REGISTER_STALE' })
    expect(findCall('share_register_settings', 'upsert')).toBeUndefined()
    expect(findCall('share_register_events', 'insert')).toBeUndefined()
  })

  it('says of an opening holding that it carries the share numbers of the earlier register', async () => {
    enqueueEntry([])
    enqueue({ data: [annaParty] })
    const preview = await registerShareEvent(ctx, { kind: 'ingaende', to_party_id: ANNA, range_start: 201, range_end: 300 }, { dryRun: true })
    if (!preview.ok || !preview.dryRun) throw new Error('expected a preview')
    expect(preview.preview).toMatchObject({ range_start: 201, range_end: 300 })
    const at = (preview.preview.warning_codes as string[]).indexOf('SHARE_REGISTER_KEEP_EARLIER_REGISTER')
    expect((preview.preview.warnings as string[])[at]).toMatch(/med de aktienummer som står där/)
  })

  it('says of taken share numbers that an entry that holds them by mistake is voided first', async () => {
    enqueueEntry()
    enqueue({ data: [annaParty] })
    const outcome = await registerShareEvent(ctx, { kind: 'ingaende', to_party_id: ANNA, range_start: 50, range_end: 150 }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'SHARE_REGISTER_RANGE_TAKEN' })
    if (outcome.ok) return
    expect(outcome.messageSv).toMatch(/50-100 finns redan i aktieboken.*rättas den först/)
  })
})

describe('completeShareRegisterSetup', () => {
  function enqueueSetup(events: unknown[], settings: Record<string, unknown> = { is_avstamningsbolag: false, setup_completed_at: null }, capital: Record<string, unknown> | null = { aktiekapital: 25000, antal_aktier: 100 }) {
    enqueue({ data: { role: 'owner' } }) // company_members
    enqueue({ data: settings }) // share_register_settings
    enqueue({ data: [classA] }) // share_classes
    enqueue({ data: events }) // share_register_events
    enqueue({ data: capital }) // company_settings
  }

  it('previews what the register holds and saves nothing', async () => {
    enqueueSetup([founding])
    const outcome = await completeShareRegisterSetup(ctx, {}, { dryRun: true })
    expect(outcome.ok && outcome.dryRun).toBe(true)
    if (!outcome.ok || !outcome.dryRun) return
    expect(outcome.preview).toMatchObject({ total_shares: 100, holders: 1, last_event_number: 1, already_completed_at: null, warnings: [] })
    expect(findCall('share_register_settings', 'upsert')).toBeUndefined()
  })

  it('warns in the preview when the register and the company details disagree on the number of shares', async () => {
    enqueueSetup([founding], undefined, { aktiekapital: 25000, antal_aktier: 500 })
    const outcome = await completeShareRegisterSetup(ctx, {}, { dryRun: true })
    if (!outcome.ok || !outcome.dryRun) throw new Error('expected a preview')
    expect((outcome.preview.warnings as string[])[0]).toMatch(/100 aktier.*500/)
  })

  it('refuses an empty register and a register that has moved on', async () => {
    enqueueSetup([])
    expect(await completeShareRegisterSetup(ctx, {}, { dryRun: false })).toMatchObject({ ok: false, code: 'SHARE_REGISTER_EMPTY' })
    reset()
    enqueueSetup([founding])
    expect(await completeShareRegisterSetup(ctx, { expected_last_event_number: 0 }, { dryRun: false })).toMatchObject({ ok: false, code: 'SHARE_REGISTER_STALE' })
    expect(findCall('share_register_settings', 'upsert')).toBeUndefined()
  })

  it('completes once: a second call answers the first one\'s moment and writes nothing', async () => {
    enqueueSetup([founding])
    enqueue({ data: { setup_completed_at: '2026-10-29T09:00:00Z' } }) // upsert
    expect(await completeShareRegisterSetup(ctx, { expected_last_event_number: 1 }, { dryRun: false })).toMatchObject({
      ok: true,
      data: { setup_completed_at: '2026-10-29T09:00:00Z', total_shares: 100, holders: 1, completed_now: true },
    })
    reset()
    enqueueSetup([founding], { is_avstamningsbolag: false, setup_completed_at: '2026-10-29T09:00:00Z' })
    expect(await completeShareRegisterSetup(ctx, {}, { dryRun: false })).toMatchObject({ ok: true, data: { setup_completed_at: '2026-10-29T09:00:00Z', completed_now: false } })
    expect(findCall('share_register_settings', 'upsert')).toBeUndefined()
  })

  it('is the owner\'s or an administrator\'s, and not for an avstämningsbolag', async () => {
    enqueue({ data: { role: 'member' } })
    expect(await completeShareRegisterSetup(ctx, {}, { dryRun: true })).toMatchObject({ ok: false, code: 'FORBIDDEN' })
    reset()
    enqueueSetup([founding], { is_avstamningsbolag: true, setup_completed_at: null })
    expect(await completeShareRegisterSetup(ctx, {}, { dryRun: false })).toMatchObject({ ok: false, code: 'SHARE_REGISTER_AVSTAMNINGSBOLAG' })
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
    enqueue({ data: null, count: 0 }) // company_signatory_rules count
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

  // A snapshot that names no representative says "could not ask", not "no
  // board". Claiming on it would seed the firmateckning alone, and never the board.
  const signatory = [{ description: 'Firman tecknas av styrelsen' }]
  it.each([
    ['the representatives call failed', { representatives: [], board: null, signatory, incompleteSections: ['board', 'representatives'] }],
    ['the list is empty, unmarked (saved before failed calls were marked, or no board at the registry yet)', { representatives: [], board: null, signatory }],
    ['the snapshot has no representatives at all', { signatory }],
  ])('claims nothing while %s', async (_label, tic_snapshot) => {
    enqueue({ data: null, count: 0 }) // company_roles count
    enqueue({ data: { tic_snapshot } })
    enqueue({ data: null }) // settings upsert, were it reached
    enqueue({ data: [{ company_id: 'company-1' }] }) // the claim, were it reached
    expect(await seedRolesFromSnapshot(ctx)).toBe(0)
    // Unclaimed, so the read after a snapshot that names the board seeds it.
    expect(findCalls('share_register_settings', 'update')).toEqual([])
    expect(findCalls('company_signatory_rules', 'insert')).toEqual([])
  })

  it('seeds the firmateckning when the named representatives hold no role kept here', async () => {
    // The registry answered: a lay auditor is no role of this register.
    enqueue({ data: null, count: 0 })
    enqueue({ data: { tic_snapshot: { representatives: [{ name: 'Bo Lind', positionDescription: 'Lekmannarevisor' }], signatory } } })
    enqueue({ data: null, count: 0 }) // company_signatory_rules count
    enqueue({ data: null }) // settings upsert
    enqueue({ data: [{ company_id: 'company-1' }] }) // claim
    enqueue({ data: null }) // company_signatory_rules insert
    expect(await seedRolesFromSnapshot(ctx)).toBe(0)
    expect(findCalls('share_register_settings', 'update')).toHaveLength(1)
    expect(findCall('company_signatory_rules', 'insert')?.[0]).toEqual(expect.objectContaining({ rule_text: 'Firman tecknas av styrelsen' }))
  })

  it('seeds when only the board summary could not be fetched', async () => {
    // The representatives were kept from the last answered fetch; the seed
    // reads them, not the summary.
    enqueue({ data: null, count: 0 })
    enqueue({
      data: {
        tic_snapshot: {
          representatives: [{ name: 'Anna Ek', positionDescription: 'VD' }],
          board: null,
          incompleteSections: ['board'],
        },
      },
    })
    enqueue({ data: null, count: 0 }) // company_signatory_rules count
    enqueue({ data: null }) // settings upsert
    enqueue({ data: [{ company_id: 'company-1' }] }) // claim
    enqueue({ data: [] }) // person by name
    enqueue({ data: ANNA }) // ensure_party
    enqueue({ data: null }) // company_roles insert
    expect(await seedRolesFromSnapshot(ctx)).toBe(1)
    expect(findCall('company_roles', 'insert')?.[0]).toEqual(expect.objectContaining({ party_id: ANNA, role: 'vd' }))
  })

  it('keeps a firmateckning entered by hand while the seed waited', async () => {
    enqueue({ data: null, count: 0 }) // company_roles count
    enqueue({ data: { tic_snapshot: { representatives: [{ name: 'Anna Ek', positionDescription: 'VD' }], signatory } } })
    enqueue({ data: null, count: 1 }) // company_signatory_rules count: one entered by hand
    enqueue({ data: null }) // settings upsert
    enqueue({ data: [{ company_id: 'company-1' }] }) // claim
    enqueue({ data: [] }) // person by name
    enqueue({ data: ANNA }) // ensure_party
    enqueue({ data: null }) // company_roles insert
    expect(await seedRolesFromSnapshot(ctx)).toBe(1)
    expect(findCall('company_roles', 'insert')?.[0]).toEqual(expect.objectContaining({ party_id: ANNA, role: 'vd' }))
    expect(findCalls('company_signatory_rules', 'insert')).toEqual([])
  })

  it('does not seed when another read already claimed it', async () => {
    enqueue({ data: null, count: 0 })
    enqueue({ data: { tic_snapshot: { representatives: [{ name: 'Anna', positionDescription: 'VD' }] } } })
    enqueue({ data: null, count: 0 }) // company_signatory_rules count
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
