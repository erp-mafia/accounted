import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

vi.mock('@/lib/parties/scb/config', () => ({
  isScbConfigured: vi.fn(),
  scbConfigFromEnv: vi.fn(() => ({ baseUrl: 'https://scb.test', pfx: Buffer.from('x'), passphrase: 'p', timeoutMs: 1 })),
}))

const searchByName = vi.fn()
vi.mock('@/lib/parties/scb/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/parties/scb/client')>()
  return { ...actual, createScbClient: vi.fn(() => ({ searchByName })) }
})

import { createClient } from '@/lib/supabase/server'
import { isScbConfigured } from '@/lib/parties/scb/config'
import { ScbApiError } from '@/lib/parties/scb/transport'
import { GET } from '../route'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'

const mockCreateClient = vi.mocked(createClient)
const mockIsScbConfigured = vi.mocked(isScbConfigured)

function buildSupabase(user: { id: string } | null) {
  return {
    auth: { getUser: vi.fn().mockResolvedValue({ data: { user } }) },
  }
}

const candidate = (over: Record<string, unknown> = {}) => ({
  orgNumber: '5566778899',
  name: 'Testbrand AB',
  city: 'Malmö',
  industry: null,
  legalForm: 'Aktiebolag',
  legalFormCode: '49',
  status: 'Är verksam',
  active: true,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  mockCreateClient.mockResolvedValue(buildSupabase({ id: 'user-1' }) as never)
  mockIsScbConfigured.mockReturnValue(true)
})

describe('GET /api/company/search', () => {
  it('returns 401 when unauthenticated', async () => {
    mockCreateClient.mockResolvedValue(buildSupabase(null) as never)
    const res = await GET(createMockRequest('/api/company/search?q=Testbrand'))
    expect(res.status).toBe(401)
    expect(searchByName).not.toHaveBeenCalled()
  })

  it('returns 400 for a query shorter than three characters', async () => {
    const res = await GET(createMockRequest('/api/company/search?q=Te'))
    expect(res.status).toBe(400)
    expect(searchByName).not.toHaveBeenCalled()
  })

  it('returns 400 when q is missing', async () => {
    const res = await GET(createMockRequest('/api/company/search'))
    expect(res.status).toBe(400)
  })

  it('returns 400 for a number: that is the orgnr path, not a register scan', async () => {
    const res = await GET(createMockRequest('/api/company/search?q=556677-8899'))
    expect(res.status).toBe(400)
    expect(searchByName).not.toHaveBeenCalled()
  })

  it('returns 503 SCB_NOT_CONFIGURED without credentials', async () => {
    mockIsScbConfigured.mockReturnValue(false)
    const res = await GET(createMockRequest('/api/company/search?q=Testbrand'))
    expect(res.status).toBe(503)
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('SCB_NOT_CONFIGURED')
    expect(searchByName).not.toHaveBeenCalled()
  })

  it('asks SCB with sole traders included and maps the rows the picker needs', async () => {
    searchByName.mockResolvedValue({
      query: 'Testbrand',
      mode: 'starts_with',
      total: 2,
      truncated: false,
      candidates: [candidate(), candidate({ orgNumber: '8001011234', name: 'ANDERSSON, ANNA', legalFormCode: '10', legalForm: 'Fysisk person', city: 'Lund' })],
    })
    const res = await GET(createMockRequest('/api/company/search?q=Testbrand'))
    expect(res.status).toBe(200)
    expect(searchByName).toHaveBeenCalledWith('Testbrand', { includeSoleTraders: true })
    const { body } = await parseJsonResponse<{ data: { suggestions: unknown[]; truncated: boolean } }>(res)
    expect(body.data.truncated).toBe(false)
    expect(body.data.suggestions).toEqual([
      { orgNumber: '5566778899', name: 'Testbrand AB', city: 'Malmö', legalEntityType: 'AB', active: true },
      { orgNumber: '8001011234', name: 'ANDERSSON, ANNA', city: 'Lund', legalEntityType: 'EF', active: true },
    ])
  })

  it('caps the list at the picker size and says so', async () => {
    searchByName.mockResolvedValue({
      query: 'Test',
      mode: 'starts_with',
      total: 8,
      truncated: false,
      candidates: Array.from({ length: 8 }, (_, i) => candidate({ orgNumber: `556677889${i}`, name: `Testbrand ${i} AB` })),
    })
    const res = await GET(createMockRequest('/api/company/search?q=Test'))
    const { body } = await parseJsonResponse<{ data: { suggestions: unknown[]; truncated: boolean } }>(res)
    expect(body.data.suggestions).toHaveLength(6)
    expect(body.data.truncated).toBe(true)
  })

  it('passes through a flood as an empty, truncated list', async () => {
    searchByName.mockResolvedValue({ query: 'Sve', mode: 'contains', total: 593, truncated: true, candidates: [] })
    const res = await GET(createMockRequest('/api/company/search?q=Sve'))
    const { body } = await parseJsonResponse<{ data: { suggestions: unknown[]; truncated: boolean } }>(res)
    expect(body.data).toEqual({ suggestions: [], truncated: true })
  })

  it('returns 502 SCB_LOOKUP_FAILED when SCB does not answer', async () => {
    searchByName.mockRejectedValue(new ScbApiError('boom', 500, ''))
    const res = await GET(createMockRequest('/api/company/search?q=Testbrand'))
    expect(res.status).toBe(502)
    const { body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(body.error.code).toBe('SCB_LOOKUP_FAILED')
  })
})
