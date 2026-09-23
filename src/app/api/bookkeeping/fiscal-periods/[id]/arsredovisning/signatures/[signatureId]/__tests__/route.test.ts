import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const requireAuthMock = vi.fn()
const requireWriteMock = vi.fn()
const createServiceClientMock = vi.fn()
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
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => createServiceClientMock(),
}))

import { DELETE, PATCH } from '../route'

const versionId = '123e4567-e89b-12d3-a456-426614174000'
const params = {
  params: Promise.resolve({ id: 'period-1', signatureId: 'signature-1' }),
}
const signedBody = {
  status: 'signed',
  annual_report_version_id: versionId,
  signing_method: 'paper_original',
  evidence_reference: 'archive:A-1',
  signed_at: '2026-03-01T10:00:00.000Z',
}

function setup() {
  const mock = createQueuedMockSupabase()
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1' },
    supabase: mock.supabase,
    error: null,
  })
  createServiceClientMock.mockReturnValue(mock.supabase)
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('annual report signature transition', () => {
  it('returns 401 without authentication', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect(
      (
        await PATCH(
          createMockRequest('/x', { method: 'PATCH', body: signedBody }),
          params,
        )
      ).status,
    ).toBe(401)
  })

  it('returns 400 when signed evidence is missing', async () => {
    setup()
    const response = await PATCH(
      createMockRequest('/x', { method: 'PATCH', body: { status: 'signed' } }),
      params,
    )
    expect(response.status).toBe(400)
  })

  it('returns 400 for a free-text evidence reference', async () => {
    setup()
    const response = await PATCH(
      createMockRequest('/x', {
        method: 'PATCH',
        body: { ...signedBody, evidence_reference: 'Original i arkiv A-1' },
      }),
      params,
    )
    expect(response.status).toBe(400)
  })

  it('returns 409 when the version is not ready for signature', async () => {
    const { enqueue } = setup()
    enqueue({ data: null })
    const response = await PATCH(
      createMockRequest('/x', { method: 'PATCH', body: signedBody }),
      params,
    )
    expect(response.status).toBe(409)
  })

  it('stores version-bound signature evidence', async () => {
    const { enqueue } = setup()
    enqueue({
      data: {
        id: versionId,
        status: 'ready_for_signature',
        finalized_at: '2026-03-01T08:00:00.000Z',
      },
    })
    enqueue({ data: { id: 'signature-1', annual_report_version_id: versionId, status: 'pending' } })
    enqueue({
      data: {
        id: 'signature-1',
        company_id: 'company-1',
        fiscal_period_id: 'period-1',
        status: 'signed',
        signing_method: 'paper_original',
        evidence_reference: 'archive:A-1',
      },
    })
    const { status, body } = await parseJsonResponse<{
      data: { status: string; evidence_reference: string }
    }>(
      await PATCH(
        createMockRequest('/x', { method: 'PATCH', body: signedBody }),
        params,
      ),
    )
    expect(status).toBe(200)
    expect(body.data.status).toBe('signed')
    expect(body.data.evidence_reference).toBe('archive:A-1')
    expect(createServiceClientMock).toHaveBeenCalledOnce()
  })

  it('rejects a signature date before the version was finalized', async () => {
    const { enqueue } = setup()
    enqueue({
      data: {
        id: versionId,
        status: 'ready_for_signature',
        finalized_at: '2026-03-02T08:00:00.000Z',
      },
    })
    enqueue({ data: { id: 'signature-1', annual_report_version_id: versionId, status: 'pending' } })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(
      await PATCH(
        createMockRequest('/x', { method: 'PATCH', body: signedBody }),
        params,
      ),
    )
    expect(status).toBe(400)
    expect(body.error.code).toBe('ARSREDOVISNING_SIGNATURE_DATE_INVALID')
    expect(createServiceClientMock).not.toHaveBeenCalled()
  })

  it('rejects a future signature date', async () => {
    const { enqueue } = setup()
    enqueue({
      data: {
        id: versionId,
        status: 'ready_for_signature',
        finalized_at: '2026-03-01T08:00:00.000Z',
      },
    })
    enqueue({ data: { id: 'signature-1', annual_report_version_id: versionId, status: 'pending' } })
    const response = await PATCH(
      createMockRequest('/x', {
        method: 'PATCH',
        body: { ...signedBody, signed_at: '2999-03-01T10:00:00.000Z' },
      }),
      params,
    )
    expect(response.status).toBe(400)
  })
})

describe('annual report draft signer removal', () => {
  it('returns 401 without authentication', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await DELETE(createMockRequest('/x', { method: 'DELETE' }), params)).status).toBe(401)
  })

  it('returns 409 when the signer is already bound to a version', async () => {
    const { enqueue } = setup()
    enqueue({ data: null, error: null })
    expect((await DELETE(createMockRequest('/x', { method: 'DELETE' }), params)).status).toBe(409)
  })

  it('removes an unbound pending signer', async () => {
    const { enqueue } = setup()
    enqueue({ data: { id: 'signature-1' }, error: null })
    expect((await DELETE(createMockRequest('/x', { method: 'DELETE' }), params)).status).toBe(204)
  })
})
