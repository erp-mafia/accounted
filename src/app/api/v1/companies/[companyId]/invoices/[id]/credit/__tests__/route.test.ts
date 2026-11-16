/**
 * Integration tests for POST /api/v1/companies/:companyId/invoices/:id/credit.
 *
 * The route parses and calls creditInvoice (lib/invoices/credit-invoice.ts),
 * the credit the dashboard and MCP use; these run the real service against a
 * table mock. The v1 copy it replaced dropped the ROT/RUT, periodisering and
 * override-account fields from the credit items, numbered self-billed
 * originals after their id and answered 201 with an unbooked credit note.
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

const mocks = vi.hoisted(() => ({
  checkPeriodLock: vi.fn(),
  createJournalEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
  cancelSchedulesForSource: vi.fn(),
  renderInvoicePdfBuffer: vi.fn(),
  uploadDocument: vi.fn(),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: mocks.checkPeriodLock }))
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/engine')>()),
  createJournalEntry: mocks.createJournalEntry,
  findFiscalPeriod: mocks.findFiscalPeriod,
}))
vi.mock('@/lib/bookkeeping/accruals/service', () => ({
  cancelSchedulesForSource: mocks.cancelSchedulesForSource,
}))
vi.mock('@/lib/invoices/render-invoice-pdf', () => ({
  renderInvoicePdfBuffer: mocks.renderInvoicePdfBuffer,
}))
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: mocks.uploadDocument,
}))
vi.mock('@/lib/collections/forward-hook', () => ({
  scheduleCollectionForwardDrain: vi.fn(),
}))

import { validateApiKey, createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { buildCreditNoteFields } from '@/lib/invoices/build-credit-note'
import { buildCreditNoteItem } from '@/lib/invoices/build-credit-note-item'
import { POST as creditInvoice } from '../route'
import { createTableMockSupabase } from '@/tests/helpers'
import type { Invoice, InvoiceItem } from '@/types'

const mockValidate = validateApiKey as ReturnType<typeof vi.fn>
const mockServiceClient = createServiceClientNoCookies as ReturnType<typeof vi.fn>

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INVOICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CREDIT_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const JE_ID = 'mmmmmmmm-mmmm-4mmm-8mmm-mmmmmmmmmmmm'
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
const url = (query = '') => `https://x.test/api/v1/companies/${COMPANY_ID}/invoices/${INVOICE_ID}/credit${query}`

const ITEM = {
  id: 'item-1',
  invoice_id: INVOICE_ID,
  sort_order: 0,
  line_type: 'product',
  description: 'x',
  quantity: 1,
  unit: 'st',
  unit_price: 10000,
  discount_percent: 0,
  line_total: 10000,
  vat_rate: 25,
  vat_amount: 2500,
  revenue_account: null,
  deduction_type: null,
  deduction_amount: 0,
  dimensions: {},
} as unknown as InvoiceItem

const ORIGINAL_SENT_INVOICE = {
  id: INVOICE_ID,
  invoice_number: '2026-0042' as string | null,
  external_invoice_number: null as string | null,
  customer_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
  invoice_date: '2026-05-12',
  due_date: '2026-06-11',
  status: 'sent',
  document_type: 'invoice',
  currency: 'SEK',
  subtotal: 10000,
  subtotal_sek: 10000,
  vat_amount: 2500,
  vat_amount_sek: 2500,
  total: 12500,
  total_sek: 12500,
  vat_treatment: 'standard_25',
  vat_rate: 25,
  moms_ruta: '05',
  credited_invoice_id: null,
  journal_entry_id: null as string | null,
  paid_at: null as string | null,
  paid_amount: 0,
  deduction_total: 0,
  default_dimensions: {},
  customer: { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Acme AB' },
  items: [ITEM],
}
type Original = typeof ORIGINAL_SENT_INVOICE

// Kontantmetoden books the sale at payment, so a PAID original already carries
// revenue + utgående moms on the ledger (issue #2552).
const ORIGINAL_PAID_INVOICE: Original = {
  ...ORIGINAL_SENT_INVOICE,
  status: 'paid',
  journal_entry_id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  paid_at: '2026-05-20T10:00:00Z',
  paid_amount: 12500,
}

const ROT_ORIGINAL: Original = {
  ...ORIGINAL_SENT_INVOICE,
  deduction_total: 3750,
  items: [{
    ...ITEM,
    description: 'Arbete',
    quantity: 10,
    unit: 'tim',
    unit_price: 1000,
    revenue_account: '3041',
    deduction_type: 'rot',
    deduction_amount: 3750,
    work_type: 'bygg',
  } as unknown as InvoiceItem],
}

/** The credit note row as createCreditNoteDraft writes it, read back. */
function draftOf(original: Original, status = 'draft') {
  const ref = (original.invoice_number ?? original.external_invoice_number) as string
  return {
    id: CREDIT_ID,
    invoice_number: `KR-${ref}`,
    ...buildCreditNoteFields(original as unknown as Invoice, { originalReference: ref, today: '2026-10-13' }),
    status,
    document_type: 'invoice',
    journal_entry_id: null,
    customer: original.customer,
    items: original.items.map((item) => buildCreditNoteItem(CREDIT_ID, item)),
  }
}

