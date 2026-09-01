/**
 * Auth-wiring + contract tests for /api/expense-claims/suggest-template.
 * The AI service is mocked; these tests pin the 401, validation 400s, the
 * graceful empty answers (AI unavailable, AI error, unknown ids) and the
 * happy path where returned ids are filtered against the candidate list.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createQueuedMockSupabase, createMockRequest, parseJsonResponse } from '@/tests/helpers'

const { supabase, reset } = createQueuedMockSupabase()

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

const generateStructuredMock = vi.fn()
const getAiStatusMock = vi.fn()
vi.mock('@/lib/ai', () => ({
  getAiService: () => ({ generateStructured: generateStructuredMock }),
  getAiStatus: () => getAiStatusMock(),
}))

import { POST } from '../route'

function post(body: unknown) {
  return createMockRequest('/api/expense-claims/suggest-template', { method: 'POST', body })
}

const validBody = {
  description: 'Supabase Pte. Ltd. subscription',
  amount: 250,
  candidates: [
    { id: 'static:software_saas', name: 'Programvara / SaaS', hint: 'Molntjänster' },
    { id: 'static:it_services', name: 'IT-tjänster' },
  ],
}

describe('/api/expense-claims/suggest-template', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase })
    requireWriteMock.mockResolvedValue({ ok: true })
    getAiStatusMock.mockReturnValue({ configured: true })
    generateStructuredMock.mockResolvedValue({ value: { template_ids: ['static:software_saas'] } })
  })

  it('returns 401 when unauthenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await POST(post(validBody), {} as never)
    expect(response.status).toBe(401)
    expect(generateStructuredMock).not.toHaveBeenCalled()
  })

  it('returns 400 when the description is missing', async () => {
    const response = await POST(post({ candidates: validBody.candidates }), {} as never)
    expect(response.status).toBe(400)
  })

  it('returns 400 when candidates are empty', async () => {
    const response = await POST(post({ description: 'Supabase', candidates: [] }), {} as never)
    expect(response.status).toBe(400)
  })

  it('returns empty ids without calling the AI when it is unavailable', async () => {
    getAiStatusMock.mockReturnValue({ configured: false })
    const response = await POST(post(validBody), {} as never)
    const { status, body } = await parseJsonResponse<{ data: { template_ids: string[] } }>(response)
    expect(status).toBe(200)
    expect(body.data.template_ids).toEqual([])
    expect(generateStructuredMock).not.toHaveBeenCalled()
  })

  it('returns the suggested ids, filtered to known candidates', async () => {
    generateStructuredMock.mockResolvedValue({
      value: { template_ids: ['static:software_saas', 'static:not-a-candidate'] },
    })
    const response = await POST(post(validBody), {} as never)
    const { status, body } = await parseJsonResponse<{ data: { template_ids: string[] } }>(response)
    expect(status).toBe(200)
    expect(body.data.template_ids).toEqual(['static:software_saas'])
    expect(generateStructuredMock).toHaveBeenCalledWith(
      expect.objectContaining({ tier: 'extraction' }),
    )
  })

  it('degrades to empty ids when the AI call throws', async () => {
    generateStructuredMock.mockRejectedValue(new Error('model timeout'))
    const response = await POST(post(validBody), {} as never)
    const { status, body } = await parseJsonResponse<{ data: { template_ids: string[] } }>(response)
    expect(status).toBe(200)
    expect(body.data.template_ids).toEqual([])
  })
})
