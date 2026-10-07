import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { sealMigrationPayload } from '@/lib/providers/migration-payload'
import { mapBokioToSupplierInvoice } from '@/lib/providers/bokio/mapper'
const { after, serviceRpc, worker } = vi.hoisted(() => ({ after: vi.fn(), serviceRpc: vi.fn(), worker: vi.fn() }))
vi.mock('next/server', async importOriginal => ({ ...await importOriginal<typeof import('next/server')>(), after }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => ({ rpc: serviceRpc }) }))
vi.mock('../migration-job-worker', () => ({
  runProviderMigrationWorker: worker,
  failureCode: (e: Error) => e.message.match(/MIGRATION_[A-Z_]+/)?.[0] ?? 'MIGRATION_RETRY',
}))
vi.mock('../provider-client', () => ({ ensureConsentSourceIdentity: vi.fn(), ProviderCompanyMismatchError: class extends Error {} }))
import { migrationJobRoutes, readMigrationStatus } from '../migration-job-routes'

const jobId = '5c4da29a-b51a-44ef-9705-fcf437d6c658'
const accept = migrationJobRoutes.find(r => r.method === 'POST' && r.path === '/migration-jobs/accept')!.handler
const request = (body: unknown) => new Request('http://localhost/api/extensions/ext/arcim-migration/migration-jobs/accept', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
function context() {
  const mock = createQueuedMockSupabase()
  const log = { error: vi.fn(), warn: vi.fn(), info: vi.fn() }
  return { ...mock, log, ctx: { supabase: mock.supabase, companyId: 'company', userId: 'user', log } as unknown as ExtensionContext }
}
const job = (overrides: Record<string, unknown> = {}) => ({ id: jobId, company_id: 'company', provider: 'bokio',
  phase: 'completed', state: 'needs_attention', error_code: null, ...overrides })

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'migration-review-unit-test-only')
})
afterEach(() => { vi.unstubAllEnvs() })

describe('accepting a reviewed import', () => {
  it('rejects an unauthenticated request before any service work', async () => {
    expect((await accept(request({ jobId }))).status).toBe(401)
    expect(serviceRpc).not.toHaveBeenCalled()
  })
  it('validates the body', async () => {
    for (const body of [{}, { jobId: 'not-a-uuid' }, { jobId, companyId: 'foreign' }]) {
      expect((await accept(request(body), context().ctx)).status).toBe(400)
    }
    expect(serviceRpc).not.toHaveBeenCalled()
  })
  it('does not reveal or accept another company\'s job', async () => {
    const { ctx, enqueue, findCalls } = context()
    enqueue({ data: null })
    expect((await accept(request({ jobId }), ctx)).status).toBe(404)
    expect(findCalls('migration_jobs', 'eq')).toEqual(expect.arrayContaining([['company_id', 'company'], ['id', jobId]]))
    expect(serviceRpc).not.toHaveBeenCalled()
  })
  it.each([
    ['a job paused mid-run', { phase: 'import', state: 'needs_attention', error_code: 'PROVIDER_AUTH_EXPIRED' }],
    ['a running job', { phase: 'link', state: 'running' }],
    ['a job waiting to retry', { phase: 'discover', state: 'retry_wait' }],
  ])('refuses %s: its unprocessed records would vanish', async (_label, state) => {
    const { ctx, enqueue } = context()
    enqueue({ data: job(state) })
    const response = await accept(request({ jobId }), ctx)
    expect(response.status).toBe(409)
    expect((await response.json()).error.code).toBe('MIGRATION_NOT_ACCEPTABLE')
    expect(serviceRpc).not.toHaveBeenCalled()
  })
  it('answers a repeated acceptance with the finished job, without writing again', async () => {
    const { ctx, enqueue } = context()
    enqueue({ data: job({ state: 'completed' }) })
    const response = await accept(request({ jobId }), ctx)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ data: { jobId } })
    expect(serviceRpc).not.toHaveBeenCalled()
  })
  it('finishes a reviewed job as the member who accepted it, and starts no worker', async () => {
    const { ctx, enqueue } = context()
    enqueue({ data: job() })
    serviceRpc.mockResolvedValue({ data: job({ state: 'completed' }), error: null })
    const response = await accept(request({ jobId }), ctx)
    expect(response.status).toBe(200)
    expect(serviceRpc).toHaveBeenCalledWith('accept_provider_migration_job', {
      p_job_id: jobId, p_company_id: 'company', p_user_id: 'user',
    })
    expect(after).not.toHaveBeenCalled()
    expect(worker).not.toHaveBeenCalled()
  })
  it('says the import was not accepted when the database refuses, and logs the code', async () => {
    const { ctx, enqueue, log } = context()
    enqueue({ data: job() })
    serviceRpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'MIGRATION_NOT_ACCEPTABLE' } })
    const response = await accept(request({ jobId }), ctx)
    expect(response.status).toBe(409)
    const body = await response.json()
    expect(body.error.code).toBe('MIGRATION_ACCEPT_FAILED')
    expect(body.error.message).toMatch(/kunde inte godkännas/)
    expect(log.warn).toHaveBeenCalledWith('accept_provider_migration_job refused', {
      jobId, failure: 'MIGRATION_NOT_ACCEPTABLE', pgCode: 'P0001' })
  })
})

