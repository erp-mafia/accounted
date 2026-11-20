/**
 * Meetings, decisions and minutes through the machine doors: bolagsstämmor,
 * styrelsemöten and per capsulam decisions (ABL 7 kap., 8:24-26). The rules
 * live in src/lib/bolaget/meetings; the dashboard's /api/bolaget/meetings
 * routes call the same functions.
 *
 * Reads answer names only: never a personnummer, never an email address.
 * Every write stages over MCP and a person approves it. Signing the minutes
 * has no machine door: BankID is a person's, and a hand-signed copy is
 * uploaded in Accounted.
 *
 * Every door is dark outside BOLAGET_COMPANY_IDS and for a legal form that
 * keeps no aktiebok (BOLAGET_DISABLED, BOLAGET_NOT_FOR_LEGAL_FORM).
 */
import { z } from 'zod'
import { saneIsoDateSchema } from '@/lib/invariants/zod'
import { bolagetGate } from '@/lib/bolaget/gate'
import { createMeeting, holdMeeting, recordDecision, updateMeeting } from '@/lib/bolaget/meetings/store'
import { getMeetingView, listMeetingsView } from '@/lib/bolaget/meetings/view'
import {
  ATTENDEE_CAPACITIES,
  DECISION_KINDS,
  DECISION_OUTCOMES,
  MEETING_KINDS,
  MEETING_ORGANS,
  MEETING_STATUSES,
} from '@/lib/bolaget/meetings/types'
import { defineOperation, type OperationContext, type OperationOutcome } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

async function gated<T>(ctx: OperationContext, run: () => Promise<OperationOutcome<T>>): Promise<OperationOutcome<T>> {
  const code = await bolagetGate(ctx.supabase, ctx.companyId)
  if (code) return { ok: false, code }
  return run()
}

const GATE_CODES = ['BOLAGET_DISABLED', 'BOLAGET_NOT_FOR_LEGAL_FORM']
const MEETING_ID = z.string().uuid().describe('The meeting (corporate_meeting_id).')
const PARTY_ID = z.string().uuid()
const NAME = z.string().trim().min(1).max(200)

// ── Outputs ──────────────────────────────────────────────────────────

const PersonOut = z.object({ party_id: z.string(), name: z.string() })

const MeetingSummaryOut = z.object({
  corporate_meeting_id: z.string(),
  kind: z.enum(MEETING_KINDS),
  kind_label: z.string(),
  organ: z.enum(MEETING_ORGANS).describe('Whose decisions: bolagsstamma (shareholders) or styrelse (board).'),
  title: z.string(),
  sequence_number: z.number().int().nullable().describe('Board minutes number (ABL 8:26), given when the meeting is held.'),
  meeting_date: z.string(),
  place: z.string().nullable(),
  is_digital: z.boolean(),
  status: z.enum(MEETING_STATUSES).describe('draft, held (minutes open) or signed (frozen).'),
  fiscal_period_id: z.string().nullable(),
  signing_pending: z.boolean(),
  signed_at: z.string().nullable(),
})

const EffectOut = z.object({
  action: z.enum(['add', 'end', 'keep']),
  decision_id: z.string(),
  role: z.string(),
  party_id: z.string().nullable(),
  name: z.string(),
  date: z.string().describe('add: first day in the role; end: last day.'),
  company_role_id: z.string().nullable(),
})

const AppliedOut = z.object({
  company_role_id: z.string(),
  decision_id: z.string(),
  party_id: z.string(),
  name: z.string(),
  role: z.string(),
  role_label: z.string(),
  date: z.string().nullable(),
})

