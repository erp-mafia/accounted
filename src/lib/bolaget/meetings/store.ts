/**
 * Meetings and their decisions in the database (corporate_meetings,
 * corporate_decisions): create from a template, change while the minutes
 * are open, record a decision, hold the meeting, delete a draft. The
 * database freezes signed minutes (20261030010000_corporate_meetings.sql);
 * these services check the same first so the answer says why in Swedish.
 *
 * Holding an årsstämma writes the AGM date and the disposition outcome to
 * the årsredovisning narrative (agm_date, agm_disposition_outcome,
 * agm_disposition_decision): the fastställelseintyg reads them from there,
 * so the meeting is their one source. Every change syncs the meeting's
 * deadlines (deadlines.source_key bolaget:meeting:<id>:<key>).
 *
 * Names and party ids only: no personnummer in a meeting, a decision, a
 * snapshot or an answer.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { addMonthsIso, todayIsoStockholm } from '@/lib/dates/iso'
import { looksLikeSwedishPersonalNumber } from '@/lib/invariants/personal-number-shape'
import type { OperationContext, OperationOutcome, OperationWarning } from '@/lib/operations/types'
import { createServiceClient } from '@/lib/supabase/server'
import { assertPartiesInCompany, checkPartyRef, ensureRegisterParty, PartyRefError } from '../people'
import { loadRoles, type RolesView } from '../roles'
import { loadShareRegisterData } from '../share-register'
import { writeSystemDeadline, type SystemDeadlineRow } from '../system-deadlines'
import { changesRoles, registerEffectsFrom } from './effects'
import { MeetingError, meetingFailure } from './errors'
import { decisionText } from './minutes-text'
import { parseDecisionPayload } from './payloads'
import { justerareState, meetingDeadlines, type MeetingShape } from './rules'
import { buildArsstammaTemplate, buildProceduralTemplate, loadArsstammaTemplateInput, loadFiscalPeriod, type DecisionDraft } from './template'
import {
  DECISION_KIND_LABELS_SV,
  MEETING_KIND_LABELS_SV,
  organOf,
  type Attendee,
  type AttendeeCapacity,
  type DecisionKind,
  type DecisionOutcome,
  type DecisionRecord,
  type MeetingKind,
  type MeetingOrgan,
  type MeetingRecord,
  type VotingList,
} from './types'

// ── Records ──────────────────────────────────────────────────────────

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v))

function normaliseMeeting(row: Record<string, unknown>): MeetingRecord {
  return {
    ...(row as unknown as MeetingRecord),
    sequence_number: num(row.sequence_number),
    adjuster_party_ids: (row.adjuster_party_ids as string[] | null) ?? [],
    attendees: (row.attendees as Attendee[] | null) ?? [],
    voting_list: (row.voting_list as VotingList | null) ?? {},
  }
}

function normaliseDecision(row: Record<string, unknown>): DecisionRecord {
  return {
    ...(row as unknown as DecisionRecord),
    item_number: Number(row.item_number),
    payload: (row.payload as Record<string, unknown> | null) ?? {},
    votes_for: num(row.votes_for),
    votes_against: num(row.votes_against),
    votes_abstained: num(row.votes_abstained),
  }
}

export async function loadMeetingRecord(supabase: SupabaseClient, companyId: string, id: string): Promise<MeetingRecord | null> {
  const { data, error } = await supabase
    .from('corporate_meetings')
    .select('id, kind, organ, sequence_number, meeting_date, meeting_time, place, is_digital, chair_party_id, secretary_party_id, adjuster_party_ids, kallelse_date, kallelse_method, fiscal_period_id, voting_list, attendees, notes, status, held_at, signed_at, signature_names, minutes_document_id, signed_document_id, signing_request_id, created_at, updated_at')
    .eq('company_id', companyId)
    .eq('id', id)
    .maybeSingle()
  if (error) throw new Error(`corporate_meetings read failed: ${error.message}`)
  return data ? normaliseMeeting(data as Record<string, unknown>) : null
}

export async function loadMeetingRecords(
  supabase: SupabaseClient,
  companyId: string,
  filter: { kind?: MeetingKind | null; fiscal_period_id?: string | null } = {},
): Promise<MeetingRecord[]> {
  let query = supabase
    .from('corporate_meetings')
    .select('id, kind, organ, sequence_number, meeting_date, meeting_time, place, is_digital, chair_party_id, secretary_party_id, adjuster_party_ids, kallelse_date, kallelse_method, fiscal_period_id, voting_list, attendees, notes, status, held_at, signed_at, signature_names, minutes_document_id, signed_document_id, signing_request_id, created_at, updated_at')
    .eq('company_id', companyId)
  if (filter.kind) query = query.eq('kind', filter.kind)
  if (filter.fiscal_period_id) query = query.eq('fiscal_period_id', filter.fiscal_period_id)
  const { data, error } = await query.order('meeting_date', { ascending: false }).order('created_at', { ascending: false }).limit(500)
  if (error) throw new Error(`corporate_meetings read failed: ${error.message}`)
  return ((data ?? []) as Record<string, unknown>[]).map(normaliseMeeting)
}

export async function loadDecisionRecords(supabase: SupabaseClient, companyId: string, meetingId: string): Promise<DecisionRecord[]> {
  const { data, error } = await supabase
    .from('corporate_decisions')
    .select('id, meeting_id, item_number, kind, title, text, payload, outcome, votes_for, votes_against, votes_abstained, reservations, created_at, updated_at')
    .eq('company_id', companyId)
    .eq('meeting_id', meetingId)
    .order('item_number')
    .order('created_at')
  if (error) throw new Error(`corporate_decisions read failed: ${error.message}`)
  return ((data ?? []) as Record<string, unknown>[]).map(normaliseDecision)
}

function assertOpen(meeting: MeetingRecord): void {
  if (meeting.status === 'signed') throw new MeetingError('CORPORATE_MEETING_LOCKED')
  if (meeting.signing_request_id) throw new MeetingError('CORPORATE_MEETING_SIGNING_PENDING')
}

async function requireMeeting(ctx: OperationContext, id: string): Promise<MeetingRecord> {
  const meeting = await loadMeetingRecord(ctx.supabase, ctx.companyId, id)
  if (!meeting) throw new MeetingError('CORPORATE_MEETING_NOT_FOUND')
  return meeting
}

// ── Parties ──────────────────────────────────────────────────────────

/** A person the meeting names: an existing register party or a new one by name. */
export interface PartyPick {
  party_id?: string | null
  name?: string | null
}

