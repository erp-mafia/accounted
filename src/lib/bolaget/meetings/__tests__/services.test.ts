import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const db = createQueuedMockSupabase()
const service = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => service.supabase }))
vi.mock('@/lib/dates/iso', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/dates/iso')>()),
  todayIsoStockholm: () => '2027-03-01',
}))
vi.mock('../../roles', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../roles')>()),
  loadRoles: vi.fn(),
  addCompanyRole: vi.fn(),
  endCompanyRole: vi.fn(),
}))
vi.mock('../../share-register', () => ({ loadShareRegisterData: vi.fn() }))
vi.mock('../../people', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../people')>()),
  assertPartiesInCompany: vi.fn(),
  ensureRegisterParty: vi.fn(),
  loadRegisterParties: vi.fn().mockResolvedValue(new Map()),
}))

import { addCompanyRole, endCompanyRole, loadRoles, type RolesView } from '../../roles'
import { loadShareRegisterData } from '../../share-register'
import { ensureRegisterParty } from '../../people'
import { createMeeting, deleteMeeting, holdMeeting, loadDecision, recordDecision, updateMeeting } from '../store'
import { applyRegisterEffects } from '../effects'
import type { OperationContext } from '@/lib/operations/types'
import type { ShareRegisterData } from '../../share-register'

const ANNA = '11111111-1111-4111-8111-111111111111'
const BO = '22222222-2222-4222-8222-222222222222'
const FP = '44444444-4444-4444-8444-444444444444'
const MEETING = '66666666-6666-4666-8666-666666666666'

const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
const ctx = { supabase: db.supabase, companyId: 'company-1', userId: 'user-1', log } as unknown as OperationContext

const register = {
  as_of: '2027-05-10',
  is_avstamningsbolag: false,
  classes: [],
  events: [],
  replay: { ranges: [], annotations: [], totalShares: 1000 },
  summary: { total_shares: 1000, total_votes: 1000, classes: [], holders: [{ party_id: ANNA, shares: 1000, votes: 1000, capital_pct: 100, votes_pct: 100, by_class: [], ranges: [] }] },
  parties: new Map([[ANNA, { party_id: ANNA, name: 'Anna Ek', kind: 'person', org_number: null, personnummer_masked: 'XXXXXXXX-1234', birth_date: null, address: null, email: null }]]),
  reconciliation: { status: 'match' },
} as unknown as ShareRegisterData

function rolesView(roles: Array<Partial<RolesView['roles'][number]>> = []): RolesView {
  return { as_of: '2027-05-10', signatory_rule: null, signatory_rules: [], board: [], ceo: null, roles: roles as RolesView['roles'] }
}

const annaBoard = { id: 'r1', party_id: ANNA, role: 'styrelseledamot' as const, valid_from: '2020-01-10', valid_to: null, source: 'person' as const, decision_id: null, registered_at: null, details: {}, created_at: '2020-01-10', party: { party_id: ANNA, name: 'Anna Ek', kind: 'person' as const, org_number: null, personnummer_masked: null, birth_date: null, address: null, email: null }, label_sv: 'Styrelseledamot', active: true }

function meetingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: MEETING,
    kind: 'arsstamma',
    organ: 'bolagsstamma',
    sequence_number: null,
    meeting_date: '2027-05-10',
    meeting_time: null,
    place: null,
    is_digital: false,
    chair_party_id: ANNA,
    secretary_party_id: ANNA,
    adjuster_party_ids: [],
    kallelse_date: null,
    kallelse_method: null,
    fiscal_period_id: FP,
    voting_list: {},
    attendees: [],
    notes: null,
    status: 'draft',
    held_at: null,
    signed_at: null,
    signature_names: null,
    minutes_document_id: null,
    signed_document_id: null,
    signing_request_id: null,
    created_at: '2027-02-01T10:00:00Z',
    updated_at: '2027-02-01T10:00:00Z',
    ...overrides,
  }
}

function decisionRow(id: string, item: number, kind: string, payload: Record<string, unknown> = {}, outcome = 'bifallen') {
  return { id, meeting_id: MEETING, item_number: item, kind, title: kind, text: null, payload, outcome, votes_for: null, votes_against: null, votes_abstained: null, reservations: null, created_at: '', updated_at: '' }
}

beforeEach(() => {
  vi.clearAllMocks()
  db.reset()
  service.reset()
  vi.mocked(loadShareRegisterData).mockResolvedValue(register)
  vi.mocked(loadRoles).mockResolvedValue(rolesView([annaBoard]))
})

