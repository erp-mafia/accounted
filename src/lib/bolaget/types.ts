/**
 * Bolaget registers: the shared vocabulary of the aktiebok (ABL 5-6 kap.),
 * the roles over time (ABL 8 kap.) and the verkliga huvudmän (LRVH).
 *
 * Pure data with no server imports: client components read the enums for
 * their pickers. Every enum mirrors a CHECK in
 * supabase/migrations/20261029210000_bolaget_registers.sql.
 */

export const COMPANY_ROLE_KINDS = [
  'styrelseledamot',
  'styrelseordforande',
  'styrelsesuppleant',
  'vd',
  'vice_vd',
  'sarskild_firmatecknare',
  'revisor',
  'huvudansvarig_revisor',
  'revisorssuppleant',
  'verklig_huvudman',
  'kontaktperson',
] as const
export type CompanyRoleKind = (typeof COMPANY_ROLE_KINDS)[number]

/** Ordinarie styrelseledamöter: the chair is one too (ABL 8:17). Suppleanter are not. */
export const BOARD_MEMBER_ROLES: readonly CompanyRoleKind[] = ['styrelseordforande', 'styrelseledamot']

/** The roles whose own shareholdings the aktiebok notes (ABL 8:45): board members, suppleanter and the VD. */
export const HOLDINGS_FLAG_ROLES: readonly CompanyRoleKind[] = ['styrelseordforande', 'styrelseledamot', 'styrelsesuppleant', 'vd', 'vice_vd']

export const ROLE_SOURCES = ['registry_tic', 'person', 'decision', 'document'] as const
export type RoleSource = (typeof ROLE_SOURCES)[number]

/** Swedish label per role, for the PDFs and agent output (UI copy comes from messages). */
export const ROLE_LABELS_SV: Record<CompanyRoleKind, string> = {
  styrelseledamot: 'Styrelseledamot',
  styrelseordforande: 'Styrelseordförande',
  styrelsesuppleant: 'Styrelsesuppleant',
  vd: 'Verkställande direktör',
  vice_vd: 'Vice verkställande direktör',
  sarskild_firmatecknare: 'Särskild firmatecknare',
  revisor: 'Revisor',
  huvudansvarig_revisor: 'Huvudansvarig revisor',
  revisorssuppleant: 'Revisorssuppleant',
  verklig_huvudman: 'Verklig huvudman',
  kontaktperson: 'Kontaktperson',
}

export const SHARE_EVENT_KINDS = [
  'bildande',
  'nyemission',
  'fondemission',
  'overlatelse',
  'indragning',
  'omvandling',
  'split',
  'sammanlaggning',
  'aktiebrev',
  'pant',
  'nyttjanderatt',
  'anteckning',
  'rattelse',
] as const
export type ShareEventKind = (typeof SHARE_EVENT_KINDS)[number]

/** Kinds that create new share numbers. */
export const ISSUE_KINDS: readonly ShareEventKind[] = ['bildande', 'nyemission', 'fondemission']
/** Kinds that move or end shares a holder has. */
export const HOLDER_KINDS: readonly ShareEventKind[] = ['overlatelse', 'indragning', 'omvandling']
/** Kinds that renumber every share. */
export const RENUMBER_KINDS: readonly ShareEventKind[] = ['split', 'sammanlaggning']
/** Kinds that change who holds what (the rest are notes on shares). */
export const HOLDING_KINDS: readonly ShareEventKind[] = [...ISSUE_KINDS, ...HOLDER_KINDS, ...RENUMBER_KINDS]

export const SHARE_EVENT_LABELS_SV: Record<ShareEventKind, string> = {
  bildande: 'Bildande',
  nyemission: 'Nyemission',
  fondemission: 'Fondemission',
  overlatelse: 'Överlåtelse',
  indragning: 'Indragning',
  omvandling: 'Omvandling',
  split: 'Split',
  sammanlaggning: 'Sammanläggning',
  aktiebrev: 'Aktiebrev',
  pant: 'Pantsättning',
  nyttjanderatt: 'Nyttjanderätt',
  anteckning: 'Anteckning',
  rattelse: 'Rättelse',
}