function pick(partyId: string | null | undefined, name: string | null | undefined): PartyPick | null | undefined {
  if (partyId === undefined && name === undefined) return undefined
  if (!partyId && !name?.trim()) return null
  return { party_id: partyId ?? null, name: name ?? null }
}

/** Refuse a personnummer anywhere in a meeting's or decision's text fields. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function refusePersonnummer(value: unknown, depth = 0): void {
  if (depth > 6 || value === null || value === undefined) return
  if (typeof value === 'string') {
    // An id is not text: a uuid can start with eight digits and a dash.
    if (UUID_RE.test(value)) return
    for (const m of value.matchAll(/\b\d{6}(?:\d{2})?[-+]?\d{4}\b/g)) {
      if (looksLikeSwedishPersonalNumber(m[0])) {
        throw new PartyRefError('BOLAGET_PERSONNUMMER_IN_APP_ONLY', 'Ett personnummer registreras bara i Accounted, under Aktiebok, aldrig i ett protokoll eller ett anrop.')
      }
    }
    return
  }
  if (Array.isArray(value)) {
    for (const item of value) refusePersonnummer(item, depth + 1)
    return
  }
  if (typeof value === 'object') for (const v of Object.values(value as Record<string, unknown>)) refusePersonnummer(v, depth + 1)
}

/** Check a pick before anything is written. */
async function checkPick(ctx: OperationContext, p: PartyPick | null | undefined, label: string): Promise<void> {
  if (!p) return
  if (p.party_id) return assertPartiesInCompany(ctx.supabase, ctx.companyId, [p.party_id])
  checkPartyRef({ name: p.name, kind: 'person' }, label)
}

async function resolvePick(ctx: OperationContext, p: PartyPick | null | undefined): Promise<string | null | undefined> {
  if (p === undefined) return undefined
  if (p === null) return null
  return ensureRegisterParty(ctx, { party_id: p.party_id ?? null, name: p.name ?? null, kind: 'person' })
}

/** Every party_id a payload names (val_styrelse members, ansvarsfrihet persons, ...). */
function payloadPartyIds(value: unknown, depth = 0, out: string[] = []): string[] {
  if (depth > 6 || value === null || typeof value !== 'object') return out
  if (Array.isArray(value)) {
    for (const item of value) payloadPartyIds(item, depth + 1, out)
    return out
  }
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (key === 'party_id' && typeof v === 'string') out.push(v)
    else payloadPartyIds(v, depth + 1, out)
  }
  return out
}

// ── Röstlängd and attendance ─────────────────────────────────────────

/**
 * The röstlängd on the meeting day, from the aktiebok (ABL 7:48): every
 * holder with shares and votes, names only. Presence and ombud carry over
 * from the previous list by party.
 */
export async function votingListSnapshot(ctx: OperationContext, day: string, previous: VotingList | null = null): Promise<VotingList> {
  const data = await loadShareRegisterData(ctx, day)
  const before = new Map((previous?.holders ?? []).map((h) => [h.party_id, h]))
  return {
    as_of: day,
    total_shares: data.summary.total_shares,
    total_votes: data.summary.total_votes,
    holders: data.summary.holders.map((h) => {
      const party = data.parties.get(h.party_id)
      const prev = before.get(h.party_id)
      return {
        party_id: h.party_id,
        name: party?.name ?? 'okänd',
        kind: party?.kind ?? 'person',
        shares: h.shares,
        votes: h.votes,
        present: prev?.present ?? true,
        proxy_name: prev?.proxy_name ?? null,
      }
    }),
  }
}

const ATTENDEE_CAPACITY_BY_ROLE: Partial<Record<string, AttendeeCapacity>> = {
  styrelseordforande: 'styrelseledamot',
  styrelseledamot: 'styrelseledamot',
  styrelsesuppleant: 'styrelsesuppleant',
  vd: 'vd',
}

/** A board meeting starts with the board, suppleanter and VD in office, all present. */
export function boardAttendees(roles: RolesView): Attendee[] {
  const out = new Map<string, Attendee>()
  const order: AttendeeCapacity[] = ['styrelseledamot', 'styrelsesuppleant', 'vd']
  for (const r of roles.roles) {
    const capacity = ATTENDEE_CAPACITY_BY_ROLE[r.role]
    if (!r.active || !capacity) continue
    const existing = out.get(r.party_id)
    if (existing && order.indexOf(existing.capacity) <= order.indexOf(capacity)) continue
    out.set(r.party_id, { party_id: r.party_id, name: r.party?.name ?? 'okänd', capacity, present: true })
  }
  return [...out.values()]
}

// ── Deadlines and the årsredovisning ─────────────────────────────────

interface DeadlineRow extends SystemDeadlineRow {
  source_key: string
}

