/**
 * Tests for the customer_number field (kundnummer, issue #914) on
 * POST /api/customers and PATCH /api/customers/[id].
 *
 * Exercises the routes through the real withRouteContext wrapper, mocking its
 * auth/company/write dependencies. Uses a hand-rolled Supabase mock that
 * records insert/update payloads so the tests can assert the route-level
 * normalization: the value is trimmed by the Zod schema, and empty string or
 * null clears the column to null.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const captured: { insert: unknown[]; update: unknown[] } = { insert: [], update: [] }
let queryResult: { data: unknown; error: unknown } = { data: null, error: null }

const buildChain = (): unknown =>
  new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => resolve(queryResult)
        }
        return (...args: unknown[]) => {
          if (prop === 'insert') captured.insert.push(args[0])
          if (prop === 'update') captured.update.push(args[0])
          return buildChain()
        }
      },
    },
  )

const supabase = {
  from: vi.fn(() => buildChain()),
  rpc: vi.fn(() => buildChain()),
}

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

import { POST } from '../route'
import { PATCH } from '../[id]/route'

type CustomerRow = { customer_number?: string | null }

describe('customer_number on POST /api/customers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    captured.insert.length = 0
    captured.update.length = 0
    queryResult = { data: null, error: null }
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('rejects a customer_number longer than 32 characters with 400', async () => {
    const request = createMockRequest('/api/customers', {
      method: 'POST',
      body: {
        name: 'Test AB',
        customer_type: 'swedish_business',
        customer_number: 'X'.repeat(33),
      },
    })

    const response = await POST(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(captured.insert).toHaveLength(0)
  })

  it('stores a trimmed customer_number on create', async () => {
    queryResult = {
      data: { id: 'cust-1', name: 'Test AB', customer_type: 'swedish_business', customer_number: '1001' },
      error: null,
    }

    const request = createMockRequest('/api/customers', {
      method: 'POST',
      body: {
        name: 'Test AB',
        customer_type: 'swedish_business',
        customer_number: '  1001  ',
      },
    })

    const response = await POST(request, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse<{ data: CustomerRow }>(response)

    expect(status).toBe(200)
    expect((captured.insert[0] as CustomerRow).customer_number).toBe('1001')
    expect(body.data.customer_number).toBe('1001')
  })

  it('normalizes an empty customer_number to null on create', async () => {
    queryResult = {
      data: { id: 'cust-1', name: 'Test AB', customer_type: 'swedish_business', customer_number: null },
      error: null,
    }

    const request = createMockRequest('/api/customers', {
      method: 'POST',
      body: { name: 'Test AB', customer_type: 'swedish_business', customer_number: '' },
    })

    const response = await POST(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect((captured.insert[0] as CustomerRow).customer_number).toBeNull()
  })

  it('defaults customer_number to null when omitted', async () => {
    queryResult = {
      data: { id: 'cust-1', name: 'Test AB', customer_type: 'swedish_business', customer_number: null },
      error: null,
    }

    const request = createMockRequest('/api/customers', {
      method: 'POST',
      body: { name: 'Test AB', customer_type: 'swedish_business' },
    })

    const response = await POST(request, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect((captured.insert[0] as CustomerRow).customer_number).toBeNull()
  })
})

describe('customer_number on PATCH /api/customers/[id]', () => {
  const routeParams = { params: Promise.resolve({ id: 'cust-1' }) }

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    captured.insert.length = 0
    captured.update.length = 0
    queryResult = {
      data: { id: 'cust-1', customer_type: 'swedish_business' },
      error: null,
    }
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('rejects a customer_number longer than 32 characters with 400', async () => {
    const request = createMockRequest('/api/customers/cust-1', {
      method: 'PATCH',
      body: { customer_number: 'X'.repeat(33) },
    })

    const response = await PATCH(request, routeParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(captured.update).toHaveLength(0)
  })

  it('updates the customer_number', async () => {
    const request = createMockRequest('/api/customers/cust-1', {
      method: 'PATCH',
      body: { customer_number: 'K-42' },
    })

    const response = await PATCH(request, routeParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect((captured.update[0] as CustomerRow).customer_number).toBe('K-42')
  })

  it('clears the customer_number when null is sent', async () => {
    const request = createMockRequest('/api/customers/cust-1', {
      method: 'PATCH',
      body: { customer_number: null },
    })

    const response = await PATCH(request, routeParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect((captured.update[0] as CustomerRow).customer_number).toBeNull()
  })

  it('clears the customer_number when an empty string is sent', async () => {
    const request = createMockRequest('/api/customers/cust-1', {
      method: 'PATCH',
      body: { customer_number: '' },
    })

    const response = await PATCH(request, routeParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect((captured.update[0] as CustomerRow).customer_number).toBeNull()
  })

  it('leaves the customer_number untouched when the field is omitted', async () => {
    const request = createMockRequest('/api/customers/cust-1', {
      method: 'PATCH',
      body: { name: 'New Name AB' },
    })

    const response = await PATCH(request, routeParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(captured.update[0]).not.toHaveProperty('customer_number')
  })
})
