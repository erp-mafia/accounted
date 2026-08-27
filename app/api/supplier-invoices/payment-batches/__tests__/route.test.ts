import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, enqueueMany, reset, findCall } =
  createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

import { GET as listBatches, POST as createBatch } from '../route'
import { POST as previewBatch } from '../preview/route'
import { GET as getBatch } from '../[id]/route'
import { GET as downloadFile } from '../[id]/file/route'
import { POST as cancelBatch } from '../[id]/cancel/route'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const UUID_A = '11111111-1111-4111-8111-111111111111'
const UUID_B = '22222222-2222-4222-8222-222222222222'
const BATCH_ID = 'b1111111-1111-4111-8111-111111111111'

const params = (id: string) => ({ params: Promise.resolve({ id }) })

const companyRow = { name: 'Testbolaget AB', org_number: '556677-8899' }
const settingsRow = {
  company_name: 'Testbolaget AB',
  iban: 'SE3550000000054910000003',
  bic: 'ESSESESS',
  clearing_number: null,
  bank_name: null,
}

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: UUID_A,
    status: 'approved',
    approved_at: '2026-08-01T10:00:00Z',
    due_date: '2099-08-20',
    remaining_amount: 737.5,
    currency: 'SEK',
    is_credit_note: false,
    payment_reference: null,
    supplier_invoice_number: 'CD3014794407',
    supplier: {
      id: 'sup-1',
      name: 'Derome Bygg & Industri AB',
      bankgiro: '5050-1055',
      plusgiro: null,
      bank_account: null,
      clearing_number: null,
      account_number: null,
    },
    ...overrides,
  }
}

function batchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: BATCH_ID,
    company_id: 'company-1',
    user_id: 'user-1',
    format: 'pain001',
    status: 'created',
    currency: 'SEK',
    total_amount: 737.5,
    item_count: 1,
    msg_id: 'ACCOUNTED-5566778899-BB1111111',
    debtor_snapshot: {
      name: 'Testbolaget AB',
      org_number: '556677-8899',
      iban: 'SE3550000000054910000003',
      bic: 'ESSESESS',
    },
    file_generated_at: null,
    download_count: 0,
    cancelled_at: null,
    cancelled_by: null,
    created_at: '2026-08-10T12:00:00Z',
    updated_at: '2026-08-10T12:00:00Z',
    ...overrides,
  }
}

function itemRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'item-1',
    batch_id: BATCH_ID,
    company_id: 'company-1',
    supplier_invoice_id: UUID_A,
    amount: 737.5,
    payment_date: '2026-08-15',
    payee_type: 'bankgiro',
    payee_bankgiro: '50501055',
    payee_plusgiro: null,
    payee_clearing: null,
    payee_account: null,
    payee_name: 'Derome Bygg & Industri AB',
    reference_type: 'invoice_number',
    reference: 'CD3014794407',
    created_at: '2026-08-10T12:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
})

describe('POST /api/supplier-invoices/payment-batches/preview', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await previewBatch(
      createMockRequest('/api/supplier-invoices/payment-batches/preview', {
        method: 'POST',
        body: { format: 'pain001', ids: [UUID_A] },
      }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 400 on an invalid body', async () => {
    const response = await previewBatch(
      createMockRequest('/api/supplier-invoices/payment-batches/preview', {
        method: 'POST',
        body: { format: 'bg_lb', ids: [UUID_A] },
      }),
    )
    expect(response.status).toBe(400)
  })

  it('returns the preview with eligible and excluded lines', async () => {
    enqueueMany([
      { data: [invoiceRow()] },
      { data: [] },
      { data: companyRow },
      { data: settingsRow },
    ])
    const response = await previewBatch(
      createMockRequest('/api/supplier-invoices/payment-batches/preview', {
        method: 'POST',
        body: { format: 'pain001', ids: [UUID_A, UUID_B] },
      }),
    )
    const { status, body } = await parseJsonResponse<{
      data: { eligible: unknown[]; excluded: unknown[]; total: number; debtor_ok: boolean }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.eligible).toHaveLength(1)
    expect(body.data.excluded).toEqual([{ id: UUID_B, reason: 'not_found' }])
    expect(body.data.total).toBe(737.5)
    expect(body.data.debtor_ok).toBe(true)
  })
})