export function meetingShape(m: MeetingRecord): MeetingShape {
  return {
    id: m.id,
    kind: m.kind,
    organ: m.organ,
    status: m.status,
    meeting_date: m.meeting_date,
    held_at: m.held_at,
    chair_party_id: m.chair_party_id,
    secretary_party_id: m.secretary_party_id,
    adjuster_party_ids: m.adjuster_party_ids,
    kallelse_date: m.kallelse_date,
    attendees: m.attendees,
    voting_list: m.voting_list,
  }
}

/**
 * Bring the meeting's deadlines in line with its state (the pattern of
 * syncDeadlines in lib/arkiv/agreements/store.ts): add the ones it raises,
 * move a changed date, remove the ones it no longer raises. A deadline a
 * person completed or dismissed stays as they left it. Service role, like
 * every system deadline.
 */
export async function syncMeetingDeadlines(ctx: OperationContext, meeting: MeetingRecord, decisions: readonly DecisionRecord[], roleChanges: boolean): Promise<number> {
  const service = createServiceClient()
  const prefix = `bolaget:meeting:${meeting.id}:`
  const today = todayIsoStockholm()
  const drafts = meetingDeadlines(meetingShape(meeting), decisions, today, { roles: roleChanges })
  const { data, error } = await service
    .from('deadlines')
    .select('id, source_key, title, due_date, is_completed, dismissed_at, status')
    .eq('company_id', ctx.companyId)
    .like('source_key', `${prefix}%`)
  if (error) throw new Error(`deadlines read failed: ${error.message}`)
  const existing = new Map(((data ?? []) as DeadlineRow[]).map((d) => [d.source_key, d]))
  const now = new Date().toISOString()
  for (const draft of drafts) {
    const key = `${prefix}${draft.key}`
    await writeSystemDeadline(service, ctx.companyId, { ...draft, sourceKey: key }, existing.get(key) ?? null, today, now)
  }
  const wanted = new Set(drafts.map((d) => `${prefix}${d.key}`))
  for (const [key, row] of existing) {
    if (wanted.has(key) || row.dismissed_at || row.is_completed) continue
    const { error: deleteError } = await service.from('deadlines').delete().eq('id', row.id)
    if (deleteError) throw new Error(`deadline delete failed: ${deleteError.message}`)
  }
  return drafts.length
}

/**
 * What a held årsstämma writes to the årsredovisning narrative: the AGM
 * date once the stämma adopted the resultaträkning and balansräkning, and
 * whether the disposition followed the board's proposal (the
 * fastställelseintyg states both). Null when the meeting adopts nothing.
 */
export function agmFields(
  meeting: Pick<MeetingRecord, 'kind' | 'status' | 'meeting_date' | 'fiscal_period_id'>,
  decisions: readonly Pick<DecisionRecord, 'kind' | 'outcome' | 'payload' | 'text'>[],
  textOf: (d: Pick<DecisionRecord, 'kind' | 'outcome' | 'payload' | 'text'>) => string,
): { fiscal_period_id: string; agm_date: string; agm_disposition_outcome: 'proposal_approved' | 'alternative_decision' | null; agm_disposition_decision: string | null } | null {
  if (meeting.kind !== 'arsstamma' || meeting.status === 'draft' || !meeting.fiscal_period_id) return null
  const adopted = decisions.find((d) => d.kind === 'faststallande_rr_br' && d.outcome === 'bifallen')
  if (!adopted) return null
  const disposition = decisions.find((d) => d.kind === 'resultatdisposition' && d.outcome === 'bifallen')
  let outcome: 'proposal_approved' | 'alternative_decision' | null = null
  let decision: string | null = null
  if (disposition) {
    const parsed = parseDecisionPayload('resultatdisposition', disposition.payload)
    const follows = parsed.ok ? parsed.payload.follows_board_proposal : true
    outcome = follows ? 'proposal_approved' : 'alternative_decision'
    decision = follows ? null : textOf(disposition).slice(0, 2000) || 'Stämman beslutade om en annan disposition än styrelsens förslag.'
  }
  return { fiscal_period_id: meeting.fiscal_period_id, agm_date: meeting.meeting_date, agm_disposition_outcome: outcome, agm_disposition_decision: decision }
}

/** The context the minutes' sentences need, without names (the AGM decision text names none). */
function plainTextContext(meeting: MeetingRecord) {
  return {
    kind: meeting.kind,
    organ: meeting.organ,
    meeting_date: meeting.meeting_date,
    kallelse_date: meeting.kallelse_date,
    kallelse_method: meeting.kallelse_method,
    chair_name: null,
    secretary_name: null,
    adjuster_names: [],
    justering: justerareState(meetingShape(meeting), 0),
    fiscal_period: null,
    has_auditor: false,
  }
}

/** Write the AGM fields to the narrative (one source for the fastställelseintyg). Best effort. */
export async function syncAgmToNarrative(ctx: OperationContext, meeting: MeetingRecord, decisions: readonly DecisionRecord[]): Promise<OperationWarning | null> {
  const fields = agmFields(meeting, decisions, (d) => decisionText(d, plainTextContext(meeting)))
  if (!fields) return null
  try {
    // The narrative row the årsredovisning reads (the same partial upsert as
    // upsertNarrative in lib/bokslut/arsredovisning/narrative-service.ts;
    // written here because the registers sit below the year-end block).
    const { error } = await ctx.supabase.from('arsredovisning_narratives').upsert(
      {
        user_id: ctx.userId,
        company_id: ctx.companyId,
        fiscal_period_id: fields.fiscal_period_id,
        agm_date: fields.agm_date,
        agm_disposition_outcome: fields.agm_disposition_outcome,
        agm_disposition_decision: fields.agm_disposition_decision,
      },
      { onConflict: 'company_id,fiscal_period_id' },
    )
    if (error) throw error
    return null
  } catch (error) {
    ctx.log.warn('[bolaget] AGM fields not written to the narrative', { companyId: ctx.companyId, meetingId: meeting.id, error: String(error) })
    return {
      code: 'AGM_NOT_RECORDED',
      message_sv: 'Stämmodagen kunde inte skrivas till årsredovisningen. Ange den under Årsredovisning.',
      message_en: 'The AGM date could not be written to the annual report. Enter it under the annual report.',
    }
  }
}

