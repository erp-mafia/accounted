/**
 * What the aktiebok printout, the per-holder extract and the aktiebrev say,
 * built from the register. Pure, so the content is tested without rendering.
 *
 * The aktiebok printout (ABL 5:10, 7:28) lists every share in numerical
 * order with its holder, identity, postal address, class, aktiebrev and
 * notes (5:5), states the förbehåll per class, notes the board's and the
 * VD's own holdings (8:45), and appends the dated history of entries (5:9).
 * An aktiebrev (6:2) names the company, the holder, the share numbers, the
 * class, the förbehåll and the issue date, with the board's names under it
 * (6:3 allows printed signatures).
 */
import { formatOrgNumberDisplay } from '@/lib/invariants/org-number'
import { pdfNumberText, pdfAmount } from '@/lib/pdf/number-text'
import { identityText } from './people'
import type { ReplayResult, ShareAnnotation } from './register-state'
import type { RoleView, RolesView } from './roles'
import type { ShareRegisterData } from './share-register'
import {
  FORBEHALL_LABELS_SV,
  HOLDINGS_FLAG_ROLES,
  ROLE_LABELS_SV,
  SHARE_EVENT_LABELS_SV,
  TRANSFER_REASON_LABELS_SV,
  type RegisterParty,
  type ShareClass,
  type ShareEvent,
} from './types'

export interface PdfCompany {
  name: string
  org_number: string | null
}

const INT = new Intl.NumberFormat('sv-SE', { maximumFractionDigits: 0 })
const PCT = new Intl.NumberFormat('sv-SE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function formatCount(n: number): string {
  return pdfNumberText(INT.format(n))
}

export function formatPct(n: number): string {
  return pdfNumberText(PCT.format(n))
}

export function formatKr(n: number): string {
  return `${pdfAmount(n)} kr`
}

export function rangeLabel(start: number | null, end: number | null): string {
  if (start === null || end === null) return ''
  return start === end ? formatCount(start) : `${formatCount(start)}-${formatCount(end)}`
}

export function forbehallLabels(c: ShareClass): string[] {
  const out: string[] = []
  if (c.forbehall_samtycke) out.push(FORBEHALL_LABELS_SV.samtycke)
  if (c.forbehall_forkop) out.push(FORBEHALL_LABELS_SV.forkop)
  if (c.forbehall_hembud) out.push(FORBEHALL_LABELS_SV.hembud)
  if (c.forbehall_omvandling) out.push(FORBEHALL_LABELS_SV.omvandling)
  if (c.forbehall_inlosen) out.push(FORBEHALL_LABELS_SV.inlosen)
  return out
}

function addressText(p: RegisterParty | undefined): string {
  if (!p?.address) return ''
  const a = p.address
  return [a.line1, a.line2, [a.postal_code, a.city].filter(Boolean).join(' '), a.country && a.country !== 'SE' ? a.country : null]
    .filter((s) => s && String(s).trim())
    .join(', ')
}