describe('createMeeting', () => {
  it('asks for the fiscal year of an årsstämma before reading anything', async () => {
    const outcome = await createMeeting(ctx, { kind: 'arsstamma', meeting_date: '2027-05-10' }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'CORPORATE_MEETING_FISCAL_PERIOD_REQUIRED' })
    expect(db.supabase.from).not.toHaveBeenCalled()
  })

  it('refuses a personnummer anywhere in the input', async () => {
    const outcome = await createMeeting(ctx, { kind: 'styrelsemote', meeting_date: '2027-05-10', chair_name: 'Anna 19800101-1234' }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: false, code: 'BOLAGET_PERSONNUMMER_IN_APP_ONLY' })
  })

  it('never mistakes a party id for a personnummer', async () => {
    const id = '19800101-1234-4abc-8def-123456789abc'
    const outcome = await createMeeting(ctx, { kind: 'styrelsemote', meeting_date: '2027-05-10', chair_party_id: id }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { chair: { party_id: id } } })
  })

  it('previews an årsstämma prefilled from the årsredovisning version, the roles and the aktiebok', async () => {
    db.enqueue({ data: { id: FP, period_start: '2026-01-01', period_end: '2026-12-31' } }) // fiscal_periods
    db.enqueue({ data: [] }) // earlier årsstämmor
    db.enqueue({
      data: [{ id: 'v1', version_number: 2, status: 'signed', report_data: { forvaltningsberattelse: { resultatdisposition: 'Förslag', proposed_dividend: 50000, resultatdisposition_amounts: { total: 300000, carried_forward: 250000 } } } }],
    })
    const outcome = await createMeeting(ctx, { kind: 'arsstamma', meeting_date: '2027-05-10', fiscal_period_id: FP }, { dryRun: true })
    expect(outcome.ok && outcome.dryRun).toBe(true)
    const preview = (outcome as { preview: Record<string, unknown> }).preview
    expect(preview).toMatchObject({ organ: 'bolagsstamma', voting_list: { holders: 1, total_shares: 1000 }, warnings: [] })
    const agenda = preview.agenda as Array<{ kind: string; title: string }>
    expect(agenda.map((a) => a.kind)).toContain('utdelning')
    expect(agenda.find((a) => a.kind === 'val_styrelse')).toBeDefined()
    expect(db.findCalls('corporate_meetings', 'insert')).toEqual([])
  })

  it('creates a board meeting with the board present and its agenda, and syncs its deadlines', async () => {
    db.enqueue({ data: { id: MEETING } }) // corporate_meetings insert
    db.enqueueMany([{}, {}, {}, {}]) // four procedural paragraphs
    db.enqueue({ data: meetingRow({ kind: 'styrelsemote', organ: 'styrelse', fiscal_period_id: null }) }) // reload
    db.enqueue({ data: [] }) // decisions
    service.enqueue({ data: [] }) // existing deadlines
    const outcome = await createMeeting(ctx, { kind: 'styrelsemote', meeting_date: '2027-05-10', place: 'Kontoret' }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { corporate_meeting_id: MEETING, organ: 'styrelse', status: 'draft', decisions_count: 4 } })
    expect(db.findCall('corporate_meetings', 'insert')?.[0]).toMatchObject({
      company_id: 'company-1',
      kind: 'styrelsemote',
      organ: 'styrelse',
      place: 'Kontoret',
      voting_list: {},
      attendees: [{ party_id: ANNA, name: 'Anna Ek', capacity: 'styrelseledamot', present: true }],
      created_by: 'user-1',
    })
    expect(db.findCalls('corporate_decisions', 'insert').map((c) => (c[0] as { item_number: number }).item_number)).toEqual([1, 2, 3, 4])
    // A board meeting raises no stämma deadline.
    expect(service.findCalls('deadlines', 'insert')).toEqual([])
  })

  it('resolves a new chair by name in the register', async () => {
    vi.mocked(ensureRegisterParty).mockResolvedValueOnce(BO)
    db.enqueue({ data: { id: MEETING } })
    db.enqueue({ data: meetingRow({ kind: 'per_capsulam', organ: 'styrelse', fiscal_period_id: null }) })
    db.enqueue({ data: [] })
    service.enqueue({ data: [] })
    const outcome = await createMeeting(ctx, { kind: 'per_capsulam', organ: 'styrelse', meeting_date: '2027-05-10', chair_name: 'Bo Ek' }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { organ: 'styrelse', decisions_count: 0 } })
    expect(db.findCall('corporate_meetings', 'insert')?.[0]).toMatchObject({ chair_party_id: BO, attendees: [] })
  })
})