/**
 * A SEK invoice of 4,38 with öre to round (crm#1480): the öresavrundning
 * choice decides whether it asks for 4,38 or 4,00.
 */
function oreOriginal(oreRounding: boolean) {
  return {
    ...ORIGINAL_SENT_INVOICE,
    subtotal: 3.5,
    subtotal_sek: 3.5,
    vat_amount: 0.88,
    vat_amount_sek: 0.88,
    total: 4.38,
    total_sek: 4.38,
    ore_rounding: oreRounding as boolean | null,
    items: [{ ...ITEM, unit_price: 3.5, line_total: 3.5, vat_amount: 0.88 } as unknown as InvoiceItem],
  }
}

/** The table mock for a credit that goes through, in query order. */
function creditSupabase(original: Original, accountingMethod = 'accrual', companyOreRounding?: boolean) {
  const draft = draftOf(original)
  return createTableMockSupabase({
    company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    invoices: [
      { data: original }, // the original
      { data: null }, // no existing credit note
      { data: { id: CREDIT_ID } }, // insert
      { data: null }, // creation_complete
      { data: draft }, // the completed draft
      { data: original }, // the original's booked-ness at issue
      { data: [{ id: CREDIT_ID }] }, // compare-and-set to sent
      { data: [{ id: CREDIT_ID }] }, // journal_entry_id link (or the original's flip)
      { data: [{ id: INVOICE_ID }] }, // the original flipped to credited
      { data: { ...draft, status: 'sent' } }, // the response re-read
    ],
    invoice_items: { data: null },
    journal_entries: { data: null },
    company_settings: {
      data: {
        company_name: 'Test AB',
        accounting_method: accountingMethod,
        entity_type: 'enskild_firma',
        ...(companyOreRounding === undefined ? {} : { ore_rounding: companyOreRounding }),
      },
    },
  })
}

