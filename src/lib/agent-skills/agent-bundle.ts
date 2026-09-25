import type { SupabaseClient } from '@supabase/supabase-js'
import type { AiClient } from '@/lib/onboarding/ai-clients'
import { AGENTS, AREAS, OWN_AGENT_KNOWLEDGE, CONNECTION_SETTINGS, isCheckable, type AgentConnection, type Area, type CheckableConnection } from './agents'
import { areasOf } from './areas'
import { REGISTRY_SKILLS, registrySkillSlug, type RegistrySkillId } from './registry'
import { toSummary } from './atoms'
import { workflowSkills } from './workflows'
import { kvittojaktenSkills } from './workflows/kvittojakten'
import { loadCompanySkillRows, ownSkill } from './company-skills'
import type { Skill } from './types'
import { buildArkivMap, type ArkivMap } from '@/lib/arkiv/map'

export type ConnectionStatus = 'connected' | 'missing' | 'in_ai' | 'unknown'

export interface AgentConnectionState {
  kind: AgentConnection
  status: ConnectionStatus
  /** Where to fix a missing Accounted connection. */
  settings_href?: string
}

export interface KnowledgeMeta {
  id: string
  tier: string
  /** `default`: the agent ships with it; `added`: the company chose it. */
  source: 'default' | 'added'
  title: string
  summary: string
  version: number | null
  reviewed_at: string | null
}

export interface AgentOverview {
  id: RegistrySkillId
  workflow: { slug: string; version: number | null }
  /** How many of the company facts this agent reads are known for the company. */
  facts_known: number
  knowledge: KnowledgeMeta[]
  references: Array<{ id: string; title: string }>
  company: Array<{ id: string; title: string; tier: 'vertical' | 'modifier' }>
  /** The company's pack sections tagged with this agent's areas: inlined when it starts. */
  industry_sections: IndustrySectionMeta[]
  connections: AgentConnectionState[]
  /** Defaults the company took away, so the page can offer them back. */
  removed: string[]
}

export interface AgentsOverview {
  agents: AgentOverview[]
  /** Confirmed company facts the agent sees in its briefing. */
  facts: number
  /** Running agreements read from the company's documents. */
  agreements: number
  /** What agents remember about the company (remember_fact). */
  remembered: number
  /** Documents an agent can search and read. */
  documents: number
  /** What the company chose for its own agents, keyed by own/<id>. */
  own_knowledge: Record<string, KnowledgeMeta[]>
  /** What an own agent the company has not adjusted carries (OWN_AGENT_KNOWLEDGE). */
  own_default: KnowledgeMeta[]
}

/** One section of an industry or company-form pack (a reference child atom). */
export interface IndustrySectionMeta {
  id: string
  title: string
  /** The pack it belongs to, e.g. vertical/konsult-it. */
  parent_id: string
}

interface AtomRow {
  id: string
  tier: string
  title: string | null
  description: string
  version: number | null
  reviewed_at: string | null
  is_active: boolean
  mcp_exposed: boolean
  parent_atom_id: string | null
  body?: string | null
}

const ATOM_META = 'id, tier, title, description, version, reviewed_at, is_active, mcp_exposed, parent_atom_id'

function workflowFor(id: RegistrySkillId, client: AiClient): Skill {
  const slug = registrySkillSlug(id, client)
  const skill = [...workflowSkills, ...kvittojaktenSkills].find((s) => s.slug === slug)
  if (!skill) throw new Error(`Agent ${id} has no workflow ${slug}`)
  return skill
}

function meta(row: AtomRow, source: KnowledgeMeta['source'] = 'default'): KnowledgeMeta {
  return { id: row.id, tier: row.tier, source, title: row.title ?? row.id, summary: toSummary(row.description, 160), version: row.version, reviewed_at: row.reviewed_at }
}

/** A company's changes to one agent's knowledge (company_agent_knowledge). */
interface KnowledgeChoice { added: string[]; removed: Set<string> }

