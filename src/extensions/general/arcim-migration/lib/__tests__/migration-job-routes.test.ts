import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import { createMockSupabase } from '@/tests/helpers'
const { after, serviceRpc, worker, ensureIdentity, MismatchError } = vi.hoisted(() => ({
  after: vi.fn(), serviceRpc: vi.fn(), worker: vi.fn(), ensureIdentity: vi.fn(),
  MismatchError: class extends Error {
    constructor(public expectedOrgNumber: string, public actualOrgNumber: string, public actualCompanyName: string | null) { super('mismatch') }
  },
}))
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
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
  return { ...mock, log, ctx: { supabase: mock.supabase, companyId: 'company', userId: 'user', log } as unknown as ExtensionContext }
}
beforeEach(() => { vi.clearAllMocks(); ensureIdentity.mockResolvedValue('present') })
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
