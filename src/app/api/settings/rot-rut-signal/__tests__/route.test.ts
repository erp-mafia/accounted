/**
 * Tests for /api/settings/rot-rut-signal — invoice-derived ROT/RUT signal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

function supabaseWithInvoiceCount(count: number | null, error: unknown = null) {
  return {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          gt: vi.fn(async () => ({ count, error })),
        })),
      })),
    })),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/settings/rot-rut-signal', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const res = await GET(createMockRequest('/api/settings/rot-rut-signal'), {})
    expect(res.status).toBe(401)
  })

  it('reports a signal when invoices with ROT/RUT deductions exist', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: supabaseWithInvoiceCount(2),
      error: null,
    })
    const { status, body } = await parseJsonResponse<{ data: { has_rot_rut: boolean } }>(
      await GET(createMockRequest('/api/settings/rot-rut-signal'), {})
    )
    expect(status).toBe(200)
    expect(body.data.has_rot_rut).toBe(true)
  })

  it('reports no signal when no such invoices exist', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: supabaseWithInvoiceCount(0),
      error: null,
    })
    const { status, body } = await parseJsonResponse<{ data: { has_rot_rut: boolean } }>(
      await GET(createMockRequest('/api/settings/rot-rut-signal'), {})
    )
    expect(status).toBe(200)
    expect(body.data.has_rot_rut).toBe(false)
  })

  it('fails closed (no suggestion) on a query error', async () => {
    requireAuthMock.mockResolvedValue({
      user: { id: 'user-1' },
      supabase: supabaseWithInvoiceCount(null, { message: 'boom' }),
      error: null,
    })
    const { status, body } = await parseJsonResponse<{ data: { has_rot_rut: boolean } }>(
      await GET(createMockRequest('/api/settings/rot-rut-signal'), {})
    )
    expect(status).toBe(200)
    expect(body.data.has_rot_rut).toBe(false)
  })
})
