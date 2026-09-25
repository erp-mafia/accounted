/**
 * Filing and year-end report reads through the v1 door of the operation
 * registry (src/lib/operations/filing-reports.ts via lib/operations/v1.ts)
 * and the v1 file routes (lib/api/v1/report-file-route.ts):
 *   GET .../reports/ink2, .../reports/ink2/sru
 *   GET .../reports/ne-bilaga, .../reports/ne-bilaga/sru
 *   GET .../reports/periodisk-sammanstallning, .../csv
 *   GET .../reports/vat-declaration/eskd
 *   GET .../reports/kassaflodesanalys, behandlingshistorik, bokslutsbilagor
 *   GET .../reports/kpi, .../reports/dimension-pnl
 *   GET .../audit-trail
 *
 * The generators are mocked: they are the dashboard's own and have their
 * tests. What is under test is the door and the service rules: auth and
 * scope, validation, the 404 for a period that is not the company's, the
 * legal-form refusals, the owner's personnummer masked in JSON but exact in
 * the SRU file, the file refusals, and the audit trail's cursor.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import JSZip from 'jszip'
// The shared wrapper's lease boundary has separate real and unit coverage.
vi.mock('@/lib/import/sie-period-read', () => ({
  withSIEExternalReport: (_s: unknown, _c: unknown, _op: unknown, read: () => Promise<unknown>) => read(),
}))

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

const m = vi.hoisted(() => ({
  ink2: vi.fn(),
  ne: vi.fn(),
  ps: vi.fn(),
  psReconcile: vi.fn(),
  vat: vi.fn(),
  kassa: vi.fn(),
  bokslut: vi.fn(),
  behandling: vi.fn(),
  dimPnl: vi.fn(),
  kpi: vi.fn(),
}))
vi.mock('@/lib/reports/ink2/ink2-engine', () => ({ generateINK2Declaration: m.ink2 }))
vi.mock('@/lib/reports/ne-bilaga/ne-engine', () => ({ generateNEDeclaration: m.ne }))
vi.mock('@/lib/reports/periodisk-sammanstallning', async (orig) => ({
  ...(await orig<typeof import('@/lib/reports/periodisk-sammanstallning')>()),
  generatePeriodiskSammanstallning: m.ps,
  reconcilePsAgainstVatDeclaration: m.psReconcile,
}))
vi.mock('@/lib/reports/vat-declaration', async (orig) => ({
  ...(await orig<typeof import('@/lib/reports/vat-declaration')>()),
  calculateVatDeclaration: m.vat,
}))
vi.mock('@/lib/reports/kassaflodesanalys', () => ({ generateKassaflodesanalys: m.kassa }))
vi.mock('@/lib/reports/bokslutsbilagor', () => ({ generateBokslutsbilagor: m.bokslut }))
vi.mock('@/lib/reports/behandlingshistorik', async (orig) => ({
  ...(await orig<typeof import('@/lib/reports/behandlingshistorik')>()),
  generateBehandlingshistorik: m.behandling,
}))
vi.mock('@/lib/reports/dimension-pnl', () => ({ generateDimensionPnl: m.dimPnl }))
vi.mock('@/lib/reports/kpi-report', async (orig) => {
  const actual = await orig<typeof import('@/lib/reports/kpi-report')>()
  m.kpi.mockImplementation(actual.generateKpiReport)
  return { ...actual, generateKpiReport: (...args: unknown[]) => m.kpi(...args) }
})

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as getInk2 } from '../ink2/route'
import { GET as getInk2Sru } from '../ink2/sru/route'
import { GET as getNe } from '../ne-bilaga/route'
import { GET as getNeSru } from '../ne-bilaga/sru/route'
import { GET as getPs } from '../periodisk-sammanstallning/route'
import { GET as getPsCsv } from '../periodisk-sammanstallning/csv/route'
import { GET as getEskd } from '../vat-declaration/eskd/route'
import { GET as getKassa } from '../kassaflodesanalys/route'
import { GET as getBehandling } from '../behandlingshistorik/route'
import { GET as getBokslut } from '../bokslutsbilagor/route'
import { GET as getKpi } from '../kpi/route'
import { GET as getDimPnl } from '../dimension-pnl/route'
import { GET as getAuditTrail } from '../../audit-trail/route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

interface TableResp {
  data?: unknown
  error?: unknown
}

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
  return { calls, from: vi.fn((table: string) => buildChain(table)), rpc: vi.fn(() => buildChain('rpc')) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const OWNER = { data: { company_id: COMPANY_ID, role: 'owner' }, error: null }
const PERIOD = {
  data: { id: PERIOD_ID, name: '2025', period_start: '2025-01-01', period_end: '2025-12-31', is_closed: true },
  error: null,
}
const NO_PERIOD = { data: null, error: null }
const AB = { data: { entity_type: 'aktiebolag' }, error: null }
const EF = { data: { entity_type: 'enskild_firma' }, error: null }
const PNR = '198001011234'
const BASE = `https://x.test/api/v1/companies/${COMPANY_ID}`
const params = { params: Promise.resolve({ companyId: COMPANY_ID }) }

function get(handler: (req: Request, p: typeof params) => Promise<Response>, path: string) {
  return handler(new Request(`${BASE}${path}`, { headers: { Authorization: 'Bearer test-fixture-not-a-real-key' } }), params)
}

function useClient(tables: Record<string, TableResp | TableResp[]>) {
  const client = makeClient({ company_members: OWNER, ...tables })
  mockServiceClient.mockReturnValue(client)
  return client
}

function ink2Declaration() {
  return {
    fiscalYear: { id: PERIOD_ID, name: '2025', start: '2025-01-01', end: '2025-12-31', isClosed: true },
    ink2: { '7011': '20250101', '7012': '20251231', '7104': 1000, '7114': 0 },
    ink2r: { '7410': 5000 },
    ink2s: { '7650': 1000 },
    breakdown: {},
    totals: { totalAssets: 1, totalEquityLiabilities: 1, operatingResult: 1, aretsResultat: 1 },
    companyInfo: { companyName: 'Testbolaget AB', orgNumber: '556677-8899', addressLine1: 'Gatan 1', postalCode: '11122', city: 'Stockholm', email: null },
    warnings: [],
  }
}

function neDeclaration() {
  return {
    fiscalYear: { id: PERIOD_ID, name: '2025', start: '2025-01-01', end: '2025-12-31', isClosed: true },
    rutor: { R1: 480000, R2: 0, R3: 0, R4: 0, R5: 0, R6: 0, R7: 0, R8: 0, R9: 0, R10: 0, R11: 480000 },
    breakdown: {},
    companyInfo: { companyName: 'Anna Svensson Konsult', orgNumber: PNR, addressLine1: 'Gatan 1', postalCode: '11122', city: 'Stockholm', email: 'anna@example.se' },
    warnings: [`Kontrollera ${PNR} mot Skatteverket`],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: 'user-1',
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['reports:read'],
    mode: 'live',
  })
})

describe('auth and scope (every report door)', () => {
  const doors: Array<[string, (req: Request, p: typeof params) => Promise<Response>, string]> = [
    ['ink2', getInk2, `/reports/ink2?period_id=${PERIOD_ID}`],
    ['ink2/sru', getInk2Sru, `/reports/ink2/sru?period_id=${PERIOD_ID}`],
    ['ne-bilaga', getNe, `/reports/ne-bilaga?period_id=${PERIOD_ID}`],
    ['ne-bilaga/sru', getNeSru, `/reports/ne-bilaga/sru?period_id=${PERIOD_ID}`],
    ['periodisk', getPs, '/reports/periodisk-sammanstallning?period_type=quarterly&year=2026&period=1'],
    ['periodisk/csv', getPsCsv, '/reports/periodisk-sammanstallning/csv?period_type=quarterly&year=2026&period=1'],
    ['eskd', getEskd, '/reports/vat-declaration/eskd?period_type=quarterly&year=2026&period=1'],
    ['kassaflodesanalys', getKassa, `/reports/kassaflodesanalys?period_id=${PERIOD_ID}`],
    ['behandlingshistorik', getBehandling, `/reports/behandlingshistorik?period_id=${PERIOD_ID}`],
    ['bokslutsbilagor', getBokslut, `/reports/bokslutsbilagor?period_id=${PERIOD_ID}`],
    ['kpi', getKpi, `/reports/kpi?period_id=${PERIOD_ID}`],
    ['dimension-pnl', getDimPnl, `/reports/dimension-pnl?period_id=${PERIOD_ID}`],
    ['audit-trail', getAuditTrail, '/audit-trail'],
  ]

  it.each(doors)('%s: 401 when the API key is rejected', async (_name, handler, path) => {
    mockValidate.mockResolvedValue({ error: 'Invalid API key', status: 401 })
    useClient({})
    expect((await get(handler, path)).status).toBe(401)
  })

  it.each(doors)('%s: 403 without reports:read', async (_name, handler, path) => {
    mockValidate.mockResolvedValue({ userId: 'user-1', companyId: COMPANY_ID, scopes: ['transactions:read'], mode: 'live' })
    useClient({})
    const res = await get(handler, path)
    expect(res.status).toBe(403)
  })
})

describe('GET /reports/ink2 and /reports/ink2/sru', () => {
  it('400 VALIDATION_ERROR without a uuid period_id', async () => {
    useClient({})
    const res = await get(getInk2, '/reports/ink2?period_id=nope')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
    expect((await get(getInk2Sru, '/reports/ink2/sru')).status).toBe(400)
  })

  it('404 for a period that is not the company\'s, before the generator runs', async () => {
    useClient({ fiscal_periods: NO_PERIOD })
    const res = await get(getInk2, `/reports/ink2?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('FISCAL_PERIOD_NOT_FOUND')
    expect(m.ink2).not.toHaveBeenCalled()
  })

  it('400 TAX_DECL_INK2_WRONG_LEGAL_FORM for an enskild firma', async () => {
    useClient({ fiscal_periods: PERIOD, company_settings: EF })
    const res = await get(getInk2, `/reports/ink2?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('TAX_DECL_INK2_WRONG_LEGAL_FORM')
    expect(m.ink2).not.toHaveBeenCalled()
  })

  it('200 with the declaration and the v1 path of the SRU file', async () => {
    useClient({ fiscal_periods: PERIOD, company_settings: AB })
    m.ink2.mockResolvedValue(ink2Declaration())
    const res = await get(getInk2, `/reports/ink2?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.ink2['7104']).toBe(1000)
    // Qualified ids on the machine doors: the fiscal year is fiscal_period_id, never a bare id.
    expect(body.data.fiscalYear.fiscal_period_id).toBe(PERIOD_ID)
    expect(body.data.fiscalYear.id).toBeUndefined()
    expect(body.data.companyInfo.orgNumber).toBe('556677-8899')
    expect(body.data.sru_file.download).toBe(`/api/v1/companies/${COMPANY_ID}/reports/ink2/sru?period_id=${PERIOD_ID}`)
  })

  it('500 TAX_DECL_GENERATION_FAILED when the generator throws', async () => {
    useClient({ fiscal_periods: PERIOD, company_settings: AB })
    m.ink2.mockRejectedValue(new Error('boom'))
    const res = await get(getInk2, `/reports/ink2?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(500)
    expect((await res.json()).error.code).toBe('TAX_DECL_GENERATION_FAILED')
  })

  it('the SRU zip holds INFO.SRU and BLANKETTER.SRU in ISO 8859-1', async () => {
    useClient({ fiscal_periods: PERIOD, company_settings: AB })
    m.ink2.mockResolvedValue(ink2Declaration())
    const res = await get(getInk2Sru, `/reports/ink2/sru?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/zip')
    expect(res.headers.get('Content-Disposition')).toContain('INK2_SRU_5566778899_2025.zip')
    const zip = await JSZip.loadAsync(await res.arrayBuffer())
    expect(Object.keys(zip.files).sort()).toEqual(['BLANKETTER.SRU', 'INFO.SRU'])
    const info = await zip.file('INFO.SRU')!.async('uint8array')
    // 'Testbolaget' is ASCII; the encoding check is that no UTF-8 multibyte lead byte appears.
    expect(Array.from(info).some((b) => b === 0xc3)).toBe(false)
  })
})

describe('GET /reports/ne-bilaga and /reports/ne-bilaga/sru', () => {
  it('400 TAX_DECL_NE_WRONG_LEGAL_FORM for an aktiebolag', async () => {
    useClient({ fiscal_periods: PERIOD, company_settings: AB })
    const res = await get(getNe, `/reports/ne-bilaga?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('TAX_DECL_NE_WRONG_LEGAL_FORM')
  })

  it('404 for a period that is not the company\'s', async () => {
    useClient({ fiscal_periods: NO_PERIOD })
    expect((await get(getNeSru, `/reports/ne-bilaga/sru?period_id=${PERIOD_ID}`)).status).toBe(404)
  })

  it('masks the owner\'s personnummer everywhere in the JSON', async () => {
    useClient({ fiscal_periods: PERIOD, company_settings: EF })
    m.ne.mockResolvedValue(neDeclaration())
    const res = await get(getNe, `/reports/ne-bilaga?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(text).not.toContain(PNR)
    expect(text).not.toContain('8001011234')
    const body = JSON.parse(text)
    expect(body.data.companyInfo.orgNumber).toBe('19800101XXXX')
    expect(body.data.rutor.R1).toBe(480000)
    expect(body.data.warnings[0]).toContain('19800101XXXX')
  })

  it('keeps the personnummer exact in the SRU file, which is the filing', async () => {
    useClient({ fiscal_periods: PERIOD, company_settings: EF })
    m.ne.mockResolvedValue(neDeclaration())
    const res = await get(getNeSru, `/reports/ne-bilaga/sru?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(200)
    const zip = await JSZip.loadAsync(await res.arrayBuffer())
    const info = await zip.file('INFO.SRU')!.async('string')
    expect(info).toContain(PNR)
  })
})

describe('GET /reports/periodisk-sammanstallning and /csv', () => {
  const report = {
    period: { type: 'quarterly', year: 2026, period: 1, start: '2026-01-01', end: '2026-03-31', label: 'Kvartal 1 2026' },
    rows: [{ country: 'DE', vatNumber: '123456789', services: 42000, goods: 0, triangulation: 0, customerId: null, customerName: 'Beispiel GmbH', hasBlockingIssue: false }],
    warnings: [],
    totals: { services: 42000, goods: 0, triangulation: 0, grand: 42000, rowCount: 1 },
  }

  it('400 VALIDATION_ERROR for a quarter above 4 or a monthly type the schema lacks', async () => {
    useClient({})
    expect((await get(getPs, '/reports/periodisk-sammanstallning?period_type=quarterly&year=2026&period=5')).status).toBe(400)
    expect((await get(getPs, '/reports/periodisk-sammanstallning?period_type=yearly&year=2026&period=1')).status).toBe(400)
  })

  it('200 with the reconciled report', async () => {
    useClient({ company_settings: { data: { moms_period: 'quarterly' }, error: null } })
    m.ps.mockResolvedValue(report)
    m.psReconcile.mockImplementation(async (_s: unknown, _c: unknown, r: unknown) => ({ ...(r as object), reconciliation: { ruta39: 42000 } }))
    const res = await get(getPs, '/reports/periodisk-sammanstallning?period_type=quarterly&year=2026&period=1')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.rows).toHaveLength(1)
    expect(body.data.reconciliation.ruta39).toBe(42000)
    expect(m.ps).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, 'quarterly', 2026, 1)
  })

  it('CSV: 400 PS_REPORT_MISSING_FILER_INFO without a tax contact, before generating', async () => {
    useClient({ company_settings: { data: { org_number: '5566778899', tax_contact_name: null }, error: null } })
    const res = await get(getPsCsv, '/reports/periodisk-sammanstallning/csv?period_type=quarterly&year=2026&period=1')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('PS_REPORT_MISSING_FILER_INFO')
    expect(m.ps).not.toHaveBeenCalled()
  })

  const filer = {
    data: { org_number: '5566778899', tax_contact_name: 'Anna', tax_contact_phone: '0701234567', tax_contact_email: 'a@b.se' },
    error: null,
  }

  it('CSV: 400 PS_REPORT_CSV_BLOCKED_BY_ERRORS while a blocking warning stands', async () => {
    useClient({ company_settings: filer })
    m.ps.mockResolvedValue({ ...report, warnings: [{ level: 'error', code: 'MISSING_VAT_NUMBER', message: 'x' }] })
    const res = await get(getPsCsv, '/reports/periodisk-sammanstallning/csv?period_type=quarterly&year=2026&period=1')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('PS_REPORT_CSV_BLOCKED_BY_ERRORS')
  })

  it('CSV: 200 with the SKV 574008 file', async () => {
    useClient({ company_settings: filer })
    m.ps.mockResolvedValue(report)
    const res = await get(getPsCsv, '/reports/periodisk-sammanstallning/csv?period_type=quarterly&year=2026&period=1')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toContain('attachment')
    const text = await res.text()
    expect(text.startsWith('SKV574008;')).toBe(true)
    expect(text).toContain('DE123456789')
  })
})

describe('GET /reports/vat-declaration/eskd', () => {
  const declaration = {
    period: { start: '2026-01-01', end: '2026-03-31' },
    rutor: {
      ruta05: 100000, ruta06: 0, ruta07: 0, ruta08: 0, ruta10: 25000, ruta11: 0, ruta12: 0,
      ruta20: 0, ruta21: 0, ruta22: 0, ruta23: 0, ruta24: 0, ruta30: 0, ruta31: 0, ruta32: 0,
      ruta35: 0, ruta36: 0, ruta37: 0, ruta38: 0, ruta39: 0, ruta40: 0, ruta41: 0, ruta42: 0,
      ruta48: 3200, ruta49: 21800, ruta50: 0, ruta60: 0, ruta61: 0, ruta62: 0,
    },
  }

  it('400 VALIDATION_ERROR for yearly with period 2', async () => {
    useClient({})
    expect((await get(getEskd, '/reports/vat-declaration/eskd?period_type=yearly&year=2026&period=2')).status).toBe(400)
  })

  it('404 VAT_ESKD_SETTINGS_MISSING without company settings', async () => {
    useClient({ company_settings: { data: null, error: null } })
    const res = await get(getEskd, '/reports/vat-declaration/eskd?period_type=quarterly&year=2026&period=1')
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('VAT_ESKD_SETTINGS_MISSING')
  })

  it('400 VAT_ESKD_ORG_NUMBER_INVALID without a 10 or 12 digit org number, before computing', async () => {
    useClient({ company_settings: { data: { org_number: '123' }, error: null } })
    const res = await get(getEskd, '/reports/vat-declaration/eskd?period_type=quarterly&year=2026&period=1')
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VAT_ESKD_ORG_NUMBER_INVALID')
    expect(m.vat).not.toHaveBeenCalled()
  })

  it('404 for a fiscal_period_id that is not the company\'s', async () => {
    useClient({ company_settings: { data: { org_number: '5566778899' }, error: null }, fiscal_periods: NO_PERIOD })
    const res = await get(getEskd, `/reports/vat-declaration/eskd?period_type=yearly&year=2026&period=1&fiscal_period_id=${PERIOD_ID}`)
    expect(res.status).toBe(404)
  })

  it('200 with the eSKD XML in ISO 8859-1', async () => {
    useClient({ company_settings: { data: { org_number: '5566778899' }, error: null } })
    m.vat.mockResolvedValue(declaration)
    const res = await get(getEskd, '/reports/vat-declaration/eskd?period_type=quarterly&year=2026&period=1')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/xml; charset=ISO-8859-1')
    expect(res.headers.get('Content-Disposition')).toContain('momsdeklaration-2026-01-01--2026-03-31.xml')
    const body = await res.text()
    expect(body).toContain('<OrgNr>556677-8899</OrgNr>')
    expect(body).toContain('<MomsBetala>21800</MomsBetala>')
  })
})

describe('GET /reports/kassaflodesanalys', () => {
  it('404 for a period that is not the company\'s', async () => {
    useClient({ fiscal_periods: NO_PERIOD })
    expect((await get(getKassa, `/reports/kassaflodesanalys?period_id=${PERIOD_ID}`)).status).toBe(404)
    expect(m.kassa).not.toHaveBeenCalled()
  })

  it('422 CASH_FLOW_TAX_ALLOCATION_REQUIRED when the tax postings cannot be split', async () => {
    useClient({ fiscal_periods: PERIOD })
    m.kassa.mockRejectedValue(Object.assign(new Error('split'), { code: 'CASH_FLOW_TAX_ALLOCATION_REQUIRED' }))
    const res = await get(getKassa, `/reports/kassaflodesanalys?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(422)
    expect((await res.json()).error.code).toBe('CASH_FLOW_TAX_ALLOCATION_REQUIRED')
  })

  it('200 with the statement', async () => {
    useClient({ fiscal_periods: PERIOD })
    m.kassa.mockResolvedValue({ fiscal_period_id: PERIOD_ID, total_cash_flow: 117000 })
    const res = await get(getKassa, `/reports/kassaflodesanalys?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(200)
    expect((await res.json()).data.total_cash_flow).toBe(117000)
  })
})

describe('GET /reports/behandlingshistorik', () => {
  const report = (orgNumber: string) => ({
    company: { name: 'Anna Svensson Konsult', org_number: orgNumber },
    period: { id: PERIOD_ID, name: '2025', start: '2025-01-01', end: '2025-12-31' },
    range: { from: '2025-01-01', to: '2025-12-31' },
    mode: 'fiscal_year',
    generated_at: '2026-01-10T10:00:00Z',
    app_version: 'abc',
    total_events: 1,
    by_category: {},
    events: [{ id: 'audit:1', details: [`Organisationsnummer: (tomt) → ${orgNumber}`] }],
  })

  it('400 VALIDATION_ERROR for a from_date outside the period', async () => {
    useClient({ fiscal_periods: PERIOD })
    const res = await get(getBehandling, `/reports/behandlingshistorik?period_id=${PERIOD_ID}&from_date=2024-06-01`)
    expect(res.status).toBe(400)
    expect(m.behandling).not.toHaveBeenCalled()
  })

  it('400 VALIDATION_ERROR for an unknown category', async () => {
    useClient({ fiscal_periods: PERIOD })
    expect((await get(getBehandling, `/reports/behandlingshistorik?period_id=${PERIOD_ID}&category=nope`)).status).toBe(400)
  })

  it('404 for a period that is not the company\'s', async () => {
    useClient({ fiscal_periods: NO_PERIOD })
    expect((await get(getBehandling, `/reports/behandlingshistorik?period_id=${PERIOD_ID}`)).status).toBe(404)
  })

  it('passes the filters like the dashboard and masks an enskild firma owner\'s personnummer', async () => {
    useClient({ fiscal_periods: PERIOD, company_settings: EF })
    m.behandling.mockResolvedValue(report(PNR))
    const res = await get(
      getBehandling,
      `/reports/behandlingshistorik?period_id=${PERIOD_ID}&from_date=2025-03-01&to_date=2025-03-31&category=verifikation`,
    )
    expect(res.status).toBe(200)
    expect(m.behandling).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      { periodId: PERIOD_ID, fromDate: '2025-03-01', toDate: '2025-03-31', categories: ['verifikation'] },
      expect.objectContaining({ globalClient: expect.anything(), resolveUserLabels: expect.any(Function) }),
    )
    const text = await res.text()
    expect(text).not.toContain(PNR)
    const body = JSON.parse(text)
    expect(body.data.company.org_number).toBe('19800101XXXX')
    expect(body.data.period.fiscal_period_id).toBe(PERIOD_ID)
    expect(body.data.events[0]).toMatchObject({ event_id: 'audit:1' })
    expect(body.data.events[0].id).toBeUndefined()
  })

  it('leaves an aktiebolag\'s org number as it is', async () => {
    useClient({ fiscal_periods: PERIOD, company_settings: AB })
    m.behandling.mockResolvedValue(report('5566778899'))
    const body = await (await get(getBehandling, `/reports/behandlingshistorik?period_id=${PERIOD_ID}`)).json()
    expect(body.data.company.org_number).toBe('5566778899')
  })
})

describe('GET /reports/bokslutsbilagor', () => {
  it('404 when the generator finds no period', async () => {
    useClient({})
    m.bokslut.mockResolvedValue(null)
    expect((await get(getBokslut, `/reports/bokslutsbilagor?period_id=${PERIOD_ID}`)).status).toBe(404)
  })

  it('200 with the pärm, the signer resolved for the calling user', async () => {
    useClient({ company_settings: AB })
    m.bokslut.mockResolvedValue({
      company: { name: 'Testbolaget AB', org_number: '5566778899' },
      period: { id: PERIOD_ID, name: '2025', start: '2025-01-01', end: '2025-12-31' },
      accounts: [
        {
          account_key: 'manual:1510',
          account_number: '1510',
          signoff: { id: 'so-1', through_date: '2025-12-31', signed_by: 'user-1' },
          attachments: [{ id: 'att-1', file_name: 'kundreskontra.pdf', sha256: 'ab' }],
        },
      ],
      summary: { unsigned: 2 },
    })
    const res = await get(getBokslut, `/reports/bokslutsbilagor?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.summary.unsigned).toBe(2)
    expect(body.data.period.fiscal_period_id).toBe(PERIOD_ID)
    expect(body.data.accounts[0].signoff).toMatchObject({ signoff_id: 'so-1' })
    expect(body.data.accounts[0].attachments[0]).toMatchObject({ attachment_id: 'att-1' })
    expect(JSON.stringify(body.data.accounts)).not.toContain('"id"')
    expect(m.bokslut).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, PERIOD_ID, expect.objectContaining({ userId: 'user-1' }))
  })
})

describe('GET /reports/kpi', () => {
  it('400 VALIDATION_ERROR when dim_no comes without dim_code', async () => {
    useClient({})
    expect((await get(getKpi, `/reports/kpi?period_id=${PERIOD_ID}&dim_no=6`)).status).toBe(400)
  })

  it('404 for a period that is not the company\'s (the dashboard\'s service)', async () => {
    useClient({ fiscal_periods: NO_PERIOD })
    const res = await get(getKpi, `/reports/kpi?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('FISCAL_PERIOD_NOT_FOUND')
  })

  it('200 passing the dimension filter as the dashboard does', async () => {
    useClient({})
    m.kpi.mockResolvedValueOnce({ ok: true, data: { netResult: 184200 } })
    const res = await get(getKpi, `/reports/kpi?period_id=${PERIOD_ID}&dim_no=6&dim_code=P001`)
    expect(res.status).toBe(200)
    expect((await res.json()).data.netResult).toBe(184200)
    expect(m.kpi).toHaveBeenCalledWith(expect.anything(), { period_id: PERIOD_ID, dimensions: { '6': 'P001' } })
  })
})

describe('GET /reports/dimension-pnl', () => {
  it('400 VALIDATION_ERROR for a dim_no that is not an SIE number', async () => {
    useClient({})
    expect((await get(getDimPnl, `/reports/dimension-pnl?period_id=${PERIOD_ID}&dim_no=0`)).status).toBe(400)
  })

  it('400 VALIDATION_ERROR for a to_date outside the period', async () => {
    useClient({ fiscal_periods: PERIOD })
    expect((await get(getDimPnl, `/reports/dimension-pnl?period_id=${PERIOD_ID}&to_date=2026-02-01`)).status).toBe(400)
    expect(m.dimPnl).not.toHaveBeenCalled()
  })

  it('404 for a period that is not the company\'s', async () => {
    useClient({ fiscal_periods: NO_PERIOD })
    expect((await get(getDimPnl, `/reports/dimension-pnl?period_id=${PERIOD_ID}`)).status).toBe(404)
  })

  it('200 defaulting to dimension 6 (projekt)', async () => {
    useClient({ fiscal_periods: PERIOD })
    m.dimPnl.mockResolvedValue({ dimension: { sie_dim_no: '6', name: 'Projekt' }, net_total: 1 })
    const res = await get(getDimPnl, `/reports/dimension-pnl?period_id=${PERIOD_ID}`)
    expect(res.status).toBe(200)
    expect(m.dimPnl).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, PERIOD_ID, '6', { toDate: undefined })
  })
})

describe('GET /audit-trail', () => {
  const row = (id: string, created_at: string) => ({
    id,
    action: 'COMMIT',
    table_name: 'journal_entries',
    record_id: 'r',
    user_id: null,
    actor_type: 'api_key',
    actor_label: 'CI key',
    description: null,
    old_state: null,
    new_state: null,
    created_at,
  })
  const ID1 = '11111111-1111-4111-8111-111111111111'
  const ID2 = '22222222-2222-4222-8222-222222222222'

  it('400 VALIDATION_ERROR for an unknown action or a bad date', async () => {
    useClient({})
    expect((await get(getAuditTrail, '/audit-trail?action=DROP')).status).toBe(400)
    expect((await get(getAuditTrail, '/audit-trail?from_date=yesterday')).status).toBe(400)
  })

  it('returns a page with a next_cursor and applies the filters, company-scoped', async () => {
    const client = useClient({
      audit_log: { data: [row(ID1, '2026-03-02T09:14:00Z'), row(ID2, '2026-03-01T09:14:00Z')], error: null },
    })
    const res = await get(getAuditTrail, '/audit-trail?limit=1&table_name=journal_entries&action=COMMIT&from_date=2026-01-01')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.entries).toHaveLength(1)
    expect(body.data.entries[0].id).toBe(ID1)
    expect(body.data.next_cursor).toEqual(expect.any(String))
    const audit = client.calls.filter((c) => c.table === 'audit_log')
    expect(audit).toContainEqual({ table: 'audit_log', method: 'eq', args: ['company_id', COMPANY_ID] })
    expect(audit).toContainEqual({ table: 'audit_log', method: 'eq', args: ['table_name', 'journal_entries'] })
    expect(audit).toContainEqual({ table: 'audit_log', method: 'eq', args: ['action', 'COMMIT'] })
    expect(audit).toContainEqual({ table: 'audit_log', method: 'gte', args: ['created_at', '2026-01-01'] })
    expect(audit).toContainEqual({ table: 'audit_log', method: 'limit', args: [2] })

    // The cursor resumes strictly after the last row returned.
    const next = useClient({ audit_log: { data: [row(ID2, '2026-03-01T09:14:00Z')], error: null } })
    const res2 = await get(getAuditTrail, `/audit-trail?limit=1&cursor=${body.data.next_cursor}`)
    const body2 = await res2.json()
    expect(body2.data.next_cursor).toBeNull()
    expect(next.calls).toContainEqual({
      table: 'audit_log',
      method: 'or',
      args: [`created_at.lt.2026-03-02T09:14:00Z,and(created_at.eq.2026-03-02T09:14:00Z,id.lt.${ID1})`],
    })
  })
})
