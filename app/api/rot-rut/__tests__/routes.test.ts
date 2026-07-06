import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeInvoice,
} from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import type { Invoice, InvoiceItem } from '@/types'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockUploadDocument = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...args: unknown[]) => mockUploadDocument(...args),
}))

const mockCreatePayoutEntry = vi.fn()
vi.mock('@/lib/bookkeeping/rot-rut-entries', () => ({
  createRotRutPayoutEntry: (...args: unknown[]) => mockCreatePayoutEntry(...args),
}))

import { GET as eligibleGET } from '../eligible/route'
import { POST as payoutFilePOST } from '../payout-file/route'
import { GET as requestsGET } from '../payout-requests/route'
import { PATCH as requestPATCH } from '../payout-requests/[id]/route'
import { POST as settlePOST } from '../payout-requests/[id]/settle/route'

const INVOICE_ID = '11111111-1111-4111-8111-111111111111'
const REQUEST_ID = '22222222-2222-4222-8222-222222222222'
// Skatteverket official example personnummer (synthetic).
const PNR = '198406012388'

const mockUser = { id: 'user-1', email: 'test@test.se' }

function makeRotItem(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: INVOICE_ID,
    sort_order: 0,
    description: 'Snickeri',
    quantity: 1,
    unit: 'tim',
    unit_price: 10000,
    line_total: 10000,
    vat_rate: 25,
    vat_amount: 2500,
    deduction_type: 'rot',
    deduction_amount: 3000,
    labor_hours: 25,
    work_type: 'BYGG',
    housing_designation: 'Stockholm Vasastan 1:23',
    apartment_number: null,
    brf_org_number: null,
    created_at: '2026-06-01T00:00:00Z',
    ...overrides,
  }
}

function makePaidRotInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return makeInvoice({
    id: INVOICE_ID,
    status: 'paid',
    paid_at: '2026-06-20T10:00:00Z',
    deduction_total: 3000,
    deduction_personnummer_encrypted: encryptPersonnummer(PNR),
    items: [makeRotItem()],
    ...overrides,
  })
}

function makePayoutRequestRow(overrides: Record<string, unknown> = {}) {
  return {
    id: REQUEST_ID,
    company_id: 'company-1',
    user_id: 'user-1',
    deduction_type: 'rot',
    name: 'ROT 2026-07-02',
    status: 'generated',
    requested_total: 3000,
    decided_total: null,
    file_name: 'rot_begaran_2026-07-02.xml',
    file_document_id: null,
    settlement_journal_entry_id: null,
    submitted_at: null,
    decided_at: null,
    created_at: '2026-07-02T00:00:00Z',
    updated_at: '2026-07-02T00:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  mockUploadDocument.mockResolvedValue({ id: 'doc-1' })
})

describe('GET /api/rot-rut/eligible', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await eligibleGET(createMockRequest('/api/rot-rut/eligible'))
    expect(response.status).toBe(401)
  })

  it('splits invoices into eligible and blocked', async () => {
    const good = makePaidRotInvoice()
    const missingHours = makePaidRotInvoice({
      id: '33333333-3333-4333-8333-333333333333',
      invoice_number: 'F-BAD',
      items: [makeRotItem({ labor_hours: null })],
    })
    enqueue({ data: [good, missingHours] })
    enqueue({ data: [] }) // no active request items

    const response = await eligibleGET(
      createMockRequest('/api/rot-rut/eligible', { searchParams: { type: 'rot' } }),
    )
    const { status, body } = await parseJsonResponse<{
      data: { eligible: Array<{ invoice_id: string; begart_belopp: number }>; blocked: Array<{ code: string }> }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.eligible).toHaveLength(1)
    expect(body.data.eligible[0].invoice_id).toBe(INVOICE_ID)
    expect(body.data.eligible[0].begart_belopp).toBe(3000)
    expect(body.data.blocked).toHaveLength(1)
    expect(body.data.blocked[0].code).toBe('MISSING_HOURS')
  })

  it('hides invoices already in an active request', async () => {
    enqueue({ data: [makePaidRotInvoice()] })
    enqueue({ data: [{ invoice_id: INVOICE_ID, request: { id: 'r', status: 'submitted', company_id: 'company-1' } }] })

    const response = await eligibleGET(createMockRequest('/api/rot-rut/eligible'))
    const { body } = await parseJsonResponse<{
      data: { eligible: unknown[]; blocked: unknown[] }
    }>(response)

    expect(body.data.eligible).toHaveLength(0)
    expect(body.data.blocked).toHaveLength(0)
  })

  it('returns 500 on database error', async () => {
    enqueue({ data: null, error: { message: 'boom' } })
    const response = await eligibleGET(createMockRequest('/api/rot-rut/eligible'))
    expect(response.status).toBe(500)
  })
})

