import type { SupabaseClient } from '@supabase/supabase-js'
import { agentToolRegistry } from '@/lib/agent/tools/registry'
import { DEFAULT_OAUTH_SCOPES } from '@/lib/auth/scope-catalog'
import { isArkivBrainEnabled } from '@/lib/arkiv/flag'
import { REMEMBERED_FACTS_CHAR_BUDGET } from './remembered-facts'
import { briefingText, describeContextWindow, type ContextWindow } from './context-window'
import { BRAIN_RECORD_KINDS, describeRecord, type WikiRecordKind, type WikiRecordView } from './wiki-record'

/**
 * The wiki's two reads, each the agent's own tool run on the server:
 * gnubok_get_agent_briefing for the context view and gnubok_get_record for a
 * record page. Core reaches them through the agent tool registry (the
 * mcp-server extension registers its tools there for the in-app chat), never
 * by importing the extension. A build without that extension has no such
 * tools, and both reads say so instead of failing.
 *
 * The tools run with the caller's session client, as the in-app chat runs
 * them: row-level security applies, and the reads stay inside the active
 * company the route resolved.
 */

export const BRIEFING_TOOL = 'gnubok_get_agent_briefing'
export const RECORD_TOOL = 'gnubok_get_record'

export type AgentContextResult =
  | { status: 'ok'; window: ContextWindow; text: string; scopes: 'default_connector' }
  | { status: 'unavailable' }

/**
 * The briefing as a Claude or ChatGPT connector receives it. The scopes are
 * the connector default (DEFAULT_OAUTH_SCOPES): they decide only which
 * recommended tools are marked callable, never what the company's context
 * holds.
 */
export async function loadAgentContext(supabase: SupabaseClient, companyId: string, userId: string): Promise<AgentContextResult> {
  const tool = await agentToolRegistry.get(BRIEFING_TOOL)
  if (!tool) return { status: 'unavailable' }
  const briefing = await tool.execute({ __keyScopes: [...DEFAULT_OAUTH_SCOPES] }, companyId, userId, supabase, { type: 'user', id: userId })
  if (typeof briefing !== 'object' || briefing === null || Array.isArray(briefing)) {
    throw new Error('The briefing tool answered no object')
  }
  const json = briefing as Record<string, unknown>
  return {
    status: 'ok',
    window: describeContextWindow(json, REMEMBERED_FACTS_CHAR_BUDGET),
    text: briefingText(json),
    scopes: 'default_connector',
  }
}

export type WikiRecordResult =
  | { status: 'ok'; record: WikiRecordView; text: string }
  | { status: 'not_found' }
  | { status: 'not_enabled' }
  | { status: 'unavailable' }

function codeOf(err: unknown): string | null {
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
    ? (err as { code: string }).code
    : null
}

/** One record as get_record answers it. Kind and id are validated by the caller. */
export async function loadWikiRecord(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  kind: WikiRecordKind,
  id: string,
): Promise<WikiRecordResult> {
  // get_record refuses these outside the brain rollout; asking first keeps the answer typed.
  if (BRAIN_RECORD_KINDS.has(kind) && !isArkivBrainEnabled(companyId)) return { status: 'not_enabled' }
  const tool = await agentToolRegistry.get(RECORD_TOOL)
  if (!tool) return { status: 'unavailable' }
  let answer: unknown
  try {
    answer = await tool.execute({ record_ref: `${kind}:${id}` }, companyId, userId, supabase, { type: 'user', id: userId })
  } catch (err) {
    const code = codeOf(err)
    if (code === 'NOT_FOUND') return { status: 'not_found' }
    if (code === 'ARKIV_NOT_ENABLED') return { status: 'not_enabled' }
    throw err
  }
  if (typeof answer !== 'object' || answer === null || Array.isArray(answer)) {
    throw new Error('get_record answered no object')
  }
  const json = answer as Record<string, unknown>
  return { status: 'ok', record: describeRecord(kind, id, json), text: JSON.stringify(json, null, 2) }
}
