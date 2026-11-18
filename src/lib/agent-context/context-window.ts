/**
 * The agent's context window, read off the briefing itself.
 *
 * The wiki's context view shows what an agent receives when it opens the
 * company. It never rebuilds that from its own reads: the server runs the
 * real briefing tool (gnubok_get_agent_briefing, through the core agent tool
 * registry) and this module only describes its output, key by key. A key the
 * briefing gains later (group facts, a new digest) is never hidden: a key
 * this module does not know lands in "other" with its name and size, so the
 * page cannot drift from what the agent reads.
 *
 * Sizes are characters of the text the agent reads (the MCP text block is
 * the result as JSON with two-space indentation). The one budget the
 * briefing has is the remembered facts' (REMEMBERED_FACTS_CHAR_BUDGET), so
 * the view names that one and no other.
 *
 * Pure: no IO. The route runs it on the server and sends the description and
 * the raw text.
 */

/** The parts of the window, in the order the page draws them. */
export const CONTEXT_SECTION_IDS = ['group', 'memory', 'company', 'patterns', 'books', 'instructions', 'other'] as const
export type ContextSectionId = (typeof CONTEXT_SECTION_IDS)[number]

/**
 * Who stands behind a part: what people and agents taught it (taught), what
 * Accounted reads from the books and registers (read), and how the agent is
 * told to work (instructions). The bar colours a part by its family.
 */
export type ContextFamily = 'taught' | 'read' | 'instructions'

export const SECTION_FAMILY: Record<ContextSectionId, ContextFamily> = {
  group: 'taught',
  memory: 'taught',
  company: 'read',
  patterns: 'read',
  books: 'read',
  instructions: 'instructions',
  other: 'instructions',
}

/** Which part each briefing key belongs to. A key missing here goes to "other". */
const KEY_SECTION: Readonly<Record<string, ContextSectionId>> = {
  // Facts saved for the company's group (group_memory).
  group_memory: 'group',
  memory: 'memory',
  memory_truncated: 'memory',
  memory_sync: 'memory',
  company: 'company',
  user_name: 'company',
  profile_summary: 'company',
  bolaget: 'company',
  arkiv: 'company',
  dimensions: 'company',
  ledger_context: 'patterns',
  unexplained: 'books',
  suggestions: 'books',
  suggestions_how: 'books',
  grants: 'books',
  data_status: 'books',
  skatteverket_connection: 'books',
  inbox: 'books',
  capabilities: 'books',
  capabilities_profile: 'books',
  measures: 'books',
  atoms: 'instructions',
  recommended_tools: 'instructions',
  bridge_note: 'instructions',
  where_to_find: 'instructions',
  feedback_channel: 'instructions',
}

/** Where a line comes from, strongest first in the page's legend. */
export type ContextSource =
  | 'settings'
  | 'register'
  | 'archive'
  | 'ledger'
  | 'checks'
  | 'connections'
  | 'profile'
  | 'memory'
  | 'accounted'

/** The labelled values the page names in words (sv and en under wiki.values). */
export type ContextValueLabel =
  | 'company_name'
  | 'org_number'
  | 'entity_type'
  | 'accounting_method'
  | 'user_name'
  | 'owners'
  | 'board'
  | 'ceo'
  | 'signatory_rule'
  | 'archive_documents'
  | 'archive_agreements'
  | 'dimensions'
  | 'unexplained'
  | 'cannot_check'
  | 'suggestions'
  | 'grants_posted'
  | 'bank_synced'
  | 'skatteverket'
  | 'inbox_address'
  | 'packages_off'
  | 'measures'
  | 'workflows'
  | 'where_to_find'
  | 'feedback'
  | 'memory_truncated'

/** A remembered fact, as the briefing lists it (company memory or the group's). */
export interface ContextFactItem {
  type: 'fact'
  fact_id: string
  scope: 'company' | 'group'
  kind: string
  content: string
  saved_at: string | null
  /** conversation, session_sync or onboarding_import; null for in-app and older rows. */
  origin: string | null
  /** The MCP client label of the connection that saved it; null outside MCP. */
  client: string | null
  /** Who saved it, by name, once the briefing carries it. */
  created_by: string | null
  created_by_deleted: boolean
}

