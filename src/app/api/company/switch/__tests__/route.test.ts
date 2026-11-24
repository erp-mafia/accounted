/**
 * Tests for POST /api/company/switch: the browser session's company switch
 * (lib/company/switch-client.ts), a route handler so that the switch never
 * re-renders the page it leaves.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}))

// The real CompanyContextError stays, so the route's instanceof checks see
// the class the tests throw; only the write itself is mocked.
vi.mock('@/lib/company/context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/company/context')>()),
  setActiveCompany: vi.fn(),
}))

import { createClient } from '@/lib/supabase/server'
import { CompanyContextError, setActiveCompany } from '@/lib/company/context'
import { POST } from '../route'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const mockCreateClient = vi.mocked(createClient)
const mockSetActiveCompany = vi.mocked(setActiveCompany)

const COMPANY_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7'

type Envelope = { error: { code: string; message: string; message_en?: string } }

function buildSupabase(opts: { user: { id: string } | null; verifiedFactor?: boolean }) {
  const factors = opts.verifiedFactor ? [{ status: 'verified' }] : []
  return {
    auth: {
      getUser: vi.fn().mockResolvedValue({ data: { user: opts.user } }),
      mfa: {
        listFactors: async () => ({ data: { all: factors, totp: factors, phone: [] }, error: null }),
      },
    },
    from: vi.fn(),
  }
}

function switchRequest(body: unknown) {
  return createMockRequest('/api/company/switch', { method: 'POST', body })
}

let supabase: ReturnType<typeof buildSupabase>

beforeEach(() => {
  vi.clearAllMocks()
  supabase = buildSupabase({ user: { id: 'user-1' } })
  mockCreateClient.mockResolvedValue(supabase as never)
  mockSetActiveCompany.mockResolvedValue(undefined)
})

describe('POST /api/company/switch', () => {
  it('returns 401 when signed out, without touching the active company', async () => {
    mockCreateClient.mockResolvedValue(buildSupabase({ user: null }) as never)

    const res = await POST(switchRequest({ company_id: COMPANY_ID }))

    expect(res.status).toBe(401)
    expect(mockSetActiveCompany).not.toHaveBeenCalled()
  })

  it('refuses a session below the MFA level its user has enrolled for', async () => {
    mockCreateClient.mockResolvedValue(buildSupabase({ user: { id: 'user-1' }, verifiedFactor: true }) as never)

    const res = await POST(switchRequest({ company_id: COMPANY_ID }))

    expect(res.status).toBe(403)
    expect(mockSetActiveCompany).not.toHaveBeenCalled()
  })

  it('returns 400 for a missing or malformed company_id', async () => {
    for (const body of [{}, { company_id: 'not-a-uuid' }, { company_id: 42 }]) {
      const res = await POST(switchRequest(body))
      expect(res.status).toBe(400)
    }
    expect(mockSetActiveCompany).not.toHaveBeenCalled()
  })

  it('returns 400 for a body that is not JSON', async () => {
    const req = new Request('http://localhost:3000/api/company/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'company_id=x',
    })

    const res = await POST(req)

    expect(res.status).toBe(400)
    expect(mockSetActiveCompany).not.toHaveBeenCalled()
  })

  it('saves the company as active and names it in the answer', async () => {
    const { status, body } = await parseJsonResponse<{ data: { company_id: string } }>(
      await POST(switchRequest({ company_id: COMPANY_ID })),
    )

    expect(status).toBe(200)
    expect(body).toEqual({ data: { company_id: COMPANY_ID } })
    expect(mockSetActiveCompany).toHaveBeenCalledWith(supabase, 'user-1', COMPANY_ID)
  })

  it('maps a missing membership to COMPANY_SWITCH_NOT_MEMBER (403)', async () => {
    mockSetActiveCompany.mockRejectedValueOnce(
      new CompanyContextError('User is not a member of this company', 'not_member'),
    )

    const { status, body } = await parseJsonResponse<Envelope>(await POST(switchRequest({ company_id: COMPANY_ID })))

    expect(status).toBe(403)
    expect(body.error.code).toBe('COMPANY_SWITCH_NOT_MEMBER')
  })

  it('maps a company paused for this membership to COMPANY_SWITCH_LOCKED (403)', async () => {
    mockSetActiveCompany.mockRejectedValueOnce(
      new CompanyContextError('Company is frozen for this membership', 'company_locked'),
    )

    const { status, body } = await parseJsonResponse<Envelope>(await POST(switchRequest({ company_id: COMPANY_ID })))

    expect(status).toBe(403)
    expect(body.error.code).toBe('COMPANY_SWITCH_LOCKED')
  })

  it('maps a failed or unverified write to a retryable COMPANY_SWITCH_PERSIST_FAILED, never to missing access (#701)', async () => {
    mockSetActiveCompany.mockRejectedValueOnce(
      new CompanyContextError('Active company write did not persist', 'persist_failed'),
    )

    const { status, body } = await parseJsonResponse<Envelope>(await POST(switchRequest({ company_id: COMPANY_ID })))

    expect(status).toBe(500)
    expect(body.error.code).toBe('COMPANY_SWITCH_PERSIST_FAILED')
  })

  it('maps an unexpected error to COMPANY_SWITCH_PERSIST_FAILED', async () => {
    mockSetActiveCompany.mockRejectedValueOnce(new Error('connection reset'))

    const { status, body } = await parseJsonResponse<Envelope>(await POST(switchRequest({ company_id: COMPANY_ID })))

    expect(status).toBe(500)
    expect(body.error.code).toBe('COMPANY_SWITCH_PERSIST_FAILED')
    // The raw cause stays in the log, never in the answer.
    expect(JSON.stringify(body)).not.toContain('connection reset')
  })
})
