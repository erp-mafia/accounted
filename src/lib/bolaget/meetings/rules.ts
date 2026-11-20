/**
 * The rules of a meeting that need no database: who signs the minutes, when
 * a justerare is needed, what an adopted election changes in the roles,
 * which deadlines a meeting raises and the warnings a person should see.
 *
 * Law (ABL 2005:551 as of SFS 2026:783, read 2026-10-28/29):
 *   - 7:48: the protokollförare signs; the chair (unless the chair kept the
 *     minutes) and at least one justerare elected by the stämma justerar; no
 *     justerare is needed when the chair and the protokollförare together
 *     represent every share. The röstlängd is in or attached to the minutes.
 *   - 7:49: the minutes are available to the shareholders within two weeks.
 *   - 7:18-20: kallelse to an årsstämma (and an extra stämma that amends the
 *     bolagsordning) six to four weeks before; another extra stämma six to
 *     two weeks before; the bolagsordning may allow a shorter time.
 *   - 8:24: board minutes signed by the protokollförare, justerade by the
 *     chair (unless the chair kept them) and, when the board has several
 *     members, by a member the board chooses. 8:26: kept in numerical order.
 *   - 8:8, 9:8: the stämma elects the board and the revisor. 8:43-44: a
 *     change is reported to Bolagsverket at once; 8:13: a board change takes
 *     effect when the notice reaches Bolagsverket.
 *   - Per capsulam: ABL has no rule for a stämma decision without a meeting
 *     (7:1, decisions are made at a stämma; 7:4 a is postal voting). Bolagsverket
 *     accepts a decision every shareholder signed; this module asks for every
 *     shareholder's (or every board member's) signature and warns.
 *
 * Where the law is uncertain the rule warns rather than blocks.
 */
import { addDaysIso } from '@/lib/dates/iso'
import { roundOre } from '@/lib/money'
import { BOARD_MEMBER_ROLES, ROLE_LABELS_SV, type CompanyRoleKind } from '../types'
import { AUDITOR_ELECTION_ROLES, BOARD_ELECTION_ROLES, parseDecisionPayload } from './payloads'
import {
  MEETING_KIND_LABELS_SV,
  type Attendee,
  type DecisionKind,
  type DecisionOutcome,
  type MeetingKind,
  type MeetingOrgan,
  type MeetingStatus,
  type VotingList,
} from './types'

export const VERKSAMT_URL = 'https://verksamt.se'

export interface MeetingShape {
  id: string
  kind: MeetingKind
  organ: MeetingOrgan
  status: MeetingStatus
  meeting_date: string
  held_at: string | null
  chair_party_id: string | null
  secretary_party_id: string | null
  adjuster_party_ids: string[]
  kallelse_date: string | null
  attendees: Attendee[]
  voting_list: VotingList | Record<string, never>
}

export interface DecisionShape {
  id: string
  kind: DecisionKind
  outcome: DecisionOutcome
  payload: Record<string, unknown>
}

export interface RoleShape {
  id: string
  party_id: string
  role: CompanyRoleKind
  valid_from: string | null
  valid_to: string | null
  /** The person's name, to match an election by name when it names no party. */
  name: string | null
}

export function isStamma(kind: MeetingKind): boolean {
  return kind === 'arsstamma' || kind === 'extra_stamma'
}

/** The röstlängd, or null when the meeting has none (a board meeting). */
export function votingListOf(meeting: Pick<MeetingShape, 'voting_list'>): VotingList | null {
  const list = meeting.voting_list as Partial<VotingList>
  return Array.isArray(list?.holders) ? (list as VotingList) : null
}

function activeOn(row: { valid_from: string | null; valid_to: string | null }, day: string): boolean {
  return (row.valid_from === null || row.valid_from <= day) && (row.valid_to === null || row.valid_to >= day)
}

/** Whether the role overlaps the period [from, to]. */
export function heldDuring(row: { valid_from: string | null; valid_to: string | null }, from: string, to: string): boolean {
  return (row.valid_from === null || row.valid_from <= to) && (row.valid_to === null || row.valid_to >= from)
}

// ── Justerare and signers ────────────────────────────────────────────

export type JusterareState =
  | 'named'
  | 'not_needed_holds_all_shares'
  | 'not_needed_single_member_board'
  | 'covered_by_board_signatures'
  | 'not_applicable'
  | 'missing'

/**
 * Whether the minutes have the justering the law asks for. A stämma needs
 * one unless the chair and the protokollförare together hold every share
 * (ABL 7:48; a one-owner company). A board needs a member to justera when it
 * has several (8:24); here every board member present signs, which covers it.
 */