describe('recordDecision', () => {
  it('refuses terms that do not fit the kind, naming the fields', async () => {
    db.enqueue({ data: meetingRow() })
    db.enqueue({ data: [] })
    const outcome = await recordDecision(ctx, { corporate_meeting_id: MEETING, kind: 'utdelning', payload: { amount_per_share: 5 } }, { dryRun: false })
    expect(outcome).toMatchObject({ ok: false, code: 'CORPORATE_DECISION_PAYLOAD_INVALID' })
    expect((outcome as { messageSv: string }).messageSv).toContain('share_count')
  })

  it('never changes signed minutes, nor minutes out for signing', async () => {
    db.enqueue({ data: meetingRow({ status: 'signed', held_at: 'x', signed_at: 'y' }) })
    expect(await recordDecision(ctx, { corporate_meeting_id: MEETING, kind: 'ovrigt' }, { dryRun: true })).toMatchObject({ ok: false, code: 'CORPORATE_MEETING_LOCKED' })
    db.enqueue({ data: meetingRow({ status: 'held', held_at: 'x', signing_request_id: 'sr1' }) })
    expect(await recordDecision(ctx, { corporate_meeting_id: MEETING, kind: 'ovrigt' }, { dryRun: true })).toMatchObject({ ok: false, code: 'CORPORATE_MEETING_SIGNING_PENDING' })
  })

  it('adds a decision before the closing item and renumbers the paragraphs', async () => {
    const open = decisionRow('d1', 1, 'ovrigt', { topic: 'oppnande' })
    const close = decisionRow('d2', 2, 'ovrigt', { topic: 'avslutande' })
    db.enqueue({ data: meetingRow() })
    db.enqueue({ data: [open, close] })
    db.enqueue({ data: { id: 'd3' } }) // insert
    db.enqueue({ data: [open, close, decisionRow('d3', 3, 'utdelning')] }) // reload for numbering
    const outcome = await recordDecision(
      ctx,
      { corporate_meeting_id: MEETING, kind: 'utdelning', payload: { amount_per_share: 50, share_count: 1000, total_amount: 50000 } },
      { dryRun: false },
    )
    expect(outcome).toMatchObject({ ok: true, data: { corporate_decision_id: 'd3', item_number: 2, kind: 'utdelning' }, created: true })
    expect(db.findCall('corporate_decisions', 'insert')?.[0]).toMatchObject({ kind: 'utdelning', title: 'Utdelning', outcome: 'bifallen' })
    expect(db.findCalls('corporate_decisions', 'update').map((c) => c[0])).toEqual([{ item_number: 3 }, { item_number: 2 }])
  })
})

describe('updateMeeting', () => {
  it('takes the röstlängd again when the date moves, keeping presence by holder', async () => {
    db.enqueue({ data: meetingRow({ voting_list: { as_of: '2027-05-10', total_shares: 1000, total_votes: 1000, holders: [{ party_id: ANNA, name: 'Anna Ek', kind: 'person', shares: 1000, votes: 1000, present: false, proxy_name: 'Ombud' }] } }) })
    const outcome = await updateMeeting(ctx, MEETING, { meeting_date: '2027-05-12' }, { dryRun: true })
    expect(outcome).toMatchObject({ ok: true, dryRun: true, preview: { voting_list_refreshed: true } })
    expect(loadShareRegisterData).toHaveBeenCalledWith(ctx, '2027-05-12')
  })
})

describe('holdMeeting', () => {
  it('refuses a meeting whose day has not come', async () => {
    db.enqueue({ data: meetingRow() })
    expect(await holdMeeting(ctx, MEETING, { dryRun: false })).toMatchObject({ ok: false, code: 'CORPORATE_MEETING_IN_FUTURE' })
  })

  it('holds an årsstämma and writes the AGM date and outcome to the årsredovisning', async () => {
    const decisions = [decisionRow('d1', 1, 'faststallande_rr_br', { fiscal_period_id: FP }), decisionRow('d2', 2, 'resultatdisposition', { follows_board_proposal: true })]
    const draft = meetingRow({ meeting_date: '2027-02-20' })
    db.enqueue({ data: draft })
    db.enqueue({ data: decisions })
    db.enqueue({ data: { sequence_number: null } }) // update
    db.enqueue({ data: { ...draft, status: 'held', held_at: '2027-03-01T09:00:00Z' } }) // reload
    db.enqueue({ data: decisions })
    db.enqueue({}) // narrative upsert
    service.enqueue({ data: [] })
    const outcome = await holdMeeting(ctx, MEETING, { dryRun: false })
    expect(outcome).toMatchObject({ ok: true, data: { status: 'held', sequence_number: null, agm_recorded: true } })
    expect(db.findCall('corporate_meetings', 'update')?.[0]).toMatchObject({ status: 'held' })
    expect(db.findCall('arsredovisning_narratives', 'upsert')).toEqual([
      { user_id: 'user-1', company_id: 'company-1', fiscal_period_id: FP, agm_date: '2027-02-20', agm_disposition_outcome: 'proposal_approved', agm_disposition_decision: null },
      { onConflict: 'company_id,fiscal_period_id' },
    ])
    expect(service.findCall('deadlines', 'insert')?.[0]).toMatchObject({ source_key: `bolaget:meeting:${MEETING}:protokoll`, due_date: '2027-03-06' })
  })
})

