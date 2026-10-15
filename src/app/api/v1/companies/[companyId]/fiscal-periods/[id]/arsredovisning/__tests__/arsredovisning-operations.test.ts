/**
 * The årsredovisning workflow through the v1 doors of the operation registry
 * (src/lib/operations/arsredovisning.ts via lib/operations/v1.ts) and the v1
 * file routes (lib/api/v1/report-file-route.ts):
 *   POST   .../fiscal-periods/:id/arsredovisning/narrative
 *   PATCH  .../fiscal-periods/:id/arsredovisning/compliance
 *   POST   .../fiscal-periods/:id/arsredovisning/versions
 *   GET    .../fiscal-periods/:id/arsredovisning/signatures
 *   POST   .../fiscal-periods/:id/arsredovisning/signatures
 *   PATCH  .../fiscal-periods/:id/arsredovisning/signatures/:signatureId
 *   DELETE .../fiscal-periods/:id/arsredovisning/signatures/:signatureId
 *   GET    .../fiscal-periods/:id/arsredovisning/pdf
 *   GET    .../fiscal-periods/:id/arsredovisning/ixbrl
 *   GET    .../fiscal-periods/:id/arsredovisning/ixbrl/validate
 *
 * The rules under test are the services' (lib/bokslut/arsredovisning/
 * workflow-service.ts and file-service.ts): period ownership on the
 * service-role client, the registrerad freeze, the version gates and the
 * content-hash pin, the signer roster rules, the SIE lease on live files,
 * and dry runs that write nothing.
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
vi.mock('@/lib/entitlements/multi-user', async () => {
  const actual = await vi.importActual<typeof import('@/lib/entitlements/multi-user')>('@/lib/entitlements/multi-user')
  return { ...actual, getMultiUserState: vi.fn().mockResolvedValue({ state: 'active' }), isMembershipDormant: () => false }
})
const serviceClientMock = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: () => serviceClientMock(),
}))
vi.mock('@/lib/bokslut/arsredovisning/model', () => ({ buildCanonicalAnnualReport: vi.fn() }))
vi.mock('@/lib/bokslut/arsredovisning/version-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bokslut/arsredovisning/version-service')>(
    '@/lib/bokslut/arsredovisning/version-service',
  )
  return {
    ...actual,
    hasStatementIntegrityErrors: vi.fn(() => false),
    createAnnualReportVersion: vi.fn(),
    getAnnualReportVersion: vi.fn(),
  }
})
vi.mock('@/lib/bokslut/ixbrl/build-input', () => ({ buildIxbrlInput: vi.fn() }))
vi.mock('@react-pdf/renderer', () => ({ renderToBuffer: vi.fn() }))
vi.mock('@/lib/bokslut/arsredovisning/arsredovisning-pdf', () => ({ ArsredovisningPDF: vi.fn() }))
vi.mock('@/lib/bokslut/arsredovisning/arsredovisning-k3-pdf', () => ({ ArsredovisningK3PDF: vi.fn() }))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { buildCanonicalAnnualReport } from '@/lib/bokslut/arsredovisning/model'
import {
  annualReportContentHash,
  createAnnualReportVersion,
  getAnnualReportVersion,
  hasStatementIntegrityErrors,
} from '@/lib/bokslut/arsredovisning/version-service'
import { buildIxbrlInput } from '@/lib/bokslut/ixbrl/build-input'
import { makeInput } from '@/lib/bokslut/ixbrl/__tests__/fixtures'
import { renderToBuffer } from '@react-pdf/renderer'
import { POST as postNarrative } from '../narrative/route'
import { PATCH as patchCompliance } from '../compliance/route'
import { POST as postVersion } from '../versions/route'
import { GET as listSignatures, POST as postSignature } from '../signatures/route'
import { DELETE as deleteSignature, PATCH as patchSignature } from '../signatures/[signatureId]/route'
import { GET as getPdf } from '../pdf/route'
import { GET as getIxbrl } from '../ixbrl/route'
import { GET as validateIxbrl } from '../ixbrl/validate/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

/**
 * Per-table queue mock that records every (table, method, args). RPCs queue
 * under 'rpc:<name>' so the SIE read lease answers a token.
 */