describe('POST /api/supplier-invoices/payment-batches', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await createBatch(
      createMockRequest('/api/supplier-invoices/payment-batches', {
        method: 'POST',
        body: { format: 'pain001', items: [{ supplier_invoice_id: UUID_A }] },
      }),
    )
    expect(response.status).toBe(401)
  })

  it('returns 400 on an empty item list', async () => {
    const response = await createBatch(
      createMockRequest('/api/supplier-invoices/payment-batches', {
        method: 'POST',
        body: { format: 'pain001', items: [] },
      }),
    )
    expect(response.status).toBe(400)
  })

  it('creates a batch and returns 201', async () => {
    // Queue is shared between from() and rpc(): the last entry is the
    // create_supplier_payment_batch RPC result.
    enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [] },
      { data: { ok: true, batch: batchRow() } },
    ])
    const response = await createBatch(
      createMockRequest('/api/supplier-invoices/payment-batches', {
        method: 'POST',
        body: { format: 'pain001', items: [{ supplier_invoice_id: UUID_A }] },
      }),
    )
    const { status, body } = await parseJsonResponse<{
      data: { id: string; msg_id: string; item_count: number }
    }>(response)

    expect(status).toBe(201)
    expect(body.data.id).toBe(BATCH_ID)
    expect(body.data.item_count).toBe(1)
  })

  it('maps an ineligible invoice to SI_BATCH_INELIGIBLE_INVOICE', async () => {
    enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow({ status: 'paid' })] },
      { data: [] },
    ])
    const response = await createBatch(
      createMockRequest('/api/supplier-invoices/payment-batches', {
        method: 'POST',
        body: { format: 'pain001', items: [{ supplier_invoice_id: UUID_A }] },
      }),
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { invoices: unknown[] } }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_BATCH_INELIGIBLE_INVOICE')
    expect(body.error.details.invoices).toEqual([{ id: UUID_A, reason: 'not_payable' }])
  })

  it('maps an active-batch collision to SI_BATCH_DUPLICATE_INVOICE (409)', async () => {
    enqueueMany([
      { data: companyRow },
      { data: settingsRow },
      { data: [invoiceRow()] },
      { data: [{ supplier_invoice_id: UUID_A, batch: { id: BATCH_ID, status: 'created' } }] },
    ])
    const response = await createBatch(
      createMockRequest('/api/supplier-invoices/payment-batches', {
        method: 'POST',
        body: { format: 'pain001', items: [{ supplier_invoice_id: UUID_A }] },
      }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_BATCH_DUPLICATE_INVOICE')
  })

  it('maps missing debtor details to SI_BATCH_DEBTOR_INCOMPLETE', async () => {
    enqueueMany([{ data: companyRow }, { data: { ...settingsRow, iban: null } }])
    const response = await createBatch(
      createMockRequest('/api/supplier-invoices/payment-batches', {
        method: 'POST',
        body: { format: 'pain001', items: [{ supplier_invoice_id: UUID_A }] },
      }),
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { missing: string } }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_BATCH_DEBTOR_INCOMPLETE')
    expect(body.error.details.missing).toBe('iban')
  })
})

describe('GET /api/supplier-invoices/payment-batches', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await listBatches(
      createMockRequest('/api/supplier-invoices/payment-batches'),
    )
    expect(response.status).toBe(401)
  })

  it('returns batches with derived settled_count and member invoice ids', async () => {
    enqueueMany([
      { data: [batchRow()] },
      {
        data: [
          {
            batch_id: BATCH_ID,
            supplier_invoice_id: UUID_A,
            invoice: { remaining_amount: 0 },
          },
        ],
      },
    ])
    const response = await listBatches(
      createMockRequest('/api/supplier-invoices/payment-batches', {
        searchParams: { status: 'created' },
      }),
    )
    const { status, body } = await parseJsonResponse<{
      data: Array<{ id: string; settled_count: number; supplier_invoice_ids: string[] }>
    }>(response)

    expect(status).toBe(200)
    expect(body.data).toHaveLength(1)
    expect(body.data[0].settled_count).toBe(1)
    expect(body.data[0].supplier_invoice_ids).toEqual([UUID_A])
  })

  it('rejects an invalid status filter', async () => {
    const response = await listBatches(
      createMockRequest('/api/supplier-invoices/payment-batches', {
        searchParams: { status: 'nonsense' },
      }),
    )
    expect(response.status).toBe(400)
  })
})