/** After a change: the deadlines (and, for a held årsstämma, the narrative). Best effort; warnings out. */
export async function afterMeetingChange(ctx: OperationContext, meetingId: string): Promise<OperationWarning[]> {
  const warnings: OperationWarning[] = []
  const meeting = await loadMeetingRecord(ctx.supabase, ctx.companyId, meetingId)
  if (!meeting) return warnings
  const decisions = await loadDecisionRecords(ctx.supabase, ctx.companyId, meetingId)
  const agm = await syncAgmToNarrative(ctx, meeting, decisions)
  if (agm) warnings.push(agm)
  try {
    const roles = await loadRoles(ctx, meeting.meeting_date)
    await syncMeetingDeadlines(ctx, meeting, decisions, changesRoles(registerEffectsFrom(roles, decisions, meeting.meeting_date)))
  } catch (error) {
    ctx.log.warn('[bolaget] meeting deadlines not synced', { companyId: ctx.companyId, meetingId, error: String(error) })
  }
  return warnings
}

// ── Create ───────────────────────────────────────────────────────────

export interface CreateMeetingInput {
  kind: MeetingKind
  /** Per capsulam: whose decision (default the stämma's). Ignored for the other kinds. */
  organ?: MeetingOrgan | null
  meeting_date: string
  meeting_time?: string | null
  place?: string | null
  is_digital?: boolean | null
  chair_party_id?: string | null
  chair_name?: string | null
  secretary_party_id?: string | null
  secretary_name?: string | null
  adjuster_party_ids?: string[] | null
  adjuster_names?: string[] | null
  kallelse_date?: string | null
  kallelse_method?: string | null
  fiscal_period_id?: string | null
  notes?: string | null
  /** Start from the template (default true). */
  use_template?: boolean | null
}

export interface CreatedMeeting {
  corporate_meeting_id: string
  kind: MeetingKind
  organ: MeetingOrgan
  meeting_date: string
  status: 'draft'
  decisions_count: number
}

function adjusterPicks(ids: string[] | null | undefined, names: string[] | null | undefined): PartyPick[] | undefined {
  if (ids === undefined && names === undefined) return undefined
  return [...(ids ?? []).map((id) => ({ party_id: id })), ...(names ?? []).filter((n) => n.trim()).map((n) => ({ name: n }))]
}

/** Checks for an årsstämma's date against its fiscal year (ABL 7:10): warnings, never a refusal. */
function arsstammaDateWarnings(meetingDate: string, periodEnd: string): OperationWarning[] {
  if (meetingDate <= periodEnd) {
    return [{ code: 'ARSSTAMMA_BEFORE_YEAR_END', message_sv: 'Årsstämman ligger före räkenskapsårets slut.', message_en: 'The AGM is dated before the end of the fiscal year.' }]
  }
  if (meetingDate > addMonthsIso(periodEnd, 6)) {
    return [{
      code: 'ARSSTAMMA_LATE',
      message_sv: 'Årsstämman ska hållas inom sex månader från räkenskapsårets utgång (7 kap. 10 § aktiebolagslagen).',
      message_en: 'The AGM is to be held within six months of the end of the fiscal year (ABL 7:10).',
    }]
  }
  return []
}

