import { describe, expect, it } from 'vitest'
import { parseDecisionPayload } from '../payloads'
import {
  boardAfterElection,
  dividendPerShare,
  justerareState,
  kallelseWindow,
  meetingDeadlines,
  meetingWarnings,
  minutesSigners,
  planRoleEffects,
  type DecisionShape,
  type MeetingShape,
  type RoleShape,
} from '../rules'
import { decisionText, type MinutesTextContext } from '../minutes-text'
import { buildArsstammaTemplate, buildProceduralTemplate } from '../template'
import { agmFields, defaultItemNumber, renumber } from '../store'
import { buildMinutesPdfData, minutesFilename } from '../minutes-pdf-data'
import type { MeetingDetail } from '../view'

const ANNA = '11111111-1111-4111-8111-111111111111'
const BO = '22222222-2222-4222-8222-222222222222'
const CARL = '33333333-3333-4333-8333-333333333333'
const FP = '44444444-4444-4444-8444-444444444444'

function stamma(overrides: Partial<MeetingShape> = {}): MeetingShape {
  return {
    id: 'm1',
    kind: 'arsstamma',
    organ: 'bolagsstamma',
    status: 'draft',
    meeting_date: '2027-05-10',
    held_at: null,
    chair_party_id: ANNA,
    secretary_party_id: ANNA,
    adjuster_party_ids: [],
    kallelse_date: null,
    attendees: [],
    voting_list: {
      as_of: '2027-05-10',
      total_shares: 1000,
      total_votes: 1000,
      holders: [{ party_id: ANNA, name: 'Anna Ek', kind: 'person', shares: 1000, votes: 1000, present: true, proxy_name: null }],
    },
    ...overrides,
  }
}

function board(overrides: Partial<MeetingShape> = {}): MeetingShape {
  return stamma({
    kind: 'styrelsemote',
    organ: 'styrelse',
    voting_list: {},
    chair_party_id: ANNA,
    secretary_party_id: BO,
    attendees: [
      { party_id: ANNA, name: 'Anna Ek', capacity: 'styrelseledamot', present: true },
      { party_id: BO, name: 'Bo Ek', capacity: 'styrelseledamot', present: true },
      { party_id: CARL, name: 'Carl Ek', capacity: 'styrelseledamot', present: false },
    ],
    ...overrides,
  })
}

describe('decision payloads', () => {
  it('validates each kind strictly and fills defaults', () => {
    const ok = parseDecisionPayload('utdelning', { amount_per_share: 50, share_count: 1000, total_amount: 50000, payment_date: '2027-05-31' })
    expect(ok).toMatchObject({ ok: true, payload: { amount_per_share: 50, payment_date: '2027-05-31' } })
    const extra = parseDecisionPayload('utdelning', { amount_per_share: 50, share_count: 1000, total_amount: 50000, personnummer: '198001011234' })
    expect(extra.ok).toBe(false)
    const missing = parseDecisionPayload('nyemission', { share_count: 10 })
    expect(missing).toMatchObject({ ok: false, issues: [{ field: 'price_per_share' }] })
    expect(parseDecisionPayload('val_revisor', { auditors: [] })).toMatchObject({ ok: true, payload: { no_auditor: false } })
    expect(parseDecisionPayload('resultatdisposition', {})).toMatchObject({ ok: true, payload: { follows_board_proposal: true } })
    expect(parseDecisionPayload('val_styrelse', { members: [{ name: 'Bo', role: 'vd' }] }).ok).toBe(false)
  })
})

