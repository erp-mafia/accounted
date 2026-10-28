import type { DecisionReceipt } from './receipts'

/**
 * "Därför bokades den så": a verifikat's decision receipts and commit actor,
 * read into one summary line (who booked it, how, when) and a few detail
 * rows (decision, proposal, the agent's reason, grounds, what changed,
 * checks, policy). Pure and
 * client-safe: the verifikat page and the Inkorg both render from it.
 *
 * Only what is recorded is shown. A field the receipt or the entry does not
 * carry yields a missing row, never a guessed one: no receipt means no
 * proposal or grounds row, an empty suggestion list (which a failed snapshot
 * also writes) is not "no suggestions were offered", and the model's own
 * confidence number is never shown.
 *
 * Receipts from step 2 (MR !463) carry rule_version, policy_version,
 * confidence_band and checks. They are optional here, so rows read before
 * that lands, and rows recorded before it, simply show fewer facts.
 */

export type BookingWhyTranslate = (key: string, values?: Record<string, string | number>) => string

/** A check a booking door ran, as step 2 records it. Any id reads; unknown ids show as recorded. */
export interface ReceiptCheckLike {
  id: string
  result: string
  detail?: string | null
}

/** The receipt fields the display reads; step-2 fields optional so both shapes fit. */
export type ReceiptLike = Pick<
  DecisionReceipt,
  'receipt_id' | 'decided_at' | 'outcome' | 'decided_by' | 'proposed_by' | 'candidates' | 'chosen' | 'booked'
> & {
  subject_kind?: DecisionReceipt['subject_kind']
  rule_version?: string | null
  policy_version?: string | null
  confidence_band?: string | null
  checks?: ReadonlyArray<ReceiptCheckLike> | null
  /** Why the agent that staged it proposed it; recorded from 2026-10-28. */
  agent_reason?: string | null
}

/** The journal entry columns the display reads: the commit actor snapshot plus who created it. */
export interface BookingWhyEntry {
  status: string | null
  source_type: string | null
  committed_at: string | null
  committed_actor_type: string | null
  committed_actor_label: string | null
  commit_method: string | null
  /** The entry's user, the person behandlingshistoriken names for a person's commit. */
  user_id: string | null
}

export interface BookingWhyPerson {
  name: string | null
  /** True when the person reaches the company through its byrå team. */
  byra: boolean
  byra_name: string | null
}

/** At most this many other decisions are listed under "Fler beslut"; the rest are counted. */
export const MAX_OTHER_DECISIONS = 10

/** One of the other decisions on a voucher, compacted to what the list shows. */
export interface OtherDecision {
  decided_at: string
  decided_by: { actor_type: string; user_id: string | null; label: string | null }
  /** The acted-on suggestion's source; null when none was acted on. */
  source: string | null
}

/**
 * What the view reads of a voucher's decisions: the newest in full, the
 * others compacted (a samlingsverifikat carries one per bank line, up to
 * MAX_RECEIPTS_PER_SUBJECT), and how many there are in all.
 */
export interface BookingWhyDecisions {
  latest: ReceiptLike | null
  /** Newest first, the latest excluded, at most MAX_OTHER_DECISIONS. */
  others: OtherDecision[]
  /** Every decision that booked the voucher, the latest included. */
  total: number
}

export interface BookingWhyData {
  entry: BookingWhyEntry
  /** Null when the receipts could not be read: unknown, not "none". */
  decisions: BookingWhyDecisions | null
  people: Record<string, BookingWhyPerson>
}

export interface BookingWhyOptions {
  t: BookingWhyTranslate
  formatWhen: (iso: string) => string
  /** The brand name, for what the app booked by itself. */
  appName: string
}

export type EvidenceLevel = 'exact' | 'strong' | 'likely' | 'your_choice'

export type BookingWhyRowId = 'decision' | 'proposal' | 'reason' | 'grounds' | 'changes' | 'checks' | 'policy' | 'more'

