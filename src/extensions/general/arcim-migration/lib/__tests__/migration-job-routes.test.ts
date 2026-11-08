import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import { sealMigrationPayload } from '@/lib/providers/migration-payload'
import { createMockSupabase, createQueuedMockSupabase } from '@/tests/helpers'
const { after, serviceRpc, worker, ensureIdentity, writePermission, MismatchError } = vi.hoisted(() => ({
  writePermission: vi.fn(), after: vi.fn(), serviceRpc: vi.fn(), worker: vi.fn(), ensureIdentity: vi.fn(),
  MismatchError: class extends Error {
    constructor(public expectedOrgNumber: string, public actualOrgNumber: string, public actualCompanyName: string | null) { super('mismatch') }
  },
}))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: writePermission }))
vi.mock('next/server', async importOriginal => ({ ...await importOriginal<typeof import('next/server')>(), after }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => ({ rpc: serviceRpc }) }))
vi.mock('../migration-job-worker', () => ({
  runProviderMigrationWorker: worker,
  failureCode: (e: Error) => e.message.match(/MIGRATION_[A-Z_]+/)?.[0] ?? 'MIGRATION_RETRY',
}))
vi.mock('../provider-client', () => ({ ensureConsentSourceIdentity: ensureIdentity, ProviderCompanyMismatchError: MismatchError }))
import { migrationJobRoutes } from '../migration-job-routes'
const id = '5c4da29a-b51a-44ef-9705-fcf437d6c658'
const route = (method: string, path = '/migration-jobs') => migrationJobRoutes.find(r => r.method === method && r.path === path)!.handler
const request = (body: unknown) => new Request('http://localhost/api/extensions/ext/arcim-migration/migration-jobs', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
function context() {
  const mock = createMockSupabase()
  mock.supabase.rpc.mockResolvedValue({data:[],error:null})
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
  return { ...mock, log, ctx: { supabase: mock.supabase, companyId: 'company', userId: 'user', log } as unknown as ExtensionContext }
}
beforeEach(() => { vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'migration-route-test-key'); vi.clearAllMocks(); ensureIdentity.mockResolvedValue('present'); writePermission.mockResolvedValue({ ok: true }) })
afterEach(() => vi.unstubAllEnvs())
describe('migration job API', () => {
  it('rejects an unauthenticated request before creating service work', async () => {
    expect((await route('POST')(request({ consentId: id, resources: ['customers'] }))).status).toBe(401)
    expect(serviceRpc).not.toHaveBeenCalled()
  })
  it('validates resources and rejects client-supplied company or fiscal scope', async () => {
    for (const body of [{ consentId: id, resources: [] }, { consentId: id, resources: ['journalEntries'] },
      { consentId: id, resources: ['customers'], companyId: 'foreign' }, { consentId: id, resources: ['customers'], scope: {} }]) {
      expect((await route('POST')(request(body), context().ctx)).status).toBe(400)
    }
    expect(serviceRpc).not.toHaveBeenCalled()
  })
  it('does not enqueue a foreign or missing consent', async () => {
    const { ctx, mockResult } = context(); mockResult({ data: null })
    expect((await route('POST')(request({ consentId: id, resources: ['customers'] }), ctx)).status).toBe(404)
    expect(serviceRpc).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })
  it('returns 202 with a durable job before running provider work', async () => {
    const { ctx, mockResult } = context(); mockResult({ data: [{ fiscal_year_start: '2025-01-01', fiscal_year_end: '2025-12-31' }] })
    serviceRpc.mockResolvedValue({ data: { id }, error: null })
    const response = await route('POST')(request({ consentId: id, resources: ['salesInvoices', 'customers', 'customers'] }), ctx)
    expect(response.status).toBe(202)
    expect(await response.json()).toEqual({ data: { jobId: id } })
    expect(serviceRpc).toHaveBeenCalledWith('create_provider_migration_job', {
      p_company_id: 'company', p_user_id: 'user', p_consent_id: id,
      p_resources: ['customers', 'salesInvoices'], p_scope: { start: '2025-01-01', end: '2025-12-31' },
    })
    expect(after).toHaveBeenCalledOnce()
    expect(worker).not.toHaveBeenCalled()
  })
  it('requires a completed SIE import even for a direct API caller', async () => {
    const { ctx, mockResult } = context(); mockResult({ data: [] })
    expect((await route('POST')(request({ consentId: id, resources: ['customers'] }), ctx)).status).toBe(400)
    expect(serviceRpc).not.toHaveBeenCalled()
  })
  it.each(['run', 'retry'])('does not %s an inaccessible job', async action => {
    const { ctx, mockResult } = context(); mockResult({ data: null })
    expect((await route('POST', `/migration-jobs/${action}`)(request({ jobId: id }), ctx)).status).toBe(404)
    expect(serviceRpc).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })
  it('returns 404 instead of foreign-job metadata', async () => {
    const { ctx, mockResult } = context(); mockResult({ data: null })
    expect((await route('GET')(new Request(`http://localhost/api/jobs?jobId=${id}`), ctx)).status).toBe(404)
  })
})