/** One aktiebok entry as a Swedish sentence. */
export function describeEvent(
  e: ShareEvent,
  parties: ReadonlyMap<string, RegisterParty>,
  classes: readonly ShareClass[],
  eventsById: ReadonlyMap<string, ShareEvent>,
): string {
  const name = (id: string | null) => (id ? parties.get(id)?.name ?? 'okänd' : 'okänd')
  const cls = (id: string | null) => classes.find((c) => c.id === id)?.code ?? ''
  const count = e.range_start !== null && e.range_end !== null ? e.range_end - e.range_start + 1 : 0
  const shares = `aktie ${rangeLabel(e.range_start, e.range_end)} (${formatCount(count)} st${e.share_class_id ? `, serie ${cls(e.share_class_id)}` : ''})`
  const price = e.price_total !== null && e.price_total !== undefined ? `, ${formatKr(Number(e.price_total))}` : ''
  const registered = e.registered_on ? `. Registrerad hos Bolagsverket ${e.registered_on}` : ''
  let text: string
  switch (e.kind) {
    case 'bildande':
    case 'nyemission':
    case 'fondemission':
      text = `${SHARE_EVENT_LABELS_SV[e.kind]}: ${shares} till ${name(e.to_party_id)}${price}${registered}`
      break
    case 'overlatelse':
      text = `Överlåtelse (${e.transfer_reason ? TRANSFER_REASON_LABELS_SV[e.transfer_reason].toLowerCase() : 'grund saknas'}): ${shares} från ${name(e.from_party_id)} till ${name(e.to_party_id)}${price}`
      break
    case 'indragning':
      text = `Indragning: ${shares} hos ${name(e.from_party_id)}${price}${registered}`
      break
    case 'omvandling':
      text = `Omvandling: ${shares} hos ${name(e.from_party_id)} till serie ${cls(e.to_share_class_id)}`
      break
    case 'split':
      text = `Split: varje aktie delas i ${e.ratio ?? '?'}${registered}`
      break
    case 'sammanlaggning':
      text = `Sammanläggning: ${e.ratio ?? '?'} aktier blir en${registered}`
      break
    case 'aktiebrev':
      text = `Aktiebrev nr ${e.aktiebrev_number ?? ''} ${e.aktiebrev_action === 'returned' ? 'makulerat' : 'utfärdat'} för aktie ${rangeLabel(e.range_start, e.range_end)}`
      break
    case 'pant':
      text = e.note_status === 'closed'
        ? `Pantsättningen till ${name(e.counterparty_party_id)} upphör för aktie ${rangeLabel(e.range_start, e.range_end)}`
        : `Pantsättning till ${name(e.counterparty_party_id)} av aktie ${rangeLabel(e.range_start, e.range_end)}`
      break
    case 'nyttjanderatt':
      text = e.note_status === 'closed'
        ? `Nyttjanderätten för ${name(e.counterparty_party_id)} upphör för aktie ${rangeLabel(e.range_start, e.range_end)}`
        : `Nyttjanderätt för ${name(e.counterparty_party_id)} till aktie ${rangeLabel(e.range_start, e.range_end)}`
      break
    case 'rattelse': {
      const target = e.corrects_event_id ? eventsById.get(e.corrects_event_id) : null
      text = `Rättelse av anteckning nr ${target?.event_number ?? '?'}`
      break
    }
    default:
      text = 'Anteckning'
  }
  return e.note && e.kind !== 'anteckning' ? `${text}. ${e.note}` : e.kind === 'anteckning' ? `Anteckning: ${e.note ?? ''}` : text
}

export interface AktiebokRow {
  party_id: string
  range_start: number
  range_end: number
  count: number
  class_code: string
  holder_name: string
  identity: string
  address: string
  aktiebrev: string | null
  notes: string[]
  board_flag: boolean
}

export interface AktiebokHolderRow {
  party_id: string
  name: string
  identity: string
  shares: number
  votes: number
  capital_pct: number
  votes_pct: number
  board_flag: boolean
}

export interface AktiebokHistoryRow {
  event_number: number
  event_date: string
  entered_on: string
  kind_label: string
  text: string
  voided: boolean
}

export interface AktiebokPdfData {
  company: PdfCompany
  as_of: string
  generated_at: string
  /** Full personnummer printed (owner or admin); masked otherwise. */
  full_identity: boolean
  classes: Array<{ code: string; name: string | null; votes_per_share: number; forbehall: string[]; forbehall_text: string | null; bolagsordning_reference: string | null }>
  total_shares: number
  total_votes: number
  rows: AktiebokRow[]
  holders: AktiebokHolderRow[]
  /** ABL 8:45: the board members', suppleanters' and VD's own holdings, a zero included. */
  officer_holdings: Array<{ name: string; roles: string; shares: number }>
  history: AktiebokHistoryRow[]
}

/** Split the holdings at every note boundary so each printed row carries its own notes. */
function rowsWithNotes(replay: ReplayResult): Array<{ party_id: string; share_class_id: string; range_start: number; range_end: number; notes: ShareAnnotation[] }> {
  const out: Array<{ party_id: string; share_class_id: string; range_start: number; range_end: number; notes: ShareAnnotation[] }> = []
  for (const r of replay.ranges) {
    const cuts = new Set<number>([r.range_start, r.range_end + 1])
    for (const n of replay.annotations) {
      if (n.range_end < r.range_start || n.range_start > r.range_end) continue
      cuts.add(Math.max(n.range_start, r.range_start))
      cuts.add(Math.min(n.range_end, r.range_end) + 1)
    }
    const points = [...cuts].sort((a, b) => a - b)
    for (let i = 0; i < points.length - 1; i++) {
      const start = points[i]!
      const end = points[i + 1]! - 1
      out.push({
        party_id: r.party_id,
        share_class_id: r.share_class_id,
        range_start: start,
        range_end: end,
        notes: replay.annotations.filter((n) => n.range_start <= start && n.range_end >= end),
      })
    }
  }
  return out
}