export interface BookingWhyRow {
  id: BookingWhyRowId
  label: string
  value: string
  /** A list under the value (the other decisions, one line each). */
  items?: string[]
}

export interface BookingWhyView {
  /** Null for an entry that is not booked (a draft, a cancelled draft). */
  summary: { text: string; when: string | null } | null
  rows: BookingWhyRow[]
}

// ── Who, how, when ──────────────────────────────────────────────────

type Who =
  | { kind: 'person'; userId: string | null }
  | { kind: 'api_key'; label: string | null }
  | { kind: 'service_account'; label: string | null }
  | { kind: 'connected_ai'; label: string | null }
  | { kind: 'assistant' }
  | { kind: 'app' }

function text(v: unknown): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

function whoFromActor(actorType: string | null | undefined, label: string | null | undefined, userId: string | null | undefined, commitMethod?: string | null): Who {
  switch (actorType) {
    case 'user':
      return { kind: 'person', userId: userId ?? null }
    case 'api_key':
      return { kind: 'api_key', label: text(label) }
    case 'mcp_oauth':
      return { kind: 'connected_ai', label: text(label) }
    case 'service_account':
      return { kind: 'service_account', label: text(label) }
    case 'agent_chat':
      return { kind: 'assistant' }
    case 'cron':
    case 'system':
      return { kind: 'app' }
    default:
      // Entries committed before the actor columns existed: the same reading
      // behandlingshistoriken makes (an API-key commit method, else a person).
      return commitMethod === 'api_key' ? { kind: 'api_key', label: text(label) } : { kind: 'person', userId: userId ?? null }
  }
}

function isBooked(status: string | null): boolean {
  return status === 'posted' || status === 'reversed'
}

function isImported(entry: BookingWhyEntry): boolean {
  return entry.source_type === 'import' || entry.commit_method === 'migration'
}

/**
 * A voucher's receipts (newest first, as getDecisionReceipts returns them)
 * compacted to what the view renders. Dismissals book nothing and are left out.
 */
export function compactDecisions(receipts: ReceiptLike[]): BookingWhyDecisions {
  const booked = receipts.filter((r) => r.outcome !== 'dismissed')
  const [latest = null, ...rest] = booked
  return {
    latest,
    others: rest.slice(0, MAX_OTHER_DECISIONS).map((r) => ({
      decided_at: r.decided_at,
      decided_by: { actor_type: r.decided_by.actor_type, user_id: r.decided_by.user_id, label: r.decided_by.label },
      source: r.chosen?.source ?? null,
    })),
    total: booked.length,
  }
}

function personDecided(r: ReceiptLike): boolean {
  return r.decided_by.actor_type === 'user'
}

/** The agent that staged the decision, when a non-person proposed it. */
function agentProposer(r: ReceiptLike): Who | null {
  const p = r.proposed_by
  if (!p || p.actor_type === 'user') return null
  return whoFromActor(p.actor_type, p.label, p.actor_id)
}

function decider(entry: BookingWhyEntry, r: ReceiptLike | null): Who {
  if (r) return whoFromActor(r.decided_by.actor_type, r.decided_by.label, r.decided_by.user_id)
  return whoFromActor(entry.committed_actor_type, entry.committed_actor_label, entry.user_id, entry.commit_method)
}

/** The user ids a view of this entry names, for the caller to resolve to people. */
export function bookingWhyUserIds(entry: BookingWhyEntry, decisions: BookingWhyDecisions | null): string[] {
  const ids = new Set<string>()
  const who = decider(entry, decisions?.latest ?? null)
  if (who.kind === 'person' && who.userId) ids.add(who.userId)
  for (const d of decisions?.others ?? []) {
    const other = whoFromActor(d.decided_by.actor_type, d.decided_by.label, d.decided_by.user_id)
    if (other.kind === 'person' && other.userId) ids.add(other.userId)
  }
  return [...ids]
}