const MeetingDetailOut = MeetingSummaryOut.extend({
  meeting_time: z.string().nullable(),
  chair: PersonOut.nullable(),
  secretary: PersonOut.nullable(),
  adjusters: z.array(PersonOut).describe('Justerare.'),
  kallelse_date: z.string().nullable(),
  kallelse_method: z.string().nullable(),
  kallelse_window: z.object({ earliest: z.string(), latest: z.string() }).nullable().describe('When the kallelse is sent (ABL 7:18-20).'),
  fiscal_period: z.object({ period_start: z.string(), period_end: z.string() }).nullable(),
  voting_list: z
    .object({
      as_of: z.string(),
      total_shares: z.number(),
      total_votes: z.number(),
      holders: z.array(
        z.object({
          party_id: z.string(),
          name: z.string(),
          kind: z.enum(['person', 'company']),
          shares: z.number(),
          votes: z.number(),
          present: z.boolean(),
          proxy_name: z.string().nullable(),
        }),
      ),
    })
    .nullable()
    .describe('Röstlängd: the aktiebok on the meeting day (ABL 7:48), names only.'),
  present: z.object({ holders: z.number(), shares: z.number(), votes: z.number() }).nullable(),
  attendees: z.array(z.object({ party_id: z.string().nullable(), name: z.string(), capacity: z.enum(ATTENDEE_CAPACITIES), present: z.boolean() })),
  notes: z.string().nullable(),
  held_at: z.string().nullable(),
  signature_names: z.string().nullable(),
  minutes_document_id: z.string().nullable(),
  signed_document_id: z.string().nullable(),
  signing_request_id: z.string().nullable(),
  decisions: z.array(
    z.object({
      corporate_decision_id: z.string(),
      item_number: z.number().int(),
      kind: z.enum(DECISION_KINDS),
      kind_label: z.string(),
      title: z.string(),
      text: z.string().nullable().describe('The text a person wrote; null when composed from the payload.'),
      text_rendered: z.string().describe('The paragraph as the minutes print it.'),
      payload: z.record(z.string(), z.unknown()),
      outcome: z.enum(DECISION_OUTCOMES),
      outcome_label: z.string(),
      votes_for: z.number().nullable(),
      votes_against: z.number().nullable(),
      votes_abstained: z.number().nullable(),
      reservations: z.string().nullable(),
    }),
  ),
  justering: z.enum([
    'named',
    'not_needed_holds_all_shares',
    'not_needed_single_member_board',
    'covered_by_board_signatures',
    'not_applicable',
    'missing',
  ]),
  signers: z.array(z.object({ party_id: z.string(), name: z.string(), role_label: z.string(), has_email: z.boolean() })),
  register_effects: z.object({
    planned: z.array(EffectOut).describe('Role changes the adopted elections make when the minutes are signed.'),
    kept: z.array(EffectOut),
    applied: z.object({ added: z.array(AppliedOut), ended: z.array(AppliedOut) }),
  }),
  warnings: z.array(z.object({ code: z.string(), message_sv: z.string(), message_en: z.string() })),
  signing: z
    .object({
      status: z.string(),
      expires_at: z.string(),
      signers: z.array(z.object({ name: z.string(), role_label: z.string().nullable(), status: z.string(), signed_at: z.string().nullable() })),
    })
    .nullable(),
})

// ── Reads ────────────────────────────────────────────────────────────

export const corporateMeetingsList = defineOperation({
  id: 'corporate-meetings.list',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'List the company\'s bolagsstämmor, styrelsemöten and per capsulam decisions, newest first.',
    description: 'Each meeting with its kind, date, place, status (draft, held, signed) and board minutes number (ABL 8:26). Filter by kind or fiscal year.',
    useWhen: 'You need the company\'s meetings, the årsstämma for a year, or the latest board minutes.',
    doNotUseFor: 'The decisions and minutes of one meeting (GET /corporate-meetings/{id}).',
    pitfalls: ['A draft is a plan; only held and signed meetings took place.'],
    example: { response: { data: { meetings: [{ corporate_meeting_id: '4b1e…', kind: 'arsstamma', title: 'Årsstämma 2027-05-10', status: 'signed' }] }, meta: META } },
  },
  input: z.object({
    kind: z.enum(MEETING_KINDS).optional().describe('arsstamma, extra_stamma, styrelsemote or per_capsulam.'),
    fiscal_period_id: z.string().uuid().optional().describe('An årsstämma\'s fiscal year.'),
  }),
  output: z.object({ meetings: z.array(MeetingSummaryOut) }),
  errorCodes: [...GATE_CODES],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/corporate-meetings' },
  mcp: {
    name: 'gnubok_list_corporate_meetings',
    title: 'List Corporate Meetings',
    description: 'List bolagsstämmor (årsstämma, extra), styrelsemöten and per capsulam decisions with date, status and minutes number.',
    visibility: 'search',
    keywords: ['bolagsstämma', 'årsstämma', 'extra bolagsstämma', 'styrelsemöte', 'protokoll', 'styrelseprotokoll', 'stämmoprotokoll', 'per capsulam'],
  },
  run: (ctx, input) =>
    gated(ctx, async () => ({ ok: true, data: { meetings: await listMeetingsView(ctx, { kind: input.kind ?? null, fiscal_period_id: input.fiscal_period_id ?? null }) } })),
})

