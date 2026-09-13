/**
 * Integration tests for POST /api/v1/companies/:companyId/invoices/:id/credit.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `credit route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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

vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false, fiscal_period_id: 'fp-1' }),
}))

vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createCreditNoteJournalEntry: vi.fn().mockResolvedValue({
    id: 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm',
  }),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import {
  createCreditNoteJournalEntry as mockedCreditEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { checkPeriodLock as mockedCheckPeriodLock } from '@/lib/api/v1/check-period-lock'
import { POST as creditInvoice } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockCreditEntry = mockedCreditEntry as ReturnType<typeof vi.fn>
const mockCheckPeriodLock = mockedCheckPeriodLock as ReturnType<typeof vi.fn>

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

function makeRequest(url: string, body?: unknown): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Content-Type': 'application/json',
      'Idempotency-Key': 'idem1234-2020-4abc-8def-1234567890ab',
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
}
function detailParams(companyId: string, id: string) {
  return { params: Promise.resolve({ companyId, id }) }
}

const ORIGINAL_SENT_INVOICE = {
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
  vat_treatment: 'standard_25',
  moms_ruta: '05',
  credited_invoice_id: null,
  customer: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Acme AB' },
  items: [{ sort_order: 0, description: 'x', quantity: 1, unit: 'st', unit_price: 10000, line_total: 10000, vat_rate: 25, vat_amount: 2500 }],
}

const CREATED_CREDIT_NOTE = {
  id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
  invoice_number: 'KR-2026-0042',
  customer_id: ORIGINAL_SENT_INVOICE.customer_id,
  status: 'sent',
  credited_invoice_id: INVOICE_ID,
  total: -12500,
  subtotal: -10000,
  vat_amount: -2500,
  document_type: 'invoice',
}

beforeEach(() => {
  vi.clearAllMocks()
  mockCheckPeriodLock.mockResolvedValue({ locked: false, fiscal_period_id: 'fp-1' })
  mockValidate.mockResolvedValue({
    userId: USER_ID,
    companyId: COMPANY_ID,
    apiKeyId: 'ak_1',
    apiKeyName: 'CI key',
    scopes: ['invoices:write'],
    mode: 'live',
  })
})

describe('POST /api/v1/companies/:companyId/invoices/:id/credit', () => {
  it('issues a credit note with reversed amounts and posts the reverse journal entry', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          { data: ORIGINAL_SENT_INVOICE, error: null }, // pre-flight read
          { data: CREATED_CREDIT_NOTE, error: null },   // insert returning
        ],
        invoice_items: { data: null, error: null },
        company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
      }),
    )

    const res = await creditInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/credit`,
        { reason: 'Felaktig kund' },
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.invoice_number).toBe('KR-2026-0042')
    expect(body.data.credited_invoice_id).toBe(INVOICE_ID)
    expect(body.data.total).toBe(-12500)
    expect(body.data.journal_entry_id).toBe('mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm')
    expect(mockCreditEntry).toHaveBeenCalledTimes(1)
  })

  it('dates the credit note in Europe/Stockholm, not UTC', async () => {
    vi.useFakeTimers()
    // 23:30 UTC on 2026-05-31 is already 2026-06-01 in Stockholm (CEST).
    vi.setSystemTime(new Date('2026-05-31T23:30:00Z'))
    try {
      const supabase = makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          { data: ORIGINAL_SENT_INVOICE, error: null },
          { data: CREATED_CREDIT_NOTE, error: null },
        ],
        invoice_items: { data: null, error: null },
        company_settings: { data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null },
      })
      mockServiceClient.mockReturnValue(supabase)

      const res = await creditInvoice(
        makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/credit`),
        detailParams(COMPANY_ID, INVOICE_ID),
      )

      expect(res.status).toBe(201)
      expect(mockCheckPeriodLock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, '2026-06-01')
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns 400 INVOICE_CREDIT_PERIOD_LOCKED before writing anything when today is in a locked period', async () => {
    mockCheckPeriodLock.mockResolvedValue({ locked: true, reason: 'period_locked_at_set', fiscal_period_id: 'fp-locked' })
    const supabase = makeFlexibleSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      invoices: [{ data: ORIGINAL_SENT_INVOICE, error: null }],
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await creditInvoice(
      makeRequest(`https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/credit`),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREDIT_PERIOD_LOCKED')
    expect(body.error.details.reason).toBe('period_locked_at_set')
    expect(body.error.details.fiscal_period_id).toBe('fp-locked')
    // Only the pre-flight read of the original happened: no insert, no flip.
    const tables = supabase.from.mock.calls.map((c) => c[0])
    expect(tables.filter((t) => t === 'invoices')).toHaveLength(1)
    expect(tables).not.toContain('invoice_items')
    expect(mockCreditEntry).not.toHaveBeenCalled()
  })

  it('returns 404 INVOICE_CREDIT_ORIGINAL_NOT_FOUND when the original is missing', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: null, error: null },
      }),
    )

    const res = await creditInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/credit`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREDIT_ORIGINAL_NOT_FOUND')
  })

  it('returns 409 INVOICE_CREDIT_ALREADY_CREDITED when original.status=credited', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: { ...ORIGINAL_SENT_INVOICE, status: 'credited' }, error: null },
      }),
    )

    const res = await creditInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/credit`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    // INVOICE_CREDIT_ALREADY_CREDITED is httpStatus 400 in the registry
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREDIT_ALREADY_CREDITED')
  })

  it('returns 400 INVOICE_CREDIT_NOT_SENT for drafts', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: { ...ORIGINAL_SENT_INVOICE, status: 'draft' }, error: null },
      }),
    )

    const res = await creditInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/credit`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREDIT_NOT_SENT')
  })

  it('rejects crediting a credit note', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: {
          data: { ...ORIGINAL_SENT_INVOICE, credited_invoice_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
          error: null,
        },
      }),
    )

    const res = await creditInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/credit`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREDIT_NOT_INVOICE')
  })

  it('rejects delivery notes', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: { ...ORIGINAL_SENT_INVOICE, document_type: 'delivery_note' }, error: null },
      }),
    )

    const res = await creditInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/credit`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREDIT_NOT_INVOICE')
  })

  it('dry-run previews the credit note without inserting', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: ORIGINAL_SENT_INVOICE, error: null },
        company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
      }),
    )

    const res = await creditInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/credit?dry_run=true`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.total).toBe(-12500)
    expect(body.data.preview.invoice_number).toBe('KR-2026-0042')
    expect(body.data.preview.credited_invoice_id).toBe(INVOICE_ID)
    expect(body.data.preview.would_create_journal_entry).toBe(true)
    expect(mockCreditEntry).not.toHaveBeenCalled()
  })

  it('rejects keys without invoices:write scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await creditInvoice(
      makeRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/credit`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(403)
  })

  it('rejects requests without Idempotency-Key', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const req = new Request(
      `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/credit`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
      },
    )

    const res = await creditInvoice(req, detailParams(COMPANY_ID, INVOICE_ID))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})