export async function createMeeting(
  ctx: OperationContext,
  input: CreateMeetingInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<CreatedMeeting>> {
  try {
    refusePersonnummer(input)
    const organ = organOf(input.kind, input.organ ?? null)
    const warnings: OperationWarning[] = []
    let fiscalPeriod: { id: string; period_start: string; period_end: string } | null = null
    if (input.kind === 'arsstamma' && !input.fiscal_period_id) throw new MeetingError('CORPORATE_MEETING_FISCAL_PERIOD_REQUIRED')
    if (input.fiscal_period_id) {
      fiscalPeriod = await loadFiscalPeriod(ctx.supabase, ctx.companyId, input.fiscal_period_id)
      if (!fiscalPeriod) throw new MeetingError('CORPORATE_MEETING_FISCAL_PERIOD_NOT_FOUND')
    }
    if (input.kind === 'arsstamma' && fiscalPeriod) {
      warnings.push(...arsstammaDateWarnings(input.meeting_date, fiscalPeriod.period_end))
      const earlier = await loadMeetingRecords(ctx.supabase, ctx.companyId, { kind: 'arsstamma', fiscal_period_id: fiscalPeriod.id })
      if (earlier.length > 0) {
        warnings.push({
          code: 'ARSSTAMMA_EXISTS',
          message_sv: 'Det finns redan en årsstämma för räkenskapsåret. En ny behövs bara för en fortsatt stämma.',
          message_en: 'An AGM for this fiscal year already exists. A second one is only for a continued meeting.',
        })
      }
    }
    const chair = pick(input.chair_party_id, input.chair_name)
    const secretary = pick(input.secretary_party_id, input.secretary_name)
    const adjusters = adjusterPicks(input.adjuster_party_ids, input.adjuster_names) ?? []
    await checkPick(ctx, chair, 'ordföranden')
    await checkPick(ctx, secretary, 'protokollföraren')
    for (const a of adjusters) await checkPick(ctx, a, 'justeraren')

    let drafts: DecisionDraft[] = []
    if (input.use_template !== false) {
      drafts = input.kind === 'arsstamma' && fiscalPeriod
        ? buildArsstammaTemplate(await loadArsstammaTemplateInput(ctx, fiscalPeriod, input.meeting_date))
        : buildProceduralTemplate(input.kind, organ)
    }
    const votingList = organ === 'bolagsstamma' ? await votingListSnapshot(ctx, input.meeting_date) : null
    const attendees = organ === 'styrelse' && input.kind !== 'per_capsulam' ? boardAttendees(await loadRoles(ctx, input.meeting_date)) : []

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          kind: input.kind,
          kind_label: MEETING_KIND_LABELS_SV[input.kind],
          organ,
          meeting_date: input.meeting_date,
          place: input.place ?? null,
          is_digital: input.is_digital ?? false,
          fiscal_period_id: fiscalPeriod?.id ?? null,
          chair: chair ? { party_id: chair.party_id ?? null, name: chair.name ?? null } : null,
          secretary: secretary ? { party_id: secretary.party_id ?? null, name: secretary.name ?? null } : null,
          agenda: drafts.map((d, i) => ({ item_number: i + 1, kind: d.kind, title: d.title })),
          voting_list: votingList ? { as_of: votingList.as_of, holders: votingList.holders.length, total_shares: votingList.total_shares } : null,
          attendees: attendees.map((a) => ({ name: a.name, capacity: a.capacity })),
          warnings,
        },
      }
    }

    const chairId = await resolvePick(ctx, chair)
    const secretaryId = await resolvePick(ctx, secretary)
    const adjusterIds: string[] = []
    for (const a of adjusters) {
      const id = await resolvePick(ctx, a)
      if (id && !adjusterIds.includes(id)) adjusterIds.push(id)
    }
    const { data: inserted, error } = await ctx.supabase
      .from('corporate_meetings')
      .insert({
        company_id: ctx.companyId,
        kind: input.kind,
        organ,
        meeting_date: input.meeting_date,
        meeting_time: input.meeting_time ?? null,
        place: input.place?.trim() || null,
        is_digital: input.is_digital ?? false,
        chair_party_id: chairId ?? null,
        secretary_party_id: secretaryId ?? null,
        adjuster_party_ids: adjusterIds,
        kallelse_date: input.kallelse_date ?? null,
        kallelse_method: input.kallelse_method?.trim() || null,
        fiscal_period_id: fiscalPeriod?.id ?? null,
        voting_list: votingList ?? {},
        attendees,
        notes: input.notes?.trim() || null,
        created_by: ctx.userId,
      })
      .select('id')
      .single()
    if (error) throw error
    const meetingId = (inserted as { id: string }).id
    for (const [index, d] of drafts.entries()) {
      const { error: decisionError } = await ctx.supabase.from('corporate_decisions').insert({
        company_id: ctx.companyId,
        meeting_id: meetingId,
        item_number: index + 1,
        kind: d.kind,
        title: d.title,
        text: d.text,
        payload: d.payload,
        created_by: ctx.userId,
      })
      if (decisionError) throw decisionError
    }
    warnings.push(...(await afterMeetingChange(ctx, meetingId)))
    return {
      ok: true,
      data: { corporate_meeting_id: meetingId, kind: input.kind, organ, meeting_date: input.meeting_date, status: 'draft', decisions_count: drafts.length },
      created: true,
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  } catch (error) {
    return meetingFailure(error)
  }
}

// ── Update ───────────────────────────────────────────────────────────

export interface UpdateMeetingInput {
  meeting_date?: string
  meeting_time?: string | null
  place?: string | null
  is_digital?: boolean
  chair_party_id?: string | null
  chair_name?: string | null
  secretary_party_id?: string | null
  secretary_name?: string | null
  /** Replaces the justerare. */
  adjuster_party_ids?: string[] | null
  adjuster_names?: string[] | null
  kallelse_date?: string | null
  kallelse_method?: string | null
  fiscal_period_id?: string | null
  notes?: string | null
  /** Presence and ombud per holder in the röstlängd. */
  presence?: Array<{ party_id: string; present: boolean; proxy_name?: string | null }> | null
  /** Replaces the list of others present (board, VD, revisor, guests). */
  attendees?: Attendee[] | null
  /** Take the röstlängd from the aktiebok again (also done when the date moves). */
  refresh_voting_list?: boolean | null
}

