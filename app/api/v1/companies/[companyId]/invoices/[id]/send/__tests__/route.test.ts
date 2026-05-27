/**
 * Integration tests for POST /api/v1/companies/:companyId/invoices/:id/send.
 *
 * Mocks the email service, PDF renderer, F-series allocator, journal-entry
 * helper, and document uploader so the route's orchestration is what's
 * under test.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `send route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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

vi.mock('@/lib/invoices/ensure-invoice-number', () => ({
  ensureInvoiceNumber: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoiceJournalEntry: vi.fn().mockResolvedValue({
    id: 'jjjjjjjj-jjjj-4jjj-8jjj-jjjjjjjjjjjj',
  }),
}))

vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: vi.fn().mockResolvedValue({}),
}))

vi.mock('@react-pdf/renderer', () => ({
  renderToBuffer: vi.fn().mockResolvedValue(Buffer.from('pdf-content')),
}))

// Email service mock — configurable per test
const mockSendEmail = vi.fn()
const mockIsConfigured = vi.fn().mockReturnValue(true)
vi.mock('@/lib/email/service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/email/service')>()
  return {
    ...actual,
    getEmailService: () => ({
      isConfigured: mockIsConfigured,
      sendEmail: mockSendEmail,
    }),
  }
})

vi.mock('@/lib/email/invoice-templates', () => ({
  generateInvoiceEmailHtml: vi.fn().mockReturnValue('<html>...</html>'),
  generateInvoiceEmailText: vi.fn().mockReturnValue('plain text'),
  generateInvoiceEmailSubject: vi.fn().mockReturnValue('Faktura'),
}))

vi.mock('@/lib/invoices/pdf-template', () => ({
  InvoicePDF: vi.fn().mockReturnValue({}),
  brandingFromCompanySettings: vi.fn().mockReturnValue({}),
}))
import { InvoicePDF } from '@/lib/invoices/pdf-template'

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { POST as sendInvoice } from '../route'

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
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': 'idem1234-3030-4abc-8def-1234567890ab',
    },
  })
}
function detailParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

const DRAFT_INVOICE = {
  id: INVOICE_ID,
  invoice_number: null,
  customer_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  invoice_date: '2026-05-12',
  due_date: '2026-06-11',
  status: 'draft',
  document_type: 'invoice',
  currency: 'SEK',
  subtotal: 10000,
  vat_amount: 2500,
  total: 12500,
  vat_treatment: 'standard_25',
  moms_ruta: '05',
  credited_invoice_id: null,
  customer: {
    id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    name: 'Acme AB',
    email: 'billing@acme.test',
    country: 'Sweden',
  },
  items: [{ id: 'iiiiiiii-iiii-4iii-8iii-iiiiiiiiiiii', sort_order: 0, description: 'x', quantity: 1, unit: 'st', unit_price: 10000, line_total: 10000, vat_rate: 25, vat_amount: 2500 }],
}

const COMPANY_SETTINGS = {
  company_id: COMPANY_ID,
  company_name: 'Test AB',
  email: 'support@test-ab.example',
  accounting_method: 'accrual',
  entity_type: 'enskild_firma',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['invoices:write'],
    mode: 'live',
  })
  mockIsConfigured.mockReturnValue(true)
  mockSendEmail.mockResolvedValue({ success: true, messageId: 're_abc123' })
})

describe('POST /api/v1/companies/:companyId/invoices/:id/send', () => {
  it('sends a draft invoice end-to-end and returns 200 with messageId', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          { data: DRAFT_INVOICE, error: null }, // pre-flight fetch
          { data: { invoice_number: '2026-0042' }, error: null }, // re-read after allocation
        ],
        company_settings: { data: COMPANY_SETTINGS, error: null },
      }),
    )

    const res = await sendInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/send`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('sent')
    expect(body.data.invoice_number).toBe('2026-0042')
    expect(body.data.message_id).toBe('re_abc123')
    expect(body.data.sent_to).toBe('billing@acme.test')
    expect(body.data.journal_entry_id).toBe('jjjjjjjj-jjjj-4jjj-8jjj-jjjjjjjjjjjj')
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
  })

  it('returns 503 when email service is not configured', async () => {
    mockIsConfigured.mockReturnValue(false)
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await sendInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/send`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_SEND_EMAIL_NOT_CONFIGURED')
  })

  it('returns 400 INVOICE_SEND_NO_CUSTOMER_EMAIL when customer lacks email', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: {
          data: { ...DRAFT_INVOICE, customer: { ...DRAFT_INVOICE.customer, email: null } },
          error: null,
        },
        company_settings: { data: COMPANY_SETTINGS, error: null },
      }),
    )

    const res = await sendInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/send`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_SEND_NO_CUSTOMER_EMAIL')
  })

  it('rejects cancelled invoices with INVOICE_SEND_CANCELLED', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: { ...DRAFT_INVOICE, status: 'cancelled' }, error: null },
      }),
    )

    const res = await sendInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/send`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_SEND_CANCELLED')
  })

  it('rejects already-sent invoices with INVOICE_UPDATE_NOT_DRAFT', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: { ...DRAFT_INVOICE, status: 'sent' }, error: null },
      }),
    )

    const res = await sendInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/send`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_UPDATE_NOT_DRAFT')
  })

  it('returns 502 INVOICE_SEND_PROVIDER_FAILED when email send fails', async () => {
    mockSendEmail.mockResolvedValue({ success: false, error: 'rate_limited' })
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          { data: DRAFT_INVOICE, error: null },
          { data: { invoice_number: '2026-0042' }, error: null },
        ],
        company_settings: { data: COMPANY_SETTINGS, error: null },
      }),
    )

    const res = await sendInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/send`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(502)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_SEND_PROVIDER_FAILED')
  })

  it('dry-run validates the pipeline without sending email or allocating a number', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: DRAFT_INVOICE, error: null },
        company_settings: { data: COMPANY_SETTINGS, error: null },
      }),
    )

    const res = await sendInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/send?dry_run=true`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.status).toBe('sent')
    expect(body.data.preview.would_send_to).toBe('billing@acme.test')
    expect(body.data.preview.would_cc).toBe('support@test-ab.example')
    expect(body.data.preview.preflight_pdf_render).toBe('ok')
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('rejects credit notes (credited_invoice_id set) with VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: {
          data: { ...DRAFT_INVOICE, credited_invoice_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
          error: null,
        },
      }),
    )

    const res = await sendInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/send`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('credited_invoice_id')
  })

  it('flags status flip 0-row no-op as a warning instead of lying in the response', async () => {
    // Status flip returns no rows (concurrent state change). Email is gone;
    // response status must say 'draft' and carry STATUS_UPDATE_FAILED.
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          { data: DRAFT_INVOICE, error: null },
          { data: { invoice_number: '2026-0042' }, error: null },
          { data: [], error: null }, // status flip: 0 rows matched
        ],
        company_settings: { data: COMPANY_SETTINGS, error: null },
      }),
    )

    const res = await sendInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/send`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('draft')
    expect(body.data.warnings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'STATUS_UPDATE_FAILED' })]),
    )
  })

  it('renders the final PDF as if already sent (no UTKAST banner)', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          { data: DRAFT_INVOICE, error: null }, // pre-flight fetch
          { data: { invoice_number: '2026-0043' }, error: null }, // re-read after allocation
        ],
        company_settings: { data: COMPANY_SETTINGS, error: null },
      }),
    )

    const res = await sendInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/send`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )
    expect(res.status).toBe(200)

    // DRAFT_INVOICE has invoice_number: null, so isFreshAllocation is true and
    // a preflight render runs first with the F-PREVIEW placeholder. The final
    // render is the second call — its invoice must carry status: 'sent' and
    // the freshly-assigned invoice_number, otherwise the customer's PDF is
    // stamped "UTKAST – inte en giltig faktura".
    const calls = vi.mocked(InvoicePDF).mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(2)
    const finalRenderArgs = calls[calls.length - 1][0]
    expect(finalRenderArgs.invoice.status).toBe('sent')
    expect(finalRenderArgs.invoice.invoice_number).toBe('2026-0043')
  })

  it('rejects keys without invoices:write scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await sendInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/send`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(403)
  })
})