export function justerareState(meeting: MeetingShape, boardSize: number): JusterareState {
  if (meeting.kind === 'per_capsulam') return 'not_applicable'
  if (meeting.adjuster_party_ids.length > 0) return 'named'
  if (isStamma(meeting.kind)) {
    const list = votingListOf(meeting)
    if (list && list.total_shares > 0) {
      const officers = new Set([meeting.chair_party_id, meeting.secretary_party_id].filter((id): id is string => Boolean(id)))
      const held = list.holders.filter((h) => officers.has(h.party_id)).reduce((sum, h) => sum + h.shares, 0)
      if (held >= list.total_shares) return 'not_needed_holds_all_shares'
    }
    return 'missing'
  }
  if (boardSize <= 1) return 'not_needed_single_member_board'
  const officers = new Set([meeting.chair_party_id, meeting.secretary_party_id])
  const otherMember = meeting.attendees.some(
    (a) => a.present && a.party_id && !officers.has(a.party_id) && a.capacity === 'styrelseledamot',
  )
  return otherMember ? 'covered_by_board_signatures' : 'missing'
}

export interface SignerSlot {
  party_id: string
  role_label: string
}

/**
 * Who signs the minutes, each once:
 *   - a stämma: the protokollförare, the chair and each justerare (7:48);
 *   - a board meeting: the protokollförare, the chair, each justerare and
 *     every board member present (8:24, the brief's conservative reading);
 *   - per capsulam: every shareholder in the röstlängd (a stämma decision)
 *     or every board member in office (a board decision).
 */
export function minutesSigners(meeting: MeetingShape, boardInOffice: ReadonlyArray<{ party_id: string; role: CompanyRoleKind }>): SignerSlot[] {
  const slots = new Map<string, string[]>()
  const add = (partyId: string | null | undefined, label: string) => {
    if (!partyId) return
    const labels = slots.get(partyId) ?? []
    if (!labels.includes(label)) labels.push(label)
    slots.set(partyId, labels)
  }
  if (meeting.kind === 'per_capsulam') {
    if (meeting.organ === 'bolagsstamma') {
      for (const h of votingListOf(meeting)?.holders ?? []) add(h.party_id, 'Aktieägare')
    } else {
      for (const r of boardInOffice) if (BOARD_MEMBER_ROLES.includes(r.role)) add(r.party_id, ROLE_LABELS_SV[r.role])
    }
    return [...slots].map(([party_id, labels]) => ({ party_id, role_label: labels.join(' och ') }))
  }
  add(meeting.secretary_party_id, 'Protokollförare')
  add(meeting.chair_party_id, 'Ordförande')
  for (const id of meeting.adjuster_party_ids) add(id, 'Justerare')
  if (meeting.organ === 'styrelse') {
    for (const a of meeting.attendees) {
      if (a.present && a.party_id && a.capacity === 'styrelseledamot') add(a.party_id, 'Styrelseledamot')
    }
  }
  return [...slots].map(([party_id, labels]) => ({ party_id, role_label: labels.join(' och ') }))
}

// ── Role effects of elections ────────────────────────────────────────

export interface RoleEffect {
  action: 'add' | 'end' | 'keep'
  decision_id: string
  role: CompanyRoleKind
  party_id: string | null
  name: string
  kind: 'person' | 'company'
  org_number: string | null
  /** add: the first day; end: the last day. */
  date: string
  company_role_id: string | null
}

function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && a.trim().toLocaleLowerCase('sv') === b.trim().toLocaleLowerCase('sv'))
}

/**
 * What adopted elections change in the roles on the meeting day: who is
 * added from that day, whose role ends the day before, and who simply
 * continues (re-elected). A rejected or tabled election changes nothing. A
 * board election replaces the board (ledamöter, ordförande, suppleanter); an
 * auditor election replaces the revisorer.
 */
