/**
 * The register as every door answers it (dashboard, v1, MCP): names and
 * masked identities only, never a personnummer. Pure.
 */
import { describeEvent } from './pdf-data'
import { nextFreeShareNumber, voidedEventIds } from './register-state'
import type { RolesView } from './roles'
import type { ShareRegisterData } from './share-register'
import { HOLDINGS_FLAG_ROLES, SHARE_EVENT_LABELS_SV, type RegisterParty, type ShareClass, type ShareEventKind } from './types'

export interface ShareRegisterHolderView {
  party_id: string
  name: string
  kind: 'person' | 'company'
  /** Masked personnummer (XXXXXXXX-1234), org number or masked foreign identity number; null when missing. */
  identity: string | null
  has_address: boolean
  shares: number
  votes: number
  capital_pct: number
  votes_pct: number
  by_class: Array<{ share_class_id: string; code: string; shares: number }>
  ranges: Array<{ range_start: number; range_end: number; share_class_id: string }>
  /** Board member, suppleant or VD on as_of (ABL 8:45). */
  officer: boolean
}

export interface ShareRegisterView {
  as_of: string
  is_avstamningsbolag: boolean
  /**
   * When every share had been entered and the register was taken into use;
   * null while it is set up. In use, an entry carries the day it is made and
   * no ingaende entry is taken.
   */
  setup_completed_at: string | null
  total_shares: number
  total_votes: number
  next_free_share_number: number
  classes: Array<Omit<ShareClass, 'id'> & { share_class_id: string; shares: number; votes: number }>
  holders: ShareRegisterHolderView[]
  notes: Array<{
    kind: 'aktiebrev' | 'pant' | 'nyttjanderatt'
    range_start: number
    range_end: number
    aktiebrev_number: string | null
    counterparty_party_id: string | null
    counterparty_name: string | null
    event_number: number
    event_date: string
  }>
  reconciliation: ShareRegisterData['reconciliation']
  /** Holders a person must still complete for the printout (ABL 5:5). */
  incomplete: { without_identity: number; without_address: number }
  /**
   * Stored note entries (aktiebrev, pant, nyttjanderätt) the history cannot
   * hold. They are left out of `notes`; each is voided with a rättelse.
   */
  note_problems: Array<{ share_register_event_id: string; event_number: number; event_date: string; kind: 'aktiebrev' | 'pant' | 'nyttjanderatt'; message: string }>
  events_count: number
  /** The number of the newest entry (0 when there is none): send it as expected_last_event_number with a new entry. */
  last_event_number: number
}

function identityOf(p: RegisterParty | undefined): string | null {
  if (!p) return null
  if (p.kind === 'company') return p.org_number ?? p.foreign_id_masked
  return p.personnummer_masked ?? p.foreign_id_masked ?? (p.birth_date ? `född ${p.birth_date}` : null)
}

export function shareRegisterView(data: ShareRegisterData, roles: RolesView | null): ShareRegisterView {
  const officers = new Set((roles?.roles ?? []).filter((r) => r.active && HOLDINGS_FLAG_ROLES.includes(r.role)).map((r) => r.party_id))
  const totals = new Map(data.summary.classes.map((c) => [c.share_class_id, c]))
  const holders = data.summary.holders.map((h) => {
    const p = data.parties.get(h.party_id)
    return {
      party_id: h.party_id,
      name: p?.name ?? 'okänd',
      kind: p?.kind ?? 'person',
      identity: identityOf(p),
      has_address: Boolean(p?.address),
      shares: h.shares,
      votes: h.votes,
      capital_pct: h.capital_pct,
      votes_pct: h.votes_pct,
      by_class: h.by_class,
      ranges: h.ranges.map((r) => ({ range_start: r.range_start, range_end: r.range_end, share_class_id: r.share_class_id })),
      officer: officers.has(h.party_id),
    }
  })
  return {
    as_of: data.as_of,
    is_avstamningsbolag: data.is_avstamningsbolag,
    setup_completed_at: data.setup_completed_at,
    total_shares: data.summary.total_shares,
    total_votes: data.summary.total_votes,
    next_free_share_number: nextFreeShareNumber(data.replay.ranges),
    classes: data.classes.map((c) => ({
      share_class_id: c.id,
      code: c.code,
      name: c.name,
      votes_per_share: Number(c.votes_per_share),
      forbehall_samtycke: c.forbehall_samtycke,
      forbehall_forkop: c.forbehall_forkop,
      forbehall_hembud: c.forbehall_hembud,
      forbehall_omvandling: c.forbehall_omvandling,
      forbehall_inlosen: c.forbehall_inlosen,
      forbehall_text: c.forbehall_text,
      bolagsordning_reference: c.bolagsordning_reference,
      shares: totals.get(c.id)?.shares ?? 0,
      votes: totals.get(c.id)?.votes ?? 0,
    })),
    holders,
    notes: data.replay.annotations.map((n) => ({
      kind: n.kind,
      range_start: n.range_start,
      range_end: n.range_end,
      aktiebrev_number: n.aktiebrev_number,
      counterparty_party_id: n.counterparty_party_id,
      counterparty_name: n.counterparty_party_id ? data.parties.get(n.counterparty_party_id)?.name ?? null : null,
      event_number: n.event_number,
      event_date: n.event_date,
    })),
    reconciliation: data.reconciliation,
    incomplete: {
      without_identity: holders.filter((h) => !h.identity).length,
      without_address: holders.filter((h) => !h.has_address).length,
    },
    note_problems: data.note_problems.map((problem) => ({
      share_register_event_id: problem.event_id,
      event_number: problem.event_number,
      event_date: problem.event_date,
      kind: problem.kind,
      message: problem.message,
    })),
    events_count: data.events.length,
    last_event_number: data.events.reduce((max, e) => Math.max(max, e.event_number), 0),
  }
}

