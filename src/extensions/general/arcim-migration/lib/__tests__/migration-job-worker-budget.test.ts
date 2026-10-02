import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProviderMigrationJob } from '@/lib/providers/migration-contract'

/**
 * The worker's deadline must reach the real Visma request. With only the
 * promise race, a 60 s register-page attempt (and its two retries) kept
 * running after the job was released, on a long-lived self-hosted process
 * right next to the cron minute that resumed the same page.
 */
const mocks = vi.hoisted(() => {
  // The Visma client and its rate limiter are module singletons: keep them
  // in-memory before the fetcher module loads.
  process.env.UPSTASH_REDIS_REST_URL = ''
  process.env.UPSTASH_REDIS_REST_TOKEN = ''
  return { resolve: vi.fn(), warn: vi.fn() }
})
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn() }))
vi.mock('@/lib/providers/resolve-consent', () => ({ resolveConsent: mocks.resolve }))
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ info: vi.fn(), warn: mocks.warn, error: vi.fn() }) }))
import { runProviderMigrationWorker } from '../migration-job-worker'

function database(overrides: Partial<ProviderMigrationJob> = {}) {
  const job = { id: 'job', company_id: 'company', user_id: 'user', consent_id: 'consent', provider: 'visma',
    resources: ['customers'], resource_index: 1, next_page: 1, phase: 'discover', state: 'queued', error_code: null,
    account_key: '5560000000', attempt: 0, failures: 0, fiscal_year_scope: null, ...overrides } as ProviderMigrationJob
  const rows: Record<string, unknown>[] = []
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'claim_provider_migration_job') {
      Object.assign(job, { worker_id: args.p_worker_id, state: 'running', attempt: job.attempt + 1 })
      return { data: { ...job } }
    }
    if (name === 'save_provider_migration_page') {
      rows.push(...(args.p_records as Record<string, unknown>[]))
      if (args.p_next_page === null) job.phase = 'import'
      else if (args.p_next_page !== 0) job.next_page = args.p_next_page as number
    }
    if (name === 'release_provider_migration_job') {
      job.failures = args.p_error_code ? job.failures + 1 : 0
      job.error_code = (args.p_error_code as string | null) ?? null
      job.state = !args.p_error_code ? 'queued' : args.p_retry_seconds === -1 ? 'needs_attention' : 'retry_wait'
    }
    return { data: null, error: null }
  })
  const supabase = { rpc, from: () => {
    const chain = { select: () => chain, eq: () => chain, order: () => chain, limit: () => chain, maybeSingle: () => chain,
      then: (resolve: (value: unknown) => void) => resolve({ data: { ...job }, error: null }) }
    return chain
  } } as unknown as SupabaseClient
  return { supabase, rpc, job, rows }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'provider-worker-unit-test-only')
  mocks.resolve.mockResolvedValue({ accessToken: 'token', consent: { provider: 'visma', org_number: '556000-0000' } })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('the worker deadline reaches the Visma request', () => {
  it('aborts the register page at the deadline, defers the job, and starts no retry afterwards', async () => {
    let signal: AbortSignal | undefined
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      signal = init.signal!
      signal.addEventListener('abort', () => reject(signal!.reason), { once: true })
    }))
    vi.stubGlobal('fetch', fetch)
    const db = database({ resources: ['supplierInvoices'], next_page: 4, failures: 4 })

    // 20 s invocation: the page may use 15 s, the Visma attempt would wait 60 s.
    const run = runProviderMigrationWorker({ supabase: db.supabase, jobId: db.job.id, budgetMs: 20_000 })
    await vi.advanceTimersByTimeAsync(15_000)
    await run

    expect(String(fetch.mock.calls[0][0])).toContain('/supplierinvoices?%24page=4&%24pagesize=1000')
    expect(signal?.aborted).toBe(true)
    expect(db.job).toMatchObject({ state: 'queued', next_page: 4, failures: 0, error_code: null })
    expect(db.rows).toHaveLength(0)
    expect(mocks.warn).toHaveBeenCalledWith('migration yielded', expect.objectContaining({
      code: 'MIGRATION_DEADLINE', needsAttention: false, resource: 'supplierInvoices', page: 4,
    }))

    // Past the 60 s attempt and its 1 s backoff: no second attempt.
    await vi.advanceTimersByTimeAsync(120_000)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('accepts a register page that answers after 20 s, beyond the old 15 s limit', async () => {
    const fetch = vi.fn((_url: string, init: RequestInit) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response(JSON.stringify({
        Meta: { TotalNumberOfPages: 1, TotalNumberOfResults: 1 }, Data: [{ Id: 'customer-1', Name: 'Example' }],
      }), { headers: { 'Content-Type': 'application/json' } })), 20_000)
      init.signal!.addEventListener('abort', () => { clearTimeout(timer); reject(init.signal!.reason) }, { once: true })
    }))
    vi.stubGlobal('fetch', fetch)
    const db = database()

    // 30 s invocation: the page lands at 20 s, then the loop has no room for another step.
    const run = runProviderMigrationWorker({ supabase: db.supabase, jobId: db.job.id, budgetMs: 30_000 })
    await vi.advanceTimersByTimeAsync(20_000)
    await run

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(db.rows).toEqual([expect.objectContaining({ source_id: 'customer-1' })])
    expect(db.job).toMatchObject({ phase: 'import', state: 'queued', failures: 0 })
    expect(mocks.warn).not.toHaveBeenCalledWith('migration yielded', expect.anything())
  })
})
