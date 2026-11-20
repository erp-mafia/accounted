import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProviderMigrationJob } from '@/lib/providers/migration-contract'

/**
 * A job whose worker is ended every run (the route killed at its time limit)
 * never reaches a release, so nothing counted it and it was claimed every
 * five minutes for good. claim_provider_migration_job now counts a lapsed
 * lease and parks the job on the fifth (20261112192901, pinned in
 * tests/pg/provider-migration-lapsed-lease.pg.test.ts). The worker's part:
 * report the parked job once and leave it alone.
 */
const mocks = vi.hoisted(() => ({ resolve: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn() }))
vi.mock('@/lib/providers/resolve-consent', () => ({ resolveConsent: mocks.resolve }))
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: mocks.error }) }))
import { runProviderMigrationWorker } from '../migration-job-worker'

const parked = {
  id: 'job', company_id: 'company', user_id: 'user', consent_id: 'consent', provider: 'fortnox',
  resources: ['customers', 'salesInvoices'], resource_index: 2, next_page: 7, phase: 'discover', state: 'needs_attention',
  error_code: 'MIGRATION_LEASE_LAPSED', account_key: '5560000000', attempt: 9, failures: 5, worker_id: null,
  lease_until: null, next_attempt_at: null, fiscal_year_scope: null,
} as unknown as ProviderMigrationJob

function database(claims: (ProviderMigrationJob | null)[]) {
  const rpc = vi.fn(async (name: string) =>
    name === 'claim_provider_migration_job' ? { data: claims.shift() ?? null, error: null } : { data: null, error: null })
  return { supabase: { rpc, from: vi.fn() } as unknown as SupabaseClient, rpc }
}

beforeEach(() => vi.clearAllMocks())

describe('a job the claim parked', () => {
  it('is reported once as an error and not worked: no consent read, no release', async () => {
    const db = database([parked])

    const result = await runProviderMigrationWorker({ supabase: db.supabase, budgetMs: 60_000 })

    expect(result).toEqual({ jobs: 0, batches: 0 })
    expect(mocks.error).toHaveBeenCalledTimes(1)
    expect(mocks.error).toHaveBeenCalledWith(
      'migration job parked: its worker was ended five runs in a row without moving it',
      expect.objectContaining({ jobId: 'job', companyId: 'company', phase: 'discover', resource: 'salesInvoices', page: 7,
        failures: 5, code: 'MIGRATION_LEASE_LAPSED' }))
    expect(mocks.resolve).not.toHaveBeenCalled()
    expect(db.rpc.mock.calls.map(([name]) => name)).toEqual(['claim_provider_migration_job', 'claim_provider_migration_job'])
    expect(db.supabase.from).not.toHaveBeenCalled()
  })

  it('ends a run for that one job (the browser nudge) without claiming another', async () => {
    const db = database([parked])
    await runProviderMigrationWorker({ supabase: db.supabase, jobId: 'job', budgetMs: 60_000 })
    expect(db.rpc).toHaveBeenCalledTimes(1)
  })
})