describe('justering and signers', () => {
  it('needs no justerare when the chair and the protokollförare hold every share (ABL 7:48)', () => {
    expect(justerareState(stamma(), 1)).toBe('not_needed_holds_all_shares')
    const two = stamma({
      voting_list: {
        as_of: '2027-05-10',
        total_shares: 1000,
        total_votes: 1000,
        holders: [
          { party_id: ANNA, name: 'Anna Ek', kind: 'person', shares: 600, votes: 600, present: true, proxy_name: null },
          { party_id: BO, name: 'Bo Ek', kind: 'person', shares: 400, votes: 400, present: true, proxy_name: null },
        ],
      },
    })
    expect(justerareState(two, 1)).toBe('missing')
    expect(justerareState({ ...two, adjuster_party_ids: [BO] }, 1)).toBe('named')
  })

  it('lets the board members present justera a board meeting with several members (ABL 8:24)', () => {
    // Anna chairs and Bo keeps the minutes: another member present justerar too.
    expect(justerareState(board(), 3)).toBe('missing')
    const carlPresent = board().attendees.map((a) => ({ ...a, present: true }))
    expect(justerareState(board({ attendees: carlPresent }), 3)).toBe('covered_by_board_signatures')
    expect(justerareState(board({ attendees: [] }), 1)).toBe('not_needed_single_member_board')
    expect(justerareState(board({ attendees: [] }), 3)).toBe('missing')
  })

  it('has the protokollförare, chair and justerare sign a stämma, each once', () => {
    expect(minutesSigners(stamma({ adjuster_party_ids: [BO] }), [])).toEqual([
      { party_id: ANNA, role_label: 'Protokollförare och Ordförande' },
      { party_id: BO, role_label: 'Justerare' },
    ])
  })

  it('has every board member present sign board minutes', () => {
    expect(minutesSigners(board(), []).map((s) => s.party_id)).toEqual([BO, ANNA])
  })

  it('has every shareholder or every board member sign per capsulam', () => {
    const pc = stamma({ kind: 'per_capsulam' })
    expect(minutesSigners(pc, [])).toEqual([{ party_id: ANNA, role_label: 'Aktieägare' }])
    const boardPc = stamma({ kind: 'per_capsulam', organ: 'styrelse', voting_list: {} })
    expect(
      minutesSigners(boardPc, [
        { party_id: ANNA, role: 'styrelseordforande' },
        { party_id: BO, role: 'styrelseledamot' },
      ]),
    ).toEqual([
      { party_id: ANNA, role_label: 'Styrelseordförande' },
      { party_id: BO, role_label: 'Styrelseledamot' },
    ])
  })
})

describe('elections change the roles', () => {
  const roles: RoleShape[] = [
    { id: 'r1', party_id: ANNA, role: 'styrelseledamot', valid_from: '2020-01-10', valid_to: null, name: 'Anna Ek' },
    { id: 'r2', party_id: BO, role: 'styrelsesuppleant', valid_from: '2020-01-10', valid_to: null, name: 'Bo Ek' },
    { id: 'r3', party_id: CARL, role: 'revisor', valid_from: '2020-01-10', valid_to: null, name: 'Exempel Revision AB' },
    { id: 'r4', party_id: CARL, role: 'styrelseledamot', valid_from: '2019-01-01', valid_to: '2019-12-31', name: 'Carl' },
  ]

  it('keeps the re-elected, adds the new from the meeting day and ends the rest the day before', () => {
    const decisions: DecisionShape[] = [
      {
        id: 'd1',
        kind: 'val_styrelse',
        outcome: 'bifallen',
        payload: { members: [{ party_id: ANNA, name: 'Anna Ek', role: 'styrelseledamot' }, { name: 'Dora Ny', role: 'styrelsesuppleant' }] },
      },
    ]
    const effects = planRoleEffects(decisions, roles, '2027-05-10')
    expect(effects).toEqual([
      expect.objectContaining({ action: 'keep', role: 'styrelseledamot', party_id: ANNA, company_role_id: 'r1' }),
      expect.objectContaining({ action: 'add', role: 'styrelsesuppleant', party_id: null, name: 'Dora Ny', date: '2027-05-10' }),
      expect.objectContaining({ action: 'end', role: 'styrelsesuppleant', party_id: BO, date: '2027-05-09', company_role_id: 'r2' }),
    ])
    expect(boardAfterElection(effects)).toEqual({ members: 1, suppleants: 1 })
  })

  it('matches an election by name when it names no party, and leaves the revisor alone', () => {
    const effects = planRoleEffects(
      [{ id: 'd1', kind: 'val_styrelse', outcome: 'bifallen', payload: { members: [{ name: 'anna ek', role: 'styrelseledamot' }, { name: 'Bo Ek', role: 'styrelsesuppleant' }] } }],
      roles,
      '2027-05-10',
    )
    expect(effects.every((e) => e.action === 'keep')).toBe(true)
  })

  it('changes nothing for a rejected or tabled election', () => {
    expect(planRoleEffects([{ id: 'd1', kind: 'val_styrelse', outcome: 'avslagen', payload: { members: [] } }], roles, '2027-05-10')).toEqual([])
  })

  it('replaces the revisor on a new auditor election', () => {
    const effects = planRoleEffects(
      [{ id: 'd2', kind: 'val_revisor', outcome: 'bifallen', payload: { auditors: [{ name: 'Ny Revision AB', kind: 'company', org_number: '5560000000', role: 'revisor' }] } }],
      roles,
      '2027-05-10',
    )
    expect(effects.map((e) => [e.action, e.name, e.role])).toEqual([
      ['add', 'Ny Revision AB', 'revisor'],
      ['end', 'Exempel Revision AB', 'revisor'],
    ])
  })
})