export const corporateMeetingsGet = defineOperation({
  id: 'corporate-meetings.get',
  kind: 'read',
  scope: 'companies:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Read one meeting: its minutes paragraph by paragraph, röstlängd, attendance, signers, effects on the roles and warnings.',
    description:
      'Each decision with its terms (payload) and the sentence the minutes print; the röstlängd from the aktiebok on the meeting day (ABL 7:48); who signs (protokollförare, ordförande, justerare, or all shareholders per capsulam); the role changes an adopted election makes when the minutes are signed; and what a person should check (warnings).',
    useWhen: 'You need what a stämma or the board decided, the dividend per share and betalningsdag, or what is missing before signing.',
    doNotUseFor: 'Signing the minutes: a person signs with BankID or uploads the signed copy in Accounted.',
    pitfalls: ['Names only: no personnummer, no email addresses.', 'register_effects.planned is a preview until the minutes are signed.'],
    example: { response: { data: { corporate_meeting_id: '4b1e…', kind: 'arsstamma', status: 'held', decisions: [{ item_number: 8, kind: 'faststallande_rr_br', text_rendered: 'Stämman fastställde resultaträkningen och balansräkningen för räkenskapsåret 2026-01-01 till 2026-12-31.' }] }, meta: META } },
  },
  input: z.object({ corporate_meeting_id: MEETING_ID }),
  output: MeetingDetailOut,
  errorCodes: [...GATE_CODES, 'CORPORATE_MEETING_NOT_FOUND'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/corporate-meetings/:id', pathParams: { id: 'corporate_meeting_id' } },
  mcp: {
    name: 'gnubok_get_corporate_meeting',
    title: 'Get Corporate Meeting',
    description: 'Read one meeting: the minutes paragraph by paragraph with terms, röstlängd, attendance, signers, the role changes elections make, and warnings.',
    visibility: 'search',
    keywords: ['stämmoprotokoll', 'styrelseprotokoll', 'beslut', 'utdelning', 'röstlängd', 'justerare', 'ansvarsfrihet'],
  },
  run: (ctx, input) =>
    gated(ctx, async () => {
      const view = await getMeetingView(ctx, input.corporate_meeting_id)
      if (!view) return { ok: false, code: 'CORPORATE_MEETING_NOT_FOUND' }
      return { ok: true, data: view }
    }),
})

// ── Writes ───────────────────────────────────────────────────────────

const MeetingFields = {
  meeting_time: z.string().regex(/^[0-2][0-9]:[0-5][0-9]$/).nullish().describe('HH:MM.'),
  place: z.string().trim().max(200).nullish(),
  chair_party_id: PARTY_ID.nullish().describe('Ordförande, when in the register (party_id from gnubok_list_company_roles or the share register).'),
  chair_name: NAME.nullish().describe('Or the chair\'s name.'),
  secretary_party_id: PARTY_ID.nullish().describe('Protokollförare.'),
  secretary_name: NAME.nullish(),
  adjuster_party_ids: z.array(PARTY_ID).max(10).nullish().describe('Justerare (replaces the list).'),
  adjuster_names: z.array(NAME).max(10).nullish(),
  kallelse_date: saneIsoDateSchema.nullish().describe('The day the kallelse was sent.'),
  kallelse_method: z.string().trim().max(200).nullish().describe('How, e.g. "e-post till samtliga aktieägare".'),
  fiscal_period_id: z.string().uuid().nullish().describe('Årsstämma: the fiscal year whose årsredovisning it adopts.'),
  notes: z.string().trim().max(4000).nullish(),
}

