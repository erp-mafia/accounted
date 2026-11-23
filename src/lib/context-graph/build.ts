/**
 * The context graph's model, read off the briefing itself.
 *
 * Input is the answer of gnubok_get_agent_briefing as the wiki's context
 * view already loads it (GET /api/wiki/context sends its text): the same
 * source as the sections under the picture, so the two cannot disagree.
 * Nothing is fetched here and nothing is written. Pure: no IO, no clock, no
 * randomness.
 *
 * It is a web, not a star. The agent sits in the middle, and things link to
 * what they are about: a counterparty to its account, a remembered fact to
 * the counterparty, account or connection its text names, a check to the
 * account it checks, a deadline to Skatteverket or the bank, a skill to the
 * facts and accounts it governs. Links are found by plain matching on names,
 * account numbers and a few words; nothing is inferred by a model.
 *
 * Caps keep the picture readable (GRAPH_CAPS). Each kind shows its first N
 * as the briefing orders them (counterparties: the most used in twelve
 * months first); the rest collapse into one "+N" dot per kind, the chips
 * keep the full counts, and every thing stays in the lists under the graph.
 *
 * The briefing carries open questions for a company with the question list
 * switched on (2026-11); it does not carry deadlines or permissions today.
 * The keys `deadlines` and `permissions` are read in the prototype's shape so
 * the dots appear the day it does; until then the waiting family holds the
 * checks that differ, the open suggestions and the open questions.
 */
import type { ChipFamily, ContextGraphModel, GraphEdge, GraphFamily, GraphNode, GraphNodeKind } from './types'

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const objects = (v: unknown): Json[] => arr(v).filter(isObject)

/** How many dots of each kind the picture draws before the rest become one "+N" dot. */
export const GRAPH_CAPS = {
  facts: 12,
  groupFacts: 6,
  counterparties: 12,
  checks: 4,
  suggestions: 4,
  deadlines: 6,
  questions: 4,
  skills: 8,
} as const

export type GraphCaps = { readonly [K in keyof typeof GRAPH_CAPS]: number }

/** The longest name drawn under a dot; a longer one is cut at a word. */
const LABEL_MAX = 24

/** A short name for a sentence: its first words, cut at a word boundary. */
export function shortLabel(text: string, max: number = LABEL_MAX): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  const cut = clean.slice(0, max + 1)
  const at = cut.lastIndexOf(' ')
  return `${(at > 8 ? cut.slice(0, at) : clean.slice(0, max)).replace(/[.,:;!?]+$/, '')}…`
}

const COMPANY_SUFFIX = /\s+(sverige\s+ab|sweden\s+ab|aktiebolag|ab|hb|kb|inc\.?|ltd\.?|gmbh|oy|as|aps)$/i

/** A counterparty's name as people say it: without the company form. */
export function plainName(name: string): string {
  return name.replace(COMPANY_SUFFIX, '').trim() || name
}

/** First words too common to say which counterparty a text is about. */
const VAGUE_FIRST_WORDS = new Set(['svenska', 'sverige', 'sveriges', 'nordic', 'nordiska', 'stockholm', 'stockholms', 'international', 'global'])

/** Whether a text names a counterparty: its plain name, or its first word when that is distinctive. */
function names(text: string, counterparty: string): boolean {
  const hay = text.toLowerCase()
  const plain = plainName(counterparty).toLowerCase()
  if (plain.length >= 4 && hay.includes(plain)) return true
  const first = plain.split(/\s+/)[0] ?? ''
  return first.length >= 5 && !VAGUE_FIRST_WORDS.has(first) && hay.includes(first)
}

/** An account number as any chart writes it: digits only. The briefing sends the company's own. */
const ACCOUNT = /^\d{3,8}$/

function mentionsAccount(text: string, account: string): boolean {
  return new RegExp(`(^|[^0-9])${account}([^0-9]|$)`).test(text)
}

interface Pattern {
  name: string
  account: string | null
  agree: number | null
  seen: number | null
  lastBooked: string | null
  vatTreatment: string | null
}