describe('deadlines', () => {
  it('raises the kallelse, handlingar and minutes deadlines for a planned årsstämma', () => {
    const drafts = meetingDeadlines(stamma(), [], '2027-03-01', { roles: false })
    expect(drafts.map((d) => [d.key, d.dueOn])).toEqual([
      ['kallelse', '2027-04-12'],
      ['handlingar', '2027-04-26'],
      ['protokoll', '2027-05-24'],
    ])
  })

  it('gives an extra stämma two weeks for kallelse, four when it amends the bolagsordning (ABL 7:18-20)', () => {
    expect(kallelseWindow('extra_stamma', '2027-05-10', false)).toEqual({ earliest: '2027-03-29', latest: '2027-04-26', weeks: 2 })
    expect(kallelseWindow('extra_stamma', '2027-05-10', true).latest).toBe('2027-04-12')
  })

  it('drops the kallelse once it is recorded, and the minutes deadline once signed', () => {
    expect(meetingDeadlines(stamma({ kallelse_date: '2027-04-01' }), [], '2027-03-01', { roles: false }).map((d) => d.key)).toEqual(['handlingar', 'protokoll'])
    expect(meetingDeadlines(stamma({ status: 'signed', held_at: '2027-05-10T10:00:00Z' }), [], '2027-05-11', { roles: false })).toEqual([])
  })

  it('asks for a Bolagsverket notice at once after a held meeting changed the board (ABL 8:44)', () => {
    const drafts = meetingDeadlines(board({ status: 'held', held_at: '2027-05-12T08:00:00Z' }), [], '2027-05-12', { roles: true })
    expect(drafts).toEqual([expect.objectContaining({ key: 'bolagsverket', dueOn: '2027-05-12', priority: 'critical' })])
    expect(drafts[0]!.notes).toContain('verksamt.se')
  })
})