function officerPartyIds(roles: RolesView | null): Map<string, RoleView[]> {
  const out = new Map<string, RoleView[]>()
  for (const r of roles?.roles ?? []) {
    if (!r.active || !HOLDINGS_FLAG_ROLES.includes(r.role)) continue
    out.set(r.party_id, [...(out.get(r.party_id) ?? []), r])
  }
  return out
}

export function buildAktiebokPdfData(
  register: ShareRegisterData,
  roles: RolesView | null,
  company: PdfCompany,
  options: { fullPersonnummer?: Map<string, string>; generatedAt: string },
): AktiebokPdfData {
  const parties = register.parties
  const classById = new Map(register.classes.map((c) => [c.id, c]))
  const officers = officerPartyIds(roles)
  const ident = (id: string) => {
    const p = parties.get(id)
    return p ? identityText(p, options.fullPersonnummer) : ''
  }
  const rows: AktiebokRow[] = rowsWithNotes(register.replay).map((r) => {
    const aktiebrev = r.notes.find((n) => n.kind === 'aktiebrev')
    return {
      party_id: r.party_id,
      range_start: r.range_start,
      range_end: r.range_end,
      count: r.range_end - r.range_start + 1,
      class_code: classById.get(r.share_class_id)?.code ?? '',
      holder_name: parties.get(r.party_id)?.name ?? 'okänd',
      identity: ident(r.party_id),
      address: addressText(parties.get(r.party_id)),
      aktiebrev: aktiebrev ? `Nr ${aktiebrev.aktiebrev_number} (${aktiebrev.event_date})` : null,
      notes: r.notes
        .filter((n) => n.kind !== 'aktiebrev')
        .map((n) => {
          const other = parties.get(n.counterparty_party_id ?? '')
          if (n.kind === 'pant') return `Pantsatt till ${other?.name ?? 'okänd'} (${n.event_date})`
          // ABL 5:6: the holder of the right stands in the aktiebok with identity number and postal address, like the owner.
          const who = [other?.name ?? 'okänd', other ? ident(other.party_id) : '', addressText(other)].filter((part) => part).join(', ')
          return `Nyttjanderätt: ${who}${n.note ? `. ${n.note}` : ''} (${n.event_date})`
        }),
      board_flag: officers.has(r.party_id),
    }
  })
  const holders: AktiebokHolderRow[] = register.summary.holders.map((h) => ({
    party_id: h.party_id,
    name: parties.get(h.party_id)?.name ?? 'okänd',
    identity: ident(h.party_id),
    shares: h.shares,
    votes: h.votes,
    capital_pct: h.capital_pct,
    votes_pct: h.votes_pct,
    board_flag: officers.has(h.party_id),
  }))
  const sharesOf = new Map(register.summary.holders.map((h) => [h.party_id, h.shares]))
  const officer_holdings = [...officers.entries()].map(([partyId, rs]) => ({
    name: rs[0]?.party?.name ?? parties.get(partyId)?.name ?? 'okänd',
    roles: [...new Set(rs.map((r) => ROLE_LABELS_SV[r.role]))].join(', '),
    shares: sharesOf.get(partyId) ?? 0,
  }))
  const eventsById = new Map(register.events.map((e) => [e.id, e]))
  const voided = new Set(register.events.filter((e) => e.kind === 'rattelse' && e.corrects_event_id).map((e) => e.corrects_event_id!))
  const history = register.events.map((e) => ({
    event_number: e.event_number,
    event_date: e.event_date,
    entered_on: e.created_at.slice(0, 10),
    kind_label: SHARE_EVENT_LABELS_SV[e.kind],
    text: describeEvent(e, parties, register.classes, eventsById),
    voided: voided.has(e.id),
  }))
  return {
    company,
    as_of: register.as_of,
    generated_at: options.generatedAt,
    full_identity: Boolean(options.fullPersonnummer && options.fullPersonnummer.size > 0),
    classes: register.classes.map((c) => ({
      code: c.code,
      name: c.name,
      votes_per_share: Number(c.votes_per_share),
      forbehall: forbehallLabels(c),
      forbehall_text: c.forbehall_text,
      bolagsordning_reference: c.bolagsordning_reference,
    })),
    total_shares: register.summary.total_shares,
    total_votes: register.summary.total_votes,
    rows,
    holders,
    officer_holdings,
    history,
  }
}