it('does not create a new import when retrying an already completed job with a renewed consent', async () => {
  const { ctx, mockResult } = context(); mockResult({ data: { id, state: 'completed' } })
  expect((await route('POST', '/migration-jobs/retry')(request({ jobId: id, consentId: id }), ctx)).status).toBe(409)
  expect(serviceRpc).not.toHaveBeenCalled()
  expect(after).not.toHaveBeenCalled()
})

describe('source identity before the job is created', () => {
  const imports = { data: [{ fiscal_year_start: '2025-01-01', fiscal_year_end: '2025-12-31' }] }

  it('fills the consent identity before calling the RPC', async () => {
    const { ctx, mockResult } = context(); mockResult(imports)
    ensureIdentity.mockResolvedValue('filled')
    serviceRpc.mockResolvedValue({ data: { id }, error: null })
    expect((await route('POST')(request({ consentId: id, resources: ['customers'] }), ctx)).status).toBe(202)
    expect(ensureIdentity).toHaveBeenCalledWith('company', id)
    expect(ensureIdentity.mock.invocationCallOrder[0]).toBeLessThan(serviceRpc.mock.invocationCallOrder[0]!)
  })

  it('refuses with 422 and creates nothing when the credentials open another company', async () => {
    const { ctx, mockResult } = context(); mockResult(imports)
    ensureIdentity.mockRejectedValue(new MismatchError('5560160680', '5567037485', 'Annat Bolag AB'))
    const response = await route('POST')(request({ consentId: id, resources: ['customers'] }), ctx)
    expect(response.status).toBe(422)
    expect((await response.json()).error.code).toBe('PROVIDER_COMPANY_MISMATCH')
    expect(serviceRpc).not.toHaveBeenCalled()
  })

  it('leaves a failed provider lookup to the RPC instead of failing the request itself', async () => {
    const { ctx, mockResult } = context(); mockResult(imports)
    ensureIdentity.mockRejectedValue(new Error('provider down'))
    serviceRpc.mockResolvedValue({ data: { id }, error: null })
    expect((await route('POST')(request({ consentId: id, resources: ['customers'] }), ctx)).status).toBe(202)
  })

  it('logs the RPC failure code on a 409, not just the status', async () => {
    const { ctx, log, mockResult } = context(); mockResult(imports)
    ensureIdentity.mockResolvedValue('unavailable')
    serviceRpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'MIGRATION_SOURCE_IDENTITY_MISSING' } })
    const response = await route('POST')(request({ consentId: id, resources: ['customers'] }), ctx)
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('MIGRATION_SOURCE_IDENTITY_MISSING')
    expect(log.warn).toHaveBeenCalledWith('create_provider_migration_job refused', {
      consentId: id, failure: 'MIGRATION_SOURCE_IDENTITY_MISSING', pgCode: 'P0001',
    })
    expect(after).not.toHaveBeenCalled()
  })

  it('fills the identity of a renewed consent before resuming a job with it', async () => {
    const { ctx, mockResult } = context()
    mockResult({ data: { id, state: 'needs_attention', resources: ['customers'], fiscal_year_scope: null } })
    serviceRpc.mockResolvedValue({ data: { id }, error: null })
    expect((await route('POST', '/migration-jobs/retry')(request({ jobId: id, consentId: id }), ctx)).status).toBe(202)
    expect(ensureIdentity).toHaveBeenCalledWith('company', id)
    expect(serviceRpc).toHaveBeenCalledWith('create_provider_migration_job', expect.objectContaining({ p_consent_id: id }))
  })
})


