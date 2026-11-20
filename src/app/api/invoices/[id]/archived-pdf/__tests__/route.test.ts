import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import type { ActiveCompanyFacts } from '@/lib/company/active-company'
import type { CompanyRole } from '@/types'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
const scoped = createQueuedMockSupabase()
const state = vi.hoisted(() => ({ role: 'member' as CompanyRole | undefined }))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn(async (_supabase: unknown, _userId: string, facts?: ActiveCompanyFacts) => {
    if (facts && state.role) facts.role = state.role
    return 'company-1'
  }),
}))

vi.mock('@/lib/auth/company-scoped-client', () => ({
  createCompanyScopedClient: vi.fn(() => scoped.supabase),
}))

const mockLoadArchived = vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: false, code: 'INVOICE_RESEND_NO_ARCHIVED_COPY' }))
vi.mock('@/lib/invoices/archived-invoice-pdf', () => ({
  loadArchivedInvoicePdf: (...args: unknown[]) => mockLoadArchived(...args),
}))

import { GET } from '../route'

const INVOICE_ID = '550e8400-e29b-41d4-a716-446655440000'
const DELIVERY_ID = '7f3c2a10-1b2c-4d5e-8f90-123456789abc'
const PDF = new Uint8Array([37, 80, 68, 70]).buffer
const ARCHIVED = {
  ok: true,
  value: { delivery: { id: DELIVERY_ID, sent_at: '2026-10-01T08:00:00.000Z' }, document: { id: 'doc-1', sha256Hash: 'sha' }, filename: 'Faktura-2026-0042.pdf', bytes: PDF },
}

function get(query = '', id = INVOICE_ID) {
  return GET(createMockRequest(`/api/invoices/${id}/archived-pdf${query}`), createMockRouteParams({ id }))
}

describe('GET /api/invoices/[id]/archived-pdf', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    scoped.reset()
    state.role = 'member'
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'user@example.com' } } })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    expect((await get()).status).toBe(401)
    expect(mockLoadArchived).not.toHaveBeenCalled()
  })

  it('returns 400 for an invoice id or a delivery id that is not a uuid', async () => {
    expect((await get('', 'not-a-uuid')).status).toBe(400)
    expect((await get('?delivery=../../other')).status).toBe(400)
    expect(mockLoadArchived).not.toHaveBeenCalled()
  })

  it('returns 404 for an invoice outside the active company, before any file is looked for', async () => {
    enqueue({ data: null, error: null })
    const response = await get(`?delivery=${DELIVERY_ID}`)
    expect(response.status).toBe(404)
    expect(mockLoadArchived).not.toHaveBeenCalled()
  })

  it('serves the archived PDF of the named delivery inline, read as the member\'s own session', async () => {
    enqueue({ data: { id: INVOICE_ID }, error: null })
    mockLoadArchived.mockResolvedValue(ARCHIVED)

    const response = await get(`?delivery=${DELIVERY_ID}`)

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/pdf')
    expect(response.headers.get('Content-Disposition')).toContain('inline')
    expect(response.headers.get('Content-Disposition')).toContain('Faktura-2026-0042.pdf')
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(PDF))
    expect(mockLoadArchived).toHaveBeenCalledWith(mockSupabase, 'company-1', INVOICE_ID, expect.anything(), { deliveryId: DELIVERY_ID })
  })

  it('without a delivery serves the latest emailed copy: the reader decides which', async () => {
    enqueue({ data: { id: INVOICE_ID }, error: null })
    mockLoadArchived.mockResolvedValue(ARCHIVED)
    expect((await get()).status).toBe(200)
    expect(mockLoadArchived).toHaveBeenCalledWith(mockSupabase, 'company-1', INVOICE_ID, expect.anything(), {})
  })

  it('for the invoicing-only role reads through the company-scoped client, for the signed-in member by name (for #206)', async () => {
    state.role = 'invoicer'
    scoped.enqueue({ data: { id: INVOICE_ID }, error: null })
    mockLoadArchived.mockResolvedValue(ARCHIVED)

    const response = await get(`?delivery=${DELIVERY_ID}`)

    expect(response.status).toBe(200)
    expect(mockLoadArchived).toHaveBeenCalledWith(scoped.supabase, 'company-1', INVOICE_ID, expect.anything(), {
      deliveryId: DELIVERY_ID,
      serviceActorUserId: 'user-1',
    })
    // The invoice itself was looked up in the company first, on the same client.
    expect(scoped.findCall('invoices', 'eq')).toBeDefined()
    expect(scoped.findCalls('invoices', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('answers 404 when the delivery kept no file and 503 when the file cannot be read, never another document', async () => {
    enqueue({ data: { id: INVOICE_ID }, error: null })
    mockLoadArchived.mockResolvedValue({ ok: false, code: 'INVOICE_RESEND_NO_ARCHIVED_COPY' })
    const none = await get(`?delivery=${DELIVERY_ID}`)
    expect(none.status).toBe(404)
    expect(JSON.stringify((await parseJsonResponse(none)).body)).toContain('ingen sparad kopia')

    enqueue({ data: { id: INVOICE_ID }, error: null })
    mockLoadArchived.mockResolvedValue({ ok: false, code: 'INVOICE_RESEND_ARCHIVE_UNAVAILABLE' })
    const unreadable = await get(`?delivery=${DELIVERY_ID}`)
    expect(unreadable.status).toBe(503)
    expect(JSON.stringify((await parseJsonResponse(unreadable)).body)).not.toContain('e-post')
  })
})