/** One labelled value: "Bokföringsmetod: faktureringsmetoden". */
export interface ContextValueItem {
  type: 'value'
  label: ContextValueLabel
  value: string
  source: ContextSource
  date: string | null
}

/** One line of the briefing's own text: a pattern, a skill, a check result. */
export interface ContextTextItem {
  type: 'text'
  text: string
  detail: string | null
  source: ContextSource
  date: string | null
  /** A pattern's evidence: booked this way `agree` times of `seen` in twelve months. */
  evidence?: { agree: number; seen: number }
  /** A supplier pattern's VAT treatment code (the page shows its Swedish name). */
  vat_treatment?: string | null
  /** A check's result as the agent gets it: the difference in kr or a count; null when the check gave none. */
  result?: { difference: number | null; unit: string }
}

/** A briefing key with no line of its own: shown by name and size. */
export interface ContextKeyItem {
  type: 'key'
  key: string
  chars: number
}

export type ContextItem = ContextFactItem | ContextValueItem | ContextTextItem | ContextKeyItem

export interface ContextSection {
  id: ContextSectionId
  family: ContextFamily
  /** Characters of this part's keys in the text the agent reads (field names and ids included). */
  chars: number
  /** Of those, the fact text itself: what the remembered-facts budget counts. 0 for a part without facts. */
  fact_chars: number
  /** The briefing keys this part holds, in briefing order. */
  keys: string[]
  items: ContextItem[]
}

export interface ContextScope {
  company: { company_id: string; name: string | null; org_number: string | null }
  /** The company's group, when the briefing carries group facts. */
  group: { name: string; kind: string | null } | null
}

export interface ContextWindow {
  scope: ContextScope
  /** Characters of the whole text the agent reads. */
  total_chars: number
  /**
   * The remembered facts against their budget, counted as the budget counts
   * (loadRememberedFacts: the characters of each fact's text, nothing else).
   * Company and group facts share it.
   */
  memory_budget: { used: number; budget: number; truncated: boolean }
  /** The non-empty parts, in CONTEXT_SECTION_IDS order. */
  sections: ContextSection[]
}

type Json = Record<string, unknown>

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])

/** The text the agent reads for a tool result: JSON with two-space indentation (the MCP text block). */
export function briefingText(briefing: Json): string {
  return JSON.stringify(briefing, null, 2)
}

function keyChars(key: string, value: unknown): number {
  // The key's own lines inside the object, as they sit in the text block.
  return JSON.stringify({ [key]: value }, null, 2).length - 4
}

function factItems(list: unknown, scope: 'company' | 'group'): ContextFactItem[] {
  const out: ContextFactItem[] = []
  for (const raw of arr(list)) {
    if (!isObject(raw)) continue
    const content = str(raw.content)
    const factId = str(raw.fact_id) ?? str(raw.id)
    if (!content || !factId) continue
    out.push({
      type: 'fact',
      fact_id: factId,
      scope,
      kind: str(raw.kind) ?? 'fact',
      content,
      saved_at: str(raw.saved_at),
      origin: str(raw.origin),
      client: str(raw.client),
      created_by: str(raw.created_by),
      created_by_deleted: raw.created_by_deleted === true,
    })
  }
  return out
}

function value(label: ContextValueLabel, v: string | number | null, source: ContextSource, date: string | null = null): ContextValueItem[] {
  if (v === null || v === '') return []
  return [{ type: 'value', label, value: String(v), source, date }]
}

function text(t: string | null, source: ContextSource, detail: string | null = null, date: string | null = null): ContextTextItem[] {
  return t ? [{ type: 'text', text: t, detail, source, date }] : []
}

