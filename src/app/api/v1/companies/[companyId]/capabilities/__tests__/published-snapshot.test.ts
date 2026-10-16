/**
 * The published v1 capabilities report for each representative company
 * (tests/fixtures/representative-companies.ts), through the route handler.
 *
 * Written before the resolver gained packages (lib/modules/capabilities.ts)
 * and kept byte-identical since: the packages step adds to the resolved
 * object the app and MCP read, not to what v1 publishes. A diff here is a
 * change to a published response.
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
vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase } from '@/tests/helpers'
import { REPRESENTATIVE_COMPANIES, representativeCompanyTables } from '@/tests/fixtures/representative-companies'
import { GET as getCapabilities } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllEnvs()
  vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
})

describe('GET /api/v1/companies/:companyId/capabilities for each representative company', () => {
  it.each(REPRESENTATIVE_COMPANIES.map((c) => [c.name, c] as const))('%s', async (_name, company) => {
    mockValidate.mockResolvedValue({
      userId: 'user-1',
      companyId: company.id,
      apiKeyId: 'ak_1',
      scopes: ['companies:read'],
      mode: 'live',
    })
    const { supabase } = createTableMockSupabase(representativeCompanyTables(company))
    mockServiceClient.mockReturnValue(supabase)
    const res = await getCapabilities(
      new Request(`https://x.test/api/v1/companies/${company.id}/capabilities`, {
        method: 'GET',
        headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
      }),
      { params: Promise.resolve({ companyId: company.id }) },
    )
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchSnapshot()
  })
})