/** The new meeting, exported for the dashboard route. */
export const CreateMeetingIn = z
  .object({
    kind: z.enum(MEETING_KINDS).describe('arsstamma, extra_stamma, styrelsemote or per_capsulam.'),
    organ: z.enum(MEETING_ORGANS).nullish().describe('per_capsulam only: bolagsstamma (all shareholders sign) or styrelse (all board members sign).'),
    meeting_date: saneIsoDateSchema.describe('The meeting day (YYYY-MM-DD); may be in the future for a planned meeting.'),
    is_digital: z.boolean().nullish(),
    use_template: z.boolean().nullish().describe('Start from the agenda (default true). An årsstämma is prefilled from the årsredovisning and the roles.'),
    ...MeetingFields,
  })
  .strict()

export const corporateMeetingsCreate = defineOperation({
  id: 'corporate-meetings.create',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Plan a meeting: an årsstämma (prefilled from the årsredovisning and the roles), an extra stämma, a styrelsemöte or a per capsulam decision.',
    description:
      'Creates a draft with its agenda. An årsstämma gets fastställande of the resultat- and balansräkning, the disposition and proposed dividend from the årsredovisning, ansvarsfrihet for the board and VD in office during the year, re-election of the board and revisor, and fees (ABL 7:11). A stämma gets the röstlängd from the aktiebok on the meeting day. Deadlines follow (kallelse, minutes within two weeks). Dry-runnable.',
    useWhen: 'The company is to hold a stämma or a board meeting, or the owners decide per capsulam.',
    doNotUseFor: 'Recording a decision on an existing meeting (POST /corporate-meetings/{id}/decisions).',
    pitfalls: [
      'CORPORATE_MEETING_FISCAL_PERIOD_REQUIRED: an årsstämma needs fiscal_period_id.',
      'BOLAGET_PERSONNUMMER_IN_APP_ONLY: a personnummer was sent; name the person.',
      'A per capsulam stämma decision has no ABL rule; every shareholder signs it.',
    ],
    example: {
      request: { kind: 'arsstamma', meeting_date: '2027-05-10', fiscal_period_id: '7c2a…', place: 'Bolagets kontor' },
      response: { data: { corporate_meeting_id: '4b1e…', kind: 'arsstamma', organ: 'bolagsstamma', meeting_date: '2027-05-10', status: 'draft', decisions_count: 15 }, meta: META },
    },
  },
  input: CreateMeetingIn,
  output: z.object({
    corporate_meeting_id: z.string(),
    kind: z.enum(MEETING_KINDS),
    organ: z.enum(MEETING_ORGANS),
    meeting_date: z.string(),
    status: z.literal('draft'),
    decisions_count: z.number().int(),
  }),
  errorCodes: [
    ...GATE_CODES,
    'CORPORATE_MEETING_FISCAL_PERIOD_REQUIRED',
    'CORPORATE_MEETING_FISCAL_PERIOD_NOT_FOUND',
    'BOLAGET_PARTY_NOT_FOUND',
    'BOLAGET_PARTY_INVALID',
    'BOLAGET_PERSONNUMMER_IN_APP_ONLY',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/corporate-meetings' },
  mcp: {
    name: 'gnubok_create_corporate_meeting',
    title: 'Create Corporate Meeting',
    description:
      'Stage a new meeting: årsstämma (prefilled from the årsredovisning and roles: adoption, disposition, dividend, ansvarsfrihet, re-election, fees), extra stämma, styrelsemöte or per capsulam.',
    visibility: 'search',
    keywords: ['årsstämma', 'bolagsstämma', 'kalla till stämma', 'styrelsemöte', 'per capsulam', 'stämmoprotokoll', 'protokoll'],
    stage: {
      pendingType: 'create_corporate_meeting',
      title: (input) => {
        const kind = typeof input.kind === 'string' ? input.kind : ''
        const label = KIND_TITLES[kind] ?? 'Nytt möte'
        return `${label}${typeof input.meeting_date === 'string' ? ` ${input.meeting_date}` : ''}`
      },
      extras: () => ({ next: { description: 'After approval, read the meeting with gnubok_list_corporate_meetings and gnubok_get_corporate_meeting.', tool: 'gnubok_list_corporate_meetings' } }),
    },
  },
  run: (ctx, input, { dryRun }) => gated(ctx, () => createMeeting(ctx, input, { dryRun })),
})