function renderWho(who: Who, data: BookingWhyData, o: BookingWhyOptions): string {
  switch (who.kind) {
    case 'person': {
      const person = who.userId ? data.people[who.userId] : undefined
      const name = text(person?.name)
      if (!name) return o.t('who_person_unknown')
      if (person?.byra) {
        const byra = text(person.byra_name)
        return byra ? o.t('who_byra_named', { name, byra }) : o.t('who_byra', { name })
      }
      return name
    }
    case 'api_key':
      return who.label ? o.t('who_api_key', { label: who.label }) : o.t('who_api_key_plain')
    case 'connected_ai':
      return who.label ? o.t('who_connected_ai', { label: who.label }) : o.t('who_connected_ai_plain')
    case 'service_account':
      return who.label ? o.t('who_service_account', { label: who.label }) : o.t('who_service_account_plain')
    case 'assistant':
      return o.t('who_assistant')
    case 'app':
      return o.appName
  }
}

type How = 'accepted' | 'changed' | 'manual' | 'approved' | 'imported' | 'booked'

function howOf(entry: BookingWhyEntry, r: ReceiptLike | null): How {
  if (isImported(entry)) return 'imported'
  if (!r) return 'booked'
  if (personDecided(r) && agentProposer(r)) return 'approved'
  if (r.outcome === 'accepted') return 'accepted'
  if (r.outcome === 'changed') return 'changed'
  // "By hand" is a person's: an API key booking without a suggestion is just booked.
  if (r.outcome === 'manual' && personDecided(r)) return 'manual'
  return 'booked'
}

function summaryText(how: How, who: Who, whoText: string, r: ReceiptLike | null, data: BookingWhyData, o: BookingWhyOptions): string {
  switch (how) {
    case 'accepted':
      return o.t('summary_accepted', { who: whoText })
    case 'changed':
      return o.t('summary_changed', { who: whoText })
    case 'manual':
      return o.t('summary_manual', { who: whoText })
    case 'approved':
      return o.t('summary_approved', { who: whoText, proposer: renderWho(agentProposer(r!)!, data, o) })
    case 'imported':
      // Who ran the import, when the entry names a person we could resolve.
      return who.kind === 'person' && who.userId && text(data.people[who.userId]?.name)
        ? o.t('summary_imported_by', { who: whoText })
        : o.t('summary_imported')
    case 'booked':
      return o.t('summary_booked', { who: whoText })
  }
}

// ── Grounds ─────────────────────────────────────────────────────────

const LIKELY_SOURCES = new Set<string>(['assistant', 'extraction', 'catalog', 'recent', 'clearing'])

/**
 * The grounds of a decision as an evidence level, from what the receipt
 * records, never from a confidence number:
 *   - your_choice: a person booked without a suggestion, or changed the one
 *     they started from;
 *   - strong: a rule matched (unless the recorded band says it needed a
 *     review), or the counterpart's history was settled (band 'direct');
 *   - likely: a reading or a guess (the assistant, a document reading, a
 *     catalog keyword, a template used lately, the till's record of money
 *     already booked on a clearing account), or a band of 'review';
 *   - exact: reserved for an exact match such as an OCR reference. No booking
 *     door records one as a suggestion yet, so nothing returns it today.
 * Null when the receipt cannot tell: an agent's own choice, or counterpart
 * history recorded before the band was (step 1 rows cannot tell settled from new).
 */
export function evidenceLevel(r: ReceiptLike): { level: EvidenceLevel; source: string | null } | null {
  if (r.outcome === 'manual' || r.outcome === 'changed') {
    return personDecided(r) && !agentProposer(r) ? { level: 'your_choice', source: null } : null
  }
  if (r.outcome !== 'accepted' || !r.chosen) return null
  const source = r.chosen.source
  const band = r.confidence_band
  if (LIKELY_SOURCES.has(source)) return { level: 'likely', source }
  if (source === 'rule') return { level: band === 'review' ? 'likely' : 'strong', source }
  if (source === 'counterparty_template') {
    if (band === 'direct') return { level: 'strong', source }
    if (band === 'review') return { level: 'likely', source }
    return null
  }
  return null
}

