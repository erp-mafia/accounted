import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ExtensionContext } from '@/lib/extensions/types'
import { openMigrationPayload, sealMigrationPayload } from '@/lib/providers/migration-payload'
const mocks = vi.hoisted(() => ({ service: vi.fn(), write: vi.fn() }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: mocks.service }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: mocks.write }))
import { migrationCorrectionRoutes } from '../migration-correction-routes'
const jobId = '10000000-0000-4000-8000-000000000001'
const chunkId = '10000000-0000-4000-8000-000000000002'
const request = () => new Request('http://localhost/missing-fields', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ jobId, chunkId, correction: { invoiceNumber: ' INV-42 ' } }) })
const route = (method: string) => migrationCorrectionRoutes.find(r => r.method === method)!.handler
function setup() {
  const db = createQueuedMockSupabase(), service = createQueuedMockSupabase()
  mocks.service.mockReturnValue(service.supabase)
  return { db, service, ctx: { companyId: 'company', userId: 'user', supabase: db.supabase } as unknown as ExtensionContext }
}
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'correction-fixture-only'); mocks.write.mockResolvedValue({ ok: true }) })
afterEach(() => vi.unstubAllEnvs())
describe('staged invoice corrections', () => {
  it('requires authentication and rejects a viewer before reading staged data', async () => {
    expect((await route('POST')(request())).status).toBe(401)
    const { ctx, db } = setup()
    mocks.write.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) })
    expect((await route('POST')(request(), ctx)).status).toBe(403)
    expect(db.calls).toHaveLength(0)
    expect(mocks.service).not.toHaveBeenCalled()
  })
  it('does not expose or modify another company job', async () => {
    const { ctx, db } = setup(); db.enqueue({ data: null })
    expect((await route('POST')(request(), ctx)).status).toBe(404)
    expect(db.findCalls('migration_jobs', 'eq')).toContainEqual(['company_id', 'company'])
    expect(mocks.service).not.toHaveBeenCalled()
  })
  it('encrypts the correction, preserves original data and stamps actor/version', async () => {
    const { ctx, db, service } = setup()
    db.enqueueMany([{ data: { id: jobId, state: 'needs_attention' } }, { data: { id: chunkId,
      payload: sealMigrationPayload({ invoiceNumber: '' }).payload, receipt: { retained: true }, updated_at: 'version-1' } }])
    service.enqueue({ data: { id: chunkId } })
    expect((await route('POST')(request(), ctx)).status).toBe(200)
    const update = service.findCall('migration_job_chunks', 'update')![0] as { receipt: { userCorrection: string; correctedBy: string; retained: boolean } }
    expect(openMigrationPayload(update.receipt.userCorrection)).toEqual({ invoiceNumber: 'INV-42' })
    expect(update.receipt.correctedBy).toBe('user')
    expect(update.receipt.retained).toBe(true)
    expect(update).not.toHaveProperty('payload')
    expect(service.findCalls('migration_job_chunks', 'eq')).toEqual(expect.arrayContaining([
      ['company_id', 'company'], ['job_id', jobId], ['id', chunkId], ['state', 'needs_attention'], ['updated_at', 'version-1'],
    ]))
    expect(service.findCalls('migration_job_chunks', 'is')).toContainEqual(['target_id', null])
  })
  it('refuses a concurrent retry instead of silently reporting saved', async () => {
    const { ctx, db, service } = setup()
    db.enqueueMany([{ data: { id: jobId, state: 'needs_attention' } }, { data: { id: chunkId,
      payload: sealMigrationPayload({ invoiceNumber: '' }).payload, receipt: {}, updated_at: 'v1' } }])
    service.enqueue({ data: null })
    expect((await route('POST')(request(), ctx)).status).toBe(409)
  })
  it('never overwrites a source invoice number', async () => {
    const { ctx, db } = setup()
    db.enqueueMany([{ data: { id: jobId, state: 'needs_attention' } }, { data: { id: chunkId,
      payload: sealMigrationPayload({ invoiceNumber: 'original' }).payload, receipt: {}, updated_at: 'v1' } }])
    expect((await route('POST')(request(), ctx)).status).toBe(409)
    expect(mocks.service).not.toHaveBeenCalled()
  })
  it('pages actionable records and exposes no encrypted payload', async () => {
    const { ctx, db } = setup()
    db.enqueueMany([{ data: { id: jobId, state: 'needs_attention' } }, { data: [{ id: chunkId, source_id: 'source',
      payload: sealMigrationPayload({ invoiceNumber: '', supplier: { name: 'Fixture supplier' }, issueDate: '2026-01-01',
        legalMonetaryTotal: { payableAmount: { value: 100 } }, currencyCode: 'SEK' }).payload }] }])
    const response = await route('GET')(new Request(`http://localhost/missing-fields?jobId=${jobId}`), ctx)
    const body = await response.json()
    expect(body.data.records[0]).toEqual({ id: chunkId, sourceId: 'source', supplier: 'Fixture supplier', date: '2026-01-01', total: 100, currency: 'SEK' })
    expect(db.findCalls('migration_job_chunks', 'limit')).toContainEqual([21])
    expect(db.findCalls('migration_job_chunks', 'is')).toContainEqual(['receipt->userCorrection', null])
  })
})