describe('warnings', () => {
  it('warns about a dividend without betalningsdag and a total that does not add up', () => {
    const warnings = meetingWarnings(
      stamma(),
      [{ id: 'd', kind: 'utdelning', outcome: 'bifallen', payload: { amount_per_share: 33.33, share_count: 3, total_amount: 100 } }],
      { boardSize: 1, boardAfter: null },
    )
    expect(warnings.map((w) => w.code)).toEqual(['DIVIDEND_PAYMENT_DATE_MISSING', 'DIVIDEND_TOTAL_MISMATCH'])
  })

  it('notes per capsulam has no ABL rule, a board below three needs a suppleant, and stämma decisions at the board', () => {
    const codes = meetingWarnings(
      board({ attendees: board().attendees.map((a) => ({ ...a, present: true })) }),
      [{ id: 'd', kind: 'faststallande_rr_br', outcome: 'bifallen', payload: {} }],
      { boardSize: 3, boardAfter: { members: 2, suppleants: 0 } },
    ).map((w) => w.code)
    expect(codes).toEqual(['STAMMA_DECISION_AT_BOARD', 'BOARD_NEEDS_SUPPLEANT'])
    expect(meetingWarnings(stamma({ kind: 'per_capsulam' }), [], { boardSize: 1, boardAfter: null }).map((w) => w.code)).toContain('PER_CAPSULAM_ALL_SHAREHOLDERS')
  })

  it('splits a dividend per share in öre', () => {
    expect(dividendPerShare(50000, 1000)).toEqual({ per_share: 50, exact: true })
    expect(dividendPerShare(100, 3)).toEqual({ per_share: 33.33, exact: false })
  })
})

describe('the årsstämma template', () => {
  const template = buildArsstammaTemplate({
    fiscalPeriod: { id: FP, period_start: '2026-01-01', period_end: '2026-12-31' },
    annualReport: { versionId: '55555555-5555-4555-8555-555555555555', resultatdisposition: 'Styrelsen föreslår utdelning.', proposedDividend: 50000, amounts: { total: 300000, carried_forward: 250000 } },
    board: [{ party_id: ANNA, name: 'Anna Ek', role: 'styrelseledamot' }, { party_id: BO, name: 'Bo Ek', role: 'styrelsesuppleant' }],
    auditors: [],
    discharge: [{ party_id: ANNA, name: 'Anna Ek', roles: ['styrelseledamot', 'vd'] }],
    totalShares: 1000,
  })

  it('prefills adoption, disposition, dividend, discharge, fees and re-election (ABL 7:11)', () => {
    expect(template.map((d) => d.kind)).toEqual([
      'ovrigt', 'ovrigt', 'ovrigt', 'ovrigt', 'ovrigt', 'ovrigt', 'ovrigt',
      'faststallande_rr_br', 'resultatdisposition', 'utdelning', 'ansvarsfrihet', 'arvoden', 'val_styrelse', 'ovrigt',
    ])
    const dividend = template.find((d) => d.kind === 'utdelning')!
    expect(dividend.payload).toMatchObject({ amount_per_share: 50, share_count: 1000, total_amount: 50000, payment_date: null, fiscal_period_id: FP })
    expect(template.find((d) => d.kind === 'resultatdisposition')!.payload).toMatchObject({ available_amount: 300000, dividend_total: 50000, carried_forward: 250000 })
    expect(template.find((d) => d.kind === 'val_styrelse')!.payload).toMatchObject({ members: [{ party_id: ANNA, role: 'styrelseledamot' }, { party_id: BO, role: 'styrelsesuppleant' }] })
    expect(template.some((d) => d.kind === 'val_revisor')).toBe(false)
    for (const d of template) expect(parseDecisionPayload(d.kind, d.payload).ok, d.kind).toBe(true)
  })

  it('has no dividend paragraph without a proposed dividend, and procedural items only elsewhere', () => {
    const none = buildArsstammaTemplate({
      fiscalPeriod: { id: FP, period_start: '2026-01-01', period_end: '2026-12-31' },
      annualReport: null,
      board: [],
      auditors: [{ party_id: CARL, name: 'Exempel Revision AB', kind: 'company', org_number: '5560000000', role: 'revisor' }],
      discharge: [],
      totalShares: 0,
    })
    expect(none.some((d) => d.kind === 'utdelning')).toBe(false)
    expect(none.some((d) => d.kind === 'val_revisor')).toBe(true)
    expect(buildProceduralTemplate('per_capsulam', 'bolagsstamma')).toEqual([])
    expect(buildProceduralTemplate('styrelsemote', 'styrelse').map((d) => d.payload.topic)).toEqual(['oppnande', 'val_justerare', 'dagordning', 'avslutande'])
  })
})