// ── Rows ────────────────────────────────────────────────────────────

const VIA_KEYS: Record<string, string> = {
  user_accept: 'via_app',
  bulk_accept: 'via_bulk',
  api_key: 'via_api',
  agent: 'via_assistant',
  migration: 'via_import',
}

const KNOWN_SOURCES = new Set<string>(['rule', 'counterparty_template', 'assistant', 'catalog', 'recent', 'extraction', 'clearing'])

/** InboxFields keys (inbox-classify.ts) a receipt can name as changed. */
const KNOWN_FIELDS = new Set<string>([
  'supplier_name',
  'supplier_org_number',
  'invoice_number',
  'invoice_date',
  'due_date',
  'payment_reference',
  'currency',
  'total',
  'vat_amount',
  'accounts',
])

/** The check ids step 2 records (suggestion-log/checks.ts on !463); any other id shows as recorded. */
const KNOWN_CHECKS = new Set<string>([
  'already_booked',
  'duplicate',
  'currency',
  'reverse_charge_seller_vat',
  'counter_legs',
  'bank_line_direction',
  'chart',
  'dimension_policy',
  'invoice_match',
  'period_lock',
  'document_reuse',
  'payee_alert',
  'representation_vat_cap',
])

function upperFirst(s: string): string {
  return s ? s.charAt(0).toLocaleUpperCase() + s.slice(1) : s
}

/** The name and revision of a version string: what precedes '+<program>' or ';<thresholds>'. */
function shortVersion(v: string): string {
  return v.split(/[+;]/)[0]
}

function viaText(who: Who, commitMethod: string | null | undefined, o: BookingWhyOptions): string | null {
  if (!commitMethod) return null
  // A connected AI commits under its minted key: say which door it came through.
  if (commitMethod === 'api_key' && who.kind === 'connected_ai') return o.t('via_mcp')
  const key = VIA_KEYS[commitMethod]
  return key ? o.t(key, { appName: o.appName }) : null
}

function proposalRow(r: ReceiptLike, data: BookingWhyData, o: BookingWhyOptions): string | null {
  const parts: string[] = []
  if (r.chosen && KNOWN_SOURCES.has(r.chosen.source)) {
    parts.push(o.t(`source_${r.chosen.source}`))
    const accounts = r.chosen.accounts.filter((a) => !!text(a))
    if (accounts.length > 0) parts.push(o.t('proposal_accounts', { accounts: accounts.join(', ') }))
  } else if (!r.chosen && r.candidates.length > 0) {
    parts.push(o.t('proposal_none_used', { count: r.candidates.length }))
  }
  const proposer = agentProposer(r)
  if (proposer) parts.push(o.t('proposal_from', { proposer: renderWho(proposer, data, o) }))
  const rules = text(r.rule_version)
  if (rules) parts.push(o.t('proposal_rule_version', { version: shortVersion(rules) }))
  return parts.length > 0 ? upperFirst(parts.join(' · ')) : null
}

function groundsRow(r: ReceiptLike, o: BookingWhyOptions): string | null {
  const grounds = evidenceLevel(r)
  if (!grounds) return null
  const level = o.t(`level_${grounds.level}`)
  return grounds.source && KNOWN_SOURCES.has(grounds.source) ? `${level} · ${o.t(`basis_${grounds.source}`)}` : level
}

