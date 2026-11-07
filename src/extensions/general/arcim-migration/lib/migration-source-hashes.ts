import type { SupabaseClient } from '@supabase/supabase-js'
import type { MigrationResource, ProviderMigrationJob } from '@/lib/providers/migration-contract'
import { migrationSourceHash, openMigrationPayload } from '@/lib/providers/migration-payload'

/** Backfill semantic identity from retained encrypted snapshots, without rewriting them. */
export async function sourceHashBaselines(supabase: SupabaseClient, job: ProviderMigrationJob, resource: MigrationResource, ids: string[]) {
  if (!ids.length) return []
  const { data, error } = await supabase.rpc('read_provider_source_hash_baselines', {
    p_job_id:job.id,p_worker_id:job.worker_id,p_attempt:job.attempt,p_resource:resource,p_ids:ids,
  })
  if (error) throw Object.assign(new Error(error.message),{code:error.code})
  if (!Array.isArray(data)) return []
  return data.map(source => ({record_id:source.record_id,chunk_id:source.chunk_id,payload_hash:source.payload_hash,
    source_hash:migrationSourceHash(openMigrationPayload(source.payload))}))
}
