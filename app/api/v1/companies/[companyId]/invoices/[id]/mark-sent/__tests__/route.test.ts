/**
 * Integration tests for POST /api/v1/companies/:companyId/invoices/:id/mark-sent.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

beforeAll(() => {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error(
      `mark-sent route tests require NODE_ENV=test (got ${process.env.NODE_ENV ?? 'undefined'})`,
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

// Stub the F-series allocator: the route's flow is what we're testing.
vi.mock('@/lib/invoices/ensure-invoice-number', () => ({
  ensureInvoiceNumber: vi.fn().mockResolvedValue(undefined),
}))

// Stub the journal-entry creator. Returns a fake entry so the route's
// "post entry, write back journal_entry_id" path is exercised.
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  createInvoiceJournalEntry: vi.fn().mockResolvedValue({
    id: 'jjjjjjjj-jjjj-4jjj-8jjj-jjjjjjjjjjjj',
    status: 'posted',
  }),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import {
  createInvoiceJournalEntry as mockedCreateEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { POST as markSent } from '../route'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockCreateJournalEntry = mockedCreateEntry as ReturnType<typeof vi.fn>

type MockResult = { data?: unknown; error?: unknown }
function makeFlexibleSupabase(byTable: Record<string, MockResult | MockResult[]>) {
  // Per-table queue: arrays return results in order across multiple calls
  // to .from('table'); single values return the same result every time.
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

function makeMarkSentRequest(url: string, extraHeaders: Record<string, string> = {}): Request {
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer test-fixture-not-a-real-key',
      'Idempotency-Key': 'idem1234-7777-4abc-8def-1234567890ab',
      ...extraHeaders,
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
  customer: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Acme AB', country: 'Sweden' },
  items: [{ id: 'iiiiiiii-iiii-4iii-8iii-iiiiiiiiiiii', sort_order: 0, description: 'x', quantity: 1, unit: 'st', unit_price: 10000, line_total: 10000, vat_rate: 25, vat_amount: 2500 }],
}

const SENT_INVOICE = { ...DRAFT_INVOICE, status: 'sent', invoice_number: '2026-0042' }

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
})

describe('POST /api/v1/companies/:companyId/invoices/:id/mark-sent', () => {
  it('transitions a draft invoice to sent and writes the journal entry id back', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        // First read: pre-flight (status=draft); second: post-update (status=sent).
        invoices: [
          { data: DRAFT_INVOICE, error: null },
          { data: SENT_INVOICE, error: null },
        ],
        company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
      }),
    )

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('sent')
    expect(body.data.invoice_number).toBe('2026-0042')
    expect(body.data.journal_entry_id).toBe('jjjjjjjj-jjjj-4jjj-8jjj-jjjjjjjjjjjj')
    expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1)
  })

  it('returns 409 INVOICE_UPDATE_NOT_DRAFT when the invoice is already sent', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: { ...DRAFT_INVOICE, status: 'sent' }, error: null },
      }),
    )

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_UPDATE_NOT_DRAFT')
    expect(body.error.details.current_status).toBe('sent')
  })

  it('rejects delivery notes with VALIDATION_ERROR (regardless of status)', async () => {
    // Critical: the delivery-note guard must run BEFORE the status check
    // so a sent delivery note still returns 400 (per the documented
    // contract) rather than 409 INVOICE_UPDATE_NOT_DRAFT.
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: { ...DRAFT_INVOICE, document_type: 'delivery_note', status: 'sent' }, error: null },
      }),
    )

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('document_type')
  })

  it('rejects credit notes (credited_invoice_id set) with VALIDATION_ERROR', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: {
          data: { ...DRAFT_INVOICE, credited_invoice_id: 'oldoldol-dold-4old-8old-oldoldoldoldold'.slice(0, 36) },
          error: null,
        },
      }),
    )

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('credited_invoice_id')
  })

  it('rejects invoices with missing moms_ruta', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: { ...DRAFT_INVOICE, moms_ruta: null }, error: null },
      }),
    )

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('moms_ruta')
  })

  it('surfaces a warning in the response when journal entry creation fails', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          { data: DRAFT_INVOICE, error: null },
          { data: SENT_INVOICE, error: null },
        ],
        company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
      }),
    )
    // Force the journal-entry generator to throw.
    mockCreateJournalEntry.mockRejectedValueOnce(new Error('Period closed'))

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    // Status STILL flips to sent.
    expect(body.data.status).toBe('sent')
    expect(body.data.journal_entry_id).toBeNull()
    // But the caller is warned.
    expect(body.data.warnings).toBeDefined()
    expect(body.data.warnings[0].code).toBe('JOURNAL_ENTRY_NOT_POSTED')
  })

  it('returns 404 when the invoice does not belong to the company', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: null, error: null },
      }),
    )

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('NOT_FOUND')
  })

  it('returns 400 VALIDATION_ERROR when :id is not a UUID', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/not-a-uuid/mark-sent`,
      ),
      detailParams(COMPANY_ID, 'not-a-uuid'),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('id')
  })

  it('dry-run returns 200 + X-Dry-Run; no journal entry is created', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: DRAFT_INVOICE, error: null },
        company_settings: { data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null },
      }),
    )

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent?dry_run=true`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.status).toBe('sent')
    expect(body.data.preview.would_create_journal_entry).toBe(true)
    expect(body.data.preview.accounting_method).toBe('accrual')
    // No mutation calls.
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('does NOT create a journal entry when accounting_method=cash', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          { data: DRAFT_INVOICE, error: null },
          { data: SENT_INVOICE, error: null },
        ],
        company_settings: { data: { accounting_method: 'cash', entity_type: 'enskild_firma' }, error: null },
      }),
    )

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('sent')
    expect(body.data.journal_entry_id).toBeNull()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('rejects keys without invoices:write scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(makeFlexibleSupabase({}))

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body.error.code).toBe('INSUFFICIENT_SCOPE')
  })

  it('rejects requests without Idempotency-Key', async () => {
    mockServiceClient.mockReturnValue(
      makeFlexibleSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }),
    )

    const req = new Request(
      `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      {
        method: 'POST',
        headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
      },
    )

    const res = await markSent(req, detailParams(COMPANY_ID, INVOICE_ID))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
  })
})
