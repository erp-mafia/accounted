import type { CatalogSkill } from '@/lib/agent-skills/catalog'
import type { WorklistCategory } from '@/lib/worklist/types'
import type { SkillUsage } from '@/lib/agent-skills/usage'
import type { AgentsOverview } from '@/lib/agent-skills/agent-bundle'
import type { KnowledgeOption } from '@/lib/agent-skills/knowledge-choices'
import type { CommunityMeta } from '@/lib/agent-skills/community'
import { isCheckable } from '@/lib/agent-skills/agents'
import type { RegistrySkillId } from '@/lib/agent-skills/registry'
import { AI_CLIENTS, type AiClient } from '@/lib/onboarding/ai-clients'
import type { ItemKind, Presence } from './hues'

/** Reads shared by the Agenter list and an agent's page. */
export type SkillSummary = Omit<CatalogSkill, 'body'>

/** Null when the status is unavailable: a failed read never makes a connected client look disconnected. */
export async function fetchConnections(signal: AbortSignal): Promise<AiClient[] | null> {
  try {
    const response = await fetch('/api/ai/connections', { signal })
    if (!response.ok) return null
    return (await response.json()).data as AiClient[]
  } catch {
    return null
  }
}

/**
 * Local development only: /skills?ai=claude (or chatgpt, grok) shows the page
 * as connected without a real MCP connection. Compiled out of production.
 */
export function simulatedClient(): AiClient | null {
  if (process.env.NODE_ENV !== 'development') return null
  const value = new URLSearchParams(window.location.search).get('ai')
  return AI_CLIENTS.find((c) => c.id === value)?.id ?? null
}

/**
 * Dev only: `?todo=1` fakes waiting Att göra work (and a few runs) so the
 * counts and run counters can be seen without writing data.
 */
export function simulatedTodo(): boolean {
  return process.env.NODE_ENV === 'development' && new URLSearchParams(window.location.search).get('todo') === '1'
}

/** The "Att göra" counts; a failed read tags nothing rather than breaking the page. */
export async function readWorklist(url: string): Promise<Partial<Record<WorklistCategory, number>>> {
  if (simulatedTodo()) return { book_transaction: 14, verifikat_missing_document: 3, inbox_document: 2 }
  const response = await fetch(url)
  if (!response.ok) return {}
  return ((await response.json()).data as { counts: Record<WorklistCategory, number> }).counts
}

/** How often each skill was run; a failed read shows no counts. */
export async function readUsage(url: string): Promise<SkillUsage> {
  if (simulatedTodo()) return { bookkeep: { count: 12, last_at: new Date().toISOString() }, 'reconcile-month': { count: 3, last_at: new Date().toISOString() } }
  const response = await fetch(url)
  if (!response.ok) return {}
  return (await response.json()).data as SkillUsage
}

/** Each agent's knowledge, company atoms and connections; a failed read leaves the parts empty. */
export async function readAgents(url: string): Promise<AgentsOverview | null> {
  const response = await fetch(url)
  if (!response.ok) return null
  return (await response.json()).data as AgentsOverview
}

export async function readOptions(url: string): Promise<KnowledgeOption[]> {
  const response = await fetch(url)
  if (!response.ok) return []
  return (await response.json()).data as KnowledgeOption[]
}

export async function readCatalog(url: string): Promise<SkillSummary[]> {
  const response = await fetch(url)
  if (!response.ok) throw new Error('Skills request failed')
  return (await response.json()).data as SkillSummary[]
}


/**
 * How an agent is doing right now, as one line and a presence dot. `aiKnown`
 * is false only when no AI is known to be connected; while the status loads
 * it is null and the line says what the agent itself is doing.
 */
export function agentStatus({ id, aiKnown, overview, waiting, lastAt, t, formatDate }: {
  id: RegistrySkillId
  aiKnown: boolean | null
  overview: AgentsOverview | null | undefined
  waiting: number | undefined
  lastAt: string | undefined
  t: (key: string, values?: Record<string, string | number>) => string
  formatDate: (iso: string) => string
}): { presence: Presence; text: string } | undefined {
  // Only when the agent is stuck (founder: no "12 att göra", no "Redo"): no AI yet, or a connection it cannot work without.
  void waiting; void lastAt; void formatDate
  if (aiKnown === false) return { presence: 'idle', text: t('status_ai_missing') }
  const missing = overview?.agents.find((a) => a.id === id)?.connections.find((c) => isCheckable(c.kind) && c.status === 'missing')
  if (missing) return { presence: 'blocked', text: t('status_needs', { conn: t(`conn_${missing.kind}`) }) }
  return undefined
}

/** The URL segment of an agent: its id, or own-<uuid> for an own agent (own/<uuid> in the API). */
export function agentSegment(agentId: string): string {
  return agentId.startsWith('own/') ? `own-${agentId.slice(4)}` : agentId
}
export function agentIdFromSegment(segment: string): string {
  return segment.startsWith('own-') ? `own/${segment.slice(4)}` : segment
}

/**
 * What the community says about a shared item: its kind, who shared it and
 * its upvotes. The catalog sends it on every community item
 * (src/lib/agent-skills/community.ts, the one definition).
 */
export type { CommunityMeta }
export function communityMeta(skill: SkillSummary): CommunityMeta | null {
  return (skill as SkillSummary & { community?: CommunityMeta }).community ?? null
}
/** A catalog item's type: community items say it, everything else in the catalog is a flow. */
export function kindOf(skill: SkillSummary): ItemKind {
  return communityMeta(skill)?.kind ?? 'workflow'
}

/** The URL segments of the item pages that are not flows: a knowledge pack, or a shared community item. */
export function rulesSegment(atomId: string): string {
  return `kunskap.${atomId.replace('/', '.')}`
}
/** An analysis of Accounted's own (analys-kassaprognos) opens at analys.<slug>. */
export function analysisSegment(slug: string): string {
  return `analys.${slug}`
}
/** Where a knowledge chip leads: an own knowledge item's page (egen.<id>), else the pack's. */
export function knowledgeHref(base: string, id: string): string {
  return id.startsWith('own/') ? `${base}/egen.${id.slice(4)}` : `${base}/${rulesSegment(id)}`
}
export function communitySegment(slug: string): string {
  // community/<name> -> community.<name>: the address accounted.se links to for "Lägg till i Accounted".
  return `community.${slug.replace(/^community\//, '').replaceAll('/', '.')}`
}
