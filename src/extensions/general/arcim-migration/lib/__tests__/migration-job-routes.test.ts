import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import { createMockSupabase } from '@/tests/helpers'
const { after, serviceRpc, worker } = vi.hoisted(() => ({ after: vi.fn(), serviceRpc: vi.fn(), worker: vi.fn() }))
vi.mock('next/server', async importOriginal => ({ ...await importOriginal<typeof import('next/server')>(), after }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => ({ rpc: serviceRpc }) }))
vi.mock('../migration-job-worker', () => ({ runProviderMigrationWorker: worker, failureCode: () => 'MIGRATION_ALREADY_ACTIVE' }))
import { migrationJobRoutes } from '../migration-job-routes'
const id = '5c4da29a-b51a-44ef-9705-fcf437d6c658'
const route = (method: string, path = '/migration-jobs') => migrationJobRoutes.find(r => r.method === method && r.path === path)!.handler
const request = (body: unknown) => new Request('http://localhost/api/extensions/ext/arcim-migration/migration-jobs', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
function context() {
  const mock = createMockSupabase()
  return { ...mock, ctx: { supabase: mock.supabase, companyId: 'company', userId: 'user', log: { error: vi.fn() } } as unknown as ExtensionContext }
}
beforeEach(() => vi.clearAllMocks())
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