describe('minutes text', () => {
  const ctx: MinutesTextContext = {
    kind: 'arsstamma',
    organ: 'bolagsstamma',
    meeting_date: '2027-05-10',
    kallelse_date: '2027-04-08',
    kallelse_method: 'e-post',
    chair_name: 'Anna Ek',
    secretary_name: 'Anna Ek',
    adjuster_names: [],
    justering: 'not_needed_holds_all_shares',
    fiscal_period: { period_start: '2026-01-01', period_end: '2026-12-31' },
    has_auditor: false,
  }

  it('composes each paragraph from its terms, and a written text wins', () => {
    const text = (kind: DecisionShape['kind'], payload: Record<string, unknown>, outcome: DecisionShape['outcome'] = 'bifallen', own: string | null = null) =>
      decisionText({ kind, payload, outcome, text: own }, ctx)
    expect(text('faststallande_rr_br', {})).toBe('Stämman fastställde resultaträkningen och balansräkningen för räkenskapsåret 2026-01-01 till 2026-12-31.')
    expect(text('utdelning', { amount_per_share: 50, share_count: 1000, total_amount: 50000, payment_date: '2027-05-31' })).toContain('Betalningsdag är 2027-05-31.')
    expect(text('val_styrelse', { members: [{ name: 'Anna Ek', role: 'styrelseledamot' }, { name: 'Bo Ek', role: 'styrelsesuppleant' }], term: 'intill slutet av nästa årsstämma' })).toBe(
      'Till styrelseledamot valdes Anna Ek för tiden intill slutet av nästa årsstämma. Till styrelsesuppleant valdes Bo Ek för tiden intill slutet av nästa årsstämma.',
    )
    expect(text('ovrigt', { topic: 'val_justerare' })).toContain('7 kap. 48 §')
    expect(text('ovrigt', { topic: 'kallelse' })).toBe('Stämman förklarades behörigen sammankallad. Kallelse skedde 2027-04-08 genom e-post.')
    expect(text('ansvarsfrihet', { persons: [{ name: 'Anna Ek', granted: true }, { name: 'Bo Ek', granted: false }] })).toBe(
      'Stämman beviljade Anna Ek ansvarsfrihet för förvaltningen under räkenskapsåret 2026-01-01 till 2026-12-31. Stämman beviljade inte Bo Ek ansvarsfrihet.',
    )
    expect(text('nyemission', { share_count: 10, price_per_share: 100 }, 'bordlagd')).toBe('Frågan bordlades.')
    expect(text('ovrigt', {}, 'bifallen', 'Egen text.')).toBe('Egen text.')
  })
})

describe('the AGM fields on the årsredovisning', () => {
  const adopted = [
    { kind: 'faststallande_rr_br' as const, outcome: 'bifallen' as const, payload: {}, text: null },
    { kind: 'resultatdisposition' as const, outcome: 'bifallen' as const, payload: { follows_board_proposal: false }, text: 'Hela resultatet balanseras.' },
  ]
  const meeting = { kind: 'arsstamma' as const, status: 'held' as const, meeting_date: '2027-05-10', fiscal_period_id: FP }

  it('records the date and an alternative disposition once held and adopted', () => {
    expect(agmFields(meeting, adopted, (d) => d.text ?? '')).toEqual({
      fiscal_period_id: FP,
      agm_date: '2027-05-10',
      agm_disposition_outcome: 'alternative_decision',
      agm_disposition_decision: 'Hela resultatet balanseras.',
    })
  })

  it('records nothing for a draft, a board meeting or a stämma that did not adopt the accounts', () => {
    expect(agmFields({ ...meeting, status: 'draft' }, adopted, () => '')).toBeNull()
    expect(agmFields({ ...meeting, kind: 'extra_stamma' }, adopted, () => '')).toBeNull()
    expect(agmFields(meeting, [{ ...adopted[0]!, outcome: 'bordlagd' }], () => '')).toBeNull()
  })
})