function pattern(t: string | null, evidence: unknown, vatTreatment: string | null = null): ContextTextItem[] {
  const ev = isObject(evidence) ? evidence : {}
  const agree = num(ev.agree)
  const seen = num(ev.seen_12m)
  return text(t, 'ledger', null, str(ev.last_booked)).map((item) => ({
    ...item,
    ...(agree !== null && seen !== null ? { evidence: { agree, seen } } : {}),
    ...(vatTreatment ? { vat_treatment: vatTreatment } : {}),
  }))
}

/** The lines one briefing key contributes; [] when the key is known but empty. */
function itemsFor(key: string, v: unknown): ContextItem[] | null {
  switch (key) {
    case 'group_memory':
      return isObject(v) ? factItems(v.facts, 'group') : []
    case 'memory':
      return factItems(v, 'company')
    case 'memory_truncated':
      return v === true ? value('memory_truncated', 'true', 'accounted') : []
    case 'memory_sync':
    case 'suggestions_how':
    case 'bridge_note':
      // Instructions to the agent; their size is counted, the text is in the raw view.
      return []
    case 'company': {
      if (!isObject(v)) return []
      return [
        ...value('company_name', str(v.name), 'settings'),
        ...value('org_number', str(v.org_number), 'settings'),
        ...value('entity_type', str(v.entity_type), 'settings'),
        ...value('accounting_method', str(v.accounting_method), 'settings'),
      ]
    }
    case 'user_name':
      return value('user_name', str(v), 'settings')
    case 'profile_summary':
      return text(str(v), 'profile')
    case 'bolaget': {
      if (!isObject(v)) return []
      const owners = arr(v.owners).filter(isObject).map((o) => `${str(o.name) ?? ''} ${num(o.capital_pct) ?? ''} %`.trim())
      const board = arr(v.board).filter(isObject).map((b) => [str(b.name), str(b.role)].filter(Boolean).join(', '))
      return [
        ...value('owners', owners.length > 0 ? owners.join('; ') : null, 'register'),
        ...value('board', board.length > 0 ? board.join('; ') : null, 'register'),
        ...value('ceo', str(v.ceo), 'register'),
        ...value('signatory_rule', str(v.signatory_rule), 'register'),
      ]
    }
    case 'arkiv': {
      if (!isObject(v)) return []
      return [...value('archive_documents', num(v.documents), 'archive'), ...value('archive_agreements', num(v.agreements), 'archive')]
    }
    case 'dimensions': {
      if (!isObject(v)) return []
      const names = arr(v.dimensions).filter(isObject).map((d) => str(d.name)).filter((n): n is string => !!n)
      return value('dimensions', names.length > 0 ? names.join(', ') : null, 'ledger')
    }
    case 'ledger_context': {
      if (!isObject(v)) return []
      const counterparty = arr(v.top_counterparty_patterns)
        .filter(isObject)
        .flatMap((p) => pattern([str(p.counterparty), str(p.dominant_account_number)].filter(Boolean).join(' → '), p.evidence))
      const supplier = arr(v.top_supplier_patterns)
        .filter(isObject)
        .flatMap((p) => pattern([str(p.supplier), str(p.dominant_account_number)].filter(Boolean).join(' → '), p.evidence, str(p.vat_treatment)))
      return [...counterparty, ...supplier]
    }
    case 'unexplained': {
      if (!isObject(v)) return []
      const asOf = str(v.as_of)
      const top = arr(v.top)
        .filter(isObject)
        .flatMap((r) => text(str(r.name_sv), 'checks', str(r.subject), asOf).map((item) => ({ ...item, result: { difference: num(r.difference), unit: str(r.unit) ?? 'SEK' } })))
      return [...value('unexplained', num(v.unexplained), 'checks', asOf), ...value('cannot_check', num(v.cannot_check) || null, 'checks', asOf), ...top]
    }
    case 'suggestions':
      return [
        ...value('suggestions', arr(v).length || null, 'accounted'),
        ...arr(v).filter(isObject).flatMap((s) => text(str(s.title), 'accounted', str(s.reason))),
      ]
    case 'grants': {
      if (!isObject(v)) return []
      return value('grants_posted', arr(v.posted_since_review).length, 'ledger')
    }
    case 'data_status':
      return isObject(v) ? value('bank_synced', str(v.bank_last_synced_at), 'connections', str(v.bank_last_synced_at)) : []
    case 'skatteverket_connection':
      // status: active or needs_reconsent (the company's connection).
      return isObject(v) ? value('skatteverket', str(v.status), 'connections') : []
    case 'inbox':
      return isObject(v) ? value('inbox_address', str(v.address), 'connections') : []
    case 'capabilities_profile': {
      // The profile's own name ("Standard") says nothing to a person; the packages it leaves off do.
      if (!isObject(v)) return []
      const off = arr(v.packages_off).filter((p): p is string => typeof p === 'string')
      return value('packages_off', off.length > 0 ? off.join(',') : null, 'settings')
    }
    case 'capabilities':
      // The packages a company cannot use, as module ids: counted, listed in the raw view.
      return []
    case 'measures':
      // What the agent can do, never the tool's name: the page says it in words.
      return isObject(v) ? value('measures', 'available', 'accounted') : []
    case 'atoms':
      return arr(v).filter(isObject).flatMap((a) => text(str(a.title), 'accounted', str(a.description)))
    case 'recommended_tools':
      return value('workflows', arr(v).filter(isObject).length || null, 'accounted')
    case 'where_to_find':
      return value('where_to_find', arr(v).length || null, 'accounted')
    case 'feedback_channel':
      return isObject(v) ? value('feedback', 'available', 'accounted') : []
    default:
      return null
  }
}