describe('migration readiness before SIE work', () => {
  it('refuses selected registers with an actionable 503 before any database or worker call', async () => {
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', '')
    const { ctx, supabase } = context()
    const response = await route('POST', '/migration-jobs/preflight')(request({ resources: ['customers', 'salesInvoices'] }), ctx)
    expect(response.status).toBe(503)
    const body = await response.json()
    expect(body.error.code).toBe('PERSONNUMMER_ENCRYPTION_NOT_CONFIGURED')
    expect(body.error.message).toContain('Administratören')
    expect(supabase.from).not.toHaveBeenCalled()
    expect(serviceRpc).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })
  it('permits SIE-only migration without the register encryption key', async () => {
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', '')
    expect((await route('POST', '/migration-jobs/preflight')(request({ resources: [] }), context().ctx)).status).toBe(200)
  })
  it('permits configured registers without revealing their key', async () => {
    const response = await route('POST', '/migration-jobs/preflight')(request({ resources: ['suppliers'] }), context().ctx)
    expect(await response.json()).toEqual({ data: { ready: true } })
  })
  it('also refuses direct job creation before source discovery or enqueueing', async () => {
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', '')
    const { ctx, supabase } = context()
    expect((await route('POST')(request({ consentId: id, resources: ['customers'] }), ctx)).status).toBe(503)
    expect(supabase.from).not.toHaveBeenCalled()
    expect(ensureIdentity).not.toHaveBeenCalled()
    expect(serviceRpc).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })
  it.each(['run', 'retry'])('refuses %s without a key before changing an existing job', async action => {
    vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', '')
    const { ctx, mockResult } = context()
    mockResult({ data: { id, state: 'needs_attention' } })
    expect((await route('POST', `/migration-jobs/${action}`)(request({ jobId: id }), ctx)).status).toBe(503)
    expect(serviceRpc).not.toHaveBeenCalled()
    expect(after).not.toHaveBeenCalled()
  })
  it('requires authenticated company context even for preflight', async () => {
    expect((await route('POST', '/migration-jobs/preflight')(request({ resources: ['customers'] }))).status).toBe(401)
  })
  it('rejects unknown resources instead of reporting readiness', async () => {
    expect((await route('POST', '/migration-jobs/preflight')(request({ resources: ['unknown'] }), context().ctx)).status).toBe(400)
  })
})


it('describes issue invoice identity without returning encrypted source snapshots', async () => {
  const db = createQueuedMockSupabase()
  const payload = sealMigrationPayload({ invoiceNumber: 'REF-1', issueDate: '2025-06-13', currencyCode: 'SEK',
    legalMonetaryTotal: { payableAmount: { value: 1462 } } }).payload
  db.enqueueMany([{ data: { id, company_id: 'company' } }, { data: [] }, { data: [
    { id: 'issue-1', resource: 'supplierInvoices', source_id: 'source-1', error_code: 'MIGRATION_INVOICE_NUMBER_TAKEN',
      payload, target_id: null, error_phase: 'import' },
    { id: 'issue-2', resource: 'supplierInvoices', source_id: 'source-2', error_code: 'MIGRATION_PAYMENT_REVIEW',
      payload: 'damaged-snapshot', target_id: 'existing-invoice', error_phase: 'reconcile' },
  ] }])
  const ctx = { supabase: db.supabase, companyId: 'company', userId: 'user' } as unknown as ExtensionContext
  const response = await route('GET')(new Request(`http://localhost/jobs?jobId=${id}`), ctx)
  const body = await response.json()
  expect(body.data.issues[0]).toMatchObject({ invoiceNumber: 'REF-1', invoiceDate: '2025-06-13', amount: 1462, currency: 'SEK', errorPhase: 'import' })
  expect(body.data.issues[0]).not.toHaveProperty('payload')
  expect(body.data.issues[1]).toMatchObject({ source_id: 'source-2', targetId: 'existing-invoice', errorPhase: 'reconcile' })
  expect(body.data.issues[1]).not.toHaveProperty('invoiceNumber')
  expect(db.findCalls('migration_job_chunks', 'eq')).toContainEqual(['company_id', 'company'])
})


