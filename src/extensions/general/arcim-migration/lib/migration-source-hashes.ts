import type { SupabaseClient } from '@supabase/supabase-js'
import type { MigrationResource, ProviderMigrationJob } from '@/lib/providers/migration-contract'
import { migrationSourceHash, openMigrationPayload } from '@/lib/providers/migration-payload'

export const SOURCE_HASH_BATCH_SIZE = 1000

interface SourceHashBaseline {
  record_id: string
  chunk_id: string
  payload_hash: string
  source_hash: string
}

/** Backfill semantic identity from retained encrypted snapshots, within the RPC's batch limit. */
export async function sourceHashBaselines(
  supabase: SupabaseClient,
  job: ProviderMigrationJob,
  resource: MigrationResource,
  ids: string[],
): Promise<SourceHashBaseline[]> {
  const baselines: SourceHashBaseline[] = []
  for (let offset = 0; offset < ids.length; offset += SOURCE_HASH_BATCH_SIZE) {
    const { data, error } = await supabase.rpc('read_provider_source_hash_baselines', {
      p_job_id: job.id,
      p_worker_id: job.worker_id,
      p_attempt: job.attempt,
      p_resource: resource,
      p_ids: ids.slice(offset, offset + SOURCE_HASH_BATCH_SIZE),
    })
    if (error) throw Object.assign(new Error(error.message), { code: error.code })
    if (!Array.isArray(data)) continue
    baselines.push(...data.map(source => ({
      record_id: source.record_id,
      chunk_id: source.chunk_id,
      payload_hash: source.payload_hash,
      source_hash: migrationSourceHash(openMigrationPayload(source.payload)),
    })))
  }
  return baselines
}