/** Describe a briefing (the tool's output, as returned) as the parts of the agent's window. */
export function describeContextWindow(briefing: Json, memoryBudget: number): ContextWindow {
  const sections = new Map<ContextSectionId, ContextSection>()
  const section = (id: ContextSectionId): ContextSection => {
    let s = sections.get(id)
    if (!s) {
      s = { id, family: SECTION_FAMILY[id], chars: 0, fact_chars: 0, keys: [], items: [] }
      sections.set(id, s)
    }
    return s
  }

  for (const [key, v] of Object.entries(briefing)) {
    if (v === undefined) continue
    const chars = keyChars(key, v)
    const known = KEY_SECTION[key]
    const s = section(known ?? 'other')
    s.chars += chars
    s.keys.push(key)
    const items = known ? itemsFor(key, v) : null
    s.items.push(...(items ?? [{ type: 'key' as const, key, chars }]))
    s.fact_chars += (items ?? []).reduce((n, i) => n + (i.type === 'fact' ? i.content.length : 0), 0)
  }

  const company = isObject(briefing.company) ? briefing.company : {}
  const group = isObject(briefing.group_memory) ? briefing.group_memory : null
  return {
    scope: {
      company: {
        company_id: str(company.company_id) ?? str(company.id) ?? '',
        name: str(company.name),
        org_number: str(company.org_number),
      },
      group: group && str(group.group_name) ? { name: str(group.group_name)!, kind: str(group.group_kind) } : null,
    },
    total_chars: briefingText(briefing).length,
    memory_budget: {
      used: (sections.get('memory')?.fact_chars ?? 0) + (sections.get('group')?.fact_chars ?? 0),
      budget: memoryBudget,
      truncated: briefing.memory_truncated === true,
    },
    sections: CONTEXT_SECTION_IDS.flatMap((id) => {
      const s = sections.get(id)
      return s && s.keys.length > 0 ? [s] : []
    }),
  }
}

/**
 * The product name for a stored MCP client label (the vocabulary of the MCP
 * server's client-label.ts). null for a label it does not know: the page then
 * says "an AI connection".
 */
export function clientDisplayName(client: string | null): string | null {
  switch (client) {
    case 'claude-code':
      return 'Claude Code'
    case 'claude-desktop':
      return 'Claude Desktop'
    case 'claude-connector':
    case 'claude':
      return 'Claude'
    case 'chatgpt':
      return 'ChatGPT'
    case 'codex':
      return 'Codex'
    case 'cursor':
      return 'Cursor'
    case 'gemini':
      return 'Gemini'
    case 'grok':
      return 'Grok'
    default:
      return null
  }
}