export function planRoleEffects(decisions: readonly DecisionShape[], roles: readonly RoleShape[], meetingDate: string): RoleEffect[] {
  const effects: RoleEffect[] = []
  const lastDay = addDaysIso(meetingDate, -1)
  const active = roles.filter((r) => activeOn(r, meetingDate))

  const plan = (
    decisionId: string,
    scope: readonly CompanyRoleKind[],
    elected: Array<{ party_id: string | null; name: string; role: CompanyRoleKind; kind: 'person' | 'company'; org_number: string | null }>,
  ) => {
    const matched = new Set<string>()
    for (const e of elected) {
      const holder = active.find(
        (r) => r.role === e.role && !matched.has(r.id) && (e.party_id ? r.party_id === e.party_id : sameName(r.name, e.name)),
      )
      if (holder) {
        matched.add(holder.id)
        effects.push({ action: 'keep', decision_id: decisionId, role: e.role, party_id: holder.party_id, name: e.name, kind: e.kind, org_number: e.org_number, date: meetingDate, company_role_id: holder.id })
      } else {
        effects.push({ action: 'add', decision_id: decisionId, role: e.role, party_id: e.party_id, name: e.name, kind: e.kind, org_number: e.org_number, date: meetingDate, company_role_id: null })
      }
    }
    for (const r of active) {
      if (!scope.includes(r.role) || matched.has(r.id)) continue
      const end = r.valid_from && r.valid_from > lastDay ? r.valid_from : lastDay
      effects.push({ action: 'end', decision_id: decisionId, role: r.role, party_id: r.party_id, name: r.name ?? '', kind: 'person', org_number: null, date: end, company_role_id: r.id })
    }
  }

  for (const d of decisions) {
    if (d.outcome !== 'bifallen') continue
    if (d.kind === 'val_styrelse') {
      const parsed = parseDecisionPayload('val_styrelse', d.payload)
      if (!parsed.ok) continue
      plan(
        d.id,
        BOARD_ELECTION_ROLES,
        parsed.payload.members.map((m) => ({ party_id: m.party_id ?? null, name: m.name, role: m.role, kind: 'person' as const, org_number: null })),
      )
    } else if (d.kind === 'val_revisor') {
      const parsed = parseDecisionPayload('val_revisor', d.payload)
      if (!parsed.ok) continue
      plan(
        d.id,
        AUDITOR_ELECTION_ROLES,
        parsed.payload.auditors.map((a) => ({ party_id: a.party_id ?? null, name: a.name, role: a.role, kind: a.kind, org_number: a.org_number ?? null })),
      )
    }
  }
  return effects
}

/** The effects that change something (an add or an end). */
export function changingEffects(effects: readonly RoleEffect[]): RoleEffect[] {
  return effects.filter((e) => e.action !== 'keep')
}

// ── Deadlines ────────────────────────────────────────────────────────

export interface MeetingDeadlineDraft {
  key: 'kallelse' | 'handlingar' | 'protokoll' | 'bolagsverket'
  title: string
  dueOn: string
  priority: 'critical' | 'important' | 'normal'
  notes: string
}

/** The kallelse window: earliest and latest day to send it (ABL 7:18-20). */
export function kallelseWindow(kind: MeetingKind, meetingDate: string, amendsBolagsordning: boolean): { earliest: string; latest: string; weeks: number } {
  const weeks = kind === 'arsstamma' || amendsBolagsordning ? 4 : 2
  return { earliest: addDaysIso(meetingDate, -42), latest: addDaysIso(meetingDate, -weeks * 7), weeks }
}

/**
 * The deadlines a meeting raises, keyed so a later sync updates or removes
 * them (deadlines.source_key bolaget:meeting:<id>:<key>):
 *   - kallelse: a planned stämma whose kallelse is not recorded;
 *   - handlingar: the årsredovisning and the board's proposals available two
 *     weeks before an årsstämma (7:25, 18:7);
 *   - protokoll: the minutes of a stämma available within two weeks (7:49);
 *   - bolagsverket: a held meeting that changed the board, the revisor or
 *     the bolagsordning, reported at once (8:44, 3:4-5), at verksamt.se.
 */