describe('POST /api/rot-rut/payout-file', () => {
  const validBody = { deduction_type: 'rot', invoice_ids: [INVOICE_ID] }

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await payoutFilePOST(
      createMockRequest('/api/rot-rut/payout-file', { method: 'POST', body: validBody }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 400 on invalid body', async () => {
    const response = await payoutFilePOST(
      createMockRequest('/api/rot-rut/payout-file', {
        method: 'POST',
        body: { deduction_type: 'gront', invoice_ids: [] },
      }),
    )
    expect(response.status).toBe(400)
  })

  it('generates the file, records the request and archives the document', async () => {
    enqueue({ data: [makePaidRotInvoice()] }) // invoices fetch
    enqueue({ data: makePayoutRequestRow() }) // request insert
    enqueue({ data: null }) // items insert
    enqueue({ data: null }) // file_document_id update

    const response = await payoutFilePOST(
      createMockRequest('/api/rot-rut/payout-file', { method: 'POST', body: validBody }),
    )
    const { status, body } = await parseJsonResponse<{
      data: { xml: string; file_name: string; arenden: unknown[]; request: { id: string } }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.xml).toContain('<ns2:RotBegaran>')
    expect(body.data.xml).toContain(`<ns2:Kopare>${PNR}</ns2:Kopare>`)
    expect(body.data.arenden).toHaveLength(1)
    expect(body.data.request.id).toBe(REQUEST_ID)
    expect(mockUploadDocument).toHaveBeenCalledTimes(1)
  })

  it('rejects all-or-nothing when a selected invoice is blocked', async () => {
    enqueue({
      data: [
        makePaidRotInvoice(),
        makePaidRotInvoice({
          id: '33333333-3333-4333-8333-333333333333',
          status: 'sent',
        }),
      ],
    })

    const response = await payoutFilePOST(
      createMockRequest('/api/rot-rut/payout-file', {
        method: 'POST',
        body: {
          deduction_type: 'rot',
          invoice_ids: [INVOICE_ID, '33333333-3333-4333-8333-333333333333'],
        },
      }),
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { blockers: Array<{ code: string }> } }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('ROT_RUT_INVOICES_BLOCKED')
  })

  it('returns 404 when an invoice id does not belong to the company', async () => {
    enqueue({ data: [] })
    const response = await payoutFilePOST(
      createMockRequest('/api/rot-rut/payout-file', { method: 'POST', body: validBody }),
    )
    expect(response.status).toBe(404)
  })

  it('maps the double-request trigger to 409 and rolls back the header row', async () => {
    enqueue({ data: [makePaidRotInvoice()] })
    enqueue({ data: makePayoutRequestRow() })
    enqueue({ data: null, error: { code: '23505', message: 'already included in an active rot/rut payout request' } })
    enqueue({ data: null }) // rollback delete

    const response = await payoutFilePOST(
      createMockRequest('/api/rot-rut/payout-file', { method: 'POST', body: validBody }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('ROT_RUT_INVOICE_CONFLICT')
  })
})

describe('GET /api/rot-rut/payout-requests', () => {
  it('lists requests', async () => {
    enqueue({ data: [makePayoutRequestRow()] })
    const response = await requestsGET(createMockRequest('/api/rot-rut/payout-requests'))
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(response)
    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
  })
})

describe('PATCH /api/rot-rut/payout-requests/[id]', () => {
  const routeParams = createMockRouteParams({ id: REQUEST_ID })

  it('returns 404 for an unknown request', async () => {
    enqueue({ data: null })
    const response = await requestPATCH(
      createMockRequest(`/api/rot-rut/payout-requests/${REQUEST_ID}`, {
        method: 'PATCH',
        body: { status: 'submitted' },
      }),
      routeParams,
    )
    expect(response.status).toBe(404)
  })

  it('rejects an invalid transition', async () => {
    enqueue({ data: makePayoutRequestRow({ status: 'paid' }) })
    const response = await requestPATCH(
      createMockRequest(`/api/rot-rut/payout-requests/${REQUEST_ID}`, {
        method: 'PATCH',
        body: { status: 'submitted' },
      }),
      routeParams,
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('ROT_RUT_INVALID_STATUS_TRANSITION')
  })

  it('requires decided_total for partially_paid', async () => {
    enqueue({ data: makePayoutRequestRow({ status: 'submitted' }) })
    const response = await requestPATCH(
      createMockRequest(`/api/rot-rut/payout-requests/${REQUEST_ID}`, {
        method: 'PATCH',
        body: { status: 'partially_paid' },
      }),
      routeParams,
    )
    expect(response.status).toBe(400)
  })

  it('marks a generated request as submitted', async () => {
    enqueue({ data: makePayoutRequestRow() })
    enqueue({ data: makePayoutRequestRow({ status: 'submitted', submitted_at: '2026-07-02T12:00:00Z' }) })

    const response = await requestPATCH(
      createMockRequest(`/api/rot-rut/payout-requests/${REQUEST_ID}`, {
        method: 'PATCH',
        body: { status: 'submitted' },
      }),
      routeParams,
    )
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(response)
    expect(status).toBe(200)
    expect(body.data.status).toBe('submitted')
  })

  it('records a rejection with decided_total 0', async () => {
    enqueue({ data: makePayoutRequestRow({ status: 'submitted' }) })
    enqueue({ data: makePayoutRequestRow({ status: 'rejected', decided_total: 0 }) })

    const response = await requestPATCH(
      createMockRequest(`/api/rot-rut/payout-requests/${REQUEST_ID}`, {
        method: 'PATCH',
        body: { status: 'rejected' },
      }),
      routeParams,
    )
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(response)
    expect(status).toBe(200)
    expect(body.data.status).toBe('rejected')
  })
})

describe('POST /api/rot-rut/payout-requests/[id]/settle', () => {
  const routeParams = createMockRouteParams({ id: REQUEST_ID })
  const settleBody = { payment_date: '2026-07-10' }

  it('returns 404 for an unknown request', async () => {
    enqueue({ data: null })
    const response = await settlePOST(
      createMockRequest(`/api/rot-rut/payout-requests/${REQUEST_ID}/settle`, {
        method: 'POST',
        body: settleBody,
      }),
      routeParams,
    )
    expect(response.status).toBe(404)
  })

  it('refuses an already settled request', async () => {
    enqueue({
      data: makePayoutRequestRow({
        status: 'paid',
        settlement_journal_entry_id: 'je-1',
      }),
    })
    const response = await settlePOST(
      createMockRequest(`/api/rot-rut/payout-requests/${REQUEST_ID}/settle`, {
        method: 'POST',
        body: settleBody,
      }),
      routeParams,
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(400)
    expect(body.error.code).toBe('ROT_RUT_SETTLE_INVALID_STATE')
  })

  it('books the payout and completes the request as paid', async () => {
    mockCreatePayoutEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: makePayoutRequestRow({ status: 'submitted' }) })
    enqueue({
      data: makePayoutRequestRow({
        status: 'paid',
        settlement_journal_entry_id: 'je-1',
        decided_total: 3000,
      }),
    })
    enqueue({ data: [{ id: 'item-1', requested_amount: 3000 }] })
    enqueue({ data: null }) // item decided_amount update

    const response = await settlePOST(
      createMockRequest(`/api/rot-rut/payout-requests/${REQUEST_ID}/settle`, {
        method: 'POST',
        body: settleBody,
      }),
      routeParams,
    )
    const { status, body } = await parseJsonResponse<{
      data: { journal_entry_id: string; request: { status: string } }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.journal_entry_id).toBe('je-1')
    expect(body.data.request.status).toBe('paid')
    expect(mockCreatePayoutEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ amount: 3000, paymentDate: '2026-07-10' }),
    )
  })

  it('forwards bank_account to the engine and defaults it to undefined', async () => {
    mockCreatePayoutEntry.mockResolvedValue({ id: 'je-3' })
    enqueue({ data: makePayoutRequestRow({ status: 'submitted' }) })
    enqueue({ data: makePayoutRequestRow({ status: 'paid', settlement_journal_entry_id: 'je-3' }) })
    enqueue({ data: [] })

    const response = await settlePOST(
      createMockRequest(`/api/rot-rut/payout-requests/${REQUEST_ID}/settle`, {
        method: 'POST',
        body: { payment_date: '2026-07-10', bank_account: '1920' },
      }),
      routeParams,
    )
    expect(response.status).toBe(200)
    expect(mockCreatePayoutEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ bankAccount: '1920' }),
    )
  })

  it('rejects a non-19xx bank_account', async () => {
    const response = await settlePOST(
      createMockRequest(`/api/rot-rut/payout-requests/${REQUEST_ID}/settle`, {
        method: 'POST',
        body: { payment_date: '2026-07-10', bank_account: '3001' },
      }),
      routeParams,
    )
    expect(response.status).toBe(400)
  })

  it('books a partial payout as partially_paid once the beslut is recorded', async () => {
    mockCreatePayoutEntry.mockResolvedValue({ id: 'je-2' })
    enqueue({ data: makePayoutRequestRow({ status: 'submitted', decided_total: 2000 }) })
    enqueue({
      data: makePayoutRequestRow({ status: 'partially_paid', decided_total: 2000 }),
    })

    const response = await settlePOST(
      createMockRequest(`/api/rot-rut/payout-requests/${REQUEST_ID}/settle`, {
        method: 'POST',
        body: { payment_date: '2026-07-10', amount: 2000 },
      }),
      routeParams,
    )
    const { status, body } = await parseJsonResponse<{ data: { request: { status: string } } }>(response)

    expect(status).toBe(200)
    expect(body.data.request.status).toBe('partially_paid')
  })

  it('refuses a partial settlement before the beslut is recorded', async () => {
    enqueue({ data: makePayoutRequestRow({ status: 'submitted', decided_total: null }) })

    const response = await settlePOST(
      createMockRequest(`/api/rot-rut/payout-requests/${REQUEST_ID}/settle`, {
        method: 'POST',
        body: { payment_date: '2026-07-10', amount: 2000 },
      }),
      routeParams,
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).not.toBe(200)
    expect(body.error.code).toBe('ROT_RUT_SETTLE_INVALID_STATE')
    expect(mockCreatePayoutEntry).not.toHaveBeenCalled()
  })

  it('returns 500 and does not update the request when the engine fails', async () => {
    mockCreatePayoutEntry.mockRejectedValue(new Error('period locked'))
    enqueue({ data: makePayoutRequestRow({ status: 'submitted' }) })

    const response = await settlePOST(
      createMockRequest(`/api/rot-rut/payout-requests/${REQUEST_ID}/settle`, {
        method: 'POST',
        body: settleBody,
      }),
      routeParams,
    )
    expect(response.status).toBe(500)
  })
})
