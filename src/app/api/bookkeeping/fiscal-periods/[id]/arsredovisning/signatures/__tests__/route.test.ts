import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))
vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: (...args: unknown[]) => requireWriteMock(...args),
}))

import { GET, POST } from '../route'

const params = { params: Promise.resolve({ id: 'period-1' }) }
const validBody = { role: 'Styrelseledamot', signer_name: 'Anna Andersson' }

function setup() {
  const mock = createQueuedMockSupabase()
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1' },
    supabase: mock.supabase,
    error: null,
  })
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('annual report signer roster route', () => {
  it('returns 401 without authentication', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await GET(createMockRequest('/x'), params)).status).toBe(401)
  })

  it('returns 400 for an invalid signer', async () => {
    setup()
    const response = await POST(
      createMockRequest('/x', { method: 'POST', body: { role: 'Administrator' } }),
      params,
    )
    expect(response.status).toBe(400)
  })

  it('returns 404 for another company period', async () => {
    const { enqueue } = setup()
    enqueue({ data: null, error: null })
    const response = await POST(
      createMockRequest('/x', { method: 'POST', body: validBody }),
      params,
    )
    expect(response.status).toBe(404)
  })

  it('returns 409 for a duplicate unbound signer', async () => {
    const { enqueue } = setup()
    enqueue({ data: { id: 'period-1' }, error: null })
    enqueue({ data: { id: 'signature-existing' }, error: null })
    const response = await POST(
      createMockRequest('/x', { method: 'POST', body: validBody }),
      params,
    )
    expect(response.status).toBe(409)
  })

  it('creates a new unbound signer roster slot', async () => {
    const { enqueue } = setup()
    enqueue({ data: { id: 'period-1' }, error: null })
    enqueue({ data: null, error: null })
    enqueue({
      data: {
        id: 'signature-1',
        company_id: 'company-1',
        fiscal_period_id: 'period-1',
        role: 'Styrelseledamot',
        signer_name: 'Anna Andersson',
        status: 'pending',
        annual_report_version_id: null,
      },
      error: null,
    })
    const { status, body } = await parseJsonResponse<{
      data: { id: string; annual_report_version_id: null }
    }>(
      await POST(createMockRequest('/x', { method: 'POST', body: validBody }), params),
    )
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ id: 'signature-1', annual_report_version_id: null })
  })
})