export interface ShareEventView {
  share_register_event_id: string
  event_number: number
  /** The day the entry belongs to in the register. */
  event_date: string
  /** The day of the event when it is earlier than event_date; else null. */
  occurred_on: string | null
  entered_at: string
  kind: ShareEventKind
  kind_label: string
  text: string
  voided: boolean
  corrects_event_id: string | null
  share_class_id: string | null
  from_party_id: string | null
  to_party_id: string | null
  counterparty_party_id: string | null
  range_start: number | null
  range_end: number | null
  transfer_reason: string | null
  price_total: number | null
  ratio: number | null
  aktiebrev_number: string | null
  aktiebrev_action: 'issued' | 'returned' | null
  note_status: 'open' | 'closed' | null
  registered_on: string | null
  decision_id: string | null
  document_id: string | null
  journal_entry_id: string | null
  note: string | null
}

/** Every entry with its Swedish sentence and whether a rättelse voided it, in entry order. */
export function shareEventsView(data: Pick<ShareRegisterData, 'events' | 'parties' | 'classes'>): ShareEventView[] {
  const voided = voidedEventIds(data.events)
  const byId = new Map(data.events.map((e) => [e.id, e]))
  return data.events.map((e) => ({
    share_register_event_id: e.id,
    event_number: e.event_number,
    event_date: e.event_date,
    occurred_on: e.occurred_on ?? null,
    entered_at: e.created_at,
    kind: e.kind,
    kind_label: SHARE_EVENT_LABELS_SV[e.kind],
    text: describeEvent(e, data.parties, data.classes, byId),
    voided: voided.has(e.id),
    corrects_event_id: e.corrects_event_id,
    share_class_id: e.share_class_id,
    from_party_id: e.from_party_id,
    to_party_id: e.to_party_id,
    counterparty_party_id: e.counterparty_party_id,
    range_start: e.range_start,
    range_end: e.range_end,
    transfer_reason: e.transfer_reason,
    price_total: e.price_total,
    ratio: e.ratio,
    aktiebrev_number: e.aktiebrev_number,
    aktiebrev_action: e.aktiebrev_action,
    note_status: e.note_status,
    registered_on: e.registered_on,
    decision_id: e.decision_id,
    document_id: e.document_id,
    journal_entry_id: e.journal_entry_id,
    note: e.note,
  }))
}

/** Roles as the doors answer them: names and masked identity, never a personnummer. */
export function rolesView(roles: RolesView) {
  return {
    as_of: roles.as_of,
    signatory_rule: roles.signatory_rule,
    roles: roles.roles.map((r) => ({
      company_role_id: r.id,
      party_id: r.party_id,
      name: r.party?.name ?? 'okänd',
      kind: r.party?.kind ?? 'person',
      identity: identityOf(r.party ?? undefined),
      role: r.role,
      role_label: r.label_sv,
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      active: r.active,
      source: r.source,
      registered_at: r.registered_at,
      decision_id: r.decision_id,
      details: r.details,
    })),
    signatory_rules: roles.signatory_rules.map((r) => ({
      signatory_rule_id: r.id,
      rule_text: r.rule_text,
      valid_from: r.valid_from,
      valid_to: r.valid_to,
      active: r.active,
      source: r.source,
      registered_at: r.registered_at,
    })),
  }
}