async function loadKnowledgeChoices(supabase: SupabaseClient, companyId: string): Promise<Map<string, KnowledgeChoice>> {
  const { data, error } = await supabase.from('company_agent_knowledge').select('agent_id, atom_id, included, created_at')
    .eq('company_id', companyId).order('created_at', { ascending: true })
  if (error) throw new Error(`Failed to load agent knowledge choices: ${error.message}`)
  const choices = new Map<string, KnowledgeChoice>()
  for (const row of (data ?? []) as Array<{ agent_id: string; atom_id: string; included: boolean }>) {
    const choice = choices.get(row.agent_id) ?? { added: [], removed: new Set<string>() }
    if (row.included) choice.added.push(row.atom_id)
    else choice.removed.add(row.atom_id)
    choices.set(row.agent_id, choice)
  }
  return choices
}

/** A reference travels with its pack: "horizontal/swedish-vat/x" belongs to "horizontal/swedish-vat". */
function packOf(referenceId: string): string {
  return referenceId.split('/').slice(0, 2).join('/')
}

/** The knowledge an agent carries for this company: its defaults, minus what was taken away, plus what was added. */
export function effectiveKnowledge(defaults: readonly string[], choice: KnowledgeChoice | undefined): Array<{ id: string; source: KnowledgeMeta['source'] }> {
  const kept = defaults.filter((id) => !choice?.removed.has(id)).map((id) => ({ id, source: 'default' as const }))
  const added = (choice?.added ?? []).filter((id) => !defaults.includes(id)).map((id) => ({ id, source: 'added' as const }))
  return [...kept, ...added]
}

/** Live rows only: a withdrawn or unexposed atom never reaches an agent (the kill switch). */
async function loadAtoms(supabase: SupabaseClient, ids: string[], withBody: boolean): Promise<Map<string, AtomRow>> {
  if (ids.length === 0) return new Map()
  const { data, error } = await supabase.from('agent_atom_registry')
    .select(withBody ? `${ATOM_META}, body` : ATOM_META).in('id', ids)
  if (error) throw new Error(`Failed to load agent knowledge: ${error.message}`)
  const rows = (data ?? []) as unknown as AtomRow[]
  return new Map(rows.filter((row) => row.is_active && row.mcp_exposed).map((row) => [row.id, row]))
}

async function loadProfileAtoms(supabase: SupabaseClient, companyId: string): Promise<string[]> {
  const { data, error } = await supabase.from('agent_profiles').select('vertical_atoms, modifier_atoms').eq('company_id', companyId).maybeSingle()
  if (error) throw error
  return [...(data?.vertical_atoms ?? []), ...(data?.modifier_atoms ?? [])]
}

interface SectionRow extends AtomRow { areas: Area[] }

/**
 * The sections of the company's live packs tagged with any of `areas`, in
 * profile order. Untagged sections never match: they stay loadable on demand
 * through the pack's own reference list.
 */
async function loadIndustrySections(supabase: SupabaseClient, packIds: string[], areas: readonly Area[], withBody: boolean): Promise<SectionRow[]> {
  if (packIds.length === 0 || areas.length === 0) return []
  const { data, error } = await supabase.from('agent_atom_registry')
    .select(`${ATOM_META}, trigger_signals${withBody ? ', body' : ''}`).in('parent_atom_id', packIds).order('id', { ascending: true })
  if (error) throw new Error(`Failed to load industry sections: ${error.message}`)
  const order = new Map(packIds.map((id, i) => [id, i]))
  return ((data ?? []) as unknown as Array<AtomRow & { trigger_signals: unknown }>)
    .filter((row) => row.is_active && row.mcp_exposed && row.parent_atom_id && order.has(row.parent_atom_id))
    .map(({ trigger_signals, ...row }) => ({ ...row, areas: areasOf(trigger_signals) }))
    .filter((row) => row.areas.some((a) => areas.includes(a)))
    .sort((a, b) => order.get(a.parent_atom_id!)! - order.get(b.parent_atom_id!)!)
}

function sectionMeta(row: SectionRow): IndustrySectionMeta {
  return { id: row.id, title: row.title ?? row.id, parent_id: row.parent_atom_id! }
}

/** A reference file's frontmatter (areas, audience) routes it; the agent reads the text below it. */
function stripFrontmatter(body: string): string {
  return body.replace(/^---\n[\s\S]*?\n---\n+/, '')
}