export interface HolderExtractData {
  company: PdfCompany
  as_of: string
  generated_at: string
  holder: { name: string; identity: string; address: string }
  shares: number
  votes: number
  capital_pct: number
  votes_pct: number
  total_shares: number
  rows: AktiebokRow[]
  history: AktiebokHistoryRow[]
}

/** One holder's extract: their shares on the date and every entry that names them. Null when the party is not in the register. */
export function buildHolderExtractData(
  register: ShareRegisterData,
  partyId: string,
  company: PdfCompany,
  options: { fullPersonnummer?: Map<string, string>; generatedAt: string },
): HolderExtractData | null {
  const party = register.parties.get(partyId)
  if (!party) return null
  const full = buildAktiebokPdfData(register, null, company, options)
  const holder = register.summary.holders.find((h) => h.party_id === partyId)
  const touches = new Set(
    register.events
      .filter((e) => e.from_party_id === partyId || e.to_party_id === partyId || e.counterparty_party_id === partyId)
      .map((e) => e.event_number),
  )
  return {
    company,
    as_of: register.as_of,
    generated_at: options.generatedAt,
    holder: { name: party.name, identity: identityText(party, options.fullPersonnummer), address: addressText(party) },
    shares: holder?.shares ?? 0,
    votes: holder?.votes ?? 0,
    capital_pct: holder?.capital_pct ?? 0,
    votes_pct: holder?.votes_pct ?? 0,
    total_shares: register.summary.total_shares,
    rows: full.rows.filter((r) => r.party_id === partyId),
    history: full.history.filter((h) => touches.has(h.event_number)),
  }
}

export interface AktiebrevData {
  company: PdfCompany
  number: string
  issued_on: string
  holder: { name: string; identity: string }
  range_start: number
  range_end: number
  count: number
  class_code: string
  class_name: string | null
  forbehall: string[]
  forbehall_text: string | null
  /** The board on the issue date; their printed names sign (ABL 6:3). */
  signers: Array<{ name: string; role: string }>
}

/** The aktiebrev an 'aktiebrev' issued entry stands for; null when the entry is not one or no single holder holds the shares. */
export function buildAktiebrevData(
  event: ShareEvent,
  register: Pick<ShareRegisterData, 'events' | 'classes' | 'parties'>,
  replayOnIssue: ReplayResult,
  roles: RolesView | null,
  company: PdfCompany,
  fullPersonnummer?: Map<string, string>,
): AktiebrevData | null {
  if (event.kind !== 'aktiebrev' || event.aktiebrev_action !== 'issued' || event.range_start === null || event.range_end === null) return null
  const covering = replayOnIssue.ranges.filter((r) => r.range_start <= event.range_end! && r.range_end >= event.range_start!)
  const holders = new Set(covering.map((r) => r.party_id))
  const classes = new Set(covering.map((r) => r.share_class_id))
  if (holders.size !== 1 || classes.size !== 1) return null
  const partyId = [...holders][0]!
  const cls = register.classes.find((c) => c.id === [...classes][0])
  const party = register.parties.get(partyId)
  if (!party || !cls) return null
  const board = (roles?.roles ?? []).filter(
    (r) =>
      (r.role === 'styrelseordforande' || r.role === 'styrelseledamot') &&
      (r.valid_from === null || r.valid_from <= event.event_date) &&
      (r.valid_to === null || r.valid_to >= event.event_date),
  )
  return {
    company,
    number: event.aktiebrev_number ?? '',
    issued_on: event.event_date,
    holder: { name: party.name, identity: identityText(party, fullPersonnummer) },
    range_start: event.range_start,
    range_end: event.range_end,
    count: event.range_end - event.range_start + 1,
    class_code: cls.code,
    class_name: cls.name,
    forbehall: forbehallLabels(cls),
    forbehall_text: cls.forbehall_text,
    signers: board.map((r) => ({ name: r.party?.name ?? 'okänd', role: ROLE_LABELS_SV[r.role] })),
  }
}

/** The company line every PDF prints. */
export function companyLine(company: PdfCompany): string {
  return company.org_number ? `${company.name}, ${formatOrgNumberDisplay(company.org_number)}` : company.name
}
