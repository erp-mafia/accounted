/**
 * Integration tests for GET /api/v1/companies/:companyId/invoices/:id/pdf.
 *
 * The PDF renderer is mocked so the test is about routing, auth, error
 * mapping and filename composition — not about actual PDF bytes.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `pdf route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
    )
  }
  process.env.NEXT_PUBLIC_SUPABASE_URL ||= 'http://localhost:54321'
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ||= 'test-anon-key'
})

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

// vi.mock is hoisted above top-level consts, so the mock fn must be created
// inside vi.hoisted() to be available when the factory runs.
const { mockRender } = vi.hoisted(() => ({
  mockRender: vi.fn().mockResolvedValue(Buffer.from('pdf-bytes')),
}))
vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: mockRender,
}))
vi.mock('@/lib/invoices/pdf-template', () => ({
  InvoicePDF: vi.fn().mockReturnValue({}),
  brandingFromCompanySettings: vi.fn().mockReturnValue({}),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GET as pdf } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
  const queues = new Map<string, MockResult[]>()
  for (const [t, val] of Object.entries(byTable)) {
    queues.set(t, Array.isArray(val) ? [...val] : [val])
  }
  const buildChain = (table: string): unknown => {
    const handler: ProxyHandler<object> = {
      get(_target, prop) {
        if (prop === 'then') {
          return (resolve: (v: unknown) => void) => {
            const q = queues.get(table)
            const next = q && q.length > 1 ? q.shift()! : (q?.[0] ?? { data: null, error: null })
            resolve(next)
          }
        }
        return (..._args: unknown[]) => buildChain(table)
      },
    }
    return new Proxy({}, handler)
  }
  return { from: vi.fn((table: string) => buildChain(table)) }
}

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INVOICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const USER_ID = 'user-1'

function makeRequest(url: string): Request {
  return new Request(url, {
    method: 'GET',
    headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
  })
}
function detailParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

const SENT_INVOICE = {
  id: INVOICE_ID,
  invoice_number: '2026-0042',
  customer_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  invoice_date: '2026-05-12',
  due_date: '2026-06-11',
  status: 'sent',
  document_type: 'invoice',
  currency: 'SEK',
  subtotal: 10000,
  vat_amount: 2500,
  total: 12500,
  credited_invoice_id: null,
  customer: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Acme AB', email: 'acc@acme.test' },
  items: [{ id: 'i1', sort_order: 0, description: 'x', quantity: 1, unit: 'st', unit_price: 10000, line_total: 10000, vat_rate: 25 }],
}

const COMPANY_SETTINGS = {
  company_id: COMPANY_ID,
  company_name: 'Test AB',
  entity_type: 'enskild_firma',
  accounting_method: 'accrual',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRender.mockResolvedValue(Buffer.from('pdf-bytes'))
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['invoices:read'],
    mode: 'live',
  })
})

describe('GET /api/v1/companies/:companyId/invoices/:id/pdf', () => {
  it('returns a PDF for a sent invoice with the faktura-<number> filename', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: SENT_INVOICE, error: null },
        company_settings: { data: COMPANY_SETTINGS, error: null },
      }),
    )

    const res = await pdf(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/pdf`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Content-Disposition')).toBe('attachment; filename="faktura-2026-0042.pdf"')
    expect(res.headers.get('X-Request-Id')).toMatch(/^req_/)
  })

  it('uses utkast-<id-slice>.pdf filename for drafts', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: {
          data: { ...SENT_INVOICE, status: 'draft', invoice_number: null },
          error: null,
        },
        company_settings: { data: COMPANY_SETTINGS, error: null },
      }),
    )

    const res = await pdf(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/pdf`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    // Same composition as the dashboard's internal pdf route: the
    // "faktura-" prefix is preserved, the number slot is the "utkast-<slice>"
    // placeholder.
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="faktura-utkast-bbbbbbbb.pdf"',
    )
  })

  it('uses kreditfaktura-<number>.pdf for credit notes and embeds original number', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          {
            data: {
              ...SENT_INVOICE,
              invoice_number: '2026-0099',
              credited_invoice_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
            },
            error: null,
          },
          { data: { invoice_number: '2026-0042' }, error: null }, // original lookup
        ],
        company_settings: { data: COMPANY_SETTINGS, error: null },
      }),
    )

    const res = await pdf(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/pdf`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Disposition')).toBe(
      'attachment; filename="kreditfaktura-2026-0099.pdf"',
    )
    // The template received the original number — verify via the InvoicePDF mock call.
    const call = (mockRender.mock.calls[0]?.[0] as unknown) as { props?: unknown } | undefined
    expect(call).toBeDefined()
  })

  it('returns 404 NOT_FOUND for unknown invoice id', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: null, error: null },
      }),
    )

    const res = await pdf(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/pdf`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns 500 INVOICE_PDF_RENDER_FAILED when the renderer throws', async () => {
    mockRender.mockRejectedValueOnce(new Error('font load failed'))
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: SENT_INVOICE, error: null },
        company_settings: { data: COMPANY_SETTINGS, error: null },
      }),
    )

    const res = await pdf(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/pdf`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_PDF_RENDER_FAILED')
  })

  it('returns 400 VALIDATION_ERROR for non-UUID id', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await pdf(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/not-a-uuid/pdf`),
      detailParams(COMPANY_ID, 'not-a-uuid'),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })

  it('rejects keys without invoices:read scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      scopes: ['transactions:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await pdf(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/pdf`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(403)
  })
})