export function meetingDeadlines(
  meeting: MeetingShape,
  decisions: readonly DecisionShape[],
  today: string,
  registerChanges: { roles: boolean },
): MeetingDeadlineDraft[] {
  const out: MeetingDeadlineDraft[] = []
  const label = MEETING_KIND_LABELS_SV[meeting.kind].toLowerCase()
  const adopted = decisions.filter((d) => d.outcome === 'bifallen')
  const amendsBolagsordning = adopted.some((d) => d.kind === 'andrad_bolagsordning')

  if (isStamma(meeting.kind) && meeting.status === 'draft' && !meeting.kallelse_date && meeting.meeting_date > today) {
    const window = kallelseWindow(meeting.kind, meeting.meeting_date, amendsBolagsordning)
    out.push({
      key: 'kallelse',
      title: meeting.kind === 'arsstamma' ? 'Kallelse till årsstämman' : 'Kallelse till extra bolagsstämma',
      dueOn: window.latest,
      priority: 'important',
      notes:
        `Stämman hålls ${meeting.meeting_date}. Kallelsen skickas tidigast ${window.earliest} och senast ${window.latest} ` +
        `(7 kap. 18-20 §§ aktiebolagslagen; bolagsordningen kan medge kortare tid och anger hur kallelse sker). ` +
        'Kallelsen anger tid, plats och en numrerad dagordning. Anteckna kallelsedagen på mötet när den är skickad.',
    })
  }

  if (meeting.kind === 'arsstamma' && meeting.status === 'draft' && meeting.meeting_date > today) {
    out.push({
      key: 'handlingar',
      title: 'Årsredovisning och förslag tillgängliga för aktieägarna',
      dueOn: addDaysIso(meeting.meeting_date, -14),
      priority: 'important',
      notes:
        `Senast två veckor före årsstämman ${meeting.meeting_date} ska årsredovisningen, revisionsberättelsen om bolaget har revisor, ` +
        'och styrelsens förslag till vinstdisposition hållas tillgängliga för aktieägarna (7 kap. 25 § och 18 kap. 7 § aktiebolagslagen).',
    })
  }

  if (isStamma(meeting.kind) && meeting.status !== 'signed') {
    out.push({
      key: 'protokoll',
      title: `Protokoll från ${label} tillgängligt`,
      dueOn: addDaysIso(meeting.meeting_date, 14),
      priority: 'important',
      notes:
        `Senast två veckor efter stämman ska protokollet hållas tillgängligt hos bolaget för aktieägarna, ` +
        'och en kopia sändas till den aktieägare som begär det (7 kap. 49 § aktiebolagslagen).',
    })
  }

  const held = meeting.status !== 'draft'
  if (held && (registerChanges.roles || amendsBolagsordning)) {
    const heldOn = meeting.held_at ? meeting.held_at.slice(0, 10) : meeting.meeting_date
    const what = [
      registerChanges.roles ? 'styrelsen eller revisorn' : null,
      amendsBolagsordning ? 'bolagsordningen' : null,
    ].filter(Boolean).join(' och ')
    out.push({
      key: 'bolagsverket',
      title: 'Anmäl ändringen till Bolagsverket',
      dueOn: heldOn > meeting.meeting_date ? heldOn : meeting.meeting_date,
      priority: 'critical',
      notes:
        `${MEETING_KIND_LABELS_SV[meeting.kind]} ${meeting.meeting_date} ändrade ${what}. Ändringen anmäls genast till Bolagsverket ` +
        '(8 kap. 43-44 §§ aktiebolagslagen; en ändrad bolagsordning 3 kap. 4-5 §§). En ändring i styrelsen gäller först när anmälan ' +
        `har kommit in till Bolagsverket (8 kap. 13 §). Anmälan görs i Bolagsverkets e-tjänst, som nås via ${VERKSAMT_URL}.`,
    })
  }
  return out
}

// ── Warnings ─────────────────────────────────────────────────────────

export interface MeetingWarning {
  code: string
  message_sv: string
  message_en: string
}

/** The amount per share (ABL 18:3), rounded to öre, and whether it divides the total exactly. */
export function dividendPerShare(total: number, shares: number): { per_share: number; exact: boolean } {
  if (shares <= 0) return { per_share: 0, exact: total === 0 }
  const perShare = roundOre(total / shares)
  return { per_share: perShare, exact: roundOre(perShare * shares) === roundOre(total) }
}

/**
 * What a person should check before the minutes are signed. Never blocks:
 * where the law is unclear or the facts are outside the register, it says so.
 */