function writes(calls: Array<{ table: string; method: string }>) {
  return calls.filter(
    (c) => c.table !== 'idempotency_keys' && ['insert', 'update', 'delete'].includes(c.method),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.checkPeriodLock.mockResolvedValue({ locked: false, fiscal_period_id: 'fp-1' })
  mocks.findFiscalPeriod.mockResolvedValue('fp-1')
  mocks.createJournalEntry.mockResolvedValue({ id: JE_ID })
  mocks.cancelSchedulesForSource.mockResolvedValue({ cancelled: 0, failedReversals: 0 })
  mocks.renderInvoicePdfBuffer.mockResolvedValue({ buffer: Buffer.from('pdf') })
  mocks.uploadDocument.mockResolvedValue({ id: 'doc-1' })
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
    const { supabase, calls } = creditSupabase(ORIGINAL_SENT_INVOICE)
    mockServiceClient.mockReturnValue(supabase)

    const res = await creditInvoice(makeRequest(url(), { reason: 'Felaktig kund' }), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.invoice_number).toBe('KR-2026-0042')
    expect(body.data.credited_invoice_id).toBe(INVOICE_ID)
    expect(body.data.status).toBe('sent')
    expect(body.data.total).toBe(-12500)
    expect(body.data.amount_to_pay).toBe(-12500)
    expect(body.data.ore_rounding_amount).toBe(0)
    expect(body.data.journal_entry_id).toBe(JE_ID)
    expect(mocks.createJournalEntry).toHaveBeenCalledTimes(1)
    const insert = calls.find((c) => c.table === 'invoices' && c.method === 'insert')
    expect(insert?.args[0]).toMatchObject({ notes: 'Felaktig kund', status: 'draft' })
  })

  it("gives back what the invoice asked for under its own rounding choice, not the company's (crm#1480)", async () => {
    // Company rounds, the invoice did not: it asked for 4,38, so the credit gives back 4,38.
    const { supabase } = creditSupabase(oreOriginal(false), 'accrual', true)
    mockServiceClient.mockReturnValue(supabase)

    const res = await creditInvoice(makeRequest(url()), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.total).toBe(-4.38)
    expect(body.data.ore_rounding).toBe(false)
    expect(body.data.amount_to_pay).toBe(-4.38)
    expect(body.data.ore_rounding_amount).toBe(0)
  })

  it('rounds the credit as the invoice was rounded when the company no longer rounds (crm#1480)', async () => {
    // The invoice asked for 4,00 (0,38 rounded off); the credit mirrors it: -4,00 with +0,38.
    const { supabase } = creditSupabase(oreOriginal(true), 'accrual', false)
    mockServiceClient.mockReturnValue(supabase)

    const res = await creditInvoice(makeRequest(url()), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.total).toBe(-4.38)
    expect(body.data.ore_rounding).toBe(true)
    expect(body.data.amount_to_pay).toBe(-4)
    expect(body.data.ore_rounding_amount).toBe(0.38)
  })

  it('mirrors a ROT invoice: Cr 1513 for Skatteverket, Cr 1510 for the customer, the override account', async () => {
    const { supabase, calls } = creditSupabase(ROT_ORIGINAL)
    mockServiceClient.mockReturnValue(supabase)

    const res = await creditInvoice(makeRequest(url()), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(201)
    const itemsInsert = calls.find((c) => c.table === 'invoice_items' && c.method === 'insert')
    expect(itemsInsert?.args[0]).toEqual([
      expect.objectContaining({ revenue_account: '3041', deduction_type: 'rot', deduction_amount: 3750 }),
    ])
    const entry = mocks.createJournalEntry.mock.calls[0][3] as {
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }
    const byAccount = Object.fromEntries(entry.lines.map((l) => [l.account_number, l]))
    expect(byAccount['3041']).toMatchObject({ debit_amount: 10000 })
    expect(byAccount['1513']).toMatchObject({ credit_amount: 3750 })
    expect(byAccount['1510']).toMatchObject({ credit_amount: 8750 })
  })

  it('numbers the credit note of a self-billed original after its external number', async () => {
    const selfBilled: Original = { ...ORIGINAL_SENT_INVOICE, invoice_number: null, external_invoice_number: 'SB-77' }
    const { supabase, calls } = creditSupabase(selfBilled)
    mockServiceClient.mockReturnValue(supabase)

    await creditInvoice(makeRequest(url()), detailParams(COMPANY_ID, INVOICE_ID))

    const insert = calls.find((c) => c.table === 'invoices' && c.method === 'insert')
    expect(insert?.args[0]).toMatchObject({ invoice_number: 'KR-SB-77' })
  })

  it('dates the credit note in Europe/Stockholm, not UTC', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    // 23:30 UTC on 2026-05-31 is already 2026-06-01 in Stockholm (CEST).
    vi.setSystemTime(new Date('2026-05-31T23:30:00Z'))
    try {
      mockServiceClient.mockReturnValue(creditSupabase(ORIGINAL_SENT_INVOICE).supabase)

      const res = await creditInvoice(makeRequest(url()), detailParams(COMPANY_ID, INVOICE_ID))

      expect(res.status).toBe(201)
      expect(mocks.checkPeriodLock).toHaveBeenCalledWith(expect.anything(), COMPANY_ID, '2026-06-01')
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    [{ locked: true, reason: 'period_locked_at_set', fiscal_period_id: 'fp-locked' }, 'period_locked_at_set'],
    [{ locked: false, reason: 'no_fiscal_period' }, 'no_fiscal_period'],
  ])('returns 400 INVOICE_CREDIT_PERIOD_LOCKED before writing anything (%o)', async (verdict, reason) => {
    mocks.checkPeriodLock.mockResolvedValue(verdict)
    const { supabase, calls } = creditSupabase(ORIGINAL_SENT_INVOICE)
    mockServiceClient.mockReturnValue(supabase)

    const res = await creditInvoice(makeRequest(url()), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREDIT_PERIOD_LOCKED')
    expect(body.error.details.reason).toBe(reason)
    expect(writes(calls)).toEqual([])
    expect(mocks.createJournalEntry).not.toHaveBeenCalled()
  })

  // Founder decision 2026-10-13: fail closed. It used to answer 201 with the
  // original already 'credited' and a JOURNAL_ENTRY_NOT_POSTED warning.
  it('fails closed when the reversing entry is refused: the draft kept, the original untouched', async () => {
    mocks.createJournalEntry.mockRejectedValue(new Error('Period locked'))
    const { supabase, calls } = creditSupabase(ORIGINAL_SENT_INVOICE)
    mockServiceClient.mockReturnValue(supabase)

    const res = await creditInvoice(makeRequest(url()), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(500)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREDIT_ISSUE_INCOMPLETE')
    expect(body.error.details.failure_steps).toEqual(['journal_entry'])
    const updates = calls.filter((c) => c.table === 'invoices' && c.method === 'update').map((c) => c.args[0])
    expect(updates).toContainEqual({ status: 'draft' })
    expect(updates).not.toContainEqual(expect.objectContaining({ status: 'credited' }))
  })

  it('returns 404 INVOICE_CREDIT_ORIGINAL_NOT_FOUND when the original is missing', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
        invoices: { data: null, error: null },
      }).supabase,
    )

    const res = await creditInvoice(makeRequest(url()), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('INVOICE_CREDIT_ORIGINAL_NOT_FOUND')
  })

  it.each([
    [{ status: 'credited' }, 'INVOICE_CREDIT_ALREADY_CREDITED'],
    [{ status: 'draft' }, 'INVOICE_CREDIT_NOT_SENT'],
    [{ invoice_number: 'KR-2026-0041', credited_invoice_id: 'ffffffff-ffff-4fff-8fff-ffffffffffff' }, 'INVOICE_CREDIT_NOT_INVOICE'],
    [{ document_type: 'delivery_note' }, 'INVOICE_CREDIT_NOT_INVOICE'],
    // accounted#58: a credit note imported without a link to its original.
    [{ status: 'paid', subtotal: -1000, vat_amount: -250, total: -1250, credited_invoice_id: null }, 'INVOICE_CREDIT_NOT_INVOICE'],
  ])('refuses %o with 400 %s, writing nothing', async (overrides, code) => {
    const { supabase, calls } = createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      invoices: { data: { ...ORIGINAL_SENT_INVOICE, ...overrides }, error: null },
    })
    mockServiceClient.mockReturnValue(supabase)

    const res = await creditInvoice(makeRequest(url()), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe(code)
    expect(writes(calls)).toEqual([])
  })

  it('dry-run previews the credit note without inserting', async () => {
    const { supabase, calls } = creditSupabase(ORIGINAL_SENT_INVOICE)
    mockServiceClient.mockReturnValue(supabase)

    const res = await creditInvoice(makeRequest(url('?dry_run=true')), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(200)
    expect(res.headers.get('X-Dry-Run')).toBe('true')
    const body = await res.json()
    expect(body.data.dry_run).toBe(true)
    expect(body.data.preview.total).toBe(-12500)
    expect(body.data.preview.invoice_number).toBe('KR-2026-0042')
    expect(body.data.preview.credited_invoice_id).toBe(INVOICE_ID)
    expect(body.data.preview.would_create_journal_entry).toBe(true)
    expect(body.data.preview.amount_to_pay).toBe(-12500)
    expect(body.data.preview.ore_rounding_amount).toBe(0)
    expect(writes(calls)).toEqual([])
    expect(mocks.createJournalEntry).not.toHaveBeenCalled()
  })

  it("dry-run previews the credit's amount to pay under the original's rounding choice", async () => {
    const { supabase, calls } = creditSupabase(oreOriginal(true), 'accrual', false)
    mockServiceClient.mockReturnValue(supabase)

    const res = await creditInvoice(makeRequest(url('?dry_run=true')), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.data.preview.ore_rounding).toBe(true)
    expect(body.data.preview.amount_to_pay).toBe(-4)
    expect(body.data.preview.ore_rounding_amount).toBe(0.38)
    expect(writes(calls)).toEqual([])
  })

  it('books the reversal under kontantmetoden when the original was paid (#2552)', async () => {
    mockServiceClient.mockReturnValue(creditSupabase(ORIGINAL_PAID_INVOICE, 'cash').supabase)

    const res = await creditInvoice(makeRequest(url()), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(201)
    expect((await res.json()).data.journal_entry_id).toBe(JE_ID)
    expect(mocks.createJournalEntry).toHaveBeenCalledTimes(1)
  })

  it('skips the reversal under kontantmetoden while the original is unpaid and unbooked', async () => {
    mockServiceClient.mockReturnValue(creditSupabase(ORIGINAL_SENT_INVOICE, 'cash').supabase)

    const res = await creditInvoice(makeRequest(url()), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.journal_entry_id).toBeNull()
    // The one warning every credit carries: nothing reached the customer.
    expect(body.data.warnings).toEqual([expect.objectContaining({ code: 'CREDIT_NOTE_NOT_DELIVERED' })])
    expect(mocks.createJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 400 VALIDATION_ERROR for a non-UUID id', async () => {
    mockServiceClient.mockReturnValue(createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    }).supabase)

    const res = await creditInvoice(makeRequest(url()), detailParams(COMPANY_ID, 'not-a-uuid'))

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 400 VALIDATION_ERROR for an invalid body', async () => {
    mockServiceClient.mockReturnValue(createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
    }).supabase)

    const res = await creditInvoice(makeRequest(url(), { reason: 'x'.repeat(2001) }), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })

  it('returns 401 when no bearer token is supplied', async () => {
    const res = await creditInvoice(
      new Request(url(), { method: 'POST', headers: { 'Idempotency-Key': 'idem1234-2020-4abc-8def-1234567890ab' } }),
      detailParams(COMPANY_ID, INVOICE_ID),
    )
    expect(res.status).toBe(401)
  })

  it('rejects keys without invoices:write scope', async () => {
    mockValidate.mockResolvedValue({
      userId: USER_ID,
      companyId: COMPANY_ID,
      scopes: ['invoices:read'],
      mode: 'live',
    })
    mockServiceClient.mockReturnValue(createTableMockSupabase({}).supabase)

    const res = await creditInvoice(makeRequest(url()), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(403)
  })

  it('rejects requests without Idempotency-Key', async () => {
    mockServiceClient.mockReturnValue(
      createTableMockSupabase({
        company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      }).supabase,
    )

    const req = new Request(url(), {
      method: 'POST',
      headers: { Authorization: 'Bearer test-fixture-not-a-real-key' },
    })

    const res = await creditInvoice(req, detailParams(COMPANY_ID, INVOICE_ID))
    expect(res.status).toBe(400)
    expect((await res.json()).error.code).toBe('VALIDATION_ERROR')
  })
})