export const TRANSFER_REASONS = ['kop', 'gava', 'arv', 'testamente', 'bodelning', 'byte', 'apport', 'annat'] as const
export type TransferReason = (typeof TRANSFER_REASONS)[number]

export const TRANSFER_REASON_LABELS_SV: Record<TransferReason, string> = {
  kop: 'Köp',
  gava: 'Gåva',
  arv: 'Arv',
  testamente: 'Testamente',
  bodelning: 'Bodelning',
  byte: 'Byte',
  apport: 'Apport',
  annat: 'Annat',
}

export const FORBEHALL_KEYS = ['samtycke', 'forkop', 'hembud', 'omvandling', 'inlosen'] as const
export type ForbehallKey = (typeof FORBEHALL_KEYS)[number]

/** The förbehåll and the ABL section that allows each (noted per ABL 5:5 and 6:2). */
export const FORBEHALL_LABELS_SV: Record<ForbehallKey, string> = {
  samtycke: 'Samtyckesförbehåll (4 kap. 8 § ABL)',
  forkop: 'Förköpsförbehåll (4 kap. 18 § ABL)',
  hembud: 'Hembudsförbehåll (4 kap. 27 § ABL)',
  omvandling: 'Omvandlingsförbehåll (4 kap. 6 § ABL)',
  inlosen: 'Inlösenförbehåll (20 kap. 31 § ABL)',
}

export type PartyKind = 'person' | 'company'

/** A share class as the registers read it. */
export interface ShareClass {
  id: string
  code: string
  name: string | null
  votes_per_share: number
  forbehall_samtycke: boolean
  forbehall_forkop: boolean
  forbehall_hembud: boolean
  forbehall_omvandling: boolean
  forbehall_inlosen: boolean
  forbehall_text: string | null
  bolagsordning_reference: string | null
}

/** One aktiebok entry as stored (share_register_events). */
export interface ShareEvent {
  id: string
  event_number: number
  event_date: string
  kind: ShareEventKind
  share_class_id: string | null
  to_share_class_id: string | null
  from_party_id: string | null
  to_party_id: string | null
  range_start: number | null
  range_end: number | null
  transfer_reason: TransferReason | null
  price_total: number | null
  ratio: number | null
  aktiebrev_number: string | null
  aktiebrev_action: 'issued' | 'returned' | null
  counterparty_party_id: string | null
  note_status: 'open' | 'closed' | null
  corrects_event_id: string | null
  registered_on: string | null
  decision_id: string | null
  document_id: string | null
  journal_entry_id: string | null
  note: string | null
  created_at: string
  created_via?: 'app' | 'api' | 'mcp'
}

/** One holding: a range of share numbers of one class held by one party. */
export interface HoldingRange {
  share_class_id: string
  party_id: string
  range_start: number
  range_end: number
}

/** A role row (company_roles). */
export interface CompanyRole {
  id: string
  party_id: string
  role: CompanyRoleKind
  valid_from: string | null
  valid_to: string | null
  source: RoleSource
  decision_id: string | null
  registered_at: string | null
  details: Record<string, unknown>
  created_at: string
}

/** A signatory rule row (company_signatory_rules). */
export interface SignatoryRule {
  id: string
  rule_text: string
  valid_from: string | null
  valid_to: string | null
  source: RoleSource
  registered_at: string | null
}

/** A party as the registers show it: never the personnummer itself. */
export interface RegisterParty {
  party_id: string
  name: string
  kind: PartyKind
  org_number: string | null
  /** "XXXXXXXX-1234", or null when no personnummer is on file. */
  personnummer_masked: string | null
  /**
   * The "annat identifieringsnummer" of a holder without a Swedish
   * personnummer or organisationsnummer (ABL 5:5 p. 2), masked like the
   * personnummer: all but its last four characters. Null when none is on file.
   */
  foreign_id_masked: string | null
  birth_date: string | null
  address: PartyAddress | null
  email: string | null
}

export interface PartyAddress {
  line1: string | null
  line2: string | null
  postal_code: string | null
  city: string | null
  country: string | null
}
