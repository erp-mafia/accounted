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

const mockRecordManualInvoiceDelivery = vi.fn().mockResolvedValue({ id: 'delivery-1' })
vi.mock('@/lib/invoices/invoice-deliveries', () => ({
  recordManualInvoiceDelivery: (...args: unknown[]) => mockRecordManualInvoiceDelivery(...args),
}))

// The issue step's tail: accrual schedules, the PDF archived as underlag.
const { mockCreateSchedules, mockRenderPdf, mockUploadDocument } = vi.hoisted(() => ({
  mockCreateSchedules: vi.fn(),
  mockRenderPdf: vi.fn(),
  mockUploadDocument: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/accruals/from-invoices', () => ({
  createSchedulesForCustomerInvoice: mockCreateSchedules,
}))
vi.mock('@/lib/invoices/render-invoice-pdf', () => ({
  renderInvoicePdfBuffer: mockRenderPdf,
}))
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: mockUploadDocument,
}))

// The kontantfaktura's payment at issue (crm#1281): the one cash verifikat.
const { mockSettleInvoicePayment } = vi.hoisted(() => ({ mockSettleInvoicePayment: vi.fn() }))
vi.mock('@/lib/invoices/settle-invoice-payment', () => ({
  settleInvoicePayment: mockSettleInvoicePayment,
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'
import {
  createInvoiceJournalEntry as mockedCreateEntry,
} from '@/lib/bookkeeping/invoice-entries'
import { ensureInvoiceNumber as mockedEnsureInvoiceNumber } from '@/lib/invoices/ensure-invoice-number'
import { POST as markSent } from '../route'
import { createTableMockSupabase } from '@/tests/helpers'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>
const mockCreateJournalEntry = mockedCreateEntry as ReturnType<typeof vi.fn>
const mockEnsureInvoiceNumber = mockedEnsureInvoiceNumber as ReturnType<typeof vi.fn>

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
  mockRecordManualInvoiceDelivery.mockResolvedValue({ id: 'delivery-1' })
  mockCreateSchedules.mockResolvedValue({ created: 0, failed: 0 })
  mockRenderPdf.mockResolvedValue({ buffer: Buffer.from('pdf') })
  mockUploadDocument.mockResolvedValue({ id: 'doc-1' })
})

describe('POST /api/v1/companies/:companyId/invoices/:id/mark-sent', () => {
  it('transitions a draft invoice to sent and writes the journal entry id back', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        // First read: pre-flight (status=draft); second: post-update (status=sent).
        invoices: [
          { data: DRAFT_INVOICE, error: null },
          { data: SENT_INVOICE, error: null },
        ],
        company_settings: {
          data: { accounting_method: 'accrual', entity_type: 'enskild_firma', bankgiro: '123-4567' },
          error: null,
        },
      }).supabase,
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
    expect(mockRecordManualInvoiceDelivery).toHaveBeenCalledWith({
      supabase: expect.anything(),
      companyId: COMPANY_ID,
      userId: USER_ID,
      invoiceId: INVOICE_ID,
    })
  })

  it('returns 409 INVOICE_UPDATE_NOT_DRAFT when the invoice is already sent', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: { ...DRAFT_INVOICE, status: 'sent' }, error: null },
      }).supabase,
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

  it.each([
    ['missing row', { data: null, error: null }],
    ['database error', { data: null, error: { message: 'connection reset' } }],
  ])('fails closed when company settings have a %s', async (_label, settingsResult) => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: DRAFT_INVOICE, error: null },
        company_settings: settingsResult,
      }).supabase,
    )

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_SEND_COMPANY_SETTINGS_MISSING')
    expect(mockEnsureInvoiceNumber).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it.each(['SEK', 'EUR'] as const)(
    'rejects a %s invoice without a payment account before number allocation',
    async (currency) => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: { ...DRAFT_INVOICE, currency }, error: null },
        company_settings: {
          data: {
            accounting_method: 'accrual',
            entity_type: 'enskild_firma',
            invoice_payment_accounts: {},
          },
          error: null,
        },
      }).supabase,
    )

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_SEND_PAYMENT_ACCOUNT_MISSING')
    expect(mockEnsureInvoiceNumber).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    },
  )

  it('rejects issuance when the registered company has no VAT number', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: DRAFT_INVOICE, error: null },
        company_settings: {
          data: {
            accounting_method: 'accrual',
            entity_type: 'enskild_firma',
            bankgiro: '123-4567',
            vat_registered: true,
            vat_number: null,
          },
          error: null,
        },
      }).supabase,
    )

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_SEND_VAT_NUMBER_MISSING')
    expect(mockEnsureInvoiceNumber).not.toHaveBeenCalled()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('rejects delivery notes with VALIDATION_ERROR (regardless of status)', async () => {
    // Critical: the delivery-note guard must run BEFORE the status check
    // so a sent delivery note still returns 400 (per the documented
    // contract) rather than 409 INVOICE_UPDATE_NOT_DRAFT.
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: { ...DRAFT_INVOICE, document_type: 'delivery_note', status: 'sent' }, error: null },
      }).supabase,
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
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: {
          data: { ...DRAFT_INVOICE, credited_invoice_id: 'oldoldol-dold-4old-8old-oldoldoldoldold'.slice(0, 36) },
          error: null,
        },
      }).supabase,
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
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: { ...DRAFT_INVOICE, moms_ruta: null }, error: null },
      }).supabase,
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

  // Fail closed (founder decision 2026-10-13): no sent invoice without its
  // verifikat. The draft is restored, the number kept, nothing delivered.
  it('fails closed when the journal entry cannot be created: back to draft, no delivery', async () => {
    const { supabase, calls } = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      invoices: [
        { data: DRAFT_INVOICE, error: null }, // pre-flight
        { data: DRAFT_INVOICE, error: null }, // booking row
        { data: [{ id: INVOICE_ID }], error: null }, // compare-and-set to sent
        { data: [{ id: INVOICE_ID }], error: null }, // restore to draft
      ],
      company_settings: {
        data: { accounting_method: 'accrual', entity_type: 'enskild_firma', bankgiro: '123-4567' },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(supabase)
    mockCreateJournalEntry.mockRejectedValueOnce(new Error('Period closed'))

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_MARK_SENT_BOOK_FAILED')
    expect(body.error.details.reason).toEqual(expect.any(String))
    const updates = calls.filter((c) => c.table === 'invoices' && c.method === 'update').map((c) => c.args[0])
    expect(updates).toEqual([{ status: 'sent' }, { status: 'draft' }])
    expect(mockRecordManualInvoiceDelivery).not.toHaveBeenCalled()
    expect(mockUploadDocument).not.toHaveBeenCalled()
  })

  it('answers an engine refusal with its own code and restores the draft', async () => {
    const { supabase, calls } = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      invoices: [
        { data: DRAFT_INVOICE, error: null },
        { data: DRAFT_INVOICE, error: null },
        { data: [{ id: INVOICE_ID }], error: null },
        { data: [{ id: INVOICE_ID }], error: null },
      ],
      company_settings: {
        data: { accounting_method: 'accrual', entity_type: 'enskild_firma', bankgiro: '123-4567' },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(supabase)
    mockCreateJournalEntry.mockRejectedValueOnce(new AccountsNotInChartError(['3001']))

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    const updates = calls.filter((c) => c.table === 'invoices' && c.method === 'update').map((c) => c.args[0])
    expect(updates).toEqual([{ status: 'sent' }, { status: 'draft' }])
  })

  it('fails closed when no open period takes the verifikat', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          { data: DRAFT_INVOICE, error: null },
          { data: DRAFT_INVOICE, error: null },
          { data: [{ id: INVOICE_ID }], error: null },
          { data: [{ id: INVOICE_ID }], error: null },
        ],
        company_settings: {
          data: { accounting_method: 'accrual', entity_type: 'enskild_firma', bankgiro: '123-4567' },
          error: null,
        },
      }).supabase,
    )
    mockCreateJournalEntry.mockResolvedValueOnce(null)

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_MARK_SENT_BOOK_FAILED')
    expect(body.error.details.reason).toMatch(/period/i)
  })

  it('books from the full row: ROT/RUT items reach the entry builder and periodised lines get their schedule', async () => {
    const ROT_ITEM = {
      id: 'iiiiiiii-iiii-4iii-8iii-iiiiiiiiiiii',
      sort_order: 0,
      line_type: 'labor',
      description: 'Arbete',
      quantity: 10,
      unit: 'tim',
      unit_price: 1000,
      line_total: 10000,
      vat_rate: 25,
      vat_amount: 2500,
      deduction_type: 'rot',
      deduction_amount: 3000,
      work_type: 'bygg',
      accrual_period_start: '2026-06-01',
      accrual_period_end: '2026-11-30',
      accrual_balance_account: '2970',
    }
    const draft = { ...DRAFT_INVOICE, deduction_total: 3000, items: [ROT_ITEM] }
    const { supabase, calls } = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      invoices: [
        { data: draft, error: null },
        { data: draft, error: null },
        { data: [{ id: INVOICE_ID }], error: null }, // compare-and-set
        { data: null, error: null }, // journal_entry_id link
        { data: SENT_INVOICE, error: null }, // response re-read
      ],
      company_settings: {
        data: { accounting_method: 'accrual', entity_type: 'enskild_firma', bankgiro: '123-4567' },
        error: null,
      },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    const selects = calls.filter((c) => c.table === 'invoices' && c.method === 'select').map((c) => String(c.args[0]))
    expect(selects).toContain('*, customer:customers(*), items:invoice_items(*)')
    const bookedInvoice = mockCreateJournalEntry.mock.calls[0][3] as { items: Array<Record<string, unknown>> }
    expect(bookedInvoice.items[0]).toMatchObject({ deduction_type: 'rot', deduction_amount: 3000 })
    expect(mockCreateSchedules).toHaveBeenCalledWith(
      expect.anything(),
      COMPANY_ID,
      USER_ID,
      expect.objectContaining({ id: INVOICE_ID }),
      [expect.objectContaining({ accrual_balance_account: '2970' })],
      'jjjjjjjj-jjjj-4jjj-8jjj-jjjjjjjjjjjj',
      'enskild_firma',
    )
    // The issued PDF is archived as underlag on the verifikat (BFL 7 kap).
    expect(mockUploadDocument).toHaveBeenCalledWith(
      expect.anything(),
      USER_ID,
      COMPANY_ID,
      expect.objectContaining({ type: 'application/pdf' }),
      expect.objectContaining({ journal_entry_id: 'jjjjjjjj-jjjj-4jjj-8jjj-jjjjjjjjjjjj' }),
    )
  })

  it('reports a failed PDF archive as a warning, the invoice issued', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          { data: DRAFT_INVOICE, error: null },
          { data: DRAFT_INVOICE, error: null },
          { data: [{ id: INVOICE_ID }], error: null },
          { data: null, error: null },
          { data: SENT_INVOICE, error: null },
        ],
        company_settings: {
          data: { accounting_method: 'accrual', entity_type: 'enskild_firma', bankgiro: '123-4567' },
          error: null,
        },
      }).supabase,
    )
    mockRenderPdf.mockRejectedValueOnce(new Error('render failed'))

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.status).toBe('sent')
    expect(body.data.warnings).toEqual([{ code: 'PDF_ARCHIVE_FAILED', message: expect.any(String) }])
  })

  it('returns 404 when the invoice does not belong to the company', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: null, error: null },
      }).supabase,
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
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }).supabase,
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
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: DRAFT_INVOICE, error: null },
        company_settings: {
          data: { accounting_method: 'accrual', entity_type: 'enskild_firma', bankgiro: '123-4567' },
          error: null,
        },
      }).supabase,
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
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          { data: DRAFT_INVOICE, error: null },
          { data: SENT_INVOICE, error: null },
        ],
        company_settings: {
          data: { accounting_method: 'cash', entity_type: 'enskild_firma', bankgiro: '123-4567' },
          error: null,
        },
      }).supabase,
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
    mockServiceClient.mockReturnValue(createTableMockSupabase({}).supabase)

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
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }).supabase,
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

