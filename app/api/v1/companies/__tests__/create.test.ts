/**
 * POST /api/v1/companies (issue #1814 PR 3): programmatic company creation
 * for partner provisioning and agents. Same static-route context shape as the
 * GET tests (Next.js 16 passes `{ params: undefined }`).
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

const mocks = vi.hoisted(() => ({
  createCompanyCore: vi.fn(),
}))

vi.mock('@/lib/auth/api-keys', async () => {
  const actual = await vi.importActual<typeof import('@/lib/auth/api-keys')>('@/lib/auth/api-keys')
  return {
    ...actual,
    validateApiKey: vi.fn(),
    createServiceClientNoCookies: vi.fn(),
  }
})

vi.mock('@supabase/supabase-js', async () => {
  const actual = await vi.importActual<typeof import('@supabase/supabase-js')>('@supabase/supabase-js')
  return { ...actual, createClient: vi.fn().mockReturnValue({}) }
})

vi.mock('@/lib/company/create-company', () => ({
  createCompanyCore: (...args: unknown[]) => mocks.createCompanyCore(...args),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as createCompany } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const USER_ID = '930abb54-c5ef-4ae0-b274-30fb16e9a295'
const TEAM_ID = '44444444-4444-4444-8444-444444444444'
const COMPANY_ID = '55555555-5555-4555-8555-555555555555'

function makeSupabase(teamId: string | null) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    order: vi.fn(() => chain),
    limit: vi.fn(() => chain),
    maybeSingle: vi.fn().mockResolvedValue({ data: teamId ? { team_id: teamId } : null, error: null }),
  }
  return {
    from: vi.fn(() => chain),
    rpc: vi.fn().mockResolvedValue({ data: COMPANY_ID, error: null }),
    chain,
  }
}

function makeRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request('https://x.test/api/v1/companies', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem-1',
      ...headers,
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

type PostCtx = Parameters<typeof createCompany>[1]
const staticRouteContext = () => ({ params: undefined } as unknown as PostCtx)

const validBody = {
  name: 'Acme AB',
  entity_type: 'aktiebolag',
  org_number: '5560000001',
  vat_registered: true,
  moms_period: 'quarterly',
  accounting_method: 'accrual',
  f_skatt: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: null,
    apiKeyId: 'key-1',
    apiKeyName: 'Partner key',
    scopes: ['companies:write', 'companies:read'],
    mode: 'live',
  })
  mockServiceClient.mockReturnValue(makeSupabase(TEAM_ID))
  mocks.createCompanyCore.mockImplementation(
    async (_client: unknown, _input: unknown, createRow: () => Promise<{ data: unknown; error: unknown }>) => {
      const { data } = await createRow()
      return { companyId: data as string }
    }
  )
})

describe('POST /api/v1/companies', () => {
  it('returns 401 for a missing bearer token', async () => {
    const request = new Request('https://x.test/api/v1/companies', {
      method: 'POST',
      body: JSON.stringify(validBody),
      headers: { 'Content-Type': 'application/json' },
    })
    const res = await createCompany(request, staticRouteContext())
    expect(res.status).toBe(401)
  })

  it('returns 403 without companies:write', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: null,
      apiKeyId: 'key-1',
      apiKeyName: 'Read key',
      scopes: ['companies:read'],
      mode: 'live',
    })
    const res = await createCompany(makeRequest(validBody), staticRouteContext())
    expect(res.status).toBe(403)
    expect(mocks.createCompanyCore).not.toHaveBeenCalled()
  })

  it('returns 400 for a VAT-registered company without a moms period', async () => {
    const res = await createCompany(makeRequest({ ...validBody, moms_period: undefined }), staticRouteContext())
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(JSON.stringify(body)).toContain('moms_period')
    expect(mocks.createCompanyCore).not.toHaveBeenCalled()
  })

  it('returns 400 for a body that is not JSON', async () => {
    const res = await createCompany(makeRequest('not json'), staticRouteContext())
    expect(res.status).toBe(400)
  })

  it('creates the company through the service-role RPC for the key user and returns 201', async () => {
    const supabase = makeSupabase(TEAM_ID)
    mockServiceClient.mockReturnValue(supabase)

    const res = await createCompany(makeRequest(validBody), staticRouteContext())
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toMatchObject({
      id: COMPANY_ID,
      name: 'Acme AB',
      entity_type: 'aktiebolag',
      org_number: '5560000001',
      vat_registered: true,
      moms_period: 'quarterly',
      team_id: TEAM_ID,
    })
    expect(body.data.fiscal_period.name).toContain('Räkenskapsår')
    expect(supabase.rpc).toHaveBeenCalledWith('create_company_for_user', {
      p_user_id: USER_ID,
      p_name: 'Acme AB',
      p_entity_type: 'aktiebolag',
      p_team_id: TEAM_ID,
    })
  })

  it('defaults the team to the user PERSONAL team only (WL-08)', async () => {
    const supabase = makeSupabase(TEAM_ID)
    mockServiceClient.mockReturnValue(supabase)

    const res = await createCompany(makeRequest(validBody), staticRouteContext())
    expect(res.status).toBe(201)

    // The default-team lookup must be restricted to kind='personal': picking
    // the first membership regardless of kind attached a consultant's private
    // company to their byrå team.
    expect(supabase.from).toHaveBeenCalledWith('team_members')
    expect(supabase.chain.select).toHaveBeenCalledWith('team_id, teams!inner(kind, created_at)')
    expect(supabase.chain.eq).toHaveBeenCalledWith('teams.kind', 'personal')
  })

  it('passes p_team_id null when the user has no personal team', async () => {
    const supabase = makeSupabase(null)
    mockServiceClient.mockReturnValue(supabase)

    const res = await createCompany(makeRequest(validBody), staticRouteContext())
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.team_id).toBeNull()
    expect(supabase.rpc).toHaveBeenCalledWith('create_company_for_user', {
      p_user_id: USER_ID,
      p_name: 'Acme AB',
      p_entity_type: 'aktiebolag',
      p_team_id: null,
    })
  })

  it('previews without creating for a test-mode key (dry run)', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: null,
      apiKeyId: 'key-1',
      apiKeyName: 'Test key',
      scopes: ['companies:write'],
      mode: 'test',
    })
    const res = await createCompany(makeRequest(validBody), staticRouteContext())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.name).toBe('Acme AB')
    expect(mocks.createCompanyCore).not.toHaveBeenCalled()
  })

  it('maps a creation failure to INTERNAL_ERROR', async () => {
    mocks.createCompanyCore.mockResolvedValue({ error: 'Kunde inte skapa kontoplan. Försök igen.' })
    const res = await createCompany(makeRequest(validBody), staticRouteContext())
    expect(res.status).toBe(500)
  })
})
