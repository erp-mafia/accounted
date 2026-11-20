/**
 * A meeting as every door answers it: the minutes with each paragraph's
 * sentence, who signs, the justering, the effects on the roles, the
 * warnings and the signing state. Names only; never a personnummer, never
 * an email address (has_email says whether a signer can be mailed).
 */
import type { OperationContext } from '@/lib/operations/types'
import { loadRegisterParties } from '../people'
import { loadRoles, type RolesView } from '../roles'
import { BOARD_MEMBER_ROLES } from '../types'
import { registerEffectsFrom, type RegisterEffectsView } from './effects'
import { decisionText, type MinutesTextContext } from './minutes-text'
import {
  boardAfterElection,
  isStamma,
  justerareState,
  kallelseWindow,
  meetingWarnings,
  minutesSigners,
  votingListOf,
  type JusterareState,
  type MeetingWarning,
} from './rules'
import { syncMeetingSigning } from './signing-sync'
import { loadDecisionRecords, loadMeetingRecord, loadMeetingRecords, meetingShape } from './store'
import { loadFiscalPeriod } from './template'
import {
  DECISION_KIND_LABELS_SV,
  MEETING_KIND_LABELS_SV,
  OUTCOME_LABELS_SV,
  type Attendee,
  type DecisionKind,
  type DecisionOutcome,
  type DecisionRecord,
  type MeetingKind,
  type MeetingOrgan,
  type MeetingRecord,
  type MeetingStatus,
  type VotingList,
} from './types'

export interface PersonRef {
  party_id: string
  name: string
}

export interface DecisionView {
  corporate_decision_id: string
  item_number: number
  kind: DecisionKind
  kind_label: string
  title: string
  /** The text a person wrote; null when the sentence is composed from the terms. */
  text: string | null
  /** The paragraph as the minutes print it. */
  text_rendered: string
  payload: Record<string, unknown>
  outcome: DecisionOutcome
  outcome_label: string
  votes_for: number | null
  votes_against: number | null
  votes_abstained: number | null
  reservations: string | null
}

export interface MeetingSummary {
  corporate_meeting_id: string
  kind: MeetingKind
  kind_label: string
  organ: MeetingOrgan
  title: string
  sequence_number: number | null
  meeting_date: string
  place: string | null
  is_digital: boolean
  status: MeetingStatus
  fiscal_period_id: string | null
  signing_pending: boolean
  signed_at: string | null
}

export interface MeetingDetail extends MeetingSummary {
  meeting_time: string | null
  chair: PersonRef | null
  secretary: PersonRef | null
  adjusters: PersonRef[]
  kallelse_date: string | null
  kallelse_method: string | null
  kallelse_window: { earliest: string; latest: string } | null
  fiscal_period: { period_start: string; period_end: string } | null
  voting_list: VotingList | null
  present: { holders: number; shares: number; votes: number } | null
  attendees: Attendee[]
  notes: string | null
  held_at: string | null
  signature_names: string | null
  minutes_document_id: string | null
  signed_document_id: string | null
  signing_request_id: string | null
  decisions: DecisionView[]
  justering: JusterareState
  signers: Array<{ party_id: string; name: string; role_label: string; has_email: boolean }>
  register_effects: RegisterEffectsView
  warnings: MeetingWarning[]
  signing: {
    status: string
    expires_at: string
    signers: Array<{ name: string; role_label: string | null; status: string; signed_at: string | null }>
  } | null
}

export function meetingTitle(m: Pick<MeetingRecord, 'kind' | 'organ' | 'sequence_number' | 'meeting_date'>): string {
  if (m.kind === 'styrelsemote') return m.sequence_number ? `Styrelsemöte nr ${m.sequence_number}` : 'Styrelsemöte'
  if (m.kind === 'per_capsulam') {
    const base = m.organ === 'styrelse' ? 'Styrelsebeslut per capsulam' : 'Stämmobeslut per capsulam'
    return m.sequence_number ? `${base} nr ${m.sequence_number}` : base
  }
  return `${MEETING_KIND_LABELS_SV[m.kind]} ${m.meeting_date}`
}

