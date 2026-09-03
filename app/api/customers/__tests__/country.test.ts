/**
 * customers.country is ISO 3166-1 alpha-2 and must agree with the customer
 * type and the VAT prefix (#2025, #2028) on POST /api/customers and
 * PATCH /api/customers/[id].
 *
 * Same harness as customer-number.test.ts: the routes run through the real
 * withRouteContext wrapper with a hand-rolled Supabase mock that records
 * insert/update payloads and answers every query with `queryResult`.
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

// Never reach VIES from a unit test.
vi.mock('@/lib/vat/vies-client', () => ({
  validateVatNumber: vi.fn().mockResolvedValue({ valid: false }),
}))

import { POST } from '../route'
import { PATCH } from '../[id]/route'

type CustomerRow = { country?: string }

const CUSTOMER_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  captured.insert.length = 0
  captured.update.length = 0
  queryResult = { data: null, error: null }
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('country on POST /api/customers', () => {
  it('stores a country name as its ISO code (#2028)', async () => {
    queryResult = { data: { id: CUSTOMER_ID, name: 'Muster Handels GmbH', country: 'DE' }, error: null }
    const request = createMockRequest('/api/customers', {
      method: 'POST',
      body: {
        name: 'Muster Handels GmbH',
        customer_type: 'eu_business',
        country: 'Germany',
        vat_number: 'DE811234567',
      },
    })

    const response = await POST(request, { params: Promise.resolve({}) })
    expect(response.status).toBe(200)
    expect((captured.insert[0] as CustomerRow).country).toBe('DE')
  })

  it('derives the EU country from the VAT prefix when none is given', async () => {
    queryResult = { data: { id: CUSTOMER_ID, name: 'Muster Handels GmbH', country: 'DE' }, error: null }
    const request = createMockRequest('/api/customers', {
      method: 'POST',
      body: { name: 'Muster Handels GmbH', customer_type: 'eu_business', vat_number: 'DE811234567' },
    })

    const response = await POST(request, { params: Promise.resolve({}) })
    expect(response.status).toBe(200)
    expect((captured.insert[0] as CustomerRow).country).toBe('DE')
  })

  it('defaults a Swedish business to SE, never to the name Sweden', async () => {
    queryResult = { data: { id: CUSTOMER_ID, name: 'Acme AB', country: 'SE' }, error: null }
    const request = createMockRequest('/api/customers', {
      method: 'POST',
      body: { name: 'Acme AB', customer_type: 'swedish_business' },
    })

    const response = await POST(request, { params: Promise.resolve({}) })
    expect(response.status).toBe(200)
    expect((captured.insert[0] as CustomerRow).country).toBe('SE')
  })

  it('rejects an EU business with land Sverige (#2025)', async () => {
    const request = createMockRequest('/api/customers', {
      method: 'POST',
      body: {
        name: 'Muster Handels GmbH',
        customer_type: 'eu_business',
        country: 'Sverige',
        vat_number: 'DE811234567',
      },
    })

    const response = await POST(request, { params: Promise.resolve({}) })
    expect(response.status).toBe(400)
    const { body } = await parseJsonResponse<{ error: unknown }>(response)
    expect(JSON.stringify(body.error)).toMatch(/country/)
    expect(captured.insert).toHaveLength(0)
  })

  it('rejects a VAT prefix that names another country than the row', async () => {
    const request = createMockRequest('/api/customers', {
      method: 'POST',
      body: { name: 'Muster', customer_type: 'eu_business', country: 'FR', vat_number: 'DE811234567' },
    })

    const response = await POST(request, { params: Promise.resolve({}) })
    expect(response.status).toBe(400)
    expect(captured.insert).toHaveLength(0)
  })

  it('rejects a country it cannot read as a code', async () => {
    const request = createMockRequest('/api/customers', {
      method: 'POST',
      body: { name: 'Acme AB', customer_type: 'swedish_business', country: 'Atlantis' },
    })

    const response = await POST(request, { params: Promise.resolve({}) })
    expect(response.status).toBe(400)
    expect(captured.insert).toHaveLength(0)
  })
})

describe('country on PATCH /api/customers/[id]', () => {
  const params = { params: Promise.resolve({ id: CUSTOMER_ID }) }

  it('normalises a country name before writing it', async () => {
    queryResult = {
      data: { id: CUSTOMER_ID, customer_type: 'swedish_business', country: 'SE', vat_number: null },
      error: null,
    }
    const request = createMockRequest(`/api/customers/${CUSTOMER_ID}`, {
      method: 'PATCH',
      body: { country: 'Sweden' },
    })

    const response = await PATCH(request, params)
    expect(response.status).toBe(200)
    expect((captured.update[0] as CustomerRow).country).toBe('SE')
  })

  it('refuses a type change that contradicts the stored country', async () => {
    queryResult = {
      data: { id: CUSTOMER_ID, customer_type: 'swedish_business', country: 'SE', vat_number: null },
      error: null,
    }
    const request = createMockRequest(`/api/customers/${CUSTOMER_ID}`, {
      method: 'PATCH',
      body: { customer_type: 'eu_business' },
    })

    const response = await PATCH(request, params)
    expect(response.status).toBe(400)
    const { body } = await parseJsonResponse<{ error: { code: string; details?: { issue?: string } } }>(response)
    expect(body.error.code).toBe('CUSTOMER_COUNTRY_MISMATCH')
    expect(body.error.details?.issue).toBe('EU_BUSINESS_COUNTRY_IS_SE')
    expect(captured.update).toHaveLength(0)
  })

  it('refuses a country change that contradicts the stored VAT prefix', async () => {
    queryResult = {
      data: { id: CUSTOMER_ID, customer_type: 'eu_business', country: 'DE', vat_number: 'DE811234567' },
      error: null,
    }
    const request = createMockRequest(`/api/customers/${CUSTOMER_ID}`, {
      method: 'PATCH',
      body: { country: 'Frankrike' },
    })

    const response = await PATCH(request, params)
    expect(response.status).toBe(400)
    const { body } = await parseJsonResponse<{ error: { code: string; details?: { issue?: string } } }>(response)
    expect(body.error.code).toBe('CUSTOMER_COUNTRY_MISMATCH')
    expect(body.error.details?.issue).toBe('VAT_PREFIX_COUNTRY_MISMATCH')
    expect(captured.update).toHaveLength(0)
  })

  it('accepts a country and type changed together into a consistent row', async () => {
    queryResult = {
      data: { id: CUSTOMER_ID, customer_type: 'swedish_business', country: 'SE', vat_number: null },
      error: null,
    }
    const request = createMockRequest(`/api/customers/${CUSTOMER_ID}`, {
      method: 'PATCH',
      body: { customer_type: 'eu_business', country: 'de', vat_number: 'DE811234567' },
    })

    const response = await PATCH(request, params)
    expect(response.status).toBe(200)
    expect((captured.update[0] as CustomerRow).country).toBe('DE')
  })
})