// accounted#45: under deferred booking an original that was never booked is
// booked first (the Bokför step, its own date), then credited. v1 answers
// both verifikat, or refuses before anything is written.
describe('POST .../credit: a deferred original that was never booked', () => {
  const ORIGINAL_JE_ID = '99999999-9999-4999-8999-999999999999'
  const deferredSettings = {
    company_name: 'Test AB',
    accounting_method: 'accrual',
    defer_invoice_booking: true,
    entity_type: 'enskild_firma',
  }

  function deferredSupabase(original: Original) {
    const draft = draftOf(original)
    return createTableMockSupabase({
      company_members: { data: { company_id: COMPANY_ID, role: 'owner' }, error: null },
      invoices: [
        { data: original }, // the original
        { data: original }, // the Bokför step's dry run
        { data: null }, // no existing credit note
        { data: { id: CREDIT_ID } }, // insert
        { data: null }, // creation_complete
        { data: draft }, // the completed draft
        { data: original }, // the original's booked-ness at issue
        { data: [{ id: CREDIT_ID }] }, // compare-and-set to sent
        { data: original }, // the Bokför step: the original
        { data: { ...original, journal_entry_id: ORIGINAL_JE_ID } }, // its CAS link
        { data: [{ id: CREDIT_ID }] }, // credit journal_entry_id link
        { data: [{ id: INVOICE_ID }] }, // the original flipped to credited
        { data: { ...draft, status: 'sent' } }, // the response re-read
      ],
      invoice_items: { data: null },
      journal_entries: [{ data: null }, { data: { voucher_series: 'A', voucher_number: 41 } }],
      company_settings: { data: deferredSettings },
    })
  }

  it('books the original first, then the credit, and answers both verifikat', async () => {
    mocks.createJournalEntry
      .mockResolvedValueOnce({ id: ORIGINAL_JE_ID })
      .mockResolvedValueOnce({ id: JE_ID })
    mockServiceClient.mockReturnValue(deferredSupabase(ORIGINAL_SENT_INVOICE).supabase)

    const res = await creditInvoice(makeRequest(url()), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.data.journal_entry_id).toBe(JE_ID)
    expect(body.data.original_journal_entry_id).toBe(ORIGINAL_JE_ID)
    expect(mocks.createJournalEntry).toHaveBeenCalledTimes(2)
    expect(mocks.createJournalEntry.mock.calls[0][3]).toMatchObject({
      source_type: 'invoice_created',
      source_id: INVOICE_ID,
      entry_date: '2026-05-12',
    })
    expect(mocks.createJournalEntry.mock.calls[1][3]).toMatchObject({ source_type: 'credit_note', source_id: CREDIT_ID })
  })

  it('refuses with 400 INVOICE_CREDIT_ORIGINAL_PERIOD_LOCKED before any write when the original\'s period is locked', async () => {
    mocks.checkPeriodLock.mockImplementation(async (_supabase: unknown, _company: string, date: string) =>
      date === '2026-05-12'
        ? { locked: true, reason: 'period_locked_at_set', fiscal_period_id: 'fp-may' }
        : { locked: false, fiscal_period_id: 'fp-1' },
    )
    const { supabase, calls } = deferredSupabase(ORIGINAL_SENT_INVOICE)
    mockServiceClient.mockReturnValue(supabase)

    const res = await creditInvoice(makeRequest(url()), detailParams(COMPANY_ID, INVOICE_ID))

    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('INVOICE_CREDIT_ORIGINAL_PERIOD_LOCKED')
    expect(writes(calls)).toEqual([])
    expect(mocks.createJournalEntry).not.toHaveBeenCalled()
  })
})
