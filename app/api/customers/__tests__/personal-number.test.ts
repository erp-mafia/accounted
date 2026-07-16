import { NextResponse } from 'next/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import { decryptPersonnummer } from '@/lib/salary/personnummer'

const captured: { insert: unknown[]; update: unknown[] } = { insert: [], update: [] }
let queryResult: { data: unknown; error: unknown } = { data: null, error: null }

const buildChain = (): unknown =>
  new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (value: unknown) => void) => resolve(queryResult)
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

type CustomerWrite = { personal_number?: string | null }

describe('personal_number on customer routes', () => {
  const routeParams = { params: Promise.resolve({ id: 'customer-1' }) }

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    captured.insert.length = 0
    captured.update.length = 0
    queryResult = { data: null, error: null }
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
  })

  it('returns 401 before creating a customer when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(
      createMockRequest('/api/customers', {
        method: 'POST',
        body: { name: 'Anna Andersson', customer_type: 'individual' },
      }),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(401)
    expect(captured.insert).toHaveLength(0)
  })

  it('returns 400 for an invalid personal number', async () => {
    const response = await POST(
      createMockRequest('/api/customers', {
        method: 'POST',
        body: {
          name: 'Anna Andersson',
          customer_type: 'individual',
          personal_number: 'not-a-personal-number',
        },
      }),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(400)
    expect(captured.insert).toHaveLength(0)
  })

  it('stores the personal number when creating a private customer', async () => {
    queryResult = {
      data: {
        id: 'customer-1',
        name: 'Anna Andersson',
        customer_type: 'individual',
        personal_number: '19900101-1234',
      },
      error: null,
    }

    const response = await POST(
      createMockRequest('/api/customers', {
        method: 'POST',
        body: {
          name: 'Anna Andersson',
          customer_type: 'individual',
          personal_number: '19900101-1234',
        },
      }),
      { params: Promise.resolve({}) },
    )

    const { status, body } = await parseJsonResponse<{ data: { personal_number: string } }>(response)
    expect(status).toBe(200)
    const encrypted = (captured.insert[0] as CustomerWrite).personal_number as string
    expect(encrypted).not.toBe('19900101-1234')
    expect(decryptPersonnummer(encrypted)).toBe('19900101-1234')
    expect(body.data.personal_number).toBe('********-1234')
  })

  it('updates the personal number for an existing private customer', async () => {
    queryResult = {
      data: {
        id: 'customer-1',
        customer_type: 'individual',
        personal_number: '900101-1234',
      },
      error: null,
    }

    const response = await PATCH(
      createMockRequest('/api/customers/customer-1', {
        method: 'PATCH',
        body: { personal_number: '900101-1234' },
      }),
      routeParams,
    )

    expect(response.status).toBe(200)
    const encrypted = (captured.update[0] as CustomerWrite).personal_number as string
    expect(encrypted).not.toBe('900101-1234')
    expect(decryptPersonnummer(encrypted)).toBe('900101-1234')
  })

  it('clears the personal number when null is sent', async () => {
    queryResult = {
      data: { id: 'customer-1', customer_type: 'individual', personal_number: null },
      error: null,
    }

    const response = await PATCH(
      createMockRequest('/api/customers/customer-1', {
        method: 'PATCH',
        body: { personal_number: null },
      }),
      routeParams,
    )

    expect(response.status).toBe(200)
    expect((captured.update[0] as CustomerWrite).personal_number).toBeNull()
  })

  it('does not change the personal number when the field is omitted', async () => {
    queryResult = {
      data: { id: 'customer-1', customer_type: 'individual', name: 'Anna A' },
      error: null,
    }

    const response = await PATCH(
      createMockRequest('/api/customers/customer-1', {
        method: 'PATCH',
        body: { name: 'Anna A' },
      }),
      routeParams,
    )

    expect(response.status).toBe(200)
    expect(captured.update[0]).not.toHaveProperty('personal_number')
  })

  it('rejects a personal number for a corporate customer', async () => {
    queryResult = {
      data: { id: 'customer-1', customer_type: 'swedish_business' },
      error: null,
    }

    const response = await PATCH(
      createMockRequest('/api/customers/customer-1', {
        method: 'PATCH',
        body: { personal_number: '900101-1234' },
      }),
      routeParams,
    )

    const { body } = await parseJsonResponse<{ error: { code: string } }>(response)
    expect(response.status).toBe(400)
    expect(body.error.code).toBe('CUSTOMER_PERSONAL_NUMBER_NOT_ALLOWED')
    expect(captured.update).toHaveLength(0)
  })

  it('returns 404 when the customer does not exist', async () => {
    queryResult = {
      data: null,
      error: { code: 'PGRST116', message: 'No rows returned' },
    }

    const response = await PATCH(
      createMockRequest('/api/customers/missing', {
        method: 'PATCH',
        body: { personal_number: '900101-1234' },
      }),
      { params: Promise.resolve({ id: 'missing' }) },
    )

    expect(response.status).toBe(404)
  })
})