/** A failed read says "unknown", never "missing": the page must not tell a connected user to connect. */
async function loadConnectionStates(supabase: SupabaseClient, companyId: string): Promise<Record<CheckableConnection, ConnectionStatus>> {
  const [bank, skv, peppol] = await Promise.all([
    supabase.from('bank_connections').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'active'),
    supabase.from('skatteverket_tokens').select('status').eq('company_id', companyId),
    supabase.from('peppol_access').select('status').eq('company_id', companyId).maybeSingle(),
  ])
  return {
    bank: bank.error ? 'unknown' : (bank.count ?? 0) > 0 ? 'connected' : 'missing',
    skatteverket: skv.error ? 'unknown' : (skv.data ?? []).some((row) => (row.status ?? 'active') === 'active') ? 'connected' : 'missing',
    peppol: peppol.error ? 'unknown' : peppol.data?.status === 'enabled' ? 'connected' : 'missing',
  }
}

function connectionsFor(id: RegistrySkillId, states: Record<CheckableConnection, ConnectionStatus>): AgentConnectionState[] {
  return AGENTS[id].connections.map((kind) => isCheckable(kind)
    ? { kind, status: states[kind], ...(states[kind] === 'missing' ? { settings_href: CONNECTION_SETTINGS[kind] } : {}) }
    : { kind, status: 'in_ai' as const })
}

function companyAtoms(atoms: Map<string, AtomRow>, profileIds: string[]): AgentOverview['company'] {
  return profileIds.flatMap((pid) => {
    const row = atoms.get(pid)
    return row && (row.tier === 'vertical' || row.tier === 'modifier') ? [{ id: row.id, title: row.title ?? row.id, tier: row.tier }] : []
  })
}

/** Every curated agent with its knowledge, the company's own atoms and connection states. No bodies. */
export async function loadAgentsOverview(supabase: SupabaseClient, companyId: string, client: AiClient = 'claude'): Promise<AgentsOverview> {
  const [profileIds, choices] = await Promise.all([loadProfileAtoms(supabase, companyId), loadKnowledgeChoices(supabase, companyId)])
  const chosen = [...choices.values()].flatMap((c) => c.added)
  const ids = [...new Set([...Object.values(AGENTS).flatMap((a) => [...a.knowledge, ...a.references]), ...profileIds, ...chosen])]
  const [atoms, states, facts, agreements, remembered, documents, sections] = await Promise.all([
    loadAtoms(supabase, ids, false),
    loadConnectionStates(supabase, companyId),
    supabase.from('company_facts').select('predicate').eq('company_id', companyId).eq('subject_kind', 'company').is('sys_to', null).neq('rank', 'deprecated').eq('status', 'confirmed').limit(500),
    supabase.from('agreements').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('status', 'active'),
    supabase.from('agent_memory').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('is_active', true),
    supabase.from('document_attachments').select('id', { count: 'exact', head: true }).eq('company_id', companyId).eq('admission_state', 'admitted'),
    // Every tagged section once; each agent keeps those in its areas below.
    loadIndustrySections(supabase, profileIds, AREAS, false),
  ])
  const company = companyAtoms(atoms, profileIds)
  const livePacks = new Set(company.map((c) => c.id))
  const sectionsFor = (areas: readonly Area[]) => sections
    .filter((s) => livePacks.has(s.parent_atom_id!) && s.areas.some((a) => areas.includes(a))).map(sectionMeta)
  const known = new Set(facts.error ? [] : ((facts.data ?? []) as Array<{ predicate: string }>).map((f) => f.predicate))
  const metas = (list: Array<{ id: string; source: KnowledgeMeta['source'] }>) =>
    list.flatMap(({ id, source }) => { const row = atoms.get(id); return row && !row.parent_atom_id ? [meta(row, source)] : [] })
  const own_knowledge = Object.fromEntries([...choices.entries()].filter(([agent]) => agent.startsWith('own/')).map(([agent, choice]) => [agent, metas(effectiveKnowledge(OWN_AGENT_KNOWLEDGE, choice))]))
  return {
    own_knowledge,
    own_default: metas(effectiveKnowledge(OWN_AGENT_KNOWLEDGE, undefined)),
    facts: known.size,
    agreements: agreements.error ? 0 : agreements.count ?? 0,
    remembered: remembered.error ? 0 : remembered.count ?? 0,
    documents: documents.error ? 0 : documents.count ?? 0,
    agents: REGISTRY_SKILLS.map(({ id }) => {
      const def = AGENTS[id]
      const workflow = workflowFor(id, client)
      return {
        id,
        workflow: { slug: workflow.slug, version: workflow.version ?? null },
        facts_known: def.facts.filter((f) => known.has(f)).length,
        knowledge: metas(effectiveKnowledge(def.knowledge, choices.get(id))),
        references: def.references
          .filter((r) => effectiveKnowledge(def.knowledge, choices.get(id)).some((k) => k.id === packOf(r)))
          .flatMap((r) => { const row = atoms.get(r); return row ? [{ id: row.id, title: row.title ?? row.id }] : [] }),
        company,
        industry_sections: sectionsFor(def.areas),
        connections: connectionsFor(id, states),
        removed: def.knowledge.filter((k) => choices.get(id)?.removed.has(k)),
      }
    }),
  }
}

