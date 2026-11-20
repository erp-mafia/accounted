/**
 * Meetings, decisions and minutes (ABL 7 kap., 8:24-26): the shared
 * vocabulary. Pure data with no server imports: client components read the
 * enums for their pickers. Every enum mirrors a CHECK in
 * supabase/migrations/20261030010000_corporate_meetings.sql.
 */

export const MEETING_KINDS = ['arsstamma', 'extra_stamma', 'styrelsemote', 'per_capsulam'] as const
export type MeetingKind = (typeof MEETING_KINDS)[number]

/** Which body decides: the bolagsstämma or the styrelse. */
export const MEETING_ORGANS = ['bolagsstamma', 'styrelse'] as const
export type MeetingOrgan = (typeof MEETING_ORGANS)[number]

export const MEETING_STATUSES = ['draft', 'held', 'signed'] as const
export type MeetingStatus = (typeof MEETING_STATUSES)[number]

export const DECISION_KINDS = [
  'faststallande_rr_br',
  'resultatdisposition',
  'utdelning',
  'ansvarsfrihet',
  'val_styrelse',
  'val_revisor',
  'arvoden',
  'andrad_bolagsordning',
  'nyemission',
  'fondemission',
  'minskning',
  'optioner',
  'aterbetalning_villkorat_tillskott',
  'ovrigt',
] as const
export type DecisionKind = (typeof DECISION_KINDS)[number]

/** Decisions a later wave books or registers (capital events); this wave only stores their terms. */
export const CAPITAL_DECISION_KINDS: readonly DecisionKind[] = [
  'utdelning',
  'nyemission',
  'fondemission',
  'minskning',
  'optioner',
  'aterbetalning_villkorat_tillskott',
]

/** Decisions that change who holds a role (company_roles). */
export const ROLE_DECISION_KINDS: readonly DecisionKind[] = ['val_styrelse', 'val_revisor']

export const DECISION_OUTCOMES = ['bifallen', 'avslagen', 'bordlagd'] as const
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number]

export const ATTENDEE_CAPACITIES = ['aktieagare', 'ombud', 'styrelseledamot', 'styrelsesuppleant', 'vd', 'revisor', 'ovrig'] as const
export type AttendeeCapacity = (typeof ATTENDEE_CAPACITIES)[number]

/** Swedish labels for the PDFs and agent output (UI copy comes from messages). */
export const MEETING_KIND_LABELS_SV: Record<MeetingKind, string> = {
  arsstamma: 'Årsstämma',
  extra_stamma: 'Extra bolagsstämma',
  styrelsemote: 'Styrelsemöte',
  per_capsulam: 'Beslut per capsulam',
}

export const DECISION_KIND_LABELS_SV: Record<DecisionKind, string> = {
  faststallande_rr_br: 'Fastställande av resultat- och balansräkning',
  resultatdisposition: 'Disposition av resultatet',
  utdelning: 'Utdelning',
  ansvarsfrihet: 'Ansvarsfrihet',
  val_styrelse: 'Val av styrelse',
  val_revisor: 'Val av revisor',
  arvoden: 'Arvoden',
  andrad_bolagsordning: 'Ändring av bolagsordningen',
  nyemission: 'Nyemission',
  fondemission: 'Fondemission',
  minskning: 'Minskning av aktiekapitalet',
  optioner: 'Teckningsoptioner',
  aterbetalning_villkorat_tillskott: 'Återbetalning av villkorat aktieägartillskott',
  ovrigt: 'Övrigt',
}

export const OUTCOME_LABELS_SV: Record<DecisionOutcome, string> = {
  bifallen: 'Bifallen',
  avslagen: 'Avslagen',
  bordlagd: 'Bordlagd',
}

export const CAPACITY_LABELS_SV: Record<AttendeeCapacity, string> = {
  aktieagare: 'Aktieägare',
  ombud: 'Ombud',
  styrelseledamot: 'Styrelseledamot',
  styrelsesuppleant: 'Styrelsesuppleant',
  vd: 'Verkställande direktör',
  revisor: 'Revisor',
  ovrig: 'Övrig',
}

/** The body the kind decides for; per capsulam says so itself. */
export function organOf(kind: MeetingKind, perCapsulamOrgan: MeetingOrgan | null = null): MeetingOrgan {
  if (kind === 'arsstamma' || kind === 'extra_stamma') return 'bolagsstamma'
  if (kind === 'styrelsemote') return 'styrelse'
  return perCapsulamOrgan ?? 'bolagsstamma'
}

/** One row of the röstlängd (ABL 7:48): names, shares and votes, never a personnummer. */
export interface VotingListHolder {
  party_id: string
  name: string
  kind: 'person' | 'company'
  shares: number
  votes: number
  present: boolean
  /** The ombud who represented the holder, when someone did. */
  proxy_name: string | null
}

export interface VotingList {
  /** The aktiebok day the list was taken from: the meeting date. */
  as_of: string
  total_shares: number
  total_votes: number
  holders: VotingListHolder[]
}

export interface Attendee {
  party_id: string | null
  name: string
  capacity: AttendeeCapacity
  present: boolean
}

/** A meeting row as stored (corporate_meetings). */
export interface MeetingRecord {
  id: string
  kind: MeetingKind
  organ: MeetingOrgan
  sequence_number: number | null
  meeting_date: string
  meeting_time: string | null
  place: string | null
  is_digital: boolean
  chair_party_id: string | null
  secretary_party_id: string | null
  adjuster_party_ids: string[]
  kallelse_date: string | null
  kallelse_method: string | null
  fiscal_period_id: string | null
  voting_list: VotingList | Record<string, never>
  attendees: Attendee[]
  notes: string | null
  status: MeetingStatus
  held_at: string | null
  signed_at: string | null
  signature_names: string | null
  minutes_document_id: string | null
  signed_document_id: string | null
  signing_request_id: string | null
  created_at: string
  updated_at: string
}

/** A decision row as stored (corporate_decisions). */
export interface DecisionRecord {
  id: string
  meeting_id: string
  item_number: number
  kind: DecisionKind
  title: string
  text: string | null
  payload: Record<string, unknown>
  outcome: DecisionOutcome
  votes_for: number | null
  votes_against: number | null
  votes_abstained: number | null
  reservations: string | null
  created_at: string
  updated_at: string
}

export const MEETING_COLUMNS =
  'id, kind, organ, sequence_number, meeting_date, meeting_time, place, is_digital, chair_party_id, secretary_party_id, adjuster_party_ids, kallelse_date, kallelse_method, fiscal_period_id, voting_list, attendees, notes, status, held_at, signed_at, signature_names, minutes_document_id, signed_document_id, signing_request_id, created_at, updated_at'

export const DECISION_COLUMNS =
  'id, meeting_id, item_number, kind, title, text, payload, outcome, votes_for, votes_against, votes_abstained, reservations, created_at, updated_at'