export async function updateMeeting(
  ctx: OperationContext,
  id: string,
  input: UpdateMeetingInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<{ corporate_meeting_id: string; status: string }>> {
  try {
    refusePersonnummer(input)
    const meeting = await requireMeeting(ctx, id)
    assertOpen(meeting)
    const warnings: OperationWarning[] = []
    if (input.fiscal_period_id) {
      const period = await loadFiscalPeriod(ctx.supabase, ctx.companyId, input.fiscal_period_id)
      if (!period) throw new MeetingError('CORPORATE_MEETING_FISCAL_PERIOD_NOT_FOUND')
      if (meeting.kind === 'arsstamma') warnings.push(...arsstammaDateWarnings(input.meeting_date ?? meeting.meeting_date, period.period_end))
    } else if (input.fiscal_period_id === null && meeting.kind === 'arsstamma') {
      throw new MeetingError('CORPORATE_MEETING_FISCAL_PERIOD_REQUIRED')
    }
    const chair = pick(input.chair_party_id, input.chair_name)
    const secretary = pick(input.secretary_party_id, input.secretary_name)
    const adjusters = adjusterPicks(input.adjuster_party_ids, input.adjuster_names)
    await checkPick(ctx, chair, 'ordföranden')
    await checkPick(ctx, secretary, 'protokollföraren')
    for (const a of adjusters ?? []) await checkPick(ctx, a, 'justeraren')
    for (const a of input.attendees ?? []) if (a.party_id) await assertPartiesInCompany(ctx.supabase, ctx.companyId, [a.party_id])

    const dateMoved = input.meeting_date !== undefined && input.meeting_date !== meeting.meeting_date
    const previous = 'holders' in meeting.voting_list ? (meeting.voting_list as VotingList) : null
    let votingList: VotingList | undefined
    if (meeting.organ === 'bolagsstamma' && (dateMoved || input.refresh_voting_list)) {
      votingList = await votingListSnapshot(ctx, input.meeting_date ?? meeting.meeting_date, previous)
    }
    if (input.presence && input.presence.length > 0) {
      const base = votingList ?? previous
      if (base) {
        const byId = new Map(input.presence.map((p) => [p.party_id, p]))
        votingList = {
          ...base,
          holders: base.holders.map((h) => {
            const p = byId.get(h.party_id)
            return p ? { ...h, present: p.present, proxy_name: p.proxy_name === undefined ? h.proxy_name : p.proxy_name?.trim() || null } : h
          }),
        }
      }
    }

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          corporate_meeting_id: meeting.id,
          kind_label: MEETING_KIND_LABELS_SV[meeting.kind],
          changes: Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)),
          voting_list_refreshed: Boolean(votingList),
          warnings,
        },
      }
    }

    const chairId = await resolvePick(ctx, chair)
    const secretaryId = await resolvePick(ctx, secretary)
    let adjusterIds: string[] | undefined
    if (adjusters) {
      adjusterIds = []
      for (const a of adjusters) {
        const pid = await resolvePick(ctx, a)
        if (pid && !adjusterIds.includes(pid)) adjusterIds.push(pid)
      }
    }
    const text = (v: string | null | undefined) => (v === undefined ? undefined : v?.trim() || null)
    const { error } = await ctx.supabase
      .from('corporate_meetings')
      .update({
        meeting_date: input.meeting_date,
        meeting_time: input.meeting_time,
        place: text(input.place),
        is_digital: input.is_digital,
        chair_party_id: chairId,
        secretary_party_id: secretaryId,
        adjuster_party_ids: adjusterIds,
        kallelse_date: input.kallelse_date,
        kallelse_method: text(input.kallelse_method),
        fiscal_period_id: input.fiscal_period_id,
        notes: text(input.notes),
        voting_list: votingList,
        attendees: input.attendees === null ? [] : input.attendees,
      })
      .eq('company_id', ctx.companyId)
      .eq('id', meeting.id)
    if (error) throw error
    warnings.push(...(await afterMeetingChange(ctx, meeting.id)))
    return { ok: true, data: { corporate_meeting_id: meeting.id, status: meeting.status }, ...(warnings.length > 0 ? { warnings } : {}) }
  } catch (error) {
    return meetingFailure(error)
  }
}

// ── Decisions ────────────────────────────────────────────────────────

export interface RecordDecisionInput {
  corporate_meeting_id: string
  /** Change this decision; omit to add one. */
  corporate_decision_id?: string | null
  /** The paragraph; a taken number moves the later ones down. Default: before the closing item. */
  item_number?: number | null
  kind?: DecisionKind | null
  title?: string | null
  text?: string | null
  payload?: Record<string, unknown> | null
  outcome?: DecisionOutcome | null
  votes_for?: number | null
  votes_against?: number | null
  votes_abstained?: number | null
  reservations?: string | null
}

/** The order after placing `movedId` at `itemNumber` (1-based); every paragraph numbered 1..n. */
export function renumber(decisions: ReadonlyArray<{ id: string; item_number: number }>, movedId: string | null, itemNumber: number | null): Map<string, number> {
  const ordered = [...decisions].sort((a, b) => a.item_number - b.item_number)
  if (movedId && itemNumber !== null) {
    const from = ordered.findIndex((d) => d.id === movedId)
    if (from >= 0) {
      const [moved] = ordered.splice(from, 1)
      ordered.splice(Math.min(Math.max(itemNumber - 1, 0), ordered.length), 0, moved!)
    }
  }
  return new Map(ordered.map((d, i) => [d.id, i + 1]))
}

/** Where a new paragraph goes when no number is given: before a closing item, else last. */
export function defaultItemNumber(decisions: ReadonlyArray<Pick<DecisionRecord, 'kind' | 'payload' | 'item_number'>>): number {
  const last = [...decisions].sort((a, b) => a.item_number - b.item_number).at(-1)
  if (last && last.kind === 'ovrigt' && last.payload.topic === 'avslutande') return last.item_number
  return (last?.item_number ?? 0) + 1
}

async function writeNumbers(ctx: OperationContext, decisions: readonly DecisionRecord[], numbers: Map<string, number>): Promise<void> {
  for (const d of decisions) {
    const next = numbers.get(d.id)
    if (next === undefined || next === d.item_number) continue
    const { error } = await ctx.supabase.from('corporate_decisions').update({ item_number: next }).eq('company_id', ctx.companyId).eq('id', d.id)
    if (error) throw error
  }
}

