import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Provenance in the W3C PROV shape (dev_docs/arkiv_plan.md): an agent (a
 * person, or a software version) runs an activity that produces a record.
 * Every stored extraction points at the activity that produced it.
 */
export type ActivityKind = 'extract' | 'review' | 'derive' | 'ask'

export interface ActivityInput {
  companyId: string
  documentId: string | null
  agentId: string
  kind: ActivityKind
  schemaType?: string
  schemaVersion?: number
  modelIds?: string[]
  promptSha256?: string
  /** Defaults to now, for activities without a run of their own (a person's review). */
  startedAt?: string
  outcome: 'settled' | 'review'
  detail?: Record<string, unknown>
}

/** The agent of one software version, created on first use. */
export function softwareAgent(supabase: SupabaseClient, name: string, version: string): Promise<string> {
  return ensureAgent(supabase, { kind: 'software', name, version }, { kind: 'software', name, version })
}

/** The agent of one person, created on first use. */
export function humanAgent(supabase: SupabaseClient, userId: string): Promise<string> {
  return ensureAgent(supabase, { kind: 'human', name: 'person', user_id: userId }, { user_id: userId })
}

async function ensureAgent(supabase: SupabaseClient, row: Record<string, string>, key: Record<string, string>): Promise<string> {
  const { error } = await supabase.from('agents').upsert(row, { onConflict: Object.keys(key).join(','), ignoreDuplicates: true })
  if (error) throw new Error(`agent upsert failed: ${error.message}`)
  const { data, error: readError } = await supabase.from('agents').select('id').match(key).single()
  if (readError) throw new Error(`agent read failed: ${readError.message}`)
  return (data as { id: string }).id
}

export async function recordActivity(supabase: SupabaseClient, activity: ActivityInput): Promise<string> {
  const endedAt = new Date().toISOString()
  const { data, error } = await supabase
    .from('activities')
    .insert({
      company_id: activity.companyId,
      document_id: activity.documentId,
      agent_id: activity.agentId,
      kind: activity.kind,
      schema_type: activity.schemaType ?? null,
      schema_version: activity.schemaVersion ?? null,
      model_ids: activity.modelIds ?? [],
      prompt_sha256: activity.promptSha256 ?? null,
      started_at: activity.startedAt ?? endedAt,
      ended_at: endedAt,
      outcome: activity.outcome,
      detail: activity.detail ?? {},
    })
    .select('id')
    .single()
  if (error) throw new Error(`activity insert failed: ${error.message}`)
  return (data as { id: string }).id
}