export function meetingWarnings(
  meeting: MeetingShape,
  decisions: readonly DecisionShape[],
  context: { boardSize: number; boardAfter: { members: number; suppleants: number } | null },
): MeetingWarning[] {
  const out: MeetingWarning[] = []
  const justering = justerareState(meeting, context.boardSize)
  if (justering === 'missing') {
    out.push({
      code: 'JUSTERARE_MISSING',
      message_sv: isStamma(meeting.kind)
        ? 'Ingen justerare är vald. Det behövs en utom när ordföranden och protokollföraren tillsammans företräder samtliga aktier (7 kap. 48 § aktiebolagslagen).'
        : 'Ingen ledamot justerar protokollet. När styrelsen har flera ledamöter justerar även en ledamot som styrelsen utser (8 kap. 24 § aktiebolagslagen).',
      message_en: isStamma(meeting.kind)
        ? 'No adjuster (justerare) is chosen. One is needed unless the chair and the secretary together represent every share (ABL 7:48).'
        : 'No board member adjusts the minutes. A board with several members has one member it chooses adjust them too (ABL 8:24).',
    })
  }
  if (meeting.kind !== 'per_capsulam' && !meeting.secretary_party_id) {
    out.push({
      code: 'SECRETARY_MISSING',
      message_sv: 'Ingen protokollförare är angiven. Protokollet undertecknas av protokollföraren.',
      message_en: 'No secretary is named. The minutes are signed by the secretary.',
    })
  }
  if (meeting.kind === 'per_capsulam' && meeting.organ === 'bolagsstamma') {
    out.push({
      code: 'PER_CAPSULAM_ALL_SHAREHOLDERS',
      message_sv:
        'Aktiebolagslagen har ingen regel om stämmobeslut utan sammanträde. Bolagsverket godtar i praxis ett beslut som samtliga aktieägare har skrivit under, med datum och röstlängd. Alla aktieägare i röstlängden blir undertecknare.',
      message_en:
        'The Companies Act has no rule for a shareholder decision without a meeting. Bolagsverket accepts in practice a decision every shareholder signed, with date and voting list. Every shareholder in the voting list signs.',
    })
  }
  if (isStamma(meeting.kind) && !votingListOf(meeting)?.holders.length) {
    out.push({
      code: 'VOTING_LIST_EMPTY',
      message_sv: 'Röstlängden är tom: aktieboken har inga aktieägare per stämmodagen.',
      message_en: 'The voting list is empty: the share register has no holders on the meeting day.',
    })
  }
  for (const d of decisions) {
    if (d.outcome !== 'bifallen') continue
    if (d.kind === 'utdelning') {
      const parsed = parseDecisionPayload('utdelning', d.payload)
      if (parsed.ok && !parsed.payload.payment_date) {
        out.push({
          code: 'DIVIDEND_PAYMENT_DATE_MISSING',
          message_sv: 'Utdelningsbeslutet saknar betalningsdag. Beslutet anger belopp per aktie och, för ett bolag som inte är avstämningsbolag, en betalningsdag (18 kap. 3 § aktiebolagslagen).',
          message_en: 'The dividend decision has no payment date. It states the amount per share and, outside an avstämningsbolag, a payment date (ABL 18:3).',
        })
      }
      if (parsed.ok && roundOre(parsed.payload.amount_per_share * parsed.payload.share_count) !== roundOre(parsed.payload.total_amount)) {
        out.push({
          code: 'DIVIDEND_TOTAL_MISMATCH',
          message_sv: 'Belopp per aktie gånger antal aktier blir inte totalbeloppet. Kontrollera utdelningen.',
          message_en: 'Amount per share times the number of shares is not the total. Check the dividend.',
        })
      }
    }
    if ((d.kind === 'val_styrelse' || d.kind === 'val_revisor' || d.kind === 'andrad_bolagsordning' || d.kind === 'ansvarsfrihet' || d.kind === 'faststallande_rr_br' || d.kind === 'resultatdisposition') && meeting.organ === 'styrelse') {
      out.push({
        code: 'STAMMA_DECISION_AT_BOARD',
        message_sv: 'Beslutet fattas av bolagsstämman, inte av styrelsen (7 kap. 11 §, 8 kap. 8 § och 9 kap. 8 § aktiebolagslagen). Kontrollera mötestypen.',
        message_en: 'This decision is the shareholders\' meeting\'s, not the board\'s (ABL 7:11, 8:8, 9:8). Check the meeting type.',
      })
    }
  }
  if (context.boardAfter && context.boardAfter.members > 0 && context.boardAfter.members < 3 && context.boardAfter.suppleants === 0) {
    out.push({
      code: 'BOARD_NEEDS_SUPPLEANT',
      message_sv: 'En styrelse med färre än tre ledamöter ska ha minst en suppleant (8 kap. 3 § aktiebolagslagen).',
      message_en: 'A board with fewer than three members needs at least one deputy (ABL 8:3).',
    })
  }
  const seen = new Set<string>()
  return out.filter((w) => (seen.has(w.code) ? false : (seen.add(w.code), true)))
}

/** Board size after the adopted elections take effect (null when nothing is elected). */
export function boardAfterElection(effects: readonly RoleEffect[]): { members: number; suppleants: number } | null {
  const board = effects.filter((e) => e.action !== 'end' && (BOARD_ELECTION_ROLES as readonly string[]).includes(e.role))
  if (board.length === 0) return null
  const members = new Set(board.filter((e) => e.role !== 'styrelsesuppleant').map((e) => e.party_id ?? e.name.toLowerCase())).size
  const suppleants = board.filter((e) => e.role === 'styrelsesuppleant').length
  return { members, suppleants }
}
