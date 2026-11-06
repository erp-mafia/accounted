import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ExtensionContext } from '@/lib/extensions/types'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { sealMigrationPayload } from '@/lib/providers/migration-payload'
const mocks = vi.hoisted(() => ({ write: vi.fn(), rpc: vi.fn() }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: mocks.write }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: () => ({ rpc: mocks.rpc }) }))
import { historicalReceivableRoutes } from '../historical-receivable-routes'
const job = '10000000-0000-4000-8000-000000000001', entry = '10000000-0000-4000-8000-000000000002', chunk = '10000000-0000-4000-8000-000000000003'
const route = (method: string) => historicalReceivableRoutes.find(row => row.method === method)!.handler
const post = (extra = {}) => new Request('http://localhost/review', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: job, paymentEntryId: entry, ...extra }) })
function setup() {
  const db = createQueuedMockSupabase()
  const ctx = { companyId: 'company', userId: 'user', supabase: db.supabase } as unknown as ExtensionContext
  return { db, ctx }
}
function queue(db: ReturnType<typeof createQueuedMockSupabase>, bank = 180000) {
  const payload = sealMigrationPayload({ invoiceNumber: '216', issueDate: '2022-09-30', status: 'paid', currencyCode: 'SEK',
    customer: { name: 'Example AB' }, lines: [], paymentStatus: { paid: true, balance: { value: 0 } },
    legalMonetaryTotal: { payableAmount: { value: 180000 } }, _raw: {} }).payload
  db.enqueueMany([
    { data: { id: job, provider: 'bokio', account_key: 'account', state: 'needs_attention', fiscal_year_scope: null } },
    { data: [{ id: entry, entry_date: '2022-11-07', description: 'Faktura #216 betalad av Example AB', source_voucher_series: 'V', source_voucher_number: 93 }] },
    { data: [{ id: chunk, source_id: 'source', payload, payload_hash: 'hash', target_id: null, state: 'needs_attention', error_code: 'MIGRATION_SOURCE_LINES_MISSING' }] },
    { data: [] }, { data: [] },
    { data: [{ journal_entry_id: entry, account_number: '1510', debit_amount: 0, credit_amount: 180000 },
      { journal_entry_id: entry, account_number: '1930', debit_amount: bank, credit_amount: 0 }] },
  ])
}
beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('PERSONNUMMER_ENCRYPTION_KEY', 'historical-review-fixture'); mocks.write.mockResolvedValue({ ok: true }) })
afterEach(() => vi.unstubAllEnvs())
it('does not discover or approve without authenticated company context', async () => {
  expect((await route('GET')(new Request(`http://localhost/review?jobId=${job}`))).status).toBe(401)
  expect((await route('POST')(post())).status).toBe(401)
  expect(mocks.rpc).not.toHaveBeenCalled()
})
it('does not permit a viewer to approve', async () => {
  const { db, ctx } = setup(); mocks.write.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) })
  expect((await route('POST')(post(), ctx)).status).toBe(403)
  expect(db.calls).toHaveLength(0)
  expect(mocks.rpc).not.toHaveBeenCalled()
})
it('rejects client-authored amounts and approval identity', async () => {
  expect((await route('POST')(post({ amount: 1, userId: 'other' }), setup().ctx)).status).toBe(400)
  expect(mocks.rpc).not.toHaveBeenCalled()
})
it('does not expose another company job', async () => {
  const { db, ctx } = setup(); db.enqueue({ data: null })
  expect((await route('POST')(post(), ctx)).status).toBe(404)
  expect(db.findCalls('migration_jobs', 'eq')).toContainEqual(['company_id', 'company'])
  expect(mocks.rpc).not.toHaveBeenCalled()
})
it('GET presents a candidate but writes nothing', async () => {
  const { db, ctx } = setup(); queue(db)
  const response = await route('GET')(new Request(`http://localhost/review?jobId=${job}`), ctx)
  expect(response.status).toBe(200)
  const body = await response.json()
  expect(body.data.findings[0]).toMatchObject({ invoiceNumber: '216', paymentEntryId: entry, origin: 'incomplete_invoice' })
  expect(body.data.findings[0]).not.toHaveProperty('payloadHash')
  expect(db.findCalls('journal_entries', 'eq')).toContainEqual(['status', 'posted'])
  expect(db.findCalls('journal_entries', 'is')).toContainEqual(['reversed_by_id', null])
  expect(mocks.rpc).not.toHaveBeenCalled()
})
it('POST revalidates evidence and derives all persisted values on the server', async () => {
  const { db, ctx } = setup(); queue(db); mocks.rpc.mockResolvedValue({ data: 'historical-id', error: null })
  expect((await route('POST')(post(), ctx)).status).toBe(200)
  expect(mocks.rpc).toHaveBeenCalledWith('review_historical_receivable', expect.objectContaining({
    p_company_id: 'company', p_user_id: 'user', p_job_id: job, p_payment_id: entry, p_decision: 'approved',
    p_finding: expect.objectContaining({ invoiceNumber: '216', paymentAmount: 180000, payloadHash: 'hash' }),
  }))
})
it('refuses approval if the ledger no longer supports the proposed amount', async () => {
  const { db, ctx } = setup(); queue(db, 1)
  expect((await route('POST')(post(), ctx)).status).toBe(409)
  expect(mocks.rpc).not.toHaveBeenCalled()
})
