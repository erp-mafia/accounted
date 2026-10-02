import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeInvoice,
} from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'
import type { Invoice, InvoiceItem } from '@/types'

/**
 * The /api/rot-rut routes with grön teknik (crm#209, #3135): the eligible
 * list serves a grön teknik list and counts other kinds, the request history
 * accepts the gron_teknik filter, and the HUS file refuses gron_teknik.
 */

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
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

vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: vi.fn(),
}))

import { GET as eligibleGET } from '../eligible/route'
import { POST as payoutFilePOST } from '../payout-file/route'
import { GET as requestsGET } from '../payout-requests/route'

/** Static routes take an empty params context. */
const NO_PARAMS = { params: Promise.resolve({} as Record<string, never>) }

const GRON_ID = '44444444-4444-4444-8444-444444444444'
const ROT_ID = '55555555-5555-4555-8555-555555555555'
// Skatteverket official example personnummer (synthetic).
const PNR = '198406012388'

function gronItem(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-gron',
    invoice_id: GRON_ID,
    sort_order: 0,
    line_type: 'product',
    description: 'Laddbox med installation',
    quantity: 1,
    unit: 'st',
    unit_price: 16000,
    line_total: 16000,
    vat_rate: 25,
    vat_amount: 4000,
    deduction_type: 'gron_teknik',
    deduction_amount: 10000,
    labor_hours: 20,
    work_type: 'INSTALLATION_LADDPUNKT',
    housing_designation: 'Exempelby 1:1',
    apartment_number: null,
    brf_org_number: null,
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  }
}

function paid(id: string, items: InvoiceItem[], deduction: number): Invoice {
  return makeInvoice({
    id,
    status: 'paid',
    paid_at: '2026-09-20T10:00:00Z',
    deduction_total: deduction,
    deduction_personnummer_encrypted: encryptPersonnummer(PNR),
    items,
  })
}

const gronInvoice = () => paid(GRON_ID, [gronItem()], 10000)
const rotInvoice = () =>
  paid(ROT_ID, [gronItem({ id: 'item-rot', invoice_id: ROT_ID, deduction_type: 'rot', work_type: 'EL', deduction_amount: 6000 })], 6000)

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
})

describe('GET /api/rot-rut/eligible?type=gron_teknik', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const response = await eligibleGET(
      createMockRequest('/api/rot-rut/eligible', { searchParams: { type: 'gron_teknik' } }),
      NO_PARAMS,
    )
    expect(response.status).toBe(401)
  })

  it('lists paid grön teknik invoices with the e-tjänst figures and counts ROT/RUT ones', async () => {
    enqueue({ data: [gronInvoice(), rotInvoice()] }) // by header total
    enqueue({ data: [] }) // by deduction lines
    enqueue({ data: [] }) // no active request items

    const response = await eligibleGET(
      createMockRequest('/api/rot-rut/eligible', { searchParams: { type: 'gron_teknik' } }),
      NO_PARAMS,
    )
    const { status, body } = await parseJsonResponse<{
      data: {
        type: string
        eligible: Array<{ invoice_id: string; begart_belopp: number; installations: Array<{ kostnad: number; betalt_belopp: number }> }>
        blocked: unknown[]
        other_type_counts: Record<string, number>
      }
    }>(response)

    expect(status).toBe(200)
    expect(body.data.type).toBe('gron_teknik')
    expect(body.data.eligible.map((e) => e.invoice_id)).toEqual([GRON_ID])
    expect(body.data.eligible[0].begart_belopp).toBe(10000)
    expect(body.data.eligible[0].installations).toEqual([
      expect.objectContaining({ work_type: 'INSTALLATION_LADDPUNKT', kostnad: 20000, betalt_belopp: 10000 }),
    ])
    expect(body.data.blocked).toEqual([])
    expect(body.data.other_type_counts).toEqual({ rot: 1 })
  })

  it('counts grön teknik invoices on the ROT list instead of offering them for a HUS file', async () => {
    enqueue({ data: [gronInvoice(), rotInvoice()] })
    enqueue({ data: [] })
    enqueue({ data: [] })

    const response = await eligibleGET(createMockRequest('/api/rot-rut/eligible', { searchParams: { type: 'rot' } }), NO_PARAMS)
    const { body } = await parseJsonResponse<{
      data: { eligible: Array<{ invoice_id: string }>; blocked: unknown[]; other_type_counts: Record<string, number> }
    }>(response)

    expect(body.data.eligible.map((e) => e.invoice_id)).toEqual([ROT_ID])
    expect(body.data.blocked).toEqual([])
    expect(body.data.other_type_counts).toEqual({ gron_teknik: 1 })
  })

  it('reads an unknown type as rot, as it always has', async () => {
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    const response = await eligibleGET(createMockRequest('/api/rot-rut/eligible', { searchParams: { type: 'green' } }), NO_PARAMS)
    const { body } = await parseJsonResponse<{ data: { type: string } }>(response)
    expect(body.data.type).toBe('rot')
  })
})

describe('POST /api/rot-rut/payout-file refuses grön teknik', () => {
  it('returns 400 for deduction_type gron_teknik without touching invoices', async () => {
    const response = await payoutFilePOST(
      createMockRequest('/api/rot-rut/payout-file', {
        method: 'POST',
        body: { deduction_type: 'gron_teknik', invoice_ids: [GRON_ID] },
      }),
      NO_PARAMS,
    )
    expect(response.status).toBe(400)
    expect(findCalls('invoices', 'select')).toHaveLength(0)
  })

  it('blocks a grön teknik invoice id sent as ROT with a pointer to the e-tjänst', async () => {
    enqueue({ data: [gronInvoice()] }) // invoices fetch
    const response = await payoutFilePOST(
      createMockRequest('/api/rot-rut/payout-file', {
        method: 'POST',
        body: { deduction_type: 'rot', invoice_ids: [GRON_ID] },
      }),
      NO_PARAMS,
    )
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { blockers?: Array<{ code: string; message: string }> } }
    }>(response)
    expect(status).toBe(400)
    expect(body.error.details?.blockers?.[0]).toMatchObject({ code: 'NO_DEDUCTION_OF_TYPE' })
    expect(body.error.details?.blockers?.[0].message).toContain('e-tjänst för grön teknik')
  })
})

describe('GET /api/rot-rut/payout-requests?type=gron_teknik', () => {
  it('accepts the filter and lists what the column holds', async () => {
    enqueue({ data: [] })
    const response = await requestsGET(
      createMockRequest('/api/rot-rut/payout-requests', { searchParams: { type: 'gron_teknik' } }),
      NO_PARAMS,
    )
    const { status, body } = await parseJsonResponse<{ data: unknown[] }>(response)
    expect(status).toBe(200)
    expect(body.data).toEqual([])
    expect(findCalls('rot_rut_payout_requests', 'eq')).toContainEqual(['deduction_type', 'gron_teknik'])
  })
})