describe('paragraph numbering', () => {
  const rows = [
    { id: 'a', item_number: 1 },
    { id: 'b', item_number: 2 },
    { id: 'c', item_number: 3 },
  ]

  it('moves a paragraph to its place and numbers every paragraph 1..n', () => {
    expect([...renumber(rows, 'c', 1)]).toEqual([['c', 1], ['a', 2], ['b', 3]])
    expect([...renumber(rows.filter((r) => r.id !== 'b'), null, null)]).toEqual([['a', 1], ['c', 2]])
  })

  it('places a new paragraph before the closing item', () => {
    expect(defaultItemNumber([{ kind: 'ovrigt', payload: { topic: 'oppnande' }, item_number: 1 }, { kind: 'ovrigt', payload: { topic: 'avslutande' }, item_number: 2 }])).toBe(2)
    expect(defaultItemNumber([{ kind: 'utdelning', payload: {}, item_number: 4 }])).toBe(5)
    expect(defaultItemNumber([])).toBe(1)
  })
})

describe('the minutes PDF content', () => {
  const view = {
    corporate_meeting_id: 'm1',
    kind: 'styrelsemote',
    kind_label: 'Styrelsemöte',
    organ: 'styrelse',
    title: 'Styrelsemöte nr 4',
    sequence_number: 4,
    meeting_date: '2027-03-01',
    meeting_time: '10:00',
    place: 'Kontoret',
    is_digital: false,
    status: 'held',
    fiscal_period_id: null,
    signing_pending: false,
    signed_at: null,
    chair: { party_id: ANNA, name: 'Anna Ek' },
    secretary: { party_id: BO, name: 'Bo Ek' },
    adjusters: [],
    kallelse_date: null,
    kallelse_method: null,
    kallelse_window: null,
    fiscal_period: null,
    voting_list: null,
    present: null,
    attendees: [
      { party_id: ANNA, name: 'Anna Ek', capacity: 'styrelseledamot', present: true },
      { party_id: CARL, name: 'Carl Ek', capacity: 'styrelseledamot', present: false },
    ],
    notes: null,
    held_at: '2027-03-01T12:00:00Z',
    signature_names: null,
    minutes_document_id: null,
    signed_document_id: null,
    signing_request_id: null,
    decisions: [
      {
        corporate_decision_id: 'd1', item_number: 1, kind: 'ovrigt', kind_label: 'Övrigt', title: 'Mötets öppnande', text: null,
        text_rendered: 'Mötet öppnades av Anna Ek.', payload: {}, outcome: 'bifallen', outcome_label: 'Bifallen',
        votes_for: 2, votes_against: 1, votes_abstained: null, reservations: 'Carl Ek reserverade sig.',
      },
    ],
    justering: 'covered_by_board_signatures',
    signers: [{ party_id: BO, name: 'Bo Ek', role_label: 'Protokollförare', has_email: true }],
    register_effects: { planned: [], kept: [], applied: { added: [], ended: [] } },
    warnings: [],
    signing: null,
  } as MeetingDetail

  it('numbers board minutes, lists who was there and records the vote and the reservation', () => {
    const data = buildMinutesPdfData(view, { name: 'Test AB', org_number: '5561234567' }, '2027-03-02')
    expect(data.title).toBe('Protokoll nr 4')
    expect(data.heading).toBe('Protokoll fört vid styrelsemöte i Test AB')
    expect(data.present).toEqual(['Anna Ek, styrelseledamot'])
    expect(data.absent).toEqual(['Carl Ek, styrelseledamot'])
    expect(data.paragraphs[0]).toMatchObject({ number: 1, votes: 'Omröstning: 2 röster för, 1 emot. Förslaget bifölls.', reservations: 'Reservation: Carl Ek reserverade sig.' })
    expect(data.aktiebok_appendix).toBe(false)
    expect(JSON.stringify(data)).not.toMatch(/\d{8}-?\d{4}/)
    expect(minutesFilename(view)).toBe('Protokoll_styrelsemote_nr_4_2027-03-01.pdf')
  })
})