describe('POST /api/v1/companies/:companyId/invoices/:id/mark-sent honours defer_invoice_booking (#967)', () => {
  it('marks sent WITHOUT a journal entry when the company defers booking', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: [
          { data: DRAFT_INVOICE, error: null },
          { data: SENT_INVOICE, error: null },
        ],
        company_settings: {
          data: {
            accounting_method: 'accrual',
            defer_invoice_booking: true,
            entity_type: 'enskild_firma',
            bankgiro: '123-4567',
          },
          error: null,
        },
      }).supabase,
    )

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.journal_entry_id ?? null).toBeNull()
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
  })

  it('dry-run preview reports would_create_journal_entry=false when booking is deferred', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: DRAFT_INVOICE, error: null },
        company_settings: {
          data: {
            accounting_method: 'accrual',
            defer_invoice_booking: true,
            entity_type: 'enskild_firma',
            bankgiro: '123-4567',
          },
          error: null,
        },
      }).supabase,
    )

    const res = await markSent(
      makeMarkSentRequest(
        `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent?dry_run=true`,
      ),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview.would_create_journal_entry).toBe(false)
    expect(body.data.preview.accounting_method).toBe('accrual')
  })
})

// crm#1281: the kontantfaktura over the API, the dashboard mark-sent's body
// and refusal, through the same issueAndBookInvoice.
describe('POST /api/v1/companies/:companyId/invoices/:id/mark-sent with paid_at_issue (crm#1281)', () => {
  const URL = `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/mark-sent`
  const SETTINGS = { accounting_method: 'accrual', entity_type: 'enskild_firma', bankgiro: '123-4567' }
  const PAID_BODY = { paid_at_issue: { account_number: '1930' } }

  function postWithBody(body: unknown, url = URL, headers: Record<string, string> = {}): Request {
    return new Request(url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer test-fixture-not-a-real-key',
        'Idempotency-Key': 'idem1281-7777-4abc-8def-1234567890ab',
        'Content-Type': 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
    })
  }

  it('issues the invoice paid: one cash verifikat on the chosen account, no 1510 registration', async () => {
    const { supabase, calls } = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      invoices: [
        { data: DRAFT_INVOICE, error: null }, // pre-flight
        // A copy: the issue step writes the paid state onto the row it books from.
        { data: { ...DRAFT_INVOICE }, error: null }, // booking row
        { data: [{ id: INVOICE_ID }], error: null }, // compare-and-set to sent
        { data: { ...SENT_INVOICE, status: 'paid', paid_amount: 12500, remaining_amount: 0 }, error: null }, // stored
      ],
      company_settings: { data: { ...SETTINGS, accounting_method: 'cash' }, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)
    mockSettleInvoicePayment.mockResolvedValue({
      ok: true,
      newStatus: 'paid',
      newPaidAmount: 12500,
      newRemaining: 0,
      journalEntryId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      paidAt: '2026-05-12T12:00:00.000Z',
    })

    const res = await markSent(postWithBody(PAID_BODY), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data).toMatchObject({
      status: 'paid',
      remaining_amount: 0,
      journal_entry_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
    })
    expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    expect(mockSettleInvoicePayment).toHaveBeenCalledWith(
      supabase,
      COMPANY_ID,
      USER_ID,
      expect.objectContaining({
        paymentAmountInInvoiceCurrency: 12500,
        paymentDate: '2026-05-12',
        accountingMethod: 'cash',
        settlementAccountNumber: '1930',
        recognizeSaleAtPayment: true,
      }),
    )
    const updates = calls.filter((c) => c.table === 'invoices' && c.method === 'update').map((c) => c.args[0])
    expect(updates).toEqual([{ status: 'sent' }])
    expect(mockRecordManualInvoiceDelivery).toHaveBeenCalledTimes(1)
  })

  it('returns 400 VALIDATION_ERROR for a payment account outside 19xx, before the invoice is read', async () => {
    const { supabase, calls } = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      invoices: { data: DRAFT_INVOICE, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await markSent(
      postWithBody({ paid_at_issue: { account_number: '1510' } }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.issues[0].field).toBe('paid_at_issue.account_number')
    expect(calls.filter((c) => c.table === 'invoices')).toEqual([])
    expect(mockSettleInvoicePayment).not.toHaveBeenCalled()
  })

  it.each([
    ['not_invoice', { document_type: 'proforma' }],
    ['periodisering', { items: [{ ...DRAFT_INVOICE.items[0], accrual_period_start: '2026-06-01', accrual_period_end: '2027-05-31' }] }],
  ])('refuses %s with INVOICE_PAID_AT_ISSUE_NOT_ALLOWED before a number is taken', async (reason, overrides) => {
    const row = { ...DRAFT_INVOICE, ...overrides }
    const { supabase, calls } = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      invoices: [
        { data: row, error: null }, // pre-flight
        { data: row, error: null }, // booking row
      ],
      company_settings: { data: SETTINGS, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await markSent(postWithBody(PAID_BODY), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_PAID_AT_ISSUE_NOT_ALLOWED')
    expect(body.error.details.reason).toBe(reason)
    expect(mockEnsureInvoiceNumber).not.toHaveBeenCalled()
    expect(mockSettleInvoicePayment).not.toHaveBeenCalled()
    expect(calls.filter((c) => c.table === 'invoices' && c.method === 'update')).toEqual([])
  })

  it('answers a refused payment with its own code and restores the draft', async () => {
    const { supabase, calls } = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      invoices: [
        { data: DRAFT_INVOICE, error: null },
        { data: DRAFT_INVOICE, error: null },
        { data: [{ id: INVOICE_ID }], error: null }, // compare-and-set to sent
        { data: [{ id: INVOICE_ID }], error: null }, // restore to draft
      ],
      company_settings: { data: SETTINGS, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)
    mockSettleInvoicePayment.mockResolvedValue({
      ok: false,
      code: 'INVOICE_PAID_NO_FISCAL_PERIOD',
      details: { paymentDate: '2026-05-12' },
    })

    const res = await markSent(postWithBody(PAID_BODY), detailParams(COMPANY_ID, INVOICE_ID))

    expect((await res.json()).error.code).toBe('INVOICE_PAID_NO_FISCAL_PERIOD')
    const updates = calls.filter((c) => c.table === 'invoices' && c.method === 'update').map((c) => c.args[0])
    expect(updates).toEqual([{ status: 'sent' }, { status: 'draft' }])
    expect(mockRecordManualInvoiceDelivery).not.toHaveBeenCalled()
  })

  it('dry-run previews the paid state with its verifikat, even under kontantmetoden', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: DRAFT_INVOICE, error: null },
        company_settings: { data: { ...SETTINGS, accounting_method: 'cash' }, error: null },
      }).supabase,
    )

    const res = await markSent(postWithBody(PAID_BODY, `${URL}?dry_run=true`), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview).toMatchObject({
      status: 'paid',
      would_create_journal_entry: true,
      paid_at_issue: { account_number: '1930', payment_date: '2026-05-12' },
    })
    expect(mockSettleInvoicePayment).not.toHaveBeenCalled()
    expect(mockEnsureInvoiceNumber).not.toHaveBeenCalled()
  })

  it('dry-run refuses what the commit would refuse', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: { ...DRAFT_INVOICE, is_self_billed: true }, error: null },
        company_settings: { data: SETTINGS, error: null },
      }).supabase,
    )

    const res = await markSent(postWithBody(PAID_BODY, `${URL}?dry_run=true`), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_PAID_AT_ISSUE_NOT_ALLOWED')
    expect(body.error.details.reason).toBe('self_billed')
  })

  it('returns 404 when the invoice does not belong to the company', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: null, error: null },
      }).supabase,
    )

    const res = await markSent(postWithBody(PAID_BODY), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(404)
    expect(mockSettleInvoicePayment).not.toHaveBeenCalled()
  })

  it('returns 401 when no bearer token is supplied', async () => {
    mockServiceClient.mockReturnValue(createTableMockSupabase({}).supabase)

    const res = await markSent(
      new Request(URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idem1281-4011-4abc-8def-1234567890ab' },
        body: JSON.stringify(PAID_BODY),
      }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )

    expect(res.status).toBe(401)
    expect(mockSettleInvoicePayment).not.toHaveBeenCalled()
  })
})