const KIND_TITLES: Record<string, string> = {
  arsstamma: 'Årsstämma',
  extra_stamma: 'Extra bolagsstämma',
  styrelsemote: 'Styrelsemöte',
  per_capsulam: 'Beslut per capsulam',
}

/** The change to a meeting, exported for the dashboard route (which takes the id from its path). */
export const UpdateMeetingIn = z
  .object({
    corporate_meeting_id: MEETING_ID,
    meeting_date: saneIsoDateSchema.optional().describe('Moving the date takes the röstlängd from the aktiebok again.'),
    is_digital: z.boolean().optional(),
    ...MeetingFields,
    presence: z
      .array(z.object({ party_id: PARTY_ID, present: z.boolean(), proxy_name: NAME.nullish().describe('The ombud\'s name.') }).strict())
      .max(500)
      .nullish()
      .describe('Röstlängd: who was present or represented.'),
    attendees: z
      .array(z.object({ party_id: PARTY_ID.nullish(), name: NAME, capacity: z.enum(ATTENDEE_CAPACITIES), present: z.boolean() }).strict())
      .max(100)
      .nullish()
      .describe('Others present (board, VD, revisor, guests); replaces the list.'),
    refresh_voting_list: z.boolean().nullish().describe('Take the röstlängd from the aktiebok again.'),
  })
  .strict()

export const corporateMeetingsUpdate = defineOperation({
  id: 'corporate-meetings.update',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Change a meeting whose minutes are not signed: date, place, chair, protokollförare, justerare, kallelse, attendance or röstlängd presence.',
    description: 'Fields left out keep their value; null clears one. Moving the date takes the röstlängd from the aktiebok again. Signed minutes never change (CORPORATE_MEETING_LOCKED). Dry-runnable.',
    useWhen: 'The kallelse was sent, the chair or justerare were chosen, or attendance is known.',
    doNotUseFor: 'Decisions (POST /corporate-meetings/{id}/decisions).',
    pitfalls: ['CORPORATE_MEETING_SIGNING_PENDING: the minutes are out for BankID signing.'],
    example: { request: { kallelse_date: '2027-04-08', kallelse_method: 'e-post' }, response: { data: { corporate_meeting_id: '4b1e…', status: 'draft' }, meta: META } },
  },
  input: UpdateMeetingIn,
  output: z.object({ corporate_meeting_id: z.string(), status: z.string() }),
  errorCodes: [...GATE_CODES, 'CORPORATE_MEETING_NOT_FOUND', 'CORPORATE_MEETING_LOCKED', 'CORPORATE_MEETING_SIGNING_PENDING', 'BOLAGET_PARTY_NOT_FOUND', 'BOLAGET_PERSONNUMMER_IN_APP_ONLY'],
  http: { method: 'PATCH', path: '/api/v1/companies/:companyId/corporate-meetings/:id', pathParams: { id: 'corporate_meeting_id' } },
  mcp: {
    name: 'gnubok_update_corporate_meeting',
    title: 'Update Corporate Meeting',
    description: 'Stage a change to a meeting whose minutes are unsigned: date, place, chair, protokollförare, justerare, kallelse, attendance or röstlängd presence.',
    visibility: 'search',
    keywords: ['ändra möte', 'justerare', 'kallelse', 'närvaro', 'röstlängd', 'ombud'],
    stage: { pendingType: 'update_corporate_meeting', title: () => 'Ändra möte' },
  },
  run: (ctx, input, { dryRun }) =>
    gated(ctx, () => {
      const { corporate_meeting_id, attendees, ...patch } = input
      return updateMeeting(
        ctx,
        corporate_meeting_id,
        { ...patch, attendees: attendees === undefined ? undefined : attendees === null ? null : attendees.map((a) => ({ ...a, party_id: a.party_id ?? null })) },
        { dryRun },
      )
    }),
})