describe('deleteMeeting', () => {
  it('keeps a held meeting', async () => {
    db.enqueue({ data: meetingRow({ status: 'held', held_at: 'x' }) })
    expect(await deleteMeeting(ctx, MEETING)).toMatchObject({ ok: false, code: 'CORPORATE_MEETING_NOT_DRAFT' })
  })
})

describe('applyRegisterEffects', () => {
  it('ends the departing member the day before and adds the elected one from the meeting day, both carrying the decision', async () => {
    vi.mocked(endCompanyRole).mockResolvedValue({ ok: true, data: { company_role_id: 'r1', valid_to: '2027-05-09' } })
    vi.mocked(addCompanyRole).mockResolvedValue({ ok: true, data: { company_role_id: 'r9', party_id: BO, role: 'styrelseledamot', valid_from: '2027-05-10' }, created: true })
    const outcome = await applyRegisterEffects(ctx, { id: MEETING, kind: 'arsstamma', meeting_date: '2027-05-10' }, [
      { id: 'd1', kind: 'val_styrelse', outcome: 'bifallen', payload: { members: [{ party_id: BO, name: 'Bo Ek', role: 'styrelseledamot' }] } },
    ])
    expect(outcome).toEqual({ ok: true, added: ['r9'], ended: ['r1'], warnings: [] })
    expect(vi.mocked(endCompanyRole).mock.calls[0]![1]).toEqual({ company_role_id: 'r1', valid_to: '2027-05-09', reason: 'Årsstämma 2027-05-10', decision_id: 'd1' })
    expect(vi.mocked(addCompanyRole).mock.calls[0]![1]).toMatchObject({ party: { party_id: BO }, role: 'styrelseledamot', valid_from: '2027-05-10', source: 'decision', decision_id: 'd1' })
  })

  it('stops at a refusal so the minutes stay unsigned', async () => {
    vi.mocked(addCompanyRole).mockResolvedValue({ ok: false, code: 'BOLAGET_PARTY_NOT_FOUND' })
    vi.mocked(endCompanyRole).mockResolvedValue({ ok: true, data: { company_role_id: 'r1', valid_to: '2027-05-09' } })
    const outcome = await applyRegisterEffects(ctx, { id: MEETING, kind: 'arsstamma', meeting_date: '2027-05-10' }, [
      { id: 'd1', kind: 'val_styrelse', outcome: 'bifallen', payload: { members: [{ party_id: BO, name: 'Bo Ek', role: 'styrelseledamot' }] } },
    ])
    expect(outcome).toMatchObject({ ok: false, code: 'BOLAGET_PARTY_NOT_FOUND' })
  })

  it('does nothing without an adopted election', async () => {
    expect(await applyRegisterEffects(ctx, { id: MEETING, kind: 'arsstamma', meeting_date: '2027-05-10' }, [])).toEqual({ ok: true, added: [], ended: [], warnings: [] })
    expect(loadRoles).not.toHaveBeenCalled()
  })
})

describe('loadDecision', () => {
  it('answers a decision with its meeting and validated terms, final once signed', async () => {
    db.enqueue({ data: decisionRow('d1', 10, 'utdelning', { amount_per_share: 50, share_count: 1000, total_amount: 50000, payment_date: '2027-05-31' }) })
    db.enqueue({ data: meetingRow({ status: 'signed', held_at: 'x', signed_at: 'y' }) })
    expect(await loadDecision(ctx, 'd1')).toMatchObject({
      corporate_decision_id: 'd1',
      corporate_meeting_id: MEETING,
      meeting_date: '2027-05-10',
      final: true,
      kind: 'utdelning',
      outcome: 'bifallen',
      payload: { amount_per_share: 50, payment_date: '2027-05-31' },
      fiscal_period_id: FP,
    })
  })

  it('answers null for another company\'s decision', async () => {
    db.enqueue({ data: null })
    expect(await loadDecision(ctx, 'd1')).toBeNull()
  })
})
