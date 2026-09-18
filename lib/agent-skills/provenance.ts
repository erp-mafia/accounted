import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { PendingOperationAgentMetadata } from '@/types'

export const skillBodyHash = (body: string): string => createHash('sha256').update(body).digest('hex')

/** Server-observed retrieval evidence, not a claim that an AI followed a skill. */
export async function loadSkillProvenance(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  actor: { id?: string; sessionId?: string | null },
): Promise<PendingOperationAgentMetadata> {
  if (!actor.id || !actor.sessionId) return { skills_loaded: [], skills_provenance: 'no_session' }
  const { data, error } = await supabase.from('event_log').select('data, created_at')
    .eq('company_id', companyId).eq('user_id', userId).eq('event_type', 'mcp.skill_loaded')
    .eq('data->>actorId', actor.id).eq('data->>sessionId', actor.sessionId)
    .gte('created_at', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
    .order('created_at', { ascending: false }).limit(101)
  if (error) return { skills_loaded: [], skills_provenance: 'unavailable' }
  const seen = new Set<string>()
  const retrievals: NonNullable<PendingOperationAgentMetadata['skill_retrievals']> = []
  for (const row of (data ?? []).slice(0, 100)) {
    const event = row.data as { slug?: unknown; bodyHash?: unknown; version?: unknown }
    if (typeof event.slug !== 'string' || seen.has(event.slug)) continue
    seen.add(event.slug)
    retrievals.push({ slug: event.slug, retrieved_at: row.created_at,
      ...(typeof event.bodyHash === 'string' ? { body_hash: event.bodyHash } : {}),
      ...(typeof event.version === 'number' ? { version: event.version } : {}),
    })
  }
  return { skills_loaded: [...seen], skill_retrievals: retrievals,
    skills_provenance: (data?.length ?? 0) > 100 ? 'recent_session_truncated' : 'recent_session' }
}

export function oauthActorLabel(client: string | null | undefined, fallback: string): string {
  const names: Record<string, string> = { claude: 'Claude (Anthropic)', chatgpt: 'ChatGPT (OpenAI)', grok: 'Grok (xAI)', cursor: 'Cursor' }
  return client ? names[client] ?? fallback : fallback
}