describe('finish execution while preserving unresolved review', () => {
  it('derives company and actor from the authenticated context and starts no worker', async () => {
    serviceRpc.mockResolvedValue({ data: 3, error: null })
    const response = await route('POST', '/migration-jobs/finish-with-review')(request({ jobId: id }), context().ctx)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { remaining: 3 } })
    expect(serviceRpc).toHaveBeenCalledWith('finish_provider_migration_with_review', { p_job_id: id, p_company_id: 'company', p_user_id: 'user' })
    expect(after).not.toHaveBeenCalled()
  })
  it('rejects unauthenticated, viewer and client-controlled identities', async () => {
    const handler = route('POST', '/migration-jobs/finish-with-review')
    expect((await handler(request({ jobId: id }))).status).toBe(401)
    expect((await handler(request({ jobId: id, companyId: 'foreign' }), context().ctx)).status).toBe(400)
    expect((await handler(request({ jobId: id, userId: 'other' }), context().ctx)).status).toBe(400)
    writePermission.mockResolvedValue({ ok: false, response: new Response('{}', { status: 403 }) })
    expect((await handler(request({ jobId: id }), context().ctx)).status).toBe(403)
    expect(serviceRpc).not.toHaveBeenCalled()
  })
  it('does not claim completion when the locked database decision is refused', async () => {
    serviceRpc.mockResolvedValue({ data: null, error: { message: 'MIGRATION_REVIEW_NOT_FINISHABLE' } })
    expect((await route('POST', '/migration-jobs/finish-with-review')(request({ jobId: id }), context().ctx)).status).toBe(409)
    expect(after).not.toHaveBeenCalled()
  })
  it('permits resuming a completed execution with deferred unresolved records', async () => {
    const db = createQueuedMockSupabase()
    db.enqueueMany([{ data: { id, state: 'completed', review_deferred_at: '2026-11-07T20:00:00Z' } }, { data: [] }, { data: [{ id: 'issue', resource: 'supplierInvoices', source_id: 'source', error_code: 'MIGRATION_PAYMENT_REVIEW' }] }])
    const ctx = { ...context().ctx, supabase: db.supabase } as unknown as ExtensionContext
    serviceRpc.mockResolvedValue({ data: null, error: null })
    expect((await route('POST', '/migration-jobs/retry')(request({ jobId: id }), ctx)).status).toBe(202)
    expect(serviceRpc).toHaveBeenCalledWith('retry_provider_migration_job', { p_job_id: id, p_company_id: 'company', p_user_id: 'user' })
  })
  it('loads saved review runs within the current company', async () => {
    const { ctx, mockResult, supabase } = context()
    mockResult({ data: [{ id, review_deferred_at: '2026-11-07T20:00:00Z', state: 'completed' }] })
    const response = await route('GET', '/migration-jobs/reviews')(new Request('http://localhost/api/jobs/reviews'), ctx)
    expect(response.status).toBe(200)
    expect(supabase.from).toHaveBeenCalledWith('migration_jobs')
    expect(response.headers.get('cache-control')).toBe('no-store')
  })
})

it('passes only selected completed fiscal years as exact invoice scope',async()=>{
  const {ctx,mockResult}=context()
  mockResult({data:[{fiscal_year_start:'2018-06-28',fiscal_year_end:'2018-12-31'},
    {fiscal_year_start:'2019-01-01',fiscal_year_end:'2019-12-31'},
    {fiscal_year_start:'2026-01-01',fiscal_year_end:'2026-12-31'}]})
  serviceRpc.mockResolvedValue({data:{id},error:null})
  expect((await route('POST')(request({consentId:id,resources:['supplierInvoices'],years:[2018,2026]}),ctx)).status).toBe(202)
  expect(serviceRpc).toHaveBeenCalledWith('create_provider_migration_job',expect.objectContaining({p_scope:{
    start:'2018-06-28',end:'2026-12-31',periods:[{start:'2018-06-28',end:'2018-12-31'},{start:'2026-01-01',end:'2026-12-31'}],
  }}))
})
it('refuses unknown or incomplete year scope before creating work',async()=>{
  const {ctx,mockResult}=context()
  mockResult({data:[{fiscal_year_start:'2026-01-01',fiscal_year_end:null}]})
  for(const years of [[2018],[2026]])expect((await route('POST')(request({consentId:id,resources:['supplierInvoices'],years}),ctx)).status).toBe(400)
  expect(serviceRpc).not.toHaveBeenCalled()
})