/**
 * What we know about the company, cut to what this agent acts on. Registry and
 * ledger facts, the owner's documents (agreements) and what agents were told
 * (remembered) arrive inline; the archive itself stays one lookup away.
 */
export interface CompanyKnowledge {
  name: string | null
  org_number: string | null
  /** The onboarding text (agent_profiles.profile_summary): written once, addressed to the owner, may be outdated. */
  onboarding_summary: string | null
  facts: Array<{ label: string; value: string; valid_from: string | null }>
  agreements?: ArkivMap['agreements']
  remembered: string[]
  documents: { total: number; look_up: string[] }
}

export interface AgentBundle {
  agent: { id: string; name: string }
  workflow: { slug: string; version: number | null; body: string }
  knowledge: Array<KnowledgeMeta & { body: string }>
  /**
   * Er bransch, för det här arbetsflödet: the company's industry and
   * company-form sections tagged with this flow's areas, inlined after the
   * knowledge within the same budget. Empty for own agents.
   */
  industry_sections: Array<IndustrySectionMeta & { body: string }>
  references: Array<{ id: string; title: string }>
  company: AgentOverview['company']
  company_knowledge: CompanyKnowledge
  connections: AgentConnectionState[]
}

const REMEMBERED = 10

/** Own agents declare no facts: they get every company fact the map holds. */
async function loadCompanyKnowledge(supabase: SupabaseClient, companyId: string, def: { facts: readonly string[] | null; agreements: boolean }): Promise<CompanyKnowledge> {
  const [map, profile, memory] = await Promise.all([
    // The map is best-effort: an archive that cannot be read never blocks the agent.
    buildArkivMap(supabase, companyId).catch(() => null),
    supabase.from('agent_profiles').select('profile_summary').eq('company_id', companyId).maybeSingle(),
    supabase.from('agent_memory').select('content').eq('company_id', companyId).eq('is_active', true)
      .order('relevance_score', { ascending: false, nullsFirst: false }).limit(REMEMBERED),
  ])
  const order = def.facts ? new Map(def.facts.map((f, i) => [f, i])) : null
  const facts = (map?.company_facts ?? [])
    .filter((f) => !order || order.has(f.predicate))
    .sort((a, b) => order ? order.get(a.predicate)! - order.get(b.predicate)! : 0)
    .map(({ label, value, valid_from }) => ({ label, value, valid_from }))
  return {
    name: map?.company.name ?? null,
    org_number: map?.company.org_number ?? null,
    onboarding_summary: profile.error ? null : profile.data?.profile_summary ?? null,
    facts,
    ...(def.agreements ? { agreements: map?.agreements ?? [] } : {}),
    remembered: memory.error ? [] : ((memory.data ?? []) as Array<{ content: string }>).map((m) => m.content),
    documents: { total: map?.documents.total ?? 0, look_up: map?.how_to ?? [] },
  }
}

export { isAgentId } from './agents'
import { isAgentId } from './agents'

/**
 * Knowledge bodies inlined per run, shared by the knowledge and then the
 * company's industry sections; what does not fit is listed to load on demand.
 */