/** A decision, exported for the dashboard route (which takes the meeting id from its path). */
export const RecordDecisionIn = z
  .object({
    corporate_meeting_id: MEETING_ID,
    corporate_decision_id: z.string().uuid().nullish().describe('Change this decision; omit to add one.'),
    item_number: z.number().int().min(1).max(999).nullish().describe('The paragraph (§); a taken number moves the later ones down. Default: before the closing item.'),
    kind: z.enum(DECISION_KINDS).nullish().describe('Required for a new decision.'),
    title: z.string().trim().min(1).max(300).nullish(),
    text: z.string().trim().max(8000).nullish().describe('The decision as the minutes word it; null composes it from the payload.'),
    payload: z
      .record(z.string(), z.unknown())
      .nullish()
      .describe(
        'Terms per kind, e.g. utdelning {amount_per_share, share_count, total_amount, payment_date}; val_styrelse {members:[{party_id|name, role}], term}; nyemission {share_count, price_per_share}. Names and party ids only.',
      ),
    outcome: z.enum(DECISION_OUTCOMES).nullish().describe('bifallen (default), avslagen or bordlagd.'),
    votes_for: z.number().min(0).max(1e12).nullish().describe('Votes (röster) for, when it went to a vote.'),
    votes_against: z.number().min(0).max(1e12).nullish(),
    votes_abstained: z.number().min(0).max(1e12).nullish(),
    reservations: z.string().trim().max(2000).nullish().describe('Reservation or dissent to note (ABL 8:24).'),
  })
  .strict()

export const corporateMeetingsDecisionsRecord = defineOperation({
  id: 'corporate-meetings.decisions.record',
  kind: 'write',
  scope: 'companies:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Add or change a decision (paragraph) in a meeting\'s unsigned minutes, with its terms per kind.',
    description:
      'Kinds: faststallande_rr_br, resultatdisposition, utdelning, ansvarsfrihet, val_styrelse, val_revisor, arvoden, andrad_bolagsordning, nyemission, fondemission, minskning, optioner, aterbetalning_villkorat_tillskott, ovrigt. The payload is validated per kind. An adopted election changes the roles when the minutes are signed; capital decisions are booked separately. Dry-runnable.',
    useWhen: 'The stämma or the board decided something to record in the minutes.',
    doNotUseFor: 'Booking a dividend or an emission (a voucher), or registering shares (POST /share-register/events).',
    pitfalls: [
      'CORPORATE_DECISION_PAYLOAD_INVALID: the terms do not fit the kind; message names the fields.',
      'CORPORATE_MEETING_LOCKED: signed minutes never change.',
      'utdelning needs a payment_date (betalningsdag, ABL 18:3) before the minutes are signed; a warning says so.',
    ],
    example: {
      request: { kind: 'utdelning', payload: { amount_per_share: 50, share_count: 1000, total_amount: 50000, payment_date: '2027-05-31' } },
      response: { data: { corporate_decision_id: '9f3d…', corporate_meeting_id: '4b1e…', item_number: 10, kind: 'utdelning' }, meta: META },
    },
  },
  input: RecordDecisionIn,
  output: z.object({ corporate_decision_id: z.string(), corporate_meeting_id: z.string(), item_number: z.number().int(), kind: z.enum(DECISION_KINDS) }),
  errorCodes: [
    ...GATE_CODES,
    'CORPORATE_MEETING_NOT_FOUND',
    'CORPORATE_DECISION_NOT_FOUND',
    'CORPORATE_DECISION_PAYLOAD_INVALID',
    'CORPORATE_MEETING_LOCKED',
    'CORPORATE_MEETING_SIGNING_PENDING',
    'BOLAGET_PARTY_NOT_FOUND',
    'BOLAGET_PERSONNUMMER_IN_APP_ONLY',
  ],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/corporate-meetings/:id/decisions', pathParams: { id: 'corporate_meeting_id' } },
  mcp: {
    name: 'gnubok_record_corporate_decision',
    title: 'Record Corporate Decision',
    description:
      'Stage a decision in unsigned minutes: adoption, disposition, utdelning, ansvarsfrihet, election of board or revisor, fees, bolagsordning, emissions, minskning, optioner, tillskott or other. Terms validated per kind.',
    visibility: 'search',
    keywords: ['stämmobeslut', 'styrelsebeslut', 'utdelning', 'besluta utdelning', 'välja styrelse', 'ansvarsfrihet', 'nyemission', 'fondemission', 'ändra bolagsordning'],
    stage: {
      pendingType: 'record_corporate_decision',
      title: (input) => `Beslut: ${typeof input.title === 'string' ? input.title : typeof input.kind === 'string' ? DECISION_TITLES[input.kind] ?? input.kind : 'ändring'}`,
    },
  },
  run: (ctx, input, { dryRun }) => gated(ctx, () => recordDecision(ctx, input, { dryRun })),
})

