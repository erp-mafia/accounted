import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  createQueuedMockSupabase,
  parseJsonResponse,
} from '@/tests/helpers'
import { encryptPersonnummer } from '@/lib/salary/personnummer'

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

import { GET } from '../route'

const INVOICE_ID = '550e8400-e29b-41d4-a716-446655440000'

type Body = { data: { deduction_personnummer_masked: string | null } }

describe('GET /api/invoices/[id]/rot-rut', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({
      data: { user: { id: 'user-1', email: 'user@example.com' } },
    })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const response = await GET(
      createMockRequest(`/api/invoices/${INVOICE_ID}/rot-rut`),
      createMockRouteParams({ id: INVOICE_ID }),
    )

    expect(response.status).toBe(401)
  })

  it('returns 400 when the invoice id is not a UUID', async () => {
    const response = await GET(
      createMockRequest('/api/invoices/not-a-uuid/rot-rut'),
      createMockRouteParams({ id: 'not-a-uuid' }),
    )

    expect(response.status).toBe(400)
  })

  it('returns 404 when the invoice is outside the active company', async () => {
    enqueue({ data: null, error: null })

    const response = await GET(
      createMockRequest(`/api/invoices/${INVOICE_ID}/rot-rut`),
      createMockRouteParams({ id: INVOICE_ID }),
    )

    expect(response.status).toBe(404)
    // Scoped by company_id on top of RLS (defense in depth).
    expect(findCalls('invoices', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('returns the personnummer masked as YYYYMMDD-XXXX, never the last four digits', async () => {
    enqueue({
      data: {
        id: INVOICE_ID,
        deduction_personnummer_encrypted: encryptPersonnummer('199001012385'),
        deduction_personnummer_last4: '2385',
      },
      error: null,
    })

    const response = await GET(
      createMockRequest(`/api/invoices/${INVOICE_ID}/rot-rut`),
      createMockRouteParams({ id: INVOICE_ID }),
    )
    const { body } = await parseJsonResponse<Body>(response)

    expect(response.status).toBe(200)
    expect(body.data).toEqual({ deduction_personnummer_masked: '19900101-XXXX' })
    expect(response.headers.get('Cache-Control')).toBe('private, no-store')
    // The ciphertext is selected for the decrypt only: the browser must never
    // get it back alongside a mask.
    expect(JSON.stringify(body)).not.toContain('2385')
    expect(JSON.stringify(body)).not.toContain('deduction_personnummer_encrypted')
  })

  it('returns null when the invoice carries no personnummer', async () => {
    enqueue({ data: { id: INVOICE_ID, deduction_personnummer_encrypted: null }, error: null })

    const response = await GET(
      createMockRequest(`/api/invoices/${INVOICE_ID}/rot-rut`),
      createMockRouteParams({ id: INVOICE_ID }),
    )
    const { body } = await parseJsonResponse<Body>(response)

    expect(response.status).toBe(200)
    expect(body.data.deduction_personnummer_masked).toBeNull()
  })

  it('returns null instead of failing when the stored ciphertext cannot be decrypted', async () => {
    enqueue({
      data: { id: INVOICE_ID, deduction_personnummer_encrypted: 'deadbeef'.repeat(10) },
      error: null,
    })

    const response = await GET(
      createMockRequest(`/api/invoices/${INVOICE_ID}/rot-rut`),
      createMockRouteParams({ id: INVOICE_ID }),
    )
    const { body } = await parseJsonResponse<Body>(response)

    expect(response.status).toBe(200)
    expect(body.data.deduction_personnummer_masked).toBeNull()
  })
})