function makeClient(byTable: Record<string, TableResp | TableResp[]>) {
  const queues = new Map<string, TableResp[]>()
  for (const [t, val] of Object.entries(byTable)) queues.set(t, Array.isArray(val) ? [...val] : [val])
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  const buildChain = (key: string): unknown =>
    new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => {
              const q = queues.get(key)
              resolve(q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null }))
            }
          }
          return (...args: unknown[]) => {
            calls.push({ table: key, method: String(prop), args })
            return buildChain(key)
          }
        },
      },
    )
  const rpc = vi.fn((fn: string, ...args: unknown[]) => {
    calls.push({ table: 'rpc', method: fn, args })
    return buildChain(`rpc:${fn}`)
  })
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc }
}

type Client = ReturnType<typeof makeClient>

const WRITES = new Set(['insert', 'update', 'upsert', 'delete'])
/** Business tables only: withApiV1's own bookkeeping (idempotency, usage) is not the operation's. */
const BOOKS = new Set([
  'arsredovisning_narratives',
  'annual_report_profiles',
  'annual_report_versions',
  'arsredovisning_signature_requests',
])
const wrote = (client: Client) =>
  client.calls.some((c) => (BOOKS.has(c.table) && WRITES.has(c.method)) || c.table === 'rpc')

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SIGNATURE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const VERSION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const PERIOD = { data: { id: PERIOD_ID }, error: null }
const NONE = { data: null, error: null }
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}/fiscal-periods/${PERIOD_ID}/arsredovisning`

function request(url: string, init: RequestInit = {}): Request {
  return new Request(url, {
    ...init,
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': crypto.randomUUID(),
      'Content-Type': 'application/json',
      ...((init.headers as Record<string, string>) ?? {}),
    },
  })
}

const periodParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: PERIOD_ID }) }
const signatureParams = { params: Promise.resolve({ companyId: COMPANY_ID, id: PERIOD_ID, signatureId: SIGNATURE_ID }) }

const MODEL = {
  schema_version: '1.0',
  generated_at: '2027-03-01T08:00:00Z',
  company_id: COMPANY_ID,
  fiscal_period_id: PERIOD_ID,
  entity_type: 'aktiebolag',
  report: {
    accounting_framework: 'k2',
    fiscal_period: { id: PERIOD_ID, period_end: '2026-12-31' },
    signatures: [{ role: 'Styrelseledamot', name: 'Anna Andersson', signed_at: null }],
    forvaltningsberattelse: { proposed_dividend: 0, resultatdisposition_amounts: { total: 412000 } },
  },
  profile: { id: 'profile-1', company_id: COMPANY_ID, fiscal_period_id: PERIOD_ID, is_public_limited_company: false },
  disclosures: {},
  eligibility: { k2_eligible: true, digital_filing_eligible: true, issues: [], digital_issues: [] },
  validation: { stage: 'draft', ok: true, error_count: 0, warning_count: 0, issues: [] },
  ixbrl: null,
}

const VERSION_ROW = {
  id: VERSION_ID,
  version_number: 1,
  status: 'draft',
  framework: 'k2',
  content_hash: 'a'.repeat(64),
  taxonomy_version: null,
  entry_point: null,
  finalized_at: null,
  created_at: '2027-03-01T08:00:00Z',
  report_data: { huge: true },
}

function signatureRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SIGNATURE_ID,
    user_id: 'user-1',
    company_id: COMPANY_ID,
    fiscal_period_id: PERIOD_ID,
    role: 'Styrelseledamot',
    signer_name: 'Anna Andersson',
    status: 'pending',
    signed_at: null,
    created_at: '2027-03-01T08:00:00Z',
    updated_at: '2027-03-01T08:00:00Z',
    annual_report_version_id: null,
    signing_method: null,
    evidence_reference: null,
    evidence_recorded_at: null,
    ...overrides,
  }
}

function use(byTable: Record<string, TableResp | TableResp[]>): Client {
  const client = makeClient({ company_members: OWNER, ...byTable })
  mockServiceClient.mockReturnValue(client)
  serviceClientMock.mockReturnValue(client)
  return client
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read', 'bookkeeping:write'],
    mode: 'live',
  })
  vi.mocked(buildCanonicalAnnualReport).mockResolvedValue(MODEL as never)
  vi.mocked(hasStatementIntegrityErrors).mockReturnValue(false)
  vi.mocked(createAnnualReportVersion).mockResolvedValue(VERSION_ROW as never)
})

// ─────────────────────────────────────────────────────────────────

describe('POST .../arsredovisning/narrative', () => {
  const post = (body: unknown, query = '') =>
    postNarrative(request(`${BASE}/narrative${query}`, { method: 'POST', body: JSON.stringify(body) }), periodParams)

  it('401 when the API key is rejected', async () => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    use({})
    expect((await post({ description: 'x' })).status).toBe(401)
  })

  it('403 without bookkeeping:write', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['reports:read'], mode: 'live' })
    const client = use({})
    expect((await post({ description: 'x' })).status).toBe(403)
    expect(wrote(client)).toBe(false)
  })

  it('400 on an invalid date, a personnummer as parent org number, an empty body or an unknown field', async () => {
    use({})
    expect((await post({ agm_date: '2026-13-99' })).status).toBe(400)
    expect((await post({ parent_company_org_number: '19850101-1234' })).status).toBe(400)
    expect((await post({})).status).toBe(400)
    expect((await post({ description: 'x', annual_report_version_id: VERSION_ID })).status).toBe(400)
    expect((await post({ agm_disposition_outcome: 'alternative_decision' })).status).toBe(400)
  })

  it('404 PERIOD_NOT_FOUND for a period outside the company', async () => {
    const client = use({ fiscal_periods: NONE })
    const res = await post({ description: 'x' })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('PERIOD_NOT_FOUND')
    expect(wrote(client)).toBe(false)
  })

  it('409 ARSREDOVISNING_REGISTERED once the årsredovisning is registrerad at Bolagsverket', async () => {
    const client = use({ fiscal_periods: PERIOD, arsredovisning_submissions: { data: { id: 'sub-1' }, error: null } })
    const res = await post({ description: 'x' })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('ARSREDOVISNING_REGISTERED')
    expect(wrote(client)).toBe(false)
  })

  it('a dry run previews the changed fields and writes nothing', async () => {
    const client = use({ fiscal_periods: PERIOD, arsredovisning_submissions: NONE })
    const res = await post({ description: 'Konsultverksamhet.', proposed_dividend: 100.456 }, '?dry_run=true')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview).toMatchObject({
      fiscal_period_id: PERIOD_ID,
      changes: { description: 'Konsultverksamhet.', proposed_dividend: 100.46 },
      clears_narrative_confirmation: true,
    })
    expect(wrote(client)).toBe(false)
  })

  it('saves the texts, clears the narrative confirmation and answers the qualified shape', async () => {
    const client = use({
      fiscal_periods: PERIOD,
      arsredovisning_submissions: NONE,
      arsredovisning_narratives: {
        data: { id: 'narr-1', company_id: COMPANY_ID, fiscal_period_id: PERIOD_ID, description: 'Konsultverksamhet.', note_overrides: {}, updated_at: 'x' },
        error: null,
      },
    })
    const res = await post({ description: 'Konsultverksamhet.\u0007' })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({ narrative_id: 'narr-1', fiscal_period_id: PERIOD_ID })
    expect(body.data.company_id).toBeUndefined()
    const upsert = client.calls.find((c) => c.table === 'arsredovisning_narratives' && c.method === 'upsert')
    // Control characters are stripped before they reach the PDF.
    expect(upsert?.args[0]).toMatchObject({ company_id: COMPANY_ID, fiscal_period_id: PERIOD_ID, description: 'Konsultverksamhet.' })
    const cleared = client.calls.find((c) => c.table === 'annual_report_profiles' && c.method === 'update')
    expect(cleared?.args[0]).toEqual({ narrative_confirmed_at: null })
  })
})

// ─────────────────────────────────────────────────────────────────

describe('PATCH .../arsredovisning/compliance', () => {
  const patch = (body: unknown, query = '') =>
    patchCompliance(request(`${BASE}/compliance${query}`, { method: 'PATCH', body: JSON.stringify(body) }), periodParams)

  it('400 for an empty body or an unknown field', async () => {
    use({})
    expect((await patch({})).status).toBe(400)
    expect((await patch({ is_public: true })).status).toBe(400)
  })

  it('404 PERIOD_NOT_FOUND before any write', async () => {
    const client = use({ fiscal_periods: NONE })
    expect((await patch({ is_public_limited_company: false })).status).toBe(404)
    expect(wrote(client)).toBe(false)
  })

  it('a dry run writes nothing and does not rebuild the report', async () => {
    const client = use({ fiscal_periods: PERIOD })
    const res = await patch({ is_parent_company: false }, '?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({
      changes: { is_parent_company: false },
      clears: ['parent_group_size', 'prepares_consolidated_accounts'],
    })
    expect(wrote(client)).toBe(false)
    expect(buildCanonicalAnnualReport).not.toHaveBeenCalled()
  })

  it('stores the answers with confirmation timestamps and answers the recomputed checks', async () => {
    const client = use({ fiscal_periods: PERIOD, annual_report_profiles: { data: MODEL.profile, error: null } })
    const res = await patch({ is_public_limited_company: false, signer_roster_confirmed: true })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.profile).toMatchObject({ annual_report_profile_id: 'profile-1' })
    expect(body.data.profile.id).toBeUndefined()
    expect(body.data.report_summary).toEqual({ proposed_dividend: 0, distributable_equity: 412000 })
    const upsert = client.calls.find((c) => c.table === 'annual_report_profiles' && c.method === 'upsert')
    expect(upsert?.args[0]).toMatchObject({
      company_id: COMPANY_ID,
      is_public_limited_company: false,
      signer_roster_confirmed_at: expect.any(String),
    })
    expect(upsert?.args[0]).not.toHaveProperty('signer_roster_confirmed')
  })
})

// ─────────────────────────────────────────────────────────────────

describe('POST .../arsredovisning/versions', () => {
  const post = (body: unknown, query = '') =>
    postVersion(request(`${BASE}/versions${query}`, { method: 'POST', body: JSON.stringify(body) }), periodParams)
  const leaseRpcs = { 'rpc:acquire_sie_period_read': { data: 'lease-1', error: null }, 'rpc:finish_sie_period_read': NONE }

  it('400 for an unknown action or a client-supplied dividend', async () => {
    use({})
    expect((await post({ action: 'delete' })).status).toBe(400)
    expect((await post({ action: 'finalize', proposed_dividend: 100 })).status).toBe(400)
    expect(buildCanonicalAnnualReport).not.toHaveBeenCalled()
  })

  it('404 PERIOD_NOT_FOUND without building anything', async () => {
    const client = use({ fiscal_periods: NONE })
    expect((await post({ action: 'snapshot' })).status).toBe(404)
    expect(buildCanonicalAnnualReport).not.toHaveBeenCalled()
    expect(wrote(client)).toBe(false)
  })

  it('409 ARSREDOVISNING_INCOMPLETE for finalize with a blocking signing-stage error', async () => {
    use({ fiscal_periods: PERIOD, ...leaseRpcs })
    vi.mocked(buildCanonicalAnnualReport).mockResolvedValue({
      ...MODEL,
      validation: { stage: 'signing', ok: false, error_count: 1, warning_count: 0, issues: [{ code: 'AR-SIGNERS-MISSING' }] },
    } as never)
    const res = await post({ action: 'finalize' })
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('ARSREDOVISNING_INCOMPLETE')
    expect(createAnnualReportVersion).not.toHaveBeenCalled()
  })

  it('409 ARSREDOVISNING_INCOMPLETE for a snapshot whose statements do not tie', async () => {
    use({ fiscal_periods: PERIOD, ...leaseRpcs })
    vi.mocked(hasStatementIntegrityErrors).mockReturnValue(true)
    expect((await post({ action: 'snapshot' })).status).toBe(409)
    expect(createAnnualReportVersion).not.toHaveBeenCalled()
  })

  it('a dry run answers the content hash and validation counts, without the lease or any write', async () => {
    const client = use({ fiscal_periods: PERIOD })
    const res = await post({ action: 'finalize' }, '?dry_run=true')
    expect(res.status).toBe(200)
    const preview = (await res.json()).data.preview
    expect(preview).toMatchObject({
      action: 'finalize',
      status_after: 'ready_for_signature',
      content_hash: annualReportContentHash(MODEL as never),
      validation: { ok: true, error_count: 0 },
      signer_count: 1,
    })
    expect(buildCanonicalAnnualReport).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, PERIOD_ID, expect.objectContaining({ stage: 'signing' }))
    expect(wrote(client)).toBe(false)
    expect(createAnnualReportVersion).not.toHaveBeenCalled()
  })

  it('409 ARSREDOVISNING_CONTENT_CHANGED when the content no longer hashes to the reviewed hash', async () => {
    use({ fiscal_periods: PERIOD, ...leaseRpcs })
    const res = await post({ action: 'snapshot', expected_content_hash: 'f'.repeat(64) })
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('ARSREDOVISNING_CONTENT_CHANGED')
    expect(createAnnualReportVersion).not.toHaveBeenCalled()
  })

  it('201 for a snapshot read under the SIE lease, with the curated version shape', async () => {
    const client = use({ fiscal_periods: PERIOD, ...leaseRpcs })
    const res = await post({ action: 'snapshot', expected_content_hash: annualReportContentHash(MODEL as never) })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data).toMatchObject({ annual_report_version_id: VERSION_ID, status: 'draft', content_hash: 'a'.repeat(64) })
    expect(body.data.report_data).toBeUndefined()
    expect(client.calls.filter((c) => c.table === 'rpc').map((c) => c.method)).toEqual([
      'acquire_sie_period_read',
      'finish_sie_period_read',
    ])
    expect(createAnnualReportVersion).toHaveBeenCalledWith(client, 'user-1', MODEL, false)
  })

  it('finalize passes the signer and runs through the trusted service client', async () => {
    const client = use({ fiscal_periods: PERIOD, ...leaseRpcs })
    const res = await post({ action: 'finalize', certificate_signer: { first_name: 'Anna', last_name: 'Andersson', role: 'VD' } })
    expect(res.status).toBe(201)
    expect(buildCanonicalAnnualReport).toHaveBeenCalledWith(
      client,
      COMPANY_ID,
      PERIOD_ID,
      expect.objectContaining({ stage: 'signing', undertecknare: { firstName: 'Anna', lastName: 'Andersson', role: 'VD' } }),
    )
    expect(serviceClientMock).toHaveBeenCalledOnce()
    expect(createAnnualReportVersion).toHaveBeenCalledWith(client, 'user-1', MODEL, true)
  })
})

// ─────────────────────────────────────────────────────────────────

describe('.../arsredovisning/signatures', () => {
  const post = (body: unknown, query = '') =>
    postSignature(request(`${BASE}/signatures${query}`, { method: 'POST', body: JSON.stringify(body) }), periodParams)
  const valid = { role: 'Styrelseledamot', signer_name: 'Anna Andersson' }

  it('GET lists the roster with qualified ids and no user ids', async () => {
    use({ fiscal_periods: PERIOD, arsredovisning_signature_requests: { data: [signatureRow()], error: null } })
    const res = await listSignatures(request(`${BASE}/signatures`), periodParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.signatures[0]).toMatchObject({ signature_id: SIGNATURE_ID, signer_name: 'Anna Andersson' })
    expect(body.data.signatures[0].user_id).toBeUndefined()
  })

  it('GET 403 without reports:read', async () => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['bookkeeping:write'], mode: 'live' })
    use({})
    expect((await listSignatures(request(`${BASE}/signatures`), periodParams)).status).toBe(403)
  })

  it('POST 400 for a role ÅRL does not know or a personnummer as the name', async () => {
    use({})
    expect((await post({ role: 'Administrator', signer_name: 'Anna' })).status).toBe(400)
    expect((await post({ role: 'VD', signer_name: '19850101-1234' })).status).toBe(400)
  })

  it('POST 404 for a period outside the company', async () => {
    const client = use({ fiscal_periods: NONE })
    expect((await post(valid)).status).toBe(404)
    expect(wrote(client)).toBe(false)
  })

  it('POST 409 ARSREDOVISNING_SIGNER_ALREADY_EXISTS for the same unbound role and name', async () => {
    const client = use({ fiscal_periods: PERIOD, arsredovisning_signature_requests: { data: { id: 'sig-0' }, error: null } })
    const res = await post(valid)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('ARSREDOVISNING_SIGNER_ALREADY_EXISTS')
    expect(wrote(client)).toBe(false)
  })

  it('POST dry run writes nothing', async () => {
    const client = use({ fiscal_periods: PERIOD, arsredovisning_signature_requests: NONE })
    const res = await post(valid, '?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({ role: 'Styrelseledamot', clears_signer_roster_confirmation: true })
    expect(wrote(client)).toBe(false)
  })

  it('POST 201 adds a pending slot', async () => {
    const client = use({
      fiscal_periods: PERIOD,
      arsredovisning_signature_requests: [NONE, { data: signatureRow(), error: null }],
    })
    const res = await post(valid)
    expect(res.status).toBe(201)
    expect((await res.json()).data).toMatchObject({ signature_id: SIGNATURE_ID, status: 'pending', annual_report_version_id: null })
    const insert = client.calls.find((c) => c.table === 'arsredovisning_signature_requests' && c.method === 'insert')
    expect(insert?.args[0]).toMatchObject({ company_id: COMPANY_ID, fiscal_period_id: PERIOD_ID, status: 'pending' })
  })
})

describe('PATCH/DELETE .../arsredovisning/signatures/:signatureId', () => {
  const patch = (body: unknown, query = '') =>
    patchSignature(request(`${BASE}/signatures/${SIGNATURE_ID}${query}`, { method: 'PATCH', body: JSON.stringify(body) }), signatureParams)
  const del = (query = '') =>
    deleteSignature(request(`${BASE}/signatures/${SIGNATURE_ID}${query}`, { method: 'DELETE' }), signatureParams)
  const signed = {
    status: 'signed',
    annual_report_version_id: VERSION_ID,
    signing_method: 'paper_original',
    evidence_reference: 'archive:AR-1',
    signed_at: '2026-03-01T10:00:00.000Z',
  }
  const READY = { data: { id: VERSION_ID, status: 'ready_for_signature', finalized_at: '2026-03-01T08:00:00.000Z' }, error: null }

  it('400 for signed without evidence, free-text evidence, or signed fields on a decline', async () => {
    use({})
    expect((await patch({ status: 'signed' })).status).toBe(400)
    expect((await patch({ ...signed, evidence_reference: 'Original i arkiv' })).status).toBe(400)
    expect((await patch({ status: 'declined', signing_method: 'bankid' })).status).toBe(400)
  })

  it('409 ARSREDOVISNING_VERSION_NOT_SIGNABLE when the version is not ready for signature', async () => {
    const client = use({ annual_report_versions: NONE })
    const res = await patch(signed)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('ARSREDOVISNING_VERSION_NOT_SIGNABLE')
    expect(wrote(client)).toBe(false)
  })

  it('409 SIGNATURE_INVALID_TRANSITION for a slot bound to another version', async () => {
    use({
      annual_report_versions: READY,
      arsredovisning_signature_requests: { data: { id: SIGNATURE_ID, status: 'pending', annual_report_version_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }, error: null },
    })
    const res = await patch(signed)
    expect(res.status).toBe(409)
    expect((await res.json()).error.code).toBe('SIGNATURE_INVALID_TRANSITION')
  })

  it('400 ARSREDOVISNING_SIGNATURE_DATE_INVALID before finalization or in the future', async () => {
    const client = use({
      annual_report_versions: { data: { ...READY.data, finalized_at: '2026-03-02T08:00:00.000Z' }, error: null },
      arsredovisning_signature_requests: { data: { id: SIGNATURE_ID, status: 'pending', annual_report_version_id: null }, error: null },
    })
    const res = await patch(signed)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('ARSREDOVISNING_SIGNATURE_DATE_INVALID')
    expect((await patch({ ...signed, signed_at: '2999-03-01T10:00:00.000Z' })).status).toBe(400)
    expect(wrote(client)).toBe(false)
  })

  it('a dry run of a signature checks everything and writes nothing', async () => {
    const client = use({
      annual_report_versions: READY,
      arsredovisning_signature_requests: { data: { id: SIGNATURE_ID, status: 'pending', annual_report_version_id: null }, error: null },
    })
    const res = await patch(signed, '?dry_run=true')
    expect(res.status).toBe(200)
    expect((await res.json()).data.preview).toMatchObject({ status_after: 'signed', evidence_reference: 'archive:AR-1' })
    expect(wrote(client)).toBe(false)
    expect(serviceClientMock).not.toHaveBeenCalled()
  })

  it('records the signature evidence through the trusted service client, scoped to the path period', async () => {
    const client = use({
      annual_report_versions: READY,
      arsredovisning_signature_requests: [
        { data: { id: SIGNATURE_ID, status: 'pending', annual_report_version_id: VERSION_ID }, error: null },
        { data: signatureRow({ status: 'signed', annual_report_version_id: VERSION_ID, signing_method: 'paper_original', evidence_reference: 'archive:AR-1' }), error: null },
      ],
    })
    const res = await patch(signed)
    expect(res.status).toBe(200)
    expect((await res.json()).data).toMatchObject({ signature_id: SIGNATURE_ID, status: 'signed', evidence_reference: 'archive:AR-1' })
    expect(serviceClientMock).toHaveBeenCalledOnce()
    const update = client.calls.find((c) => c.table === 'arsredovisning_signature_requests' && c.method === 'update')
    expect(update?.args[0]).toMatchObject({ status: 'signed', evidence_recorded_by: 'user-1', annual_report_version_id: VERSION_ID })
    expect(client.calls).toContainEqual({ table: 'arsredovisning_signature_requests', method: 'eq', args: ['fiscal_period_id', PERIOD_ID] })
  })

  it('declines a pending slot, and 409 when it is no longer pending', async () => {
    use({ arsredovisning_signature_requests: { data: signatureRow({ status: 'declined' }), error: null } })
    const res = await patch({ status: 'declined' })
    expect(res.status).toBe(200)
    expect((await res.json()).data.status).toBe('declined')

    use({ arsredovisning_signature_requests: NONE })
    const refused = await patch({ status: 'declined' })
    expect(refused.status).toBe(409)
    expect((await refused.json()).error.code).toBe('SIGNATURE_INVALID_TRANSITION')
  })

  it('DELETE removes an unbound pending slot; a dry run writes nothing; a bound slot is 409', async () => {
    const dry = use({ arsredovisning_signature_requests: { data: { id: SIGNATURE_ID }, error: null } })
    const preview = await del('?dry_run=true')
    expect(preview.status).toBe(200)
    expect(wrote(dry)).toBe(false)

    const client = use({ arsredovisning_signature_requests: { data: { id: SIGNATURE_ID }, error: null } })
    const res = await del()
    expect(res.status).toBe(200)
    expect((await res.json()).data).toEqual({ signature_id: SIGNATURE_ID, deleted: true })
    expect(client.calls.some((c) => c.table === 'arsredovisning_signature_requests' && c.method === 'delete')).toBe(true)

    use({ arsredovisning_signature_requests: NONE })
    const locked = await del()
    expect(locked.status).toBe(409)
    expect((await locked.json()).error.code).toBe('ARSREDOVISNING_SIGNER_ROSTER_LOCKED')
  })
})

// ─────────────────────────────────────────────────────────────────

describe('file routes and the iXBRL pre-flight', () => {
  const leaseRpcs = { 'rpc:acquire_sie_period_read': { data: 'lease-1', error: null }, 'rpc:finish_sie_period_read': NONE }

  it('GET pdf renders the live draft under the SIE lease as an attachment', async () => {
    vi.mocked(renderToBuffer).mockResolvedValue(Buffer.from('annual PDF'))
    const client = use(leaseRpcs)
    const res = await getPdf(request(`${BASE}/pdf`), periodParams)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain('attachment')
    expect(res.headers.get('Content-Disposition')).toContain('arsredovisning-2026-12-31-utkast.pdf')
    expect(client.calls.filter((c) => c.table === 'rpc').map((c) => c.method)).toEqual([
      'acquire_sie_period_read',
      'finish_sie_period_read',
    ])
  })

  it('GET pdf of a signed version reads no live balances and takes no lease', async () => {
    vi.mocked(renderToBuffer).mockResolvedValue(Buffer.from('annual PDF'))
    vi.mocked(getAnnualReportVersion).mockResolvedValue({
      summary: { status: 'signed' },
      report_data: MODEL.report,
    } as never)
    const client = use({ arsredovisning_signature_requests: { data: [], error: null } })
    const res = await getPdf(request(`${BASE}/pdf?version_id=${VERSION_ID}`), periodParams)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toContain('papperskopia')
    expect(client.rpc).not.toHaveBeenCalled()
    expect(buildCanonicalAnnualReport).not.toHaveBeenCalled()
  })

  it('GET pdf 404 for an unknown version, 400 for a malformed period id, 403 without reports:read', async () => {
    vi.mocked(getAnnualReportVersion).mockResolvedValue(null)
    use({})
    expect((await getPdf(request(`${BASE}/pdf?version_id=${VERSION_ID}`), periodParams)).status).toBe(404)
    const bad = await getPdf(request(`${BASE}/pdf`), { params: Promise.resolve({ companyId: COMPANY_ID, id: 'nope' }) })
    expect(bad.status).toBe(400)
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['bookkeeping:write'], mode: 'live' })
    expect((await getPdf(request(`${BASE}/pdf`), periodParams)).status).toBe(403)
  })

  it('GET ixbrl answers the XHTML document with the dividend forwarded', async () => {
    vi.mocked(buildIxbrlInput).mockResolvedValue(makeInput())
    use(leaseRpcs)
    const res = await getIxbrl(request(`${BASE}/ixbrl?proposed_dividend=50000`), periodParams)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/xhtml+xml')
    expect(await res.text()).toContain('ID_DATUM_UNDERTECKNANDE_FASTSTALLELSEINTYG')
    expect(buildIxbrlInput).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, PERIOD_ID, { proposedDividend: 50000 })
  })

  it('GET ixbrl/validate answers the pre-flight as JSON (issues are not failures)', async () => {
    const input = makeInput()
    input.underskrifter.signers = []
    vi.mocked(buildIxbrlInput).mockResolvedValue(input)
    const client = use({})
    const res = await validateIxbrl(request(`${BASE}/ixbrl/validate`), periodParams)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ok).toBe(false)
    expect(body.data.issues.map((issue: { code: string }) => issue.code)).toContain('1107')
    expect(body.data.annual_report_version_id).toBeNull()
    expect(client.rpc).not.toHaveBeenCalled()
  })

  it('GET ixbrl/validate 404 PERIOD_NOT_FOUND for a missing period, 400 for a malformed version id', async () => {
    vi.mocked(buildIxbrlInput).mockRejectedValue(new Error('Fiscal period not found'))
    use({})
    const res = await validateIxbrl(request(`${BASE}/ixbrl/validate`), periodParams)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('PERIOD_NOT_FOUND')
    expect((await validateIxbrl(request(`${BASE}/ixbrl/validate?version_id=nope`), periodParams)).status).toBe(400)
  })
})
