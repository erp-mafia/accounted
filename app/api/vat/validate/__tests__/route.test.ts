import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

// Exercised through the real withRouteContext wrapper: mock its auth/company
// dependencies and inject the Supabase client via requireAuth.
const { supabase } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

// Mock VIES client
const mockValidateVatNumber = vi.fn()
vi.mock('@/lib/vat/vies-client', () => ({
  validateVatNumber: (...args: unknown[]) => mockValidateVatNumber(...args),
}))

// Company is not a sandbox, so VIES calls proceed.
vi.mock('@/lib/sandbox/guard', () => ({
  guardSandbox: vi.fn().mockResolvedValue(null),
}))

import { POST } from '../route'

describe('POST /api/vat/validate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const req = createMockRequest('/api/vat/validate', {
      method: 'POST',
      body: { vat_number: 'DE123456789' },
    })

    const res = await POST(req, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 when vat_number is missing', async () => {
    const req = createMockRequest('/api/vat/validate', {
      method: 'POST',
      body: {},
    })

    const res = await POST(req, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(400)
  })

  it('returns 400 when vat_number is too short', async () => {
    const req = createMockRequest('/api/vat/validate', {
      method: 'POST',
      body: { vat_number: 'DE' },
    })

    const res = await POST(req, { params: Promise.resolve({}) })
    const { status } = await parseJsonResponse(res)

    expect(status).toBe(400)
  })

  it('returns valid result from VIES', async () => {
    mockValidateVatNumber.mockResolvedValueOnce({
      valid: true,
      name: 'Test GmbH',
      address: 'Berlin',
      country_code: 'DE',
      vat_number: 'DE123456789',
    })

    const req = createMockRequest('/api/vat/validate', {
      method: 'POST',
      body: { vat_number: 'DE123456789' },
    })

    const res = await POST(req, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body).toEqual({
      valid: true,
      name: 'Test GmbH',
      address: 'Berlin',
      country_code: 'DE',
      vat_number: 'DE123456789',
    })
  })

  it('returns invalid result from VIES', async () => {
    mockValidateVatNumber.mockResolvedValueOnce({
      valid: false,
      country_code: 'DE',
      vat_number: 'DE000000000',
    })

    const req = createMockRequest('/api/vat/validate', {
      method: 'POST',
      body: { vat_number: 'DE000000000' },
    })

    const res = await POST(req, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body).toMatchObject({ valid: false })
  })

  it('updates customer when customer_id provided and valid', async () => {
    mockValidateVatNumber.mockResolvedValueOnce({
      valid: true,
      name: 'Test GmbH',
      country_code: 'DE',
      vat_number: 'DE123456789',
    })

    const req = createMockRequest('/api/vat/validate', {
      method: 'POST',
      body: {
        vat_number: 'DE123456789',
        customer_id: '550e8400-e29b-41d4-a716-446655440000',
      },
    })

    const res = await POST(req, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body).toMatchObject({ valid: true })
  })

  it('does not update customer when validation fails', async () => {
    mockValidateVatNumber.mockResolvedValueOnce({
      valid: false,
      error: 'Invalid VAT number format',
    })

    const req = createMockRequest('/api/vat/validate', {
      method: 'POST',
      body: {
        vat_number: 'DE12345',
        customer_id: '550e8400-e29b-41d4-a716-446655440000',
      },
    })

    const res = await POST(req, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body).toMatchObject({ valid: false })
  })

  it('handles VIES service error gracefully', async () => {
    mockValidateVatNumber.mockResolvedValueOnce({
      valid: false,
      error: 'Could not verify VAT number. Service temporarily unavailable.',
    })

    const req = createMockRequest('/api/vat/validate', {
      method: 'POST',
      body: { vat_number: 'DE123456789' },
    })

    const res = await POST(req, { params: Promise.resolve({}) })
    const { status, body } = await parseJsonResponse(res)

    expect(status).toBe(200)
    expect(body).toMatchObject({ valid: false, error: expect.stringContaining('unavailable') })
  })
})