function changesRow(r: ReceiptLike, o: BookingWhyOptions): string | null {
  const parts: string[] = []
  const fields = r.booked?.changed_fields ?? []
  for (const f of fields) parts.push(KNOWN_FIELDS.has(f) ? o.t(`field_${f}`) : f)
  if (r.outcome === 'changed' && r.chosen && r.booked) {
    const from = text(r.chosen.accounts[0])
    const to = text(r.booked.account)
    if (from && to && from !== to && r.chosen.accounts.length === 1) parts.push(o.t('changes_account', { from, to }))
    const vatFrom = text(r.chosen.vat_treatment)
    const vatTo = text(r.booked.vat_treatment)
    if (vatFrom && vatTo && vatFrom !== vatTo) parts.push(o.t('changes_vat'))
  }
  return parts.length > 0 ? upperFirst(parts.join(', ')) : null
}

function checksRow(r: ReceiptLike, o: BookingWhyOptions): string | null {
  if (!Array.isArray(r.checks) || r.checks.length === 0) return null
  const names = r.checks
    .filter((c) => !!text(c?.id))
    .map((c) => {
      const name = KNOWN_CHECKS.has(c.id) ? o.t(`check_${c.id}`) : c.id
      if (c.result === 'warn') return o.t('check_warned', { name })
      if (c.result === 'fail') return o.t('check_failed', { name })
      return name
    })
  return names.length > 0 ? names.join(', ') : null
}

function moreRow(d: BookingWhyDecisions, data: BookingWhyData, o: BookingWhyOptions): BookingWhyRow | null {
  if (d.total <= 1) return null
  const items = d.others.map((x) => {
    const who = renderWho(whoFromActor(x.decided_by.actor_type, x.decided_by.label, x.decided_by.user_id), data, o)
    const source = x.source && KNOWN_SOURCES.has(x.source) ? o.t(`source_${x.source}`) : null
    return upperFirst([o.formatWhen(x.decided_at), who, source].filter(Boolean).join(' · '))
  })
  // The latest is described above; what the list leaves out is counted.
  const rest = d.total - 1 - d.others.length
  if (rest > 0) items.push(o.t('more_rest', { count: rest }))
  return { id: 'more', label: o.t('row_more'), value: o.t('more_value', { count: d.total }), items }
}

function policyRow(r: ReceiptLike, o: BookingWhyOptions): string | null {
  const band = r.confidence_band
  if (band !== 'direct' && band !== 'review') return null
  const verdict = o.t(band === 'direct' ? 'policy_direct' : 'policy_review')
  const version = text(r.policy_version)
  return version ? `${verdict} · ${shortVersion(version)}` : verdict
}

/** The summary line and the detail rows for one verifikat. */
export function bookingWhy(data: BookingWhyData, o: BookingWhyOptions): BookingWhyView {
  const { entry } = data
  if (!isBooked(entry.status)) return { summary: null, rows: [] }

  const r = data.decisions?.latest ?? null
  const who = decider(entry, r)
  const whoText = renderWho(who, data, o)
  const how = howOf(entry, r)
  const at = r?.decided_at ?? entry.committed_at
  const when = at ? o.formatWhen(at) : null

  const rows: BookingWhyRow[] = []
  const push = (id: BookingWhyRowId, value: string | null) => {
    if (value) rows.push({ id, label: o.t(`row_${id}`), value })
  }

  push('decision', upperFirst([whoText, viaText(who, r?.decided_by.commit_method ?? entry.commit_method, o), when].filter(Boolean).join(' · ')))
  if (r) {
    push('proposal', proposalRow(r, data, o))
    // The agent's own words, as recorded: shown as given, never paraphrased.
    push('reason', text(r.agent_reason))
    push('grounds', groundsRow(r, o))
    push('changes', changesRow(r, o))
    push('checks', checksRow(r, o))
    push('policy', policyRow(r, o))
    const more = data.decisions ? moreRow(data.decisions, data, o) : null
    if (more) rows.push(more)
  }

  return { summary: { text: upperFirst(summaryText(how, who, whoText, r, data, o)), when }, rows }
}