describe('GET /api/supplier-invoices/payment-batches/[id]', () => {
  it('returns 404 for an unknown batch', async () => {
    enqueue({ data: null })
    const response = await getBatch(
      createMockRequest(`/api/supplier-invoices/payment-batches/${BATCH_ID}`),
      params(BATCH_ID),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('SI_BATCH_NOT_FOUND')
  })

  it('returns the batch with items and live invoice state', async () => {
    enqueueMany([
      { data: batchRow() },
      {
        data: [
          {
            ...itemRow(),
            invoice: {
              id: UUID_A,
              status: 'approved',
              remaining_amount: 737.5,
              supplier_invoice_number: 'CD3014794407',
              arrival_number: 12,
            },
          },
        ],
      },
    ])
    const response = await getBatch(
      createMockRequest(`/api/supplier-invoices/payment-batches/${BATCH_ID}`),
      params(BATCH_ID),
    )
    const { status, body } = await parseJsonResponse<{
      data: { id: string; items: unknown[] }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.id).toBe(BATCH_ID)
    expect(body.data.items).toHaveLength(1)
  })
})

describe('GET /api/supplier-invoices/payment-batches/[id]/file', () => {
  it('returns 404 for an unknown batch', async () => {
    enqueue({ data: null })
    const response = await downloadFile(
      createMockRequest(`/api/supplier-invoices/payment-batches/${BATCH_ID}/file`),
      params(BATCH_ID),
    )
    expect(response.status).toBe(404)
  })

  it('returns 409 for a cancelled batch', async () => {
    enqueue({ data: batchRow({ status: 'cancelled' }) })
    const response = await downloadFile(
      createMockRequest(`/api/supplier-invoices/payment-batches/${BATCH_ID}/file`),
      params(BATCH_ID),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_BATCH_CANCELLED')
  })

  it('serves the XML attachment and stamps the download', async () => {
    enqueueMany([
      { data: batchRow() },
      { data: [itemRow()] },
      { data: null },
    ])
    const response = await downloadFile(
      createMockRequest(`/api/supplier-invoices/payment-batches/${BATCH_ID}/file`),
      params(BATCH_ID),
    )

    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('application/xml; charset=utf-8')
    expect(response.headers.get('Content-Disposition')).toBe(
      'attachment; filename="betalfil_20260810_b1111111.xml"',
    )
    const xml = await response.text()
    expect(xml).toContain('<MsgId>ACCOUNTED-5566778899-BB1111111</MsgId>')
    expect(xml).toContain('<MmbId>9900</MmbId>')

    const stamp = findCall('supplier_payment_batches', 'update')?.[0] as Record<string, unknown>
    expect(stamp.download_count).toBe(1)
    expect(stamp.file_generated_at).toBeTruthy()
  })
})

describe('POST /api/supplier-invoices/payment-batches/[id]/cancel', () => {
  it('cancels an active batch', async () => {
    enqueue({
      data: { id: BATCH_ID, status: 'cancelled', cancelled_at: '2026-08-10T13:00:00Z' },
    })
    const response = await cancelBatch(
      createMockRequest(`/api/supplier-invoices/payment-batches/${BATCH_ID}/cancel`, {
        method: 'POST',
      }),
      params(BATCH_ID),
    )
    const { status, body } = await parseJsonResponse<{ data: { status: string } }>(response)
    expect(status).toBe(200)
    expect(body.data.status).toBe('cancelled')
  })

  it('returns ALREADY_CANCELLED when the CAS update matches nothing but the batch exists', async () => {
    enqueueMany([
      { data: null },
      { data: batchRow({ status: 'cancelled' }) },
    ])
    const response = await cancelBatch(
      createMockRequest(`/api/supplier-invoices/payment-batches/${BATCH_ID}/cancel`, {
        method: 'POST',
      }),
      params(BATCH_ID),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_BATCH_ALREADY_CANCELLED')
  })

  it('returns 404 when the batch does not exist at all', async () => {
    enqueueMany([{ data: null }, { data: null }])
    const response = await cancelBatch(
      createMockRequest(`/api/supplier-invoices/payment-batches/${BATCH_ID}/cancel`, {
        method: 'POST',
      }),
      params(BATCH_ID),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(status).toBe(404)
    expect(body.error.code).toBe('SI_BATCH_NOT_FOUND')
  })
})
