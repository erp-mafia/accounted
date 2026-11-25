import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ProviderMigrationJob } from '@/lib/providers/migration-contract'

/**
 * A Fortnox access token lives an hour, and the worker reads it once per run
 * (up to 210 s). A run that starts in the token's last minutes meets its end
 * midway, and Fortnox answers 401, a moment before the expiry we stamped
 * (resolveConsent's B11). The grant itself is alive: the refresh token still
 * works. Such a run takes a fresh token and goes on. A reconnect is asked for
 * only when Fortnox refuses the refresh, or refuses the token the refresh
 * just handed out.
 *
 * Everything below the worker is real: resolveConsent and its refresh, the
 * consent token seal, the Fortnox client, the detail pass and its reading of
 * a refusal. Fortnox (its API and token endpoint) and the two databases are
 * the fakes.
 */
const mocks = vi.hoisted(() => {
  // The Fortnox client and its rate limiter are module singletons: keep them
  // in-memory before the fetcher module loads.
  process.env.UPSTASH_REDIS_REST_URL = ''
  process.env.UPSTASH_REDIS_REST_TOKEN = ''
  return { tokens: undefined as SupabaseClient | undefined, warn: vi.fn() }
})
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => mocks.tokens }))
vi.mock('@/lib/logger', () => ({ createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: mocks.warn, error: vi.fn() }) }))
import { mapFortnoxToCustomer } from '@/lib/providers/fortnox/mapper'
import { sealMigrationPayload } from '@/lib/providers/migration-payload'
import { openConsentToken, sealConsentToken } from '@/lib/providers/consent-tokens'
import { runProviderMigrationWorker } from '../migration-job-worker'

const listed = (number: string) => ({ CustomerNumber: number, Name: `Kund ${number}` })

/** provider_consents and provider_consent_tokens, as resolveConsent reads and writes them. */
function consentDatabase(expiresInMs: number) {
  const consent = { id: 'consent', company_id: 'company', provider: 'fortnox', status: 1, org_number: '556000-0000' }
  const row: Record<string, unknown> = { consent_id: 'consent', provider: 'fortnox',
    access_token: sealConsentToken('access-1'), refresh_token: sealConsentToken('refresh-1'),
    token_expires_at: new Date(Date.now() + expiresInMs).toISOString(), credential_revision: 'revision-1' }
  let revisions = 1
  const from = (table: string) => {
    const filters: Record<string, unknown> = {}
    let patch: Record<string, unknown> | undefined
    const chain = {
      select: () => chain, limit: () => chain,
      eq: (key: string, value: unknown) => { filters[key] = value; return chain },
      update: (value: Record<string, unknown>) => { patch = value; return chain },
      then: (resolve: (value: unknown) => void) => {
        if (table === 'provider_consents') return resolve({ data: [consent], error: null })
        if (!patch) return resolve({ data: [{ ...row }], error: null })
        // As the revision guard and the table's trigger: a write moves the revision.
        if (filters.credential_revision !== row.credential_revision) return resolve({ data: [], error: null })
        Object.assign(row, patch, { credential_revision: `revision-${++revisions}` })
        return resolve({ data: [{ consent_id: 'consent', credential_revision: row.credential_revision }], error: null })
      },
    }
    return chain
  }
  return { supabase: { from } as unknown as SupabaseClient, storedToken: () => openConsentToken(row.access_token as string) }
}

/**
 * Fortnox. The first token answers `answers` requests and is then refused,
 * as when its hour ends mid-run. The token endpoint swaps refresh-1 for a
 * new pair, or refuses it (`invalid_grant`: the grant is gone).
 */
