import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createQueuedMockSupabase,
} from '@/tests/helpers'

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

import { POST } from '../execute/route'
import type { CustomerImportExecuteResult } from '@/lib/import/customers/types'

type ExecuteBody = { data: CustomerImportExecuteResult }

const mockUser = { id: 'user-1', email: 'test@test.se' }

function row(overrides: Record<string, unknown> = {}) {
  return {
    row_index: 2,
    name: 'Acme AB',
    customer_type: 'swedish_business',
    customer_number: null,
    org_number: '5560217780',
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

function post(body: unknown) {
  const request = createMockRequest('/api/import/customers/execute', { method: 'POST', body })
  return POST(request, { params: Promise.resolve({}) })
}

describe('POST /api/import/customers/execute', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockFetchAllRows.mockResolvedValue([])
  })

  it('returns 401 for unauthenticated requests', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await post({ rows: [row()], update_duplicates: false })
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(401)
  })

  it('returns 400 for an empty rows array', async () => {
    const res = await post({ rows: [], update_duplicates: false })
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('returns 400 for a customer number longer than 32 characters', async () => {
    const res = await post({
      rows: [row({ customer_number: 'K'.repeat(33) })],
      update_duplicates: false,
    })
    const { status } = await parseJsonResponse(res)
    expect(status).toBe(400)
  })

  it('stores the customer number on a new customer', async () => {
    enqueue({ data: { id: 'c1', name: 'Acme AB', org_number: '5560217780', email: null } })

    const res = await post({
      rows: [row({ customer_number: ' 1001 ' })],
      update_duplicates: false,
    })
    const { status, body } = await parseJsonResponse<ExecuteBody>(res)

    expect(status).toBe(200)
    expect(body.data.created).toBe(1)
    const [payload] = findCall('customers', 'insert') as [Record<string, unknown>]
    expect(payload.customer_number).toBe('1001')
  })

  it('accepts a row without the field (client from before the column existed)', async () => {
    enqueue({ data: { id: 'c1', name: 'Acme AB', org_number: '5560217780', email: null } })
    const { customer_number: _omit, ...legacy } = row()

    const res = await post({ rows: [legacy], update_duplicates: false })
    const { status, body } = await parseJsonResponse<ExecuteBody>(res)

    expect(status).toBe(200)
    expect(body.data.created).toBe(1)
    const [payload] = findCall('customers', 'insert') as [Record<string, unknown>]
    expect(payload.customer_number).toBeNull()
  })

  it('writes the customer number onto a matched customer in update mode', async () => {
    mockFetchAllRows.mockResolvedValue([
      { id: 'x', name: 'Acme AB', org_number: '556021-7780', email: null, customer_number: null },
    ])
    enqueue({ data: { id: 'x', name: 'Acme AB', customer_number: '1001' } })

    const res = await post({
      rows: [row({ customer_number: '1001' })],
      update_duplicates: true,
    })
    const { status, body } = await parseJsonResponse<ExecuteBody>(res)

    expect(status).toBe(200)
    expect(body.data.updated).toBe(1)
    const [payload] = findCall('customers', 'update') as [Record<string, unknown>]
    expect(payload.customer_number).toBe('1001')
  })

  it('leaves an existing customer number alone when the file has none', async () => {
    mockFetchAllRows.mockResolvedValue([
      { id: 'x', name: 'Acme AB', org_number: '5560217780', email: null, customer_number: '7' },
    ])
    enqueue({ data: { id: 'x', name: 'Acme AB', customer_number: '7' } })

    const res = await post({ rows: [row()], update_duplicates: true })
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(200)
    const [payload] = findCall('customers', 'update') as [Record<string, unknown>]
    expect(payload).not.toHaveProperty('customer_number')
  })

  it('skips a matched customer when update_duplicates is false', async () => {
    mockFetchAllRows.mockResolvedValue([
      { id: 'x', name: 'Acme AB', org_number: '5560217780', email: null, customer_number: null },
    ])

    const res = await post({
      rows: [row({ customer_number: '1001' })],
      update_duplicates: false,
    })
    const { status, body } = await parseJsonResponse<ExecuteBody>(res)

    expect(status).toBe(200)
    expect(body.data.skipped).toBe(1)
    expect(findCall('customers', 'update')).toBeUndefined()
  })
})