export async function recordDecision(
  ctx: OperationContext,
  input: RecordDecisionInput,
  { dryRun }: { dryRun: boolean },
): Promise<OperationOutcome<{ corporate_decision_id: string; corporate_meeting_id: string; item_number: number; kind: DecisionKind }>> {
  try {
    refusePersonnummer(input)
    const meeting = await requireMeeting(ctx, input.corporate_meeting_id)
    assertOpen(meeting)
    const decisions = await loadDecisionRecords(ctx.supabase, ctx.companyId, meeting.id)
    const existing = input.corporate_decision_id ? decisions.find((d) => d.id === input.corporate_decision_id) : null
    if (input.corporate_decision_id && !existing) throw new MeetingError('CORPORATE_DECISION_NOT_FOUND')
    const kind = input.kind ?? existing?.kind
    if (!kind) throw new MeetingError('CORPORATE_DECISION_PAYLOAD_INVALID', 'Ange vilken sorts beslut det är.', { field: 'kind' })
    const rawPayload = input.payload !== undefined && input.payload !== null ? input.payload : kind === existing?.kind ? existing.payload : {}
    const parsed = parseDecisionPayload(kind, rawPayload)
    if (!parsed.ok) {
      throw new MeetingError(
        'CORPORATE_DECISION_PAYLOAD_INVALID',
        `Beslutets uppgifter är inte giltiga: ${parsed.issues.map((i) => i.field || 'payload').join(', ')}.`,
        { issues: parsed.issues },
      )
    }
    const payload = parsed.payload as Record<string, unknown>
    await assertPartiesInCompany(ctx.supabase, ctx.companyId, payloadPartyIds(payload))
    const title = input.title?.trim() || existing?.title || DECISION_KIND_LABELS_SV[kind]
    const target = input.item_number ?? (existing ? null : defaultItemNumber(decisions))

    if (dryRun) {
      return {
        ok: true,
        dryRun: true,
        preview: {
          corporate_meeting_id: meeting.id,
          corporate_decision_id: existing?.id ?? null,
          item_number: target ?? existing?.item_number ?? null,
          kind,
          kind_label: DECISION_KIND_LABELS_SV[kind],
          title,
          outcome: input.outcome ?? existing?.outcome ?? 'bifallen',
          payload,
        },
      }
    }

    let decisionId: string
    if (existing) {
      const { error } = await ctx.supabase
        .from('corporate_decisions')
        .update({
          kind,
          title,
          text: input.text === undefined ? undefined : input.text?.trim() || null,
          payload,
          outcome: input.outcome ?? undefined,
          votes_for: input.votes_for,
          votes_against: input.votes_against,
          votes_abstained: input.votes_abstained,
          reservations: input.reservations === undefined ? undefined : input.reservations?.trim() || null,
        })
        .eq('company_id', ctx.companyId)
        .eq('id', existing.id)
      if (error) throw error
      decisionId = existing.id
    } else {
      // Placed after every paragraph first; the renumbering below moves it to its place.
      const { data, error } = await ctx.supabase
        .from('corporate_decisions')
        .insert({
          company_id: ctx.companyId,
          meeting_id: meeting.id,
          item_number: Math.min(decisions.length + 1, 999),
          kind,
          title,
          text: input.text?.trim() || null,
          payload,
          outcome: input.outcome ?? 'bifallen',
          votes_for: input.votes_for ?? null,
          votes_against: input.votes_against ?? null,
          votes_abstained: input.votes_abstained ?? null,
          reservations: input.reservations?.trim() || null,
          created_by: ctx.userId,
        })
        .select('id')
        .single()
      if (error) throw error
      decisionId = (data as { id: string }).id
    }
    const current = await loadDecisionRecords(ctx.supabase, ctx.companyId, meeting.id)
    const numbers = renumber(current, decisionId, target)
    await writeNumbers(ctx, current, numbers)
    const warnings = meeting.status === 'held' ? await afterMeetingChange(ctx, meeting.id) : []
    return {
      ok: true,
      data: { corporate_decision_id: decisionId, corporate_meeting_id: meeting.id, item_number: numbers.get(decisionId) ?? 1, kind },
      created: !existing,
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  } catch (error) {
    return meetingFailure(error)
  }
}

export async function deleteDecision(ctx: OperationContext, meetingId: string, decisionId: string): Promise<OperationOutcome<{ corporate_decision_id: string }>> {
  try {
    const meeting = await requireMeeting(ctx, meetingId)
    assertOpen(meeting)
    const decisions = await loadDecisionRecords(ctx.supabase, ctx.companyId, meeting.id)
    if (!decisions.some((d) => d.id === decisionId)) throw new MeetingError('CORPORATE_DECISION_NOT_FOUND')
    const { error } = await ctx.supabase.from('corporate_decisions').delete().eq('company_id', ctx.companyId).eq('id', decisionId)
    if (error) throw error
    const rest = decisions.filter((d) => d.id !== decisionId)
    await writeNumbers(ctx, rest, renumber(rest, null, null))
    if (meeting.status === 'held') await afterMeetingChange(ctx, meeting.id)
    return { ok: true, data: { corporate_decision_id: decisionId } }
  } catch (error) {
    return meetingFailure(error)
  }
}

// ── Hold and delete ──────────────────────────────────────────────────

export interface HeldMeeting {
  corporate_meeting_id: string
  status: 'held'
  sequence_number: number | null
  agm_recorded: boolean
}

/**
 * The meeting took place: status held, a board meeting takes its number
 * (ABL 8:26), an årsstämma writes the AGM date to the årsredovisning, and
 * the deadlines follow (minutes within two weeks, Bolagsverket notice for a
 * board change). The decisions stay open until the minutes are signed; the
 * elections change the roles when they are.
 */
export async function holdMeeting(ctx: OperationContext, id: string, { dryRun }: { dryRun: boolean }): Promise<OperationOutcome<HeldMeeting>> {
  try {
    const meeting = await requireMeeting(ctx, id)
    if (meeting.status !== 'draft') throw new MeetingError(meeting.status === 'held' ? 'CORPORATE_MEETING_ALREADY_HELD' : 'CORPORATE_MEETING_LOCKED')
    if (meeting.meeting_date > todayIsoStockholm()) throw new MeetingError('CORPORATE_MEETING_IN_FUTURE')
    const decisions = await loadDecisionRecords(ctx.supabase, ctx.companyId, meeting.id)
    const roles = await loadRoles(ctx, meeting.meeting_date)
    const effects = registerEffectsFrom(roles, decisions, meeting.meeting_date)
    const held = { ...meeting, status: 'held' as const }
    const agm = agmFields(held, decisions, (d) => decisionText(d, plainTextContext(held)))
    if (dryRun) {
      let nextNumber: number | null = null
      if (meeting.organ === 'styrelse') {
        const { data } = await ctx.supabase
          .from('corporate_meetings')
          .select('sequence_number')
          .eq('company_id', ctx.companyId)
          .eq('organ', 'styrelse')
          .not('sequence_number', 'is', null)
          .order('sequence_number', { ascending: false })
          .limit(1)
        nextNumber = (Number(((data ?? []) as Array<{ sequence_number: number }>)[0]?.sequence_number ?? 0) || 0) + 1
      }
      return {
        ok: true,
        dryRun: true,
        preview: {
          corporate_meeting_id: meeting.id,
          kind_label: MEETING_KIND_LABELS_SV[meeting.kind],
          meeting_date: meeting.meeting_date,
          sequence_number: nextNumber,
          decisions: decisions.map((d) => ({ item_number: d.item_number, title: d.title, outcome: d.outcome })),
          role_changes_on_signing: effects.planned.map((e) => ({ action: e.action, name: e.name, role: e.role, date: e.date })),
          agm: agm ? { fiscal_period_id: agm.fiscal_period_id, agm_date: agm.agm_date, agm_disposition_outcome: agm.agm_disposition_outcome } : null,
        },
      }
    }
    const { data, error } = await ctx.supabase
      .from('corporate_meetings')
      .update({ status: 'held', held_at: new Date().toISOString() })
      .eq('company_id', ctx.companyId)
      .eq('id', meeting.id)
      .eq('status', 'draft')
      .select('sequence_number')
      .maybeSingle()
    if (error) throw error
    if (!data) throw new MeetingError('CORPORATE_MEETING_ALREADY_HELD')
    const warnings = await afterMeetingChange(ctx, meeting.id)
    return {
      ok: true,
      data: {
        corporate_meeting_id: meeting.id,
        status: 'held',
        sequence_number: num((data as { sequence_number: unknown }).sequence_number),
        agm_recorded: Boolean(agm) && !warnings.some((w) => w.code === 'AGM_NOT_RECORDED'),
      },
      ...(warnings.length > 0 ? { warnings } : {}),
    }
  } catch (error) {
    return meetingFailure(error)
  }
}

/** Delete a draft meeting with its decisions and deadlines. Held and signed minutes are kept. */
export async function deleteMeeting(ctx: OperationContext, id: string): Promise<OperationOutcome<{ corporate_meeting_id: string }>> {
  try {
    const meeting = await requireMeeting(ctx, id)
    if (meeting.status !== 'draft') throw new MeetingError('CORPORATE_MEETING_NOT_DRAFT')
    const { data, error } = await ctx.supabase
      .from('corporate_meetings')
      .delete()
      .eq('company_id', ctx.companyId)
      .eq('id', meeting.id)
      .eq('status', 'draft')
      .select('id')
    if (error) throw error
    if (!data || data.length === 0) throw new MeetingError('CORPORATE_MEETING_NOT_DRAFT')
    const { error: deadlineError } = await createServiceClient()
      .from('deadlines')
      .delete()
      .eq('company_id', ctx.companyId)
      .like('source_key', `bolaget:meeting:${meeting.id}:%`)
      .eq('is_completed', false)
    if (deadlineError) ctx.log.warn('[bolaget] meeting deadlines not removed', { companyId: ctx.companyId, meetingId: meeting.id, error: deadlineError.message })
    return { ok: true, data: { corporate_meeting_id: meeting.id } }
  } catch (error) {
    return meetingFailure(error)
  }
}

// ── The read later waves call ────────────────────────────────────────

export interface LoadedDecision {
  corporate_decision_id: string
  corporate_meeting_id: string
  meeting_kind: MeetingKind
  meeting_organ: MeetingOrgan
  meeting_date: string
  meeting_status: MeetingRecord['status']
  /** True once the minutes are signed: the decision is final and recorded. */
  final: boolean
  item_number: number
  kind: DecisionKind
  title: string
  outcome: DecisionOutcome
  /** The validated terms (DecisionPayloads[kind]); null when stored terms no longer validate. */
  payload: Record<string, unknown> | null
  fiscal_period_id: string | null
}

/**
 * One decision with its meeting, for the capital-event wave (a dividend's
 * per-share amount and betalningsdag, a nyemission's terms) and the
 * reporting wave. Null when it is not this company's.
 */
export async function loadDecision(ctx: Pick<OperationContext, 'supabase' | 'companyId'>, decisionId: string): Promise<LoadedDecision | null> {
  const { data, error } = await ctx.supabase
    .from('corporate_decisions')
    .select('id, meeting_id, item_number, kind, title, text, payload, outcome, votes_for, votes_against, votes_abstained, reservations, created_at, updated_at')
    .eq('company_id', ctx.companyId)
    .eq('id', decisionId)
    .maybeSingle()
  if (error) throw new Error(`corporate_decisions read failed: ${error.message}`)
  if (!data) return null
  const decision = normaliseDecision(data as Record<string, unknown>)
  const meeting = await loadMeetingRecord(ctx.supabase, ctx.companyId, decision.meeting_id)
  if (!meeting) return null
  const parsed = parseDecisionPayload(decision.kind, decision.payload)
  return {
    corporate_decision_id: decision.id,
    corporate_meeting_id: meeting.id,
    meeting_kind: meeting.kind,
    meeting_organ: meeting.organ,
    meeting_date: meeting.meeting_date,
    meeting_status: meeting.status,
    final: meeting.status === 'signed',
    item_number: decision.item_number,
    kind: decision.kind,
    title: decision.title,
    outcome: decision.outcome,
    payload: parsed.ok ? (parsed.payload as Record<string, unknown>) : null,
    fiscal_period_id: meeting.fiscal_period_id,
  }
}