function fortnox(options: { answers: number; refresh?: 'invalid_grant'; refuseRefreshed?: boolean }) {
  const refreshes: string[] = []
  const live = new Set(['access-1'])
  let answered = 0
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    if (url === 'https://apps.fortnox.se/oauth-v1/token') {
      refreshes.push(new URLSearchParams(String(init?.body)).get('refresh_token') ?? '')
      if (options.refresh === 'invalid_grant') return json(400, { error: 'invalid_grant', error_description: 'Invalid refresh token' })
      if (!options.refuseRefreshed) live.add('access-2')
      return json(200, { access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 3600, token_type: 'bearer', scope: 'customer' })
    }
    const token = new Headers(init?.headers).get('Authorization')?.replace(/^Bearer /, '')
    if (token === 'access-1' && answered === options.answers) live.delete('access-1')
    if (!token || !live.has(token)) return json(401, { message: 'unauthorized' })
    if (token === 'access-1') answered++
    const page = url.match(/\/customers\?page=(\d+)$/)?.[1]
    if (page) {
      const numbers = page === '1' ? ['1', '2'] : ['3', '4']
      return json(200, { MetaInformation: { '@TotalPages': 2, '@CurrentPage': Number(page), '@TotalResources': 4 },
        Customers: numbers.map(listed) })
    }
    const number = url.match(/\/customers\/(\d+)$/)?.[1]
    if (!number) return json(404, { message: 'not found' })
    return json(200, { Customer: { ...listed(number), Type: 'COMPANY', Active: true } })
  })
  return { fetch, refreshes }
}