const DECISION_TITLES: Record<string, string> = {
  faststallande_rr_br: 'fastställande av resultat- och balansräkning',
  resultatdisposition: 'disposition av resultatet',
  utdelning: 'utdelning',
  ansvarsfrihet: 'ansvarsfrihet',
  val_styrelse: 'val av styrelse',
  val_revisor: 'val av revisor',
  arvoden: 'arvoden',
  andrad_bolagsordning: 'ändrad bolagsordning',
  nyemission: 'nyemission',
  fondemission: 'fondemission',
  minskning: 'minskning av aktiekapitalet',
  optioner: 'teckningsoptioner',
  aterbetalning_villkorat_tillskott: 'återbetalning av villkorat tillskott',
  ovrigt: 'övrigt',
}

export const corporateMeetingsHold = defineOperation({
  id: 'corporate-meetings.hold',
  kind: 'write',
  scope: 'companies:write',
  risk: 'medium',
  reversible: false,
  docs: {
    summary: 'Mark a meeting as held: a board meeting takes its minutes number, an årsstämma records its date on the årsredovisning.',
    description:
      'Status draft to held, once the meeting day has come. Board minutes are numbered in sequence (ABL 8:26). An årsstämma that adopted the resultat- and balansräkning writes agm_date and the disposition outcome to the årsredovisning (the fastställelseintyg reads them). Deadlines follow: minutes available within two weeks (7:49), a Bolagsverket notice after a board change (8:44). The minutes stay open until signed in Accounted; elections change the roles then. Dry-runnable.',
    useWhen: 'The meeting took place and its decisions are recorded.',
    doNotUseFor: 'Signing the minutes (a person, in Accounted).',
    pitfalls: ['CORPORATE_MEETING_IN_FUTURE: the meeting day has not come.', 'CORPORATE_MEETING_ALREADY_HELD.', 'A held meeting is never deleted.'],
    example: { response: { data: { corporate_meeting_id: '4b1e…', status: 'held', sequence_number: null, agm_recorded: true }, meta: META } },
  },
  input: z.object({ corporate_meeting_id: MEETING_ID }).strict(),
  output: z.object({ corporate_meeting_id: z.string(), status: z.literal('held'), sequence_number: z.number().int().nullable(), agm_recorded: z.boolean() }),
  errorCodes: [...GATE_CODES, 'CORPORATE_MEETING_NOT_FOUND', 'CORPORATE_MEETING_ALREADY_HELD', 'CORPORATE_MEETING_IN_FUTURE', 'CORPORATE_MEETING_LOCKED'],
  http: { method: 'POST', path: '/api/v1/companies/:companyId/corporate-meetings/:id/hold', pathParams: { id: 'corporate_meeting_id' } },
  mcp: {
    name: 'gnubok_hold_corporate_meeting',
    title: 'Hold Corporate Meeting',
    description: 'Stage marking a meeting as held: board minutes get their number (ABL 8:26), an årsstämma records its date on the årsredovisning, deadlines follow. Minutes are signed by a person in Accounted.',
    visibility: 'search',
    keywords: ['stämman hållen', 'mötet hållet', 'protokollnummer', 'fastställelseintyg', 'stämmodatum'],
    stage: { pendingType: 'hold_corporate_meeting', title: () => 'Markera mötet som hållet' },
  },
  run: (ctx, input, { dryRun }) => gated(ctx, () => holdMeeting(ctx, input.corporate_meeting_id, { dryRun })),
})

export const CORPORATE_MEETING_OPERATIONS = [
  corporateMeetingsList,
  corporateMeetingsGet,
  corporateMeetingsCreate,
  corporateMeetingsUpdate,
  corporateMeetingsDecisionsRecord,
  corporateMeetingsHold,
] as const
