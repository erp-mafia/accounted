/**
 * The v1 doors of commitments and holdings (lib/operations/commitments.ts),
 * on the real withApiV1 wrapper: auth, scope, the company gate, the
 * operation's input contract and the outcome envelope. The services are
 * stubbed; their rules are tested in lib/commitments/__tests__.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

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
const service = vi.hoisted(() => ({
  listAgreements: vi.fn(),
  listObligations: vi.fn(),
  createAgreement: vi.fn(),
  updateAgreement: vi.fn(),
  endAgreement: vi.fn(),
}))
vi.mock('@/lib/commitments/agreements', () => service)

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET, POST } from '../route'
import { PATCH } from '../[id]/route'
import { POST as END } from '../[id]/end/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const AGREEMENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/agreements`
const MEMBER = { company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null } }

const view = {
  agreement_id: AGREEMENT_ID,
  kind: 'rental',
  origin: 'manual',
  title: 'Hyresavtal kontor',
  status: 'active',
  counterparty_party_id: null,
  counterparty_name: null,
  starts_on: '2026-01-01',
  ends_on: null,
  notice_months: null,
  renewal_terms: null,
  amount: 12500,
  currency: 'SEK',
  period: 'monthly',
  first_due_on: null,
  principal: null,
  interest_rate: null,
  document_id: null,
  source_document_id: null,
  notes: null,
  next_payment: null,
  notice_deadline: null,
  end_deadline: null,
}

function request(url: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(url, {
    method,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem-1' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

const params = (extra: Record<string, string> = {}) => ({ params: Promise.resolve({ companyId: COMPANY_ID, ...extra }) })

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, apiKeyId: 'ak_1', apiKeyName: 'Key', scopes: ['companies:read', 'companies:write'], mode: 'live' })
  mockServiceClient.mockReturnValue(createTableMockSupabase(MEMBER as never).supabase)
})

describe('GET /api/v1/companies/{companyId}/agreements', () => {
  it('returns 401 without a valid key', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key' })
    expect((await GET(request(BASE), params())).status).toBe(401)
    expect(service.listAgreements).not.toHaveBeenCalled()
  })

  it('returns 403 for a key without companies:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', apiKeyId: 'ak_1', apiKeyName: 'Key', scopes: ['documents:read'], mode: 'live' })
    const res = await GET(request(BASE), params())
    expect(res.status).toBe(403)
    expect((await res.json()).error.code).toBe('INSUFFICIENT_SCOPE')
  })

  it('returns 400 for an unknown status', async () => {
    expect((await GET(request(`${BASE}?status=pending`), params())).status).toBe(400)
    expect(service.listAgreements).not.toHaveBeenCalled()
  })

  it('answers 404 COMMITMENTS_UNAVAILABLE outside the rollout', async () => {
    service.listAgreements.mockResolvedValue({ ok: false, code: 'COMMITMENTS_UNAVAILABLE' })
    const res = await GET(request(BASE), params())
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('COMMITMENTS_UNAVAILABLE')
  })

  it('lists the agreements with the filters passed on', async () => {
    service.listAgreements.mockResolvedValue({ ok: true, data: { agreements: [view] } })
    const res = await GET(request(`${BASE}?status=active&kind=rental`), params())
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ agreements: [view] })
    expect(service.listAgreements).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_ID, userId: 'user-1' }), { status: 'active', kind: 'rental' })
  })
})

describe('POST /api/v1/companies/{companyId}/agreements', () => {
  const body = { kind: 'rental', title: 'Hyresavtal kontor', starts_on: '2026-01-01', amount: 12500, period: 'monthly' }

  it('returns 400 for an amount without a period', async () => {
    expect((await POST(request(BASE, 'POST', { ...body, period: undefined }), params())).status).toBe(400)
    expect(service.createAgreement).not.toHaveBeenCalled()
  })

  it('previews on a dry run and writes nothing', async () => {
    service.createAgreement.mockResolvedValue({ ok: true, dryRun: true, preview: { action: 'create' } })
    const res = await POST(request(`${BASE}?dry_run=true`, 'POST', body), params())
    expect(res.status).toBe(200)
    expect(service.createAgreement).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ kind: 'rental' }), { dryRun: true })
  })

  it('registers the agreement and answers 201', async () => {
    service.createAgreement.mockResolvedValue({ ok: true, created: true, data: view })
    const res = await POST(request(BASE, 'POST', body), params())
    expect(res.status).toBe(201)
    expect((await res.json()).data).toEqual(view)
  })
})

describe('PATCH .../agreements/{id} and POST .../end', () => {
  it('answers 404 for an agreement the company does not have', async () => {
    service.updateAgreement.mockResolvedValue({ ok: false, code: 'AGREEMENT_NOT_FOUND' })
    const res = await PATCH(request(`${BASE}/${AGREEMENT_ID}`, 'PATCH', { notice_months: 3 }), params({ id: AGREEMENT_ID }))
    expect(res.status).toBe(404)
    expect(service.updateAgreement).toHaveBeenCalledWith(expect.anything(), AGREEMENT_ID, { notice_months: 3 }, { dryRun: false })
  })

  it('ends the agreement named by the path', async () => {
    service.endAgreement.mockResolvedValue({ ok: true, data: { ...view, status: 'ended' } })
    const res = await END(request(`${BASE}/${AGREEMENT_ID}/end`, 'POST', { ended_on: '2026-10-31' }), params({ id: AGREEMENT_ID }))
    expect(res.status).toBe(200)
    expect(service.endAgreement).toHaveBeenCalledWith(expect.anything(), AGREEMENT_ID, { ended_on: '2026-10-31' }, { dryRun: false })
  })
})
