/**
 * Tests for GET /api/v1/companies/:companyId/skatteverket/vat-declarations
 * (issue #1663): auth 401, scope 403, validation 400, extension-absent 503,
 * structured error passthrough, and the happy path via the registry-resolved
 * read service.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return { ...actual, validateApiKey: vi.fn(), createServiceClientNoCookies: vi.fn() }
})
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/extensions/registry', () => ({
  extensionRegistry: { get: vi.fn() },
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { extensionRegistry } from '@/lib/extensions/registry'
import { GET } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockRegistryGet = extensionRegistry.get as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/skatteverket/vat-declarations`

type MockResult = { data?: unknown; error?: unknown }
function makeSupabase(byTable: Record<string, MockResult>) {
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) =>
            resolve(byTable[table] ?? { data: null, error: null })
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

function makeRequest(url: string, withAuth = true): Request {
  return new Request(url, {
    method: 'GET',
    headers: withAuth ? { Authorization: 'Bearer test-fixture-not-a-real-key' } : {},
  })
}

const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }
const mockFetchStatus = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    scopes: ['compliance:read'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(
    makeSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    }),
  )
  mockRegistryGet.mockReturnValue({
    id: 'skatteverket',
    services: { fetchVatDeclarationStatus: mockFetchStatus },
  })
  mockFetchStatus.mockResolvedValue({
    ok: true,
    redovisare: '165560000167',
    redovisningsperiod: '202603',
    submitted: { skatt: 12500 },
    decided: null,
  })
})

describe('GET /api/v1/companies/:companyId/skatteverket/vat-declarations', () => {
  it('returns 401 without a bearer token', async () => {
    const res = await GET(
      makeRequest(`${BASE}?period_type=quarterly&year=2026&period=1`, false),
      params,
    )
    expect(res.status).toBe(401)
    expect(mockFetchStatus).not.toHaveBeenCalled()
  })

  it('rejects keys without compliance:read scope', async () => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: COMPANY_ID,
      apiKeyId: 'ak_1',
      scopes: ['reports:read'],
      mode: 'live',
    })
    const res = await GET(
      makeRequest(`${BASE}?period_type=quarterly&year=2026&period=1`),
      params,
    )
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
  })

  it('returns 404 when the key user is not a member of the company', async () => {
    mockServiceClient.mockReturnValue(
      makeSupabase({ company_members: { data: null, error: null } }),
    )
    const res = await GET(
      makeRequest(`${BASE}?period_type=quarterly&year=2026&period=1`),
      params,
    )
    expect(res.status).toBe(404)
  })

  it('rejects a missing period_type with 400', async () => {
    const res = await GET(makeRequest(`${BASE}?year=2026&period=1`), params)
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(mockFetchStatus).not.toHaveBeenCalled()
  })

  it('rejects a quarterly period out of range with 400', async () => {
    const res = await GET(
      makeRequest(`${BASE}?period_type=quarterly&year=2026&period=5`),
      params,
    )
    expect(res.status).toBe(400)
    expect(mockFetchStatus).not.toHaveBeenCalled()
  })

  it('returns 503 EXTENSION_DISABLED when the extension is not registered', async () => {
    mockRegistryGet.mockReturnValue(undefined)
    const res = await GET(
      makeRequest(`${BASE}?period_type=quarterly&year=2026&period=1`),
      params,
    )
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.code).toBe('EXTENSION_DISABLED')
  })

  it('passes structured service failures through (SKATTEVERKET_NOT_CONNECTED → 401)', async () => {
    mockFetchStatus.mockResolvedValue({
      ok: false,
      code: 'SKATTEVERKET_NOT_CONNECTED',
      http_status: 401,
      error: 'Inte ansluten till Skatteverket.',
    })
    const res = await GET(
      makeRequest(`${BASE}?period_type=quarterly&year=2026&period=1`),
      params,
    )
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.error.code).toBe('SKATTEVERKET_NOT_CONNECTED')
    expect(body.error.details).toMatchObject({ message: 'Inte ansluten till Skatteverket.' })
  })

  it('happy path: forwards the parsed period and returns the envelope', async () => {
    const res = await GET(
      makeRequest(`${BASE}?period_type=quarterly&year=2026&period=1&state=submitted`),
      params,
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toEqual({
      redovisare: '165560000167',
      redovisningsperiod: '202603',
      submitted: { skatt: 12500 },
      decided: null,
    })
    expect(body.meta.request_id).toMatch(/^req_/)
    // The service gets the caller's identity + the URL company, coerced params.
    expect(mockFetchStatus).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      COMPANY_ID,
      { periodType: 'quarterly', year: 2026, period: 1, state: 'submitted' },
    )
  })
})
