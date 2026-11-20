import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase, enqueue, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

const isAdminMock = vi.fn()
vi.mock('@/lib/auth/require-write', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/require-write')>()
  return {
    isCompanyAdmin: (...args: unknown[]) => isAdminMock(...args),
    getCompanyRole: async () => ({ ok: true, role: 'owner', companyId: 'company-1' }),
    companyAdminRequiredResponse: actual.companyAdminRequiredResponse,
  }
})

const storageBucket = {
  upload: vi.fn().mockResolvedValue({ data: {}, error: null }),
  list: vi.fn().mockResolvedValue({ data: [], error: null }),
  remove: vi.fn().mockResolvedValue({ data: [], error: null }),
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: () => ({
    storage: { from: vi.fn().mockReturnValue(storageBucket) },
  }),
}))

import { DELETE, POST } from '../route'

function makeFontRequest(
  size = 8,
  signature: number[] = [0x00, 0x01, 0x00, 0x00],
  name = 'brand.ttf',
): Request {
  const bytes = new Uint8Array(size)
  bytes.set(signature.slice(0, size))
  const formData = new FormData()
  formData.append('file', new File([bytes], name, { type: 'font/ttf' }))
  return new Request('http://localhost/api/settings/invoice-font', {
    method: 'POST',
    body: formData,
  })
}

describe('POST /api/settings/invoice-font', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    isAdminMock.mockResolvedValue(true)
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await POST(makeFontRequest(), { params: Promise.resolve({}) })

    expect(response.status).toBe(401)
  })

  it('refuses a member with 403 before anything reaches the bucket or the row', async () => {
    isAdminMock.mockResolvedValue(false)

    const response = await POST(makeFontRequest(), { params: Promise.resolve({}) })
    const { body } = await parseJsonResponse<{ error: { code: string; details: { required_roles: string[] } } }>(response)

    expect(response.status).toBe(403)
    expect(body.error.code).toBe('FORBIDDEN')
    expect(body.error.details.required_roles).toEqual(['owner', 'admin'])
    expect(storageBucket.upload).not.toHaveBeenCalled()
  })

  it('returns 400 for a file with an invalid font signature', async () => {
    const response = await POST(
      makeFontRequest(8, [0x25, 0x50, 0x44, 0x46]),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(400)
  })

  it('returns 400 when the font exceeds 5 MB', async () => {
    const response = await POST(
      makeFontRequest(5 * 1024 * 1024 + 1),
      { params: Promise.resolve({}) },
    )
    const { body } = await parseJsonResponse<{ error: string }>(response)

    expect(response.status).toBe(400)
    expect(body.error).toContain('5 MB')
  })

  it('returns 404 and takes the upload back when no settings row was written', async () => {
    enqueue({ data: null, error: null })

    const response = await POST(makeFontRequest(), { params: Promise.resolve({}) })

    expect(response.status).toBe(404)
    expect(storageBucket.remove).toHaveBeenCalled()
  })

  it('uploads a valid TTF and selects it for invoice PDFs', async () => {
    enqueue({ data: { company_id: 'company-1' }, error: null })

    const response = await POST(makeFontRequest(), { params: Promise.resolve({}) })
    const { body } = await parseJsonResponse<{
      data: { invoice_font_family: string; invoice_custom_font_name: string }
    }>(response)

    expect(response.status).toBe(200)
    expect(body.data).toMatchObject({
      invoice_font_family: 'Custom',
      invoice_custom_font_name: 'brand.ttf',
    })
    expect(storageBucket.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^company-1\/invoice-font-\d+\.ttf$/),
      expect.any(Buffer),
      expect.objectContaining({ contentType: 'font/ttf' }),
    )
  })

  it('uploads a valid WOFF with its normalized content type', async () => {
    enqueue({ data: { company_id: 'company-1' }, error: null })

    const response = await POST(
      makeFontRequest(8, [0x77, 0x4f, 0x46, 0x46], 'brand.woff'),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(200)
    expect(storageBucket.upload).toHaveBeenCalledWith(
      expect.stringMatching(/^company-1\/invoice-font-\d+\.woff$/),
      expect.any(Buffer),
      expect.objectContaining({ contentType: 'font/woff' }),
    )
  })
})

describe('DELETE /api/settings/invoice-font', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
    isAdminMock.mockResolvedValue(true)
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await DELETE(
      new Request('http://localhost/api/settings/invoice-font', { method: 'DELETE' }),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(401)
  })

  it('refuses a member and leaves the font in place', async () => {
    isAdminMock.mockResolvedValue(false)

    const response = await DELETE(
      new Request('http://localhost/api/settings/invoice-font', { method: 'DELETE' }),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(403)
    expect(storageBucket.remove).not.toHaveBeenCalled()
  })

  it('keeps the file when no settings row was written', async () => {
    enqueue({ data: null, error: null })

    const response = await DELETE(
      new Request('http://localhost/api/settings/invoice-font', { method: 'DELETE' }),
      { params: Promise.resolve({}) },
    )

    expect(response.status).toBe(404)
    expect(storageBucket.remove).not.toHaveBeenCalled()
  })

  it('removes the custom font and restores Helvetica', async () => {
    enqueue({ data: { company_id: 'company-1' }, error: null })

    const response = await DELETE(
      new Request('http://localhost/api/settings/invoice-font', { method: 'DELETE' }),
      { params: Promise.resolve({}) },
    )
    const { body } = await parseJsonResponse<{
      data: { invoice_font_family: string; invoice_custom_font_path: null }
    }>(response)

    expect(response.status).toBe(200)
    expect(body.data).toEqual({
      invoice_font_family: 'Helvetica',
      invoice_custom_font_path: null,
      invoice_custom_font_name: null,
    })
  })
})
