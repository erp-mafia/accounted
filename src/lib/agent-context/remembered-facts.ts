import type { SupabaseClient } from '@supabase/supabase-js'
import { isMissingColumnError } from '@/lib/pending-operations/agent-reason'

/**
 * Every fact agents were told about a company (agent_memory, written by
 * gnubok_remember_fact), for the two places an agent reads them: the MCP
 * briefing and the bundle a curated workflow starts with.
 *
 * All of them, newest first, instead of a ranked top few: a company holds a
 * handful (median 4 in prod, 2026-10; the largest about 48k characters), so a
 * cap only hid facts. Newest first so a later fact can settle an earlier one.
 * A fact retired by `replaces` (is_active false, superseded_by set) is left out.
 *
 * The character budget only guards an outlier: when the facts pass it, the
 * newest that fit are kept and `truncated` says so.
 */
export const REMEMBERED_FACTS_CHAR_BUDGET = 60_000

/** Upper bound on rows read, far above any company today. */
const ROW_BOUND = 500

export interface RememberedFact {
  fact_id: string
  kind: string
  content: string
  relevance_score: number | null
  saved_at: string | null
  /** conversation, session_sync or onboarding_import; null on older rows and in-app writes. */
  origin: string | null
  /** MCP client label of the connection that wrote it; null outside MCP. */
  client: string | null
}

export interface RememberedFacts {
  facts: RememberedFact[]
  truncated: boolean
}

interface Row {
  id: string
  kind: string
  content: string
  relevance_score: number | null
  created_at: string | null
  origin?: string | null
  client?: string | null
}

/** Reads the company's active facts. Throws when the read fails. */
export async function loadRememberedFacts(supabase: SupabaseClient, companyId: string): Promise<RememberedFacts> {
  // Literal selects, twice, so the schema guard (tests/schema) can check them.
  let result: { data: unknown; error: { code?: string; message: string } | null } = await supabase
    .from('agent_memory')
    .select('id, kind, content, relevance_score, created_at, origin, client')
    .eq('company_id', companyId)
    .eq('is_active', true)
    .is('superseded_by', null)
    .order('created_at', { ascending: false, nullsFirst: false })
    .limit(ROW_BOUND)
  // origin and client arrive with migration 20261029122000, which applies
  // after the merge deploys: until then the read goes without them.
  if (isMissingColumnError(result.error)) {
    result = await supabase
      .from('agent_memory')
      .select('id, kind, content, relevance_score, created_at')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .is('superseded_by', null)
      .order('created_at', { ascending: false, nullsFirst: false })
      .limit(ROW_BOUND)
  }
  if (result.error) throw new Error(`Failed to load agent memory: ${result.error.message}`)

  const facts: RememberedFact[] = []
  let used = 0
  let truncated = false
  for (const row of (result.data ?? []) as unknown as Row[]) {
    used += row.content.length
    if (used > REMEMBERED_FACTS_CHAR_BUDGET) {
      truncated = true
      break
    }
    facts.push({
      fact_id: row.id,
      kind: row.kind,
      content: row.content,
      relevance_score: row.relevance_score,
      saved_at: row.created_at,
      origin: row.origin ?? null,
      client: row.client ?? null,
    })
  }
  return { facts, truncated }
}

/** When the AI last offered facts from its own memory (origin session_sync), or null. */
export function lastSessionSync(facts: readonly RememberedFact[]): string | null {
  let latest: string | null = null
  for (const fact of facts) {
    if (fact.origin === 'session_sync' && fact.saved_at && (!latest || fact.saved_at > latest)) latest = fact.saved_at
  }
  return latest
}
