import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'
import { decryptPersonnummer, encryptPersonnummer } from '@/lib/salary/personnummer'

const { supabase: mockSupabase, enqueue, reset, findCall } = createQueuedMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const mockEmit = vi.fn().mockResolvedValue(undefined)
vi.mock('@/lib/events', () => ({ eventBus: { emit: (...a: unknown[]) => mockEmit(...a) } }))

const mockFetchAllRows = vi.fn()
vi.mock('@/lib/supabase/fetch-all', () => ({
  fetchAllRows: (...a: unknown[]) => mockFetchAllRows(...a),
}))

import { POST } from '../route'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const ROUTE_CTX = { params: Promise.resolve({}) }

// Synthetic personnummer, never a real one.
const PERSONAL_NUMBER = '19900101-1234'
const CIPHERTEXT_SHAPE = /^[0-9a-f]{76,255}$/

function row(overrides: Record<string, unknown> = {}) {
  return {
    row_index: 2,
    name: 'Bertil Bengtsson',
    customer_type: 'individual',
    org_number: PERSONAL_NUMBER,
    email: null,
    phone: null,
    address_line1: null,
    address_line2: null,
    postal_code: null,
    city: null,
    country: 'SE',
    vat_number: null,
    default_payment_terms: 30,
    notes: null,
    ...overrides,
  }
}

function makeRequest(body: unknown) {
  return createMockRequest('/api/import/customers/execute', { method: 'POST', body })
}

type CustomerWrite = { org_number?: string | null; personal_number?: string | null }

describe('POST /api/import/customers/execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockFetchAllRows.mockResolvedValue([])
  })

  it('returns 401 for unauthenticated requests', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await POST(makeRequest({ rows: [row()], update_duplicates: false }), ROUTE_CTX)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 400 for an individual whose org number is not a personnummer', async () => {
    const res = await POST(makeRequest({ rows: [row({ org_number: '556677-8899' })], update_duplicates: false }), ROUTE_CTX)
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
    expect(findCall('customers', 'insert')).toBeUndefined()
  })

  it('stores an imported individual\'s personnummer encrypted, with no org number', async () => {
    enqueue({
      data: {
        id: 'c1',
        name: 'Bertil Bengtsson',
        customer_type: 'individual',
        org_number: null,
        email: null,
        personal_number: encryptPersonnummer(PERSONAL_NUMBER),
      },
    })

    const res = await POST(makeRequest({ rows: [row()], update_duplicates: false }), ROUTE_CTX)
    const { status, body } = await parseJsonResponse<{ data: { created: number } }>(res)

    expect(status).toBe(200)
    expect(body.data.created).toBe(1)
    const inserted = findCall('customers', 'insert')![0] as CustomerWrite
    expect(inserted.org_number).toBeNull()
    expect(inserted.personal_number).toMatch(CIPHERTEXT_SHAPE)
    expect(decryptPersonnummer(inserted.personal_number!)).toBe(PERSONAL_NUMBER)
    expect(JSON.stringify(inserted)).not.toContain(PERSONAL_NUMBER)
    // The event carries the masked form, never the ciphertext.
    const payload = mockEmit.mock.calls[0][0] as { payload: { customer: CustomerWrite } }
    expect(payload.payload.customer.personal_number).toBe('********-1234')
  })

  it('keeps a business org number where it is', async () => {
    enqueue({ data: { id: 'c1', name: 'Acme AB', org_number: '5566778899', email: null } })

    const res = await POST(makeRequest({
      rows: [row({ name: 'Acme AB', customer_type: 'swedish_business', org_number: '5566778899' })],
      update_duplicates: false,
    }), ROUTE_CTX)
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    const inserted = findCall('customers', 'insert')![0] as CustomerWrite
    expect(inserted.org_number).toBe('5566778899')
    expect(inserted.personal_number).toBeNull()
  })

  it('does not match an individual by its personnummer, only by email', async () => {
    // A legacy row that still holds the personnummer in org_number.
    mockFetchAllRows.mockResolvedValue([
      { id: 'old', name: 'Bertil', customer_type: 'individual', org_number: PERSONAL_NUMBER, email: null, personal_number: null },
    ])
    enqueue({ data: { id: 'c1', name: 'Bertil Bengtsson', org_number: null, email: null } })

    const res = await POST(makeRequest({ rows: [row()], update_duplicates: false }), ROUTE_CTX)
    const { status, body } = await parseJsonResponse<{ data: { created: number; skipped: number } }>(res)

    expect(status).toBe(200)
    expect(body.data.created).toBe(1)
    expect(body.data.skipped).toBe(0)
  })

  it('merging into a legacy row moves its personnummer out of org_number', async () => {
    mockFetchAllRows.mockResolvedValue([
      {
        id: 'old',
        name: 'Bertil',
        customer_type: 'individual',
        org_number: PERSONAL_NUMBER,
        email: 'bertil@example.test',
        personal_number: null,
      },
    ])
    enqueue({ data: { id: 'old', name: 'Bertil Bengtsson', org_number: null } })

    const res = await POST(makeRequest({
      rows: [row({ org_number: null, email: 'bertil@example.test' })],
      update_duplicates: true,
    }), ROUTE_CTX)
    const { status, body } = await parseJsonResponse<{ data: { updated: number } }>(res)

    expect(status).toBe(200)
    expect(body.data.updated).toBe(1)
    const updated = findCall('customers', 'update')![0] as CustomerWrite
    expect(updated.org_number).toBeNull()
    expect(decryptPersonnummer(updated.personal_number!)).toBe(PERSONAL_NUMBER)
  })

  it('merging a business match into an individual clears its org number', async () => {
    mockFetchAllRows.mockResolvedValue([
      {
        id: 'old',
        name: 'Bertil',
        customer_type: 'swedish_business',
        org_number: '5566778899',
        email: 'bertil@example.test',
        personal_number: null,
      },
    ])
    enqueue({ data: { id: 'old', name: 'Bertil Bengtsson', org_number: null } })

    const res = await POST(makeRequest({
      rows: [row({ org_number: null, email: 'bertil@example.test' })],
      update_duplicates: true,
    }), ROUTE_CTX)
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    const updated = findCall('customers', 'update')![0] as CustomerWrite & { customer_type?: string }
    expect(updated.customer_type).toBe('individual')
    expect(updated.org_number).toBeNull()
    expect(updated.personal_number).toBeUndefined()
  })
})
