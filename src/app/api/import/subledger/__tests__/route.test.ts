import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams } from '@/tests/helpers'
import { SUBLEDGER_COLUMNS } from '@/lib/import/subledger/schema'

const mocks = vi.hoisted(() => ({ auth: vi.fn(), write: vi.fn(), rpc: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: mocks.auth }))
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: mocks.write }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: async () => '00000000-0000-4000-8000-000000000001' }))
import { POST } from '../route'

const row = { counterparty: 'Example AB', invoice_number: '001', invoice_date: '2026-08-31', due_date: '2026-09-20',
  currency: 'SEK', vat_treatment: 'standard_25', total: 1250, vat_amount: 250, remaining_amount: 625,
  voucher_series: 'B', voucher_number: 17, voucher_year: 2026, payment_reference: '' }
const input = { company_id: '00000000-0000-4000-8000-000000000001', kind: 'customer', snapshot_date: '2026-09-21', rows: [row] }
/** Build a JSON request using the valid synthetic import by default. */
const request = (body: unknown = input) => createMockRequest('/api/import/subledger', { method: 'POST', body })
/** Exercise the wrapped route with the current authentication mocks. */
const call = (body: unknown = input) => POST(request(body), createMockRouteParams({}))

describe('hosted subledger import route', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({ user: { id: 'user' }, supabase: { rpc: mocks.rpc } })
    mocks.write.mockResolvedValue({ ok: true })
    mocks.rpc.mockResolvedValue({ data: { difference: 0, token: 'a'.repeat(32) }, error: null })
  })
  it('requires authentication before parsing', async () => {
    mocks.auth.mockResolvedValue({ error: NextResponse.json({}, { status: 401 }) })
    expect((await call()).status).toBe(401); expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('rejects read-only members', async () => {
    mocks.write.mockResolvedValue({ ok: false, response: NextResponse.json({}, { status: 403 }) })
    expect((await call()).status).toBe(403); expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it.each([{ ...input, rows: [] }, { ...input, execute: true }, { ...input, rows: [{ ...row, remaining_amount: 2000 }] }])('validates before RPC', async body => {
    expect((await call(body)).status).toBe(400); expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('rejects a preview from a different active company', async () => {
    expect((await call({ ...input, company_id: '00000000-0000-4000-8000-000000000002' })).status).toBe(409)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })
  it('returns 404 for a missing fiscal period', async () => {
    mocks.rpc.mockResolvedValue({ error: { message: 'SUBLEDGER_PERIOD_NOT_FOUND' } })
    expect((await call()).status).toBe(404)
  })
  it('previews with a session client, company binding, and no execute flag', async () => {
    const response = await call()
    expect(response.status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith('import_file_subledger', expect.objectContaining({ p_company_id: input.company_id, p_execute: false, p_rows: [row] }))
    expect((await response.json()).data.source_rows).toEqual([row])
  })
  it('passes the reviewed token for execution', async () => {
    expect((await call({ ...input, execute: true, preview_token: 'a'.repeat(32) })).status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith('import_file_subledger', expect.objectContaining({ p_execute: true, p_preview_token: 'a'.repeat(32) }))
  })
  it('maps stale previews without exposing database details', async () => {
    mocks.rpc.mockResolvedValue({ error: { message: 'SUBLEDGER_PREVIEW_STALE' } })
    expect((await call()).status).toBe(409)
    mocks.rpc.mockResolvedValue({ error: { message: 'constraint failure secret customer data' } })
    const response = await call(); expect(response.status).toBe(500)
    expect(await response.text()).not.toContain('secret customer')
  })
  it('uploads a template without accepting execute from the multipart form', async () => {
    const form = new FormData()
    for (const [key, value] of Object.entries({ company_id: input.company_id, kind: 'supplier', snapshot_date: input.snapshot_date, execute: 'true' })) form.set(key, value)
    form.set('file', new File([SUBLEDGER_COLUMNS.join(';') + '\n' + SUBLEDGER_COLUMNS.map(key => row[key]).join(';')], 'invoices.csv'))
    const response = await POST(new Request('https://example.test/api/import/subledger', { method: 'POST', body: form }), createMockRouteParams({}))
    expect(response.status).toBe(200)
    expect(mocks.rpc).toHaveBeenCalledWith('import_file_subledger', expect.objectContaining({ p_kind: 'supplier', p_execute: false }))
  })
})