const INLINE_BUDGET = 60_000

function splitByBudget(rows: AtomRow[], list: Array<{ id: string; source: KnowledgeMeta['source'] }>) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const inline: Array<KnowledgeMeta & { body: string }> = []
  const overflow: Array<{ id: string; title: string }> = []
  let used = 0
  for (const { id, source } of list) {
    const row = byId.get(id)
    if (!row?.body || row.parent_atom_id) continue
    if (used + row.body.length <= INLINE_BUDGET) {
      inline.push({ ...meta(row, source), body: row.body })
      used += row.body.length
    } else overflow.push({ id: row.id, title: row.title ?? row.id })
  }
  return { inline, overflow, used }
}

/** The sections that fit what the knowledge left of the budget; the rest become references. */
function splitSections(rows: SectionRow[], used: number) {
  const inline: AgentBundle['industry_sections'] = []
  const overflow: Array<{ id: string; title: string }> = []
  for (const row of rows) {
    const body = stripFrontmatter(row.body ?? '')
    if (!body) continue
    if (used + body.length <= INLINE_BUDGET) {
      inline.push({ ...sectionMeta(row), body })
      used += body.length
    } else overflow.push({ id: row.id, title: row.title ?? row.id })
  }
  return { inline, overflow }
}

/**
 * One agent, ready to run: the instruction body, the knowledge the company
 * gave it (defaults adjusted by company_agent_knowledge) inlined within a
 * budget, then the company's pack sections tagged with the flow's areas in
 * what is left of it, references and company atoms as ids to load with load_skill.
 * `own/<id>` runs a company's own agent the same way.
 */
export async function loadAgentBundle(supabase: SupabaseClient, companyId: string, id: string, client: AiClient = 'claude'): Promise<AgentBundle | null> {
  const curated = isAgentId(id) ? AGENTS[id] : null
  let workflow: { slug: string; name: string; version: number | null; body: string }
  if (curated) {
    const skill = workflowFor(id as RegistrySkillId, client)
    workflow = { slug: skill.slug, name: skill.name, version: skill.version ?? null, body: skill.body }
  } else if (id.startsWith('own/')) {
    const row = (await loadCompanySkillRows(supabase, companyId)).find((r) => `own/${r.id}` === id)
    const skill = row ? ownSkill(row) : null
    if (!skill) return null
    workflow = { slug: skill.slug, name: skill.name, version: null, body: skill.body }
  } else return null

  const [profileIds, choices] = await Promise.all([loadProfileAtoms(supabase, companyId), loadKnowledgeChoices(supabase, companyId)])
  const list = effectiveKnowledge(curated?.knowledge ?? OWN_AGENT_KNOWLEDGE, choices.get(id))
  const [bodies, metaRows, states, companyKnowledge, sectionRows] = await Promise.all([
    loadAtoms(supabase, list.map((k) => k.id), true),
    loadAtoms(supabase, [...(curated?.references ?? []), ...profileIds], false),
    loadConnectionStates(supabase, companyId),
    loadCompanyKnowledge(supabase, companyId, { facts: curated?.facts ?? null, agreements: curated?.agreements ?? true }),
    // Own agents name no areas, so they get no sections (the query is skipped).
    loadIndustrySections(supabase, profileIds, curated?.areas ?? [], true),
  ])
  const { inline, overflow, used } = splitByBudget([...bodies.values()], list)
  const company = companyAtoms(metaRows, profileIds)
  const livePacks = new Set(company.map((c) => c.id))
  const sections = splitSections(sectionRows.filter((s) => livePacks.has(s.parent_atom_id!)), used)
  return {
    agent: { id, name: workflow.name },
    workflow: { slug: workflow.slug, version: workflow.version, body: workflow.body },
    knowledge: inline,
    industry_sections: sections.inline,
    references: [...overflow, ...sections.overflow, ...(curated?.references ?? []).filter((r) => list.some((k) => k.id === packOf(r))).flatMap((r) => { const row = metaRows.get(r); return row ? [{ id: row.id, title: row.title ?? row.id }] : [] })],
    company,
    company_knowledge: companyKnowledge,
    connections: curated ? connectionsFor(id as RegistrySkillId, states) : [],
  }
}