describe('the review a finished import stops for', () => {
  const counts = (needsAttention: number) => ({ data: [{ resource: 'supplierInvoices', total: 20, imported: 17, completed: 17,
    skipped: 0, needs_attention: needsAttention, pending: 0, fx_unresolved: 0, vat_unresolved: 0, credit_notes_unlinked: 0 }] })
  const numberless = mapBokioToSupplierInvoice({ id: 'si-1', invoiceDate: '2026-02-10', currency: 'SEK', totalAmount: 450,
    remainingAmount: 0, supplierRef: { id: 'supplier', name: 'Leverantören AB' }, lineItems: [] })

  it('reads no records while the import is still running', async () => {
    const { ctx, enqueue, calls } = context()
    enqueue({ data: job({ phase: 'import', state: 'running' }) })
    enqueue(counts(1))
    const status = await readMigrationStatus(ctx, jobId)
    expect(status?.issues).toEqual([])
    expect(status?.review).toEqual({ total: 1, acceptable: false, unchanged: false, truncated: false })
    expect(calls.some(c => c.table === 'migration_job_chunks')).toBe(false)
  })
  it('names each record from its own snapshot and says whether it reached Accounted', async () => {
    const { ctx, enqueue } = context()
    enqueue({ data: job() })
    enqueue(counts(2))
    enqueue({ data: [
      { id: 'a', resource: 'supplierInvoices', source_id: 'si-1', error_code: 'MIGRATION_SUPPLIER_INVOICE_NUMBER_MISSING',
        error_phase: 'import', target_id: null, receipt: {} },
      { id: 'b', resource: 'salesInvoices', source_id: 'inv-1003', error_code: 'MIGRATION_REGISTRATION_REVIEW',
        error_phase: 'link', target_id: 'invoice-1003', receipt: {
          link: { invoiceNumber: '1003', invoiceDate: '2026-03-02', totalSek: 11200, sourceVoucher: { series: 'K', number: 5 } },
          review: { kind: 'registration', outcome: 'amountMismatch', bookedSek: 11240, expectedSek: 11200 } } },
    ] })
    enqueue({ data: [{ id: 'a', payload: sealMigrationPayload(numberless).payload }, { id: 'b', payload: 'not-a-snapshot' }] })
    const status = await readMigrationStatus(ctx, jobId)
    expect(status?.issues).toEqual([
      expect.objectContaining({ id: 'a', imported: false, repeated: false, error_phase: 'import', voucher: null, review: null,
        label: { number: null, date: '2026-02-10', amount: 450, currency: 'SEK', party: 'Leverantören AB' } }),
      expect.objectContaining({ id: 'b', imported: true, error_phase: 'link', voucher: { series: 'K', number: 5 },
        review: expect.objectContaining({ outcome: 'amountMismatch', bookedSek: 11240 }),
        // An unreadable snapshot falls back to the receipt the import wrote.
        label: { number: '1003', date: '2026-03-02', amount: 11200, currency: 'SEK', party: null } }),
    ])
    expect(status?.review).toEqual({ total: 2, acceptable: true, unchanged: false, truncated: false })
  })
  it('says a retry changed nothing once every record failed again the same way', async () => {
    const { ctx, enqueue } = context()
    enqueue({ data: job() })
    enqueue(counts(2))
    enqueue({ data: ['a', 'b'].map(id => ({ id, resource: 'supplierInvoices', source_id: id, error_code: 'MIGRATION_INVOICE_NUMBER_TAKEN',
      error_phase: 'import', target_id: null, receipt: { previous_error_code: 'MIGRATION_INVOICE_NUMBER_TAKEN' } })) })
    enqueue({ data: [] })
    const status = await readMigrationStatus(ctx, jobId)
    expect(status?.issues.every(issue => issue.repeated)).toBe(true)
    expect(status?.review.unchanged).toBe(true)
  })
  it.each([
    ['a record failed differently this time', 'MIGRATION_INVOICE_AMBIGUOUS', 'MIGRATION_INVOICE_NUMBER_TAKEN'],
    ['a record failed for a passing reason', 'MIGRATION_DETAIL_RETRY', 'MIGRATION_DETAIL_RETRY'],
  ])('keeps the retry when %s', async (_label, previous, current) => {
    const { ctx, enqueue } = context()
    enqueue({ data: job() })
    enqueue(counts(1))
    enqueue({ data: [{ id: 'a', resource: 'supplierInvoices', source_id: 'a', error_code: current,
      error_phase: 'import', target_id: null, receipt: { previous_error_code: previous } }] })
    enqueue({ data: [] })
    const status = await readMigrationStatus(ctx, jobId)
    expect(status?.review.unchanged).toBe(false)
  })
  it('does not call an unlisted remainder unchanged', async () => {
    const { ctx, enqueue } = context()
    enqueue({ data: job() })
    enqueue(counts(600))
    enqueue({ data: [{ id: 'a', resource: 'supplierInvoices', source_id: 'a', error_code: '23502',
      error_phase: 'import', target_id: null, receipt: { previous_error_code: '23502' } }] })
    enqueue({ data: [] })
    const status = await readMigrationStatus(ctx, jobId)
    expect(status?.review).toEqual({ total: 600, acceptable: true, unchanged: false, truncated: true })
  })
})
