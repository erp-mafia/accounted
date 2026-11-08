import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProviderMigrationJob } from '@/lib/providers/migration-contract'
import { migrationSourceHash, sealMigrationPayload } from '@/lib/providers/migration-payload'
import { sourceHashBaselines } from '../migration-source-hashes'

const job = { id: 'job', worker_id: 'worker', attempt: 3 } as ProviderMigrationJob
beforeEach(() => vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'source-hashes-test-only'))
afterEach(() => vi.unstubAllEnvs())

describe('source hash baseline batching', () => {
  it.each([0, 1, 1000, 1001, 2001])('reads %s IDs within the RPC limit and preserves their hashes', async count => {
    const ids = Array.from({ length: count }, (_, index) => `source-${index}`)
    const rpc = vi.fn(async (_name: string, args: Record<string, unknown> & { p_ids: string[] }) => ({ data: args.p_ids.map((id: string) => ({
      record_id: id, chunk_id: `chunk-${id}`, payload_hash: 'retained-hash',
      payload: sealMigrationPayload({ id }).payload,
    })), error: null }))

    const rows = await sourceHashBaselines({ rpc } as unknown as SupabaseClient, job, 'customers', ids)

    expect(rows).toHaveLength(count)
    expect(rpc).toHaveBeenCalledTimes(Math.ceil(count / 1000))
    expect(rpc.mock.calls.flatMap(([, args]) => args.p_ids)).toEqual(ids)
    for (const [name, args] of rpc.mock.calls) {
      expect(name).toBe('read_provider_source_hash_baselines')
      expect(args.p_ids.length).toBeLessThanOrEqual(1000)
      expect(args).toMatchObject({ p_job_id: 'job', p_worker_id: 'worker', p_attempt: 3, p_resource: 'customers' })
    }
    expect(rows).toEqual(ids.map(id => ({ record_id: id, chunk_id: `chunk-${id}`,
      payload_hash: 'retained-hash', source_hash: migrationSourceHash({ id }) })))
  })

  it('retains database error codes and stops before later batches', async () => {
    const rpc = vi.fn().mockResolvedValueOnce({ data: [], error: null })
      .mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'Lease lost' } })
    const ids = Array.from({ length: 2001 }, (_, index) => String(index))
    await expect(sourceHashBaselines({ rpc } as unknown as SupabaseClient, job, 'customers', ids))
      .rejects.toMatchObject({ code: '42501', message: 'Lease lost' })
    expect(rpc).toHaveBeenCalledTimes(2)
  })
})
