/**
 * The published v1 capabilities report for each representative company
 * (tests/fixtures/representative-companies.ts), through the route handler.
 *
 * Written before the resolver gained packages (lib/modules/capabilities.ts)
 * and kept byte-identical since: the packages step adds to the resolved
 * object the app and MCP read, not to what v1 publishes. A diff here is a
 * change to a published response.
 *
 * The profiles step adds one field, `profile`. It is taken out before the
 * snapshot and pinned exactly beside it, so the snapshot file stays byte
 * for byte what it was: every other field of the response is unchanged, and
 * a company without a stored profile publishes the implicit Standard.
 *
 * The rollout parts add one field per module, `parts`, taken out the same
 * way and pinned beside the snapshot: empty for every module but year-end,
 * whose Avtal och åtaganden is off for a company outside the rollout
 * (BOLAGET_COMPANY_IDS is empty here).
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
  vi.stubEnv('BOLAGET_COMPANY_IDS', '')
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
    const { profile, modules, ...rest } = body.data as { profile: unknown; modules: Array<{ id: string; parts: unknown[] }> }
    const unchanged = { ...rest, modules: modules.map(({ parts: _parts, ...m }) => m) }
    expect(unchanged).toMatchSnapshot()
    for (const m of modules) {
      expect(m.parts, m.id).toEqual(
        m.id === 'year-end'
          ? [
              {
                id: 'commitments',
                name: 'Agreements and commitments',
                name_sv: 'Avtal och åtaganden',
                status: 'off',
                reasons: ['switched_on_per_company'],
                resolution:
                  'Agreements and commitments is switched on company by company and is not on for this company: write to support@accounted.se to have it switched on.',
              },
            ]
          : [],
      )
    }
    expect(profile).toEqual({
      id: 'standard',
      version: 1,
      name: 'Standard (everything on)',
      name_sv: 'Standard (allt på)',
      source: 'implicit',
    })
  })
})