/** The job's own tables, as the worker's RPCs move them (as in migration-job-worker.test.ts). */
function jobDatabase(job: Partial<ProviderMigrationJob>, pending: string[] = []) {
  const row = { id: 'job', company_id: 'company', user_id: 'user', consent_id: 'consent', provider: 'fortnox',
    resources: ['customers'], resource_index: 1, next_page: 1, phase: 'discover', state: 'queued', error_code: null,
    account_key: '5560000000', attempt: 0, failures: 0, fiscal_year_scope: null, ...job } as ProviderMigrationJob
  type Chunk = { id: string; resource: string; source_id: string; state: string; target_id: null; receipt: object; payload: string }
  const chunks: Chunk[] = []
  const add = (records: { source_id: string; payload: string }[]) => {
    for (const r of records) chunks.push({ id: r.source_id, resource: 'customers', source_id: r.source_id, state: 'pending',
      target_id: null, receipt: {}, payload: r.payload })
  }
  add(pending.map(n => ({ source_id: n, ...sealMigrationPayload(mapFortnoxToCustomer(listed(n))) })))
  const next = { import: 'link', link: 'reconcile', reconcile: 'settle', settle: 'completed' } as const
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (name === 'claim_provider_migration_job') {
      if (row.state !== 'queued') return { data: null, error: null }
      Object.assign(row, { worker_id: args.p_worker_id, state: 'running', attempt: row.attempt + 1 })
      return { data: { ...row }, error: null }
    }
    if (name === 'save_provider_migration_page') {
      add(args.p_records as { source_id: string; payload: string }[])
      if (args.p_next_page === null) Object.assign(row, { phase: 'import', resource_index: 2, next_page: 1 })
      else if (args.p_next_page !== 0) row.next_page = args.p_next_page as number
    }
    if (name === 'commit_provider_migration_records') {
      for (const r of args.p_records as { id: string; error?: string; skip?: string }[]) {
        chunks.find(c => c.id === r.id)!.state = r.error ? 'needs_attention' : r.skip ? 'skipped' : 'done'
      }
    }
    if (name === 'advance_provider_migration_job') {
      row.phase = next[row.phase as keyof typeof next]
      if (row.phase === 'completed') row.state = 'completed'
    }
    if (name === 'release_provider_migration_job') {
      row.failures = args.p_error_code ? row.failures + 1 : 0
      row.error_code = (args.p_error_code as string | null) ?? null
      row.state = !args.p_error_code ? 'queued' : (args.p_retry_seconds as number) < 0 ? 'needs_attention' : 'retry_wait'
    }
    return { data: null, error: null }
  })
  const from = (table: string) => {
    const filters: Record<string, unknown> = {}
    let limit = Infinity
    const chain = {
      select: () => chain, order: () => chain, in: () => chain, maybeSingle: () => chain,
      eq: (key: string, value: unknown) => { filters[key] = value; return chain },
      limit: (value: number) => { limit = value; return chain },
      then: (resolve: (value: unknown) => void) => resolve(table === 'migration_jobs'
        ? { data: Object.entries(filters).every(([key, value]) => row[key as keyof ProviderMigrationJob] === value) ? { ...row } : null, error: null }
        : { data: chunks.filter(c => c.state === filters.state).slice(0, limit), error: null }),
    }
    return chain
  }
  return { supabase: { rpc, from } as unknown as SupabaseClient, job: row, chunks }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'provider-worker-unit-test-only')
  vi.stubEnv('FORTNOX_CLIENT_ID', 'client-id')
  vi.stubEnv('FORTNOX_CLIENT_SECRET', 'client-secret')
})
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('a Fortnox token that ends mid-run', () => {
  it('is refreshed and the register import goes on, instead of asking for a reconnect', async () => {
    // Stamped to last another minute; Fortnox ends it after two records.
    const consent = consentDatabase(60_000)
    mocks.tokens = consent.supabase
    const provider = fortnox({ answers: 2 })
    vi.stubGlobal('fetch', provider.fetch)
    const db = jobDatabase({ phase: 'import', resource_index: 2 }, ['1', '2', '3', '4'])

    await runProviderMigrationWorker({ supabase: db.supabase, jobId: 'job', budgetMs: 60_000 })

    expect(db.job).toMatchObject({ state: 'completed', error_code: null })
    expect(db.chunks.map(c => c.state)).toEqual(['done', 'done', 'done', 'done'])
    expect(provider.refreshes).toEqual(['refresh-1'])
    expect(consent.storedToken()).toBe('access-2')
    expect(mocks.warn).not.toHaveBeenCalledWith('migration yielded', expect.anything())
  })

  it('is refreshed when it ends while a register is listed', async () => {
    const consent = consentDatabase(60_000)
    mocks.tokens = consent.supabase
    const provider = fortnox({ answers: 1 })
    vi.stubGlobal('fetch', provider.fetch)
    const db = jobDatabase({ phase: 'discover' })

    await runProviderMigrationWorker({ supabase: db.supabase, jobId: 'job', budgetMs: 60_000 })

    expect(db.job).toMatchObject({ state: 'completed', error_code: null })
    expect(db.chunks.map(c => [c.source_id, c.state])).toEqual([['1', 'done'], ['2', 'done'], ['3', 'done'], ['4', 'done']])
    expect(provider.refreshes).toEqual(['refresh-1'])
  })

  it('still asks for a reconnect when Fortnox refuses the refresh: the grant is gone', async () => {
    mocks.tokens = consentDatabase(60_000).supabase
    const provider = fortnox({ answers: 2, refresh: 'invalid_grant' })
    vi.stubGlobal('fetch', provider.fetch)
    const db = jobDatabase({ phase: 'import', resource_index: 2 }, ['1', '2', '3', '4'])

    await runProviderMigrationWorker({ supabase: db.supabase, jobId: 'job', budgetMs: 60_000 })

    expect(db.job).toMatchObject({ state: 'needs_attention', error_code: 'PROVIDER_AUTH_EXPIRED' })
    // What was read before the refusal is kept.
    expect(db.chunks.map(c => c.state)).toEqual(['done', 'done', 'pending', 'pending'])
    expect(provider.refreshes).toEqual(['refresh-1'])
  })

  it('asks for a reconnect when Fortnox refuses the refreshed token too, after one refresh', async () => {
    mocks.tokens = consentDatabase(60_000).supabase
    const provider = fortnox({ answers: 2, refuseRefreshed: true })
    vi.stubGlobal('fetch', provider.fetch)
    const db = jobDatabase({ phase: 'import', resource_index: 2 }, ['1', '2', '3', '4'])

    await runProviderMigrationWorker({ supabase: db.supabase, jobId: 'job', budgetMs: 60_000 })

    expect(db.job).toMatchObject({ state: 'needs_attention', error_code: 'PROVIDER_AUTH_EXPIRED' })
    expect(db.chunks.map(c => c.state)).toEqual(['done', 'done', 'pending', 'pending'])
    expect(provider.refreshes).toEqual(['refresh-1'])
  })
})