export function summaryOf(m: MeetingRecord): MeetingSummary {
  return {
    corporate_meeting_id: m.id,
    kind: m.kind,
    kind_label: MEETING_KIND_LABELS_SV[m.kind],
    organ: m.organ,
    title: meetingTitle(m),
    sequence_number: m.sequence_number,
    meeting_date: m.meeting_date,
    place: m.place,
    is_digital: m.is_digital,
    status: m.status,
    fiscal_period_id: m.fiscal_period_id,
    signing_pending: Boolean(m.signing_request_id) && m.status !== 'signed',
    signed_at: m.signed_at,
  }
}

/** The company's meetings, newest first, each in step with its signing request. */
export async function listMeetingsView(
  ctx: OperationContext,
  filter: { kind?: MeetingKind | null; fiscal_period_id?: string | null } = {},
): Promise<MeetingSummary[]> {
  const records = await loadMeetingRecords(ctx.supabase, ctx.companyId, filter)
  const synced: MeetingRecord[] = []
  for (const r of records) synced.push(r.signing_request_id && r.status === 'held' ? await syncMeetingSigning(ctx, r) : r)
  return synced.map(summaryOf)
}

function boardOn(roles: RolesView): Array<{ party_id: string; role: (typeof BOARD_MEMBER_ROLES)[number] }> {
  return roles.roles.filter((r) => r.active && BOARD_MEMBER_ROLES.includes(r.role)).map((r) => ({ party_id: r.party_id, role: r.role as (typeof BOARD_MEMBER_ROLES)[number] }))
}

async function signingSummary(ctx: OperationContext, requestId: string): Promise<MeetingDetail['signing']> {
  const [request, signers] = await Promise.all([
    ctx.supabase.from('signing_requests').select('status, expires_at').eq('company_id', ctx.companyId).eq('id', requestId).maybeSingle(),
    ctx.supabase
      .from('signing_request_signers')
      .select('name, role_label, status, signed_at, position')
      .eq('company_id', ctx.companyId)
      .eq('signing_request_id', requestId)
      .order('position', { ascending: true }),
  ])
  if (request.error || !request.data) return null
  const row = request.data as { status: string; expires_at: string }
  return {
    status: row.status === 'open' && new Date(row.expires_at).getTime() <= Date.now() ? 'expired' : row.status,
    expires_at: row.expires_at,
    signers: ((signers.data ?? []) as Array<{ name: string; role_label: string | null; status: string; signed_at: string | null }>).map((s) => ({
      name: s.name,
      role_label: s.role_label,
      status: s.status,
      signed_at: s.signed_at,
    })),
  }
}

