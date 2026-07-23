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
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: vi.fn(() => ({ rpc: vi.fn() })),
}))
vi.mock('@/lib/bokslut/arsredovisning/model', () => ({
  buildCanonicalAnnualReport: vi.fn(),
}))
vi.mock('@/lib/bokslut/arsredovisning/version-service', () => ({
  createAnnualReportVersion: vi.fn(),
  hasStatementIntegrityErrors: vi.fn(),
  listAnnualReportVersions: vi.fn(),
}))

import { buildCanonicalAnnualReport } from '@/lib/bokslut/arsredovisning/model'
import {
  createAnnualReportVersion,
  hasStatementIntegrityErrors,
  listAnnualReportVersions,
} from '@/lib/bokslut/arsredovisning/version-service'
import { GET, POST } from '../route'

const params = { params: Promise.resolve({ id: 'period-1' }) }
const version = {
  id: 'version-1',
  version_number: 1,
  status: 'draft',
  framework: 'k2',
  content_hash: 'a'.repeat(64),
  taxonomy_version: '2024-09-12',
  entry_point: 'k2-ab-risbs-2024-09-12',
  finalized_at: null,
  created_at: '2026-07-21T10:00:00Z',
}

function setup() {
  const mock = createQueuedMockSupabase()
  requireAuthMock.mockResolvedValue({
    user: { id: 'user-1' },
    supabase: mock.supabase,
    error: null,
  })
  vi.mocked(listAnnualReportVersions).mockResolvedValue([version] as never)
  vi.mocked(createAnnualReportVersion).mockResolvedValue(version as never)
  vi.mocked(buildCanonicalAnnualReport).mockResolvedValue({
    validation: { ok: true },
  } as never)
  vi.mocked(hasStatementIntegrityErrors).mockReturnValue(false)
  return mock
}

beforeEach(() => {
  vi.clearAllMocks()
  requireWriteMock.mockResolvedValue({ ok: true })
})

describe('annual report versions route', () => {
  it('returns 401 without authentication', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: {},
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    expect((await GET(createMockRequest('/x'), params)).status).toBe(401)
  })

  it('returns 400 for an invalid action', async () => {
    setup()
    const response = await POST(
      createMockRequest('/x', { method: 'POST', body: { action: 'delete' } }),
      params,
    )
    expect(response.status).toBe(400)
  })

  it('rejects a client-supplied dividend override', async () => {
    setup()
    const response = await POST(
      createMockRequest('/x', {
        method: 'POST',
        body: { action: 'finalize', proposed_dividend: 100 },
      }),
      params,
    )
    expect(response.status).toBe(400)
    expect(buildCanonicalAnnualReport).not.toHaveBeenCalled()
  })

  it('returns 404 for another company period', async () => {
    const { enqueue } = setup()
    enqueue({ data: null })
    expect((await GET(createMockRequest('/x'), params)).status).toBe(404)
  })

  it('lists immutable versions', async () => {
    const { enqueue } = setup()
    enqueue({ data: { id: 'period-1' } })
    const { body } = await parseJsonResponse<{ data: Array<typeof version> }>(
      await GET(createMockRequest('/x'), params),
    )
    expect(body.data[0].content_hash).toHaveLength(64)
  })

  it('creates a finalized version through the canonical model', async () => {
    const { enqueue } = setup()
    enqueue({ data: { id: 'period-1' } })
    const response = await POST(
      createMockRequest('/x', { method: 'POST', body: { action: 'finalize' } }),
      params,
    )
    expect(response.status).toBe(201)
    expect(buildCanonicalAnnualReport).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'period-1',
      expect.objectContaining({ stage: 'signing' }),
    )
    expect(createAnnualReportVersion).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      expect.anything(),
      true,
    )
  })

  it.each(['snapshot', 'finalize'] as const)(
    'rejects an inconsistent report before creating a %s version',
    async (action) => {
      const { enqueue } = setup()
      enqueue({ data: { id: 'period-1' } })
      vi.mocked(hasStatementIntegrityErrors).mockReturnValue(true)
      vi.mocked(buildCanonicalAnnualReport).mockResolvedValue({
        validation: {
          ok: false,
          issues: [{ code: 'AR-RESULT-MISMATCH', severity: 'error' }],
        },
      } as never)

      const { status, body } = await parseJsonResponse<{
        error: { code: string; message: string; message_en: string }
      }>(
        await POST(
          createMockRequest('/x', { method: 'POST', body: { action } }),
          params,
        ),
      )

      expect(status).toBe(409)
      expect(body.error).toEqual(
        expect.objectContaining({
          code: 'ARSREDOVISNING_INCOMPLETE',
          message: expect.any(String),
          message_en: expect.any(String),
        }),
      )
      expect(createAnnualReportVersion).not.toHaveBeenCalled()
    },
  )

  it('accepts a VD as the fastställelseintyg signer', async () => {
    const { enqueue } = setup()
    enqueue({ data: { id: 'period-1' } })
    const response = await POST(
      createMockRequest('/x', {
        method: 'POST',
        body: {
          action: 'finalize',
          certificate_signer: {
            first_name: 'Anna',
            last_name: 'Andersson',
            role: 'VD',
          },
        },
      }),
      params,
    )
    expect(response.status).toBe(201)
    expect(buildCanonicalAnnualReport).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'period-1',
      expect.objectContaining({
        undertecknare: expect.objectContaining({ role: 'VD' }),
      }),
    )
  })
})