function readPatterns(ledger: unknown): Pattern[] {
  if (!isObject(ledger)) return []
  const one = (p: Json, nameKey: string): Pattern | null => {
    const name = str(p[nameKey])
    if (!name) return null
    const ev = isObject(p.evidence) ? p.evidence : {}
    return {
      name,
      account: str(p.dominant_account_number),
      agree: num(ev.agree),
      seen: num(ev.seen_12m),
      lastBooked: str(ev.last_booked),
      vatTreatment: str(p.vat_treatment),
    }
  }
  const all = [
    ...objects(ledger.top_supplier_patterns).map((p) => one(p, 'supplier')),
    ...objects(ledger.top_counterparty_patterns).map((p) => one(p, 'counterparty')),
  ].filter((p): p is Pattern => p !== null)
  // The same name can sit in both lists: keep the one seen most.
  const byName = new Map<string, Pattern>()
  for (const p of all) {
    const key = p.name.toLowerCase()
    const had = byName.get(key)
    if (!had || (p.seen ?? 0) > (had.seen ?? 0)) byName.set(key, p)
  }
  // Most used first; the briefing's own order settles a tie (the sort is stable).
  return [...byName.values()].sort((a, b) => (b.seen ?? 0) - (a.seen ?? 0))
}

/** Build the graph of a briefing (the tool's output, as returned). */
export function buildContextGraph(briefing: Json, caps: GraphCaps = GRAPH_CAPS): ContextGraphModel {
  const nodes = new Map<string, GraphNode>()
  const edges: GraphEdge[] = []
  const linked = new Set<string>()
  const counts: Record<ChipFamily, number> = { taught: 0, read: 0, wait: 0, instructions: 0 }
  let hidden = 0

  const add = (node: GraphNode): string => {
    if (!nodes.has(node.id)) nodes.set(node.id, node)
    return node.id
  }
  const link = (a: string | null | undefined, b: string | null | undefined) => {
    if (!a || !b || a === b || !nodes.has(a) || !nodes.has(b)) return
    const key = a < b ? `${a}|${b}` : `${b}|${a}`
    if (linked.has(key)) return
    linked.add(key)
    edges.push([a, b])
  }
  /** Draw the first `cap` of a kind and fold the rest into one "+N" dot linked to `anchor`. */
  const capped = <T>(list: T[], cap: number, family: ChipFamily, moreOf: GraphNodeKind, anchor: string, draw: (item: T, i: number) => void) => {
    counts[family] += list.length
    list.slice(0, cap).forEach(draw)
    const rest = list.length - cap
    if (rest > 0) {
      hidden += rest
      link(anchor, add({ id: `more:${moreOf}`, family, kind: 'more', label: null, text: null, count: rest, moreOf }))
    }
  }
  const single = (family: ChipFamily, node: Omit<GraphNode, 'family'>): string => {
    counts[family] += 1
    return add({ ...node, family })
  }

  add({ id: 'agent', family: 'agent', kind: 'agent', label: null, text: null })

  // --- Instructions first: other things link to the skills. ---
  const skillIds: { id: string; atom: string }[] = []
  capped(objects(briefing.atoms).filter((a) => str(a.title)), caps.skills, 'instructions', 'skill', 'agent', (a, i) => {
    const atom = str(a.atom_id) ?? str(a.id) ?? `atom-${i}`
    const id = add({ id: `skill:${atom}`, family: 'instructions', kind: 'skill', label: shortLabel(str(a.title)!), text: str(a.title), detail: str(a.description), atomId: atom })
    skillIds.push({ id, atom })
    link('agent', id)
  })
  const skill = (part: string): string | null => skillIds.find((s) => s.atom.includes(part))?.id ?? null
  const vatSkill = skill('vat')
  const booksSkill = skill('accounting-compliance')
  const payrollSkill = skill('payroll')

  const workflows = objects(briefing.recommended_tools).length
  if (workflows > 0) link('agent', single('instructions', { id: 'workflows', kind: 'workflows', label: null, text: null, count: workflows }))

  const permissions = isObject(briefing.permissions) ? briefing.permissions : null
  if (permissions) {
    link('agent', single('instructions', { id: 'permissions', kind: 'permissions', label: null, text: null, count: arr(permissions.areas).length || null }))
  }

  // --- What Accounted reads: the company, its connections, counterparties and their accounts. ---
  const bolaget = isObject(briefing.bolaget) ? briefing.bolaget : null
  if (bolaget) {
    const owners = objects(bolaget.owners)
      .map((o) => [str(o.name), num(o.capital_pct) !== null ? `${num(o.capital_pct)} %` : null].filter(Boolean).join(' '))
      .filter(Boolean)
    const board = objects(bolaget.board)
      .map((b) => str(b.name))
      .filter(Boolean)
    if (owners.length > 0 || board.length > 0) {
      link('agent', single('read', { id: 'owners', kind: 'owners', label: null, text: owners.join(', ') || null, detail: board.join(', ') || null }))
      link('owners', 'permissions')
    }
  }
  // The archive's counts arrive under `arkiv`, or inside `bolaget` in the prototype's shape.
  const archive = isObject(briefing.arkiv) ? briefing.arkiv : bolaget && isObject(bolaget.archive) ? bolaget.archive : null
  if (archive && (num(archive.documents) !== null || num(archive.agreements) !== null)) {
    link('agent', single('read', { id: 'archive', kind: 'archive', label: null, text: null, count: num(archive.documents), count2: num(archive.agreements) }))
  }

  const bankSynced = isObject(briefing.data_status) ? str(briefing.data_status.bank_last_synced_at) : null
  if (bankSynced) link('agent', single('read', { id: 'bank', kind: 'bank', label: null, text: null, date: bankSynced }))
  const skvStatus = isObject(briefing.skatteverket_connection) ? str(briefing.skatteverket_connection.status) : null
  if (skvStatus) link('agent', single('read', { id: 'skatteverket', kind: 'skatteverket', label: null, text: null, status: skvStatus }))
  link(vatSkill, 'skatteverket')
  const inbox = isObject(briefing.inbox) ? str(briefing.inbox.address) : null
  if (inbox) {
    link('agent', single('read', { id: 'inbox', kind: 'inbox', label: null, text: inbox }))
    link('inbox', 'archive')
  }

  const account = (number: string | null): string | null => {
    if (!number || !ACCOUNT.test(number)) return null
    const id = add({ id: `account:${number}`, family: 'ref', kind: 'account', label: number, text: null, account: number })
    // The accounts hang on the bookkeeping skill when the agent has it, else on the agent itself.
    link(id, booksSkill ?? 'agent')
    return id
  }

  const counterparties: { id: string; name: string }[] = []
  capped(readPatterns(briefing.ledger_context), caps.counterparties, 'read', 'counterparty', booksSkill ?? 'agent', (p, i) => {
    const id = add({
      id: `counterparty:${i}`,
      family: 'read',
      kind: 'counterparty',
      label: shortLabel(plainName(p.name)),
      text: p.name,
      account: p.account,
      evidence: p.agree !== null && p.seen !== null ? { agree: p.agree, seen: p.seen } : null,
      date: p.lastBooked,
      vatTreatment: p.vatTreatment,
    })
    counterparties.push({ id, name: p.name })
    const acct = account(p.account)
    // A counterparty with no account to hang on still belongs to the web.
    link(id, acct ?? booksSkill ?? 'agent')
    if (p.vatTreatment) link(id, vatSkill)
  })

  /** Link a thing to everything its text is about. */
  const about = (id: string, text: string) => {
    for (const c of counterparties) if (names(text, c.name)) link(id, c.id)
    for (const n of nodes.values()) if (n.kind === 'account' && n.account && mentionsAccount(text, n.account)) link(id, n.id)
    if (/\bbank|\bswish|\bkort(et|betalning)?\b/i.test(text)) link(id, 'bank')
    if (/skatteverket|skattekonto/i.test(text)) link(id, 'skatteverket')
    if (/moms/i.test(text)) link(id, vatSkill)
    if (/\blön|förmån|semester/i.test(text)) link(id, payrollSkill)
    if (/kvitto|underlag|avtal/i.test(text)) link(id, 'archive')
  }

  // --- The waiting family: checks that differ, open suggestions, deadlines, the agent's own questions. ---
  const unexplained = isObject(briefing.unexplained) ? briefing.unexplained : null
  capped(objects(unexplained?.top).filter((r) => str(r.name_sv)), caps.checks, 'wait', 'check', 'agent', (r, i) => {
    const name = str(r.name_sv)!
    const subject = str(r.subject)
    const id = add({
      id: `check:${i}`,
      family: 'wait',
      kind: 'check',
      label: shortLabel(name),
      text: name,
      account: subject && ACCOUNT.test(subject) ? subject : null,
      date: str(unexplained?.as_of),
      result: { difference: num(r.difference), unit: str(r.unit) ?? 'SEK' },
    })
    link('agent', id)
    link(id, account(subject))
    if (/bank/i.test(`${str(r.check_id) ?? ''} ${name}`)) link(id, 'bank')
    if (/moms|vat|skatt/i.test(`${str(r.check_id) ?? ''} ${name}`)) link(id, 'skatteverket')
  })

  capped(objects(briefing.suggestions).filter((s) => str(s.title)), caps.suggestions, 'wait', 'suggestion', 'agent', (s, i) => {
    const title = str(s.title)!
    const id = add({ id: `suggestion:${i}`, family: 'wait', kind: 'suggestion', label: shortLabel(title), text: title, detail: str(s.reason) })
    link('agent', id)
    link(id, 'workflows')
    about(id, title)
  })

  capped(objects(briefing.deadlines).filter((d) => str(d.what)), caps.deadlines, 'wait', 'deadline', 'agent', (d, i) => {
    const what = str(d.what)!
    const id = add({ id: `deadline:${i}`, family: 'wait', kind: 'deadline', label: shortLabel(what), text: what, detail: str(d.state), date: str(d.due), amount: num(d.amount) })
    link('agent', id)
    about(id, what)
    if (/skatt|moms|deklaration/i.test(what)) link(id, 'skatteverket')
    if (/^betala/i.test(what)) link(id, 'bank')
  })

  capped(objects(briefing.open_questions).filter((q) => str(q.question)), caps.questions, 'wait', 'question', 'agent', (q, i) => {
    const question = str(q.question)!
    const subject = str(q.about) ?? str(q.why)
    const id = add({ id: `question:${i}`, family: 'wait', kind: 'question', label: shortLabel(question), text: question, detail: subject, date: str(q.asked_at) })
    link('agent', id)
    about(id, `${question} ${subject ?? ''}`)
  })

  // --- What people and agents taught it. ---
  const fact = (raw: Json, scope: 'fact' | 'group_fact'): string | null => {
    const content = str(raw.content)
    const factId = str(raw.fact_id) ?? str(raw.id)
    if (!content || !factId) return null
    const id = add({
      id: `${scope}:${factId}`,
      family: 'taught',
      kind: scope,
      label: shortLabel(content),
      text: content,
      date: str(raw.saved_at),
      factKind: str(raw.kind) ?? 'fact',
      savedBy: str(raw.created_by),
      client: str(raw.client),
    })
    link('agent', id)
    about(id, content)
    return id
  }
  const valid = (list: unknown) => objects(list).filter((f) => str(f.content) && (str(f.fact_id) ?? str(f.id)))
  capped(valid(briefing.memory), caps.facts, 'taught', 'fact', 'agent', (f) => {
    const id = fact(f, 'fact')
    if (id && /\d[\d\s]*kr|belopp|gräns/i.test(str(f.content) ?? '')) link(id, 'permissions')
  })

  const group = isObject(briefing.group_memory) ? briefing.group_memory : null
  const groupFacts = valid(group?.facts)
  if (group && groupFacts.length > 0) {
    const groupName = str(group.group_name)
    if (groupName) add({ id: 'group', family: 'ref', kind: 'group', label: shortLabel(groupName), text: groupName })
    capped(groupFacts, caps.groupFacts, 'taught', 'group_fact', nodes.has('group') ? 'group' : 'agent', (f) => link('group', fact(f, 'group_fact')))
  }

  const list = [...nodes.values()]
  return { nodes: list, edges, counts, hidden, empty: list.length <= 1 }
}

/** The chip family a dot answers to; null for the agent and the neutral dots. */
export function chipFamily(family: GraphFamily): ChipFamily | null {
  return family === 'agent' || family === 'ref' ? null : family
}

/** The briefing back from the text the context view holds; null when it is not a JSON object. */
export function parseBriefingText(text: string): Json | null {
  try {
    const parsed: unknown = JSON.parse(text)
    return isObject(parsed) ? parsed : null
  } catch {
    // Safe to ignore: text that is not JSON has no graph to draw, and the page shows the text itself below.
    return null
  }
}