/** The full view of one meeting record (no signing sync; getMeetingView does that first). */
export async function buildMeetingView(ctx: OperationContext, record: MeetingRecord, decisionRecords?: DecisionRecord[]): Promise<MeetingDetail> {
  const [decisions, roles, fiscalPeriod] = await Promise.all([
    decisionRecords ? Promise.resolve(decisionRecords) : loadDecisionRecords(ctx.supabase, ctx.companyId, record.id),
    loadRoles(ctx, record.meeting_date),
    record.fiscal_period_id ? loadFiscalPeriod(ctx.supabase, ctx.companyId, record.fiscal_period_id) : Promise.resolve(null),
  ])
  const shape = meetingShape(record)
  const board = boardOn(roles)
  const boardSize = new Set(board.map((b) => b.party_id)).size
  const slots = minutesSigners(shape, board)
  const partyIds = [
    record.chair_party_id,
    record.secretary_party_id,
    ...record.adjuster_party_ids,
    ...slots.map((s) => s.party_id),
  ].filter((id): id is string => Boolean(id))
  const parties = await loadRegisterParties(ctx.companyId, partyIds)
  const nameOf = (id: string | null): PersonRef | null => (id ? { party_id: id, name: parties.get(id)?.name ?? 'okänd' } : null)
  const effects = registerEffectsFrom(roles, decisions, record.meeting_date)
  const justering = justerareState(shape, boardSize)
  const hasAuditor = roles.roles.some((r) => r.active && (r.role === 'revisor' || r.role === 'huvudansvarig_revisor'))
  const textContext: MinutesTextContext = {
    kind: record.kind,
    organ: record.organ,
    meeting_date: record.meeting_date,
    kallelse_date: record.kallelse_date,
    kallelse_method: record.kallelse_method,
    chair_name: nameOf(record.chair_party_id)?.name ?? null,
    secretary_name: nameOf(record.secretary_party_id)?.name ?? null,
    adjuster_names: record.adjuster_party_ids.map((id) => parties.get(id)?.name ?? 'okänd'),
    justering,
    fiscal_period: fiscalPeriod ? { period_start: fiscalPeriod.period_start, period_end: fiscalPeriod.period_end } : null,
    has_auditor: hasAuditor,
  }
  const list = votingListOf(record)
  const presentHolders = list?.holders.filter((h) => h.present) ?? []
  const amends = decisions.some((d) => d.kind === 'andrad_bolagsordning' && d.outcome === 'bifallen')
  const kallelse = isStamma(record.kind) ? kallelseWindow(record.kind, record.meeting_date, amends) : null
  return {
    ...summaryOf(record),
    meeting_time: record.meeting_time,
    chair: nameOf(record.chair_party_id),
    secretary: nameOf(record.secretary_party_id),
    adjusters: record.adjuster_party_ids.map((id) => nameOf(id)!),
    kallelse_date: record.kallelse_date,
    kallelse_method: record.kallelse_method,
    kallelse_window: kallelse ? { earliest: kallelse.earliest, latest: kallelse.latest } : null,
    fiscal_period: textContext.fiscal_period,
    voting_list: list,
    present: list
      ? {
          holders: presentHolders.length,
          shares: presentHolders.reduce((s, h) => s + h.shares, 0),
          votes: presentHolders.reduce((s, h) => s + h.votes, 0),
        }
      : null,
    attendees: record.attendees,
    notes: record.notes,
    held_at: record.held_at,
    signature_names: record.signature_names,
    minutes_document_id: record.minutes_document_id,
    signed_document_id: record.signed_document_id,
    signing_request_id: record.signing_request_id,
    decisions: decisions.map((d) => ({
      corporate_decision_id: d.id,
      item_number: d.item_number,
      kind: d.kind,
      kind_label: DECISION_KIND_LABELS_SV[d.kind],
      title: d.title,
      text: d.text,
      text_rendered: decisionText(d, textContext),
      payload: d.payload,
      outcome: d.outcome,
      outcome_label: OUTCOME_LABELS_SV[d.outcome],
      votes_for: d.votes_for,
      votes_against: d.votes_against,
      votes_abstained: d.votes_abstained,
      reservations: d.reservations,
    })),
    justering,
    signers: slots.map((s) => ({ party_id: s.party_id, name: parties.get(s.party_id)?.name ?? 'okänd', role_label: s.role_label, has_email: Boolean(parties.get(s.party_id)?.email) })),
    register_effects: effects,
    warnings: meetingWarnings(shape, decisions, { boardSize, boardAfter: boardAfterElection([...effects.planned, ...effects.kept]) }),
    signing: record.signing_request_id ? await signingSummary(ctx, record.signing_request_id) : null,
  }
}

/** One meeting, in step with its signing request; null when it is not the company's. */
export async function getMeetingView(ctx: OperationContext, id: string): Promise<MeetingDetail | null> {
  const record = await loadMeetingRecord(ctx.supabase, ctx.companyId, id)
  if (!record) return null
  return buildMeetingView(ctx, await syncMeetingSigning(ctx, record))
}

