import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, parseJsonResponse } from '@/tests/helpers'

vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: vi.fn() }))
vi.mock('@/lib/company/context', () => ({ getActiveCompanyId: vi.fn().mockResolvedValue('company-1') }))
vi.mock('@/lib/supabase/server', () => ({ createServiceClient: () => ({}) }))
const connectionsMock = vi.hoisted(() => ({
  listConnections: vi.fn(),
  summariseConnection: vi.fn((row: { provider: string; receive_state: string }) => ({ provider: row.provider, receive_state: row.receive_state })),
}))
vi.mock('@/lib/digital-mailboxes/connections', () => connectionsMock)
vi.mock('@/lib/digital-mailboxes/providers', () => ({
  digitalMailboxAvailability: () => ({ kivra: { receive: true, send: true }, billo: { receive: true, send: false } }),
}))
const companyMailboxMock = vi.hoisted(() => ({ kivraCompanyMailboxForCompany: vi.fn() }))
vi.mock('@/lib/digital-mailboxes/company-mailbox', () => companyMailboxMock)

import { GET } from '../route'
import { requireAuth } from '@/lib/auth/require-auth'

type Answer = { data: { providers: Record<'kivra' | 'billo', { available: unknown; connection: unknown; company_mailbox?: string }> } }

function authed() {
  vi.mocked(requireAuth).mockResolvedValue({ user: { id: 'user-1' }, supabase: { rpc: vi.fn() }, error: null } as never)
}

describe('GET /api/digital-mailboxes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    connectionsMock.listConnections.mockResolvedValue([])
    companyMailboxMock.kivraCompanyMailboxForCompany.mockResolvedValue('has')
  })

  it('returns 401 when unauthenticated', async () => {
    vi.mocked(requireAuth).mockResolvedValue({
      user: null,
      supabase: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    } as never)
    const response = await GET(createMockRequest('/api/digital-mailboxes'), createMockRouteParams({}))
    expect(response.status).toBe(401)
    expect(companyMailboxMock.kivraCompanyMailboxForCompany).not.toHaveBeenCalled()
  })

  it('answers what each provider can do and its connection, without asking Kivra about the company', async () => {
    authed()
    connectionsMock.listConnections.mockResolvedValue([{ provider: 'billo', receive_state: 'active' }])
    const response = await GET(createMockRequest('/api/digital-mailboxes'), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<Answer>(response)
    expect(status).toBe(200)
    expect(body.data.providers.kivra).toEqual({ available: { receive: true, send: true }, connection: null })
    expect(body.data.providers.billo.connection).toEqual({ provider: 'billo', receive_state: 'active' })
    expect(companyMailboxMock.kivraCompanyMailboxForCompany).not.toHaveBeenCalled()
  })

  it('adds whether the company has a mailbox at Kivra when the caller asks for it', async () => {
    authed()
    const response = await GET(createMockRequest('/api/digital-mailboxes?company_mailbox=1'), createMockRouteParams({}))
    const { status, body } = await parseJsonResponse<Answer>(response)
    expect(status).toBe(200)
    expect(body.data.providers.kivra.company_mailbox).toBe('has')
    expect(body.data.providers.billo.company_mailbox).toBeUndefined()
    expect(companyMailboxMock.kivraCompanyMailboxForCompany).toHaveBeenCalledTimes(1)
    expect(companyMailboxMock.kivraCompanyMailboxForCompany).toHaveBeenCalledWith(expect.anything(), 'company-1', null)
  })

  it('leaves the field out when the question is moot', async () => {
    authed()
    companyMailboxMock.kivraCompanyMailboxForCompany.mockResolvedValue(null)
    const response = await GET(createMockRequest('/api/digital-mailboxes?company_mailbox=1'), createMockRouteParams({}))
    const { body } = await parseJsonResponse<Answer>(response)
    expect(body.data.providers.kivra).not.toHaveProperty('company_mailbox')
  })
})
