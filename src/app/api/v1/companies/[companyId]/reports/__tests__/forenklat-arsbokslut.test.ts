/**
 * The förenklat årsbokslut through the v1 doors: the report operation
 * (lib/operations/forenklat-arsbokslut.ts via lib/operations/v1.ts) and the
 * PDF file route (lib/api/v1/report-file-route.ts). The service is mocked: it
 * has its own tests. Under test: auth and scope, validation, the failure
 * codes, and the v1 path of the PDF the JSON names.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
// The shared wrapper's lease boundary has separate real and unit coverage.
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEExternalReport: (_s: unknown, _c: unknown, _op: unknown, read: () => Promise<unknown>) => read(),
}))

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') throw new Error('NODE_ENV=test required')
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
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

const m = vi.hoisted(() => ({ report: vi.fn(), pdf: vi.fn() }))
vi.mock('@/lib/bokslut/forenklat-arsbokslut/service', () => ({
  getForenklatArsbokslut: m.report,
  getForenklatArsbokslutPdfFile: m.pdf,
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createTableMockSupabase } from '@/tests/helpers'
import { GET as getReport } from '../forenklat-arsbokslut/route'
import { GET as getPdf } from '../forenklat-arsbokslut/pdf/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}`
const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

function get(handler: (req: Request, p: typeof params) => Promise<Response>, path: string) {
  return handler(new Request(`${BASE}${path}`, { headers: { Authorization: 'Bearer test-fixture-not-a-real-key' } }), params)
}

const REPORT = {
  regelverk: 'BFNAR 2010:1',
  company: { name: 'Föreningen', org_number: '8020001234' },
  fiscal_period: { fiscal_period_id: PERIOD_ID, name: '2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: true },
  previous_period: null,
  resultatrakning: [{ kind: 'post', key: 'medlemsavgifter', label: 'Medlemsavgifter', current: 100, previous: null }],
  balansrakning: [],
  totals: {
    aretsOverUnderskott: { current: 100, previous: null },
    summaTillgangar: { current: 100, previous: null },
    summaEgetKapitalOchSkulder: { current: 100, previous: null },
    nettoomsattning: { current: 100, previous: null },
  },
  eligibility: { confirmed: true, confirmed_at: '2027-03-01T10:00:00Z' },
  notes: null,
  signatories: [],
  blockers: [],
  warnings: [],
}

beforeEach(() => {
  vi.clearAllMocks()
  mockServiceClient.mockReturnValue(
    createTableMockSupabase({ company_members: { data: { company_id: COMPANY_ID, role: 'owner' } } }).supabase,
  )
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read'],
    mode: 'live',
  })
  m.report.mockResolvedValue({ ok: true, data: REPORT })
  m.pdf.mockResolvedValue({
    ok: true,
    data: { filename: 'forenklat-arsbokslut-2026-12-31.pdf', contentType: 'application/pdf', bytes: new Uint8Array([37, 80, 68, 70, 45]) },
  })
})

describe('GET /reports/forenklat-arsbokslut and /pdf: auth', () => {
  it.each([
    ['report', getReport, `/reports/forenklat-arsbokslut?period_id=${PERIOD_ID}`],
    ['pdf', getPdf, `/reports/forenklat-arsbokslut/pdf?period_id=${PERIOD_ID}`],
  ] as const)('%s: 401 for a rejected key, 403 without reports:read', async (_name, handler, path) => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    expect((await get(handler, path)).status).toBe(401)
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    expect((await get(handler, path)).status).toBe(403)
    expect(m.report).not.toHaveBeenCalled()
    expect(m.pdf).not.toHaveBeenCalled()
  })
})

describe('GET /reports/forenklat-arsbokslut', () => {
  it('400 VALIDATION_ERROR without a uuid period_id', async () => {
    const res = await get(getReport, '/reports/forenklat-arsbokslut?period_id=nope')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    expect((await get(getPdf, '/reports/forenklat-arsbokslut/pdf')).status).toBe(400)
  })

  it('404 for a period that is not the company\'s, 400 for a form without one', async () => {
    m.report.mockResolvedValue({ ok: false, code: 'FISCAL_PERIOD_NOT_FOUND' })
    const missing = await get(getReport, `/reports/forenklat-arsbokslut?period_id=${PERIOD_ID}`)
    expect(missing.status).toBe(404)
    expect((await missing.json()).error.code).toBe('FISCAL_PERIOD_NOT_FOUND')

    m.report.mockResolvedValue({ ok: false, code: 'FORENKLAT_ARSBOKSLUT_WRONG_LEGAL_FORM' })
    const wrong = await get(getReport, `/reports/forenklat-arsbokslut?period_id=${PERIOD_ID}`)
    expect(wrong.status).toBe(400)
    expect((await wrong.json()).error.code).toBe('FORENKLAT_ARSBOKSLUT_WRONG_LEGAL_FORM')
  })

  it('200 with the report and the v1 path of the PDF', async () => {
    const res = await get(getReport, `/reports/forenklat-arsbokslut?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.regelverk).toBe('BFNAR 2010:1')
    expect(body.data.fiscal_period.fiscal_period_id).toBe(PERIOD_ID)
    expect(body.data.pdf_file).toEqual({
      download: `/api/v1/companies/${COMPANY_ID}/reports/forenklat-arsbokslut/pdf?period_id=${PERIOD_ID}`,
      content_type: 'application/pdf',
    })
    expect(m.report).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_ID }), PERIOD_ID)
  })
})

describe('GET /reports/forenklat-arsbokslut/pdf', () => {
  it('200 with the PDF as a download', async () => {
    const res = await get(getPdf, `/reports/forenklat-arsbokslut/pdf?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toContain('forenklat-arsbokslut-2026-12-31.pdf')
    expect(Buffer.from(await res.arrayBuffer()).subarray(0, 4).toString()).toBe('%PDF')
  })

  it('422 FORENKLAT_ARSBOKSLUT_BLOCKED with the reason while the report has blockers', async () => {
    m.pdf.mockResolvedValue({
      ok: false,
      code: 'FORENKLAT_ARSBOKSLUT_BLOCKED',
      details: { reason: 'Räkenskapsåret är inte stängt.' },
    })
    const res = await get(getPdf, `/reports/forenklat-arsbokslut/pdf?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(422)
    const body = await res.json()
    expect(body.error.code).toBe('FORENKLAT_ARSBOKSLUT_BLOCKED')
  })
})
