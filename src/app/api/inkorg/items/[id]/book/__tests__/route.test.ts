import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'
import type { InvoiceExtractionResult } from '@/types'
import type { OneClickInput } from '@/lib/operations/inkorg-one-click'
import type { OneClickItem } from '@/lib/operations/inkorg-one-click-read'

const { supabase: mockSupabase, enqueueMany, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: (...args: unknown[]) => requireWriteMock(...args) }))

// What the books say about the item (the loader, tested with the planner's rules); the planner itself runs for real.
const readMock = vi.fn()
vi.mock('@/lib/operations/inkorg-one-click-read', () => ({ readOneClickInput: (...args: unknown[]) => readMock(...args) }))
// The shared internals each form runs through, tested at their own doors.
const bookDirectMock = vi.fn()
vi.mock('@/lib/operations/inbox-book-direct', () => ({ bookInboxItemDirectly: (...args: unknown[]) => bookDirectMock(...args) }))
const convertMock = vi.fn()
vi.mock('@/lib/operations/inbox-convert', () => ({ convertInboxItemToSupplierInvoice: (...args: unknown[]) => convertMock(...args) }))
const settleMock = vi.fn()
vi.mock('@/lib/operations/inbox-register-and-settle', () => ({ registerAndSettleInboxItem: (...args: unknown[]) => settleMock(...args) }))
const pairGuardMock = vi.fn()
vi.mock('@/lib/operations/inbox-pair-guard', () => ({ refuseWhenPairBooked: (...args: unknown[]) => pairGuardMock(...args) }))
const createSupplierMock = vi.fn()
vi.mock('@/lib/suppliers/create-supplier', () => ({ createSupplier: (...args: unknown[]) => createSupplierMock(...args) }))
const matchSupplierMock = vi.fn()
vi.mock('@/lib/suppliers/match-supplier', () => ({ matchSupplierByIdentity: (...args: unknown[]) => matchSupplierMock(...args) }))
const linkSupplierMock = vi.fn()
vi.mock('@/lib/documents/inbox-match', () => ({ matchInboxItemSupplier: (...args: unknown[]) => linkSupplierMock(...args) }))
const findPeriodMock = vi.fn()
vi.mock('@/lib/bookkeeping/engine', () => ({ findFiscalPeriod: (...args: unknown[]) => findPeriodMock(...args) }))

import { POST } from '../route'
import { GET } from '../../booking-plan/route'

const ITEM_ID = '6f1c2a40-0000-4000-8000-0000000000a1'
const TX_ID = '6f1c2a40-0000-4000-8000-0000000000b2'
const OTHER_TX_ID = '6f1c2a40-0000-4000-8000-0000000000b3'
const PERIOD_ID = '6f1c2a40-0000-4000-8000-0000000000e5'
const SUPPLIER_ID = '6f1c2a40-0000-4000-8000-0000000000c3'

type ReadingOverrides = Omit<Partial<InvoiceExtractionResult>, 'supplier' | 'invoice' | 'totals'> & {
  supplier?: Partial<InvoiceExtractionResult['supplier']>
  invoice?: Partial<InvoiceExtractionResult['invoice']>
  totals?: Partial<InvoiceExtractionResult['totals']>
}

function reading(overrides: ReadingOverrides = {}): InvoiceExtractionResult {
  return {
    supplier: { name: null, orgNumber: null, vatNumber: null, address: null, bankgiro: null, plusgiro: null, iban: null, bic: null, ...overrides.supplier },
    invoice: { invoiceNumber: null, invoiceDate: null, dueDate: null, paymentReference: null, currency: 'SEK', ...overrides.invoice },
    lineItems: [],
    totals: { subtotal: null, vatAmount: null, total: null, ...overrides.totals },
    vatBreakdown: [],
    confidence: 0.9,
    documentKind: overrides.documentKind ?? null,
  } as InvoiceExtractionResult
}

/** Wispr Flow: a US SaaS invoice paid by the receipt it came with, 150 kr off the card. */
const WISPR: OneClickInput = {
  kind: 'supplier_invoice',
  reading: reading({
    documentKind: 'supplier_invoice',
    supplier: { name: 'Wispr Flow', address: '2261 Market Street #4512, San Francisco, CA 94114' },
    invoice: { invoiceNumber: 'WF-1043', invoiceDate: '2026-10-13' },
    totals: { subtotal: 150, vatAmount: 0, total: 150 },
  }),
  paidByReceipt: true,
  receiptDate: '2026-10-13',
  bank: { transactionId: TX_ID, date: '2026-10-14', amountSek: -150, settlementAccount: '1930', source: 'proposal' },
  company: { vatRegistered: true, cashMethod: false, supplierInvoices: true },
  category: 'expense.software.saas',
  supplier: null,
  counterpartyAccount: null,
  sellerRegionAnswer: null,
  invoiceRate: null,
}

/** A Swedish consultant's invoice: unpaid, or paid three weeks later. */
const CONSULTING: OneClickInput = {
  ...WISPR,
  reading: reading({
    documentKind: 'supplier_invoice',
    supplier: { name: 'Konsult AB', orgNumber: '556677-8899' },
    invoice: { invoiceNumber: 'F-1001', invoiceDate: '2026-09-01', dueDate: '2026-09-30' },
    totals: { subtotal: 1000, vatAmount: 250, total: 1250 },
  }),
  paidByReceipt: false,
  receiptDate: null,
  category: 'expense.professional_services.consulting',
}

const ITEM: OneClickItem = { id: ITEM_ID, documentId: 'doc-1', matchedSupplierId: null, description: 'Wispr Flow', reading: WISPR.reading }

function loads(input: OneClickInput, item = ITEM) {
  readMock.mockResolvedValue({ ok: true, input, item })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'a@b.se' }, supabase: mockSupabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  pairGuardMock.mockResolvedValue(null)
  matchSupplierMock.mockResolvedValue(null)
  findPeriodMock.mockResolvedValue(PERIOD_ID)
  linkSupplierMock.mockResolvedValue({ ok: true, data: {} })
  loads(WISPR)
  bookDirectMock.mockResolvedValue({ ok: true, journalEntry: { id: 'je-71', voucher_series: 'A', voucher_number: 71 }, transactionId: TX_ID })
})

const plan = async (query = '') => {
  const res = await GET(createMockRequest(`/api/inkorg/items/${ITEM_ID}/booking-plan${query}`), createMockRouteParams({ id: ITEM_ID }))
  return parseJsonResponse<{ data: { plan: { form: string; ask: string | null; reason: string; lines: unknown[] }; preview_token: string } }>(res)
}

const post = (body: unknown, id = ITEM_ID) =>
  POST(createMockRequest(`/api/inkorg/items/${id}/book`, { method: 'POST', body }), createMockRouteParams({ id }))

async function tokenFor(query = ''): Promise<string> {
  return (await plan(query)).body.data.preview_token
}

describe('POST /api/inkorg/items/:id/book', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await post({ preview_token: 'pv1.' + 'a'.repeat(43) })).status).toBe(401)
    expect(readMock).not.toHaveBeenCalled()
  })

  it('refuses a viewer', async () => {
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await post({ preview_token: 'pv1.' + 'a'.repeat(43) })).status).toBe(403)
    expect(bookDirectMock).not.toHaveBeenCalled()
  })

  it('returns 400 without a token, with a malformed one, or with an unknown answer', async () => {
    expect((await post({})).status).toBe(400)
    expect((await post({ preview_token: 'not-a-token' })).status).toBe(400)
    expect((await post({ preview_token: 'pv1.' + 'a'.repeat(43), seller_country: 'mars' })).status).toBe(400)
    expect((await post({ preview_token: 'pv1.' + 'a'.repeat(43), purchase_category: 'expense.nothing' })).status).toBe(400)
    expect(readMock).not.toHaveBeenCalled()
  })

  it('returns 404 for an item that is not the company\'s', async () => {
    readMock.mockResolvedValue({ ok: false, code: 'INBOX_ITEM_NOT_FOUND' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post({ preview_token: 'pv1.' + 'a'.repeat(43) }))
    expect(status).toBe(404)
    expect(body.error.code).toBe('INBOX_ITEM_NOT_FOUND')
    expect(readMock).toHaveBeenCalledWith(mockSupabase, 'company-1', ITEM_ID, expect.anything(), expect.anything())
  })

  it('refuses a stale token with the fresh plan and its token, writing nothing', async () => {
    const token = await tokenFor()
    // The bank row's amount moved since the plan was read.
    loads({ ...WISPR, bank: { ...WISPR.bank!, amountSek: -151 } })
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { preview_token: string; preview: { lines: unknown[] } } } }>(await post({ preview_token: token }))
    expect(status).toBe(409)
    expect(body.error.code).toBe('PREVIEW_STALE')
    expect(body.error.details.preview_token).not.toBe(token)
    expect(body.error.details.preview.lines.length).toBeGreaterThan(0)
    expect(bookDirectMock).not.toHaveBeenCalled()
  })

  it('refuses a bank row the plan no longer names', async () => {
    const token = await tokenFor()
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post({ preview_token: token, transaction_id: OTHER_TX_ID }))
    expect(status).toBe(409)
    expect(body.error.code).toBe('INBOX_BANK_MATCH_STALE')
    expect(bookDirectMock).not.toHaveBeenCalled()
  })

  it('refuses when the other half of the purchase is booked already', async () => {
    const token = await tokenFor()
    pairGuardMock.mockResolvedValue({
      ok: false,
      code: 'INBOX_ITEM_PAIR_ALREADY_BOOKED',
      details: { inbox_item_id: ITEM_ID, sibling_item_id: 'item-2', sibling_kind: 'receipt', journal_entry_id: 'je-1', voucher: 'A66', supplier_invoice_id: null },
      messageSv: 'Kvittot från samma köp är redan bokfört på verifikat A66.',
      messageEn: 'The receipt from the same purchase is booked already on voucher A66.',
    })
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(await post({ preview_token: token }))
    expect(status).toBe(409)
    expect(body.error.code).toBe('INBOX_ITEM_PAIR_ALREADY_BOOKED')
    expect(body.error.message).toContain('A66')
    expect(bookDirectMock).not.toHaveBeenCalled()
  })

  it('answers 422 with what to ask while the plan asks something', async () => {
    loads({ ...WISPR, category: null })
    const token = await tokenFor()
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { ask: string } } }>(await post({ preview_token: token }))
    expect(status).toBe(422)
    expect(body.error.code).toBe('INKORG_BOOKING_NEEDS_ANSWER')
    expect(body.error.details.ask).toBe('category')
    expect(bookDirectMock).not.toHaveBeenCalled()
  })

  it('books the Wispr purchase as one verifikat against the bank row, with reverse charge', async () => {
    const token = await tokenFor()
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await post({ preview_token: token, transaction_id: TX_ID }))
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ form: 'direct', journal_entry_id: 'je-71', voucher: 'A71', supplier_created: false, transaction_id: TX_ID })
    expect(findPeriodMock).toHaveBeenCalledWith(mockSupabase, 'company-1', '2026-10-13')
    const [, itemId, bookBody] = bookDirectMock.mock.calls[0]
    expect(itemId).toBe(ITEM_ID)
    expect(bookBody).toMatchObject({ fiscal_period_id: PERIOD_ID, entry_date: '2026-10-13', description: 'Wispr Flow', transaction_id: TX_ID })
    expect(bookBody.lines.map((l: { account_number: string }) => l.account_number)).toEqual(['5420', '1930', '2645', '2614', '4531', '4598'])
    expect(convertMock).not.toHaveBeenCalled()
  })

  it('books with the person\'s answers, planned with the same answers', async () => {
    // The loader takes the person's category over the item's (none here).
    readMock.mockImplementation(async (_s: unknown, _c: unknown, _id: unknown, answers: { purchaseCategory?: string | null }) => ({
      ok: true,
      input: { ...WISPR, category: answers.purchaseCategory ?? null },
      item: ITEM,
    }))
    const token = await tokenFor('?purchase_category=expense.software.saas')
    const { status } = await post({ preview_token: token, purchase_category: 'expense.software.saas' })
    expect(status).toBe(200)
    expect(readMock).toHaveBeenLastCalledWith(mockSupabase, 'company-1', ITEM_ID, { purchaseCategory: 'expense.software.saas', sellerRegion: null }, expect.anything())
  })

  it('names a matched supplier on the item it books directly', async () => {
    loads({ ...WISPR, supplier: { id: SUPPLIER_ID, supplierType: 'non_eu_business', defaultExpenseAccount: null, paymentTermsDays: 30 } })
    const token = await tokenFor()
    await post({ preview_token: token })
    expect(linkSupplierMock).toHaveBeenCalledWith(expect.objectContaining({ companyId: 'company-1' }), ITEM_ID, SUPPLIER_ID)
  })

  it('refuses a date no open period covers, never moving it', async () => {
    findPeriodMock.mockResolvedValue(null)
    const token = await tokenFor()
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post({ preview_token: token }))
    expect(status).toBe(400)
    expect(body.error.code).toBe('NO_OPEN_PERIOD_FOR_DATE')
    expect(bookDirectMock).not.toHaveBeenCalled()
  })

  it('passes the internals\' refusal through as it is (a locked period)', async () => {
    bookDirectMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: { code: 'PERIOD_LOCKED', message: 'Bokföringen är låst för denna period.' } }, { status: 400 }) })
    const token = await tokenFor()
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post({ preview_token: token }))
    expect(status).toBe(400)
    expect(body.error.code).toBe('PERIOD_LOCKED')
  })

  it('passes a voucher guard refusal through with the warnings to show, writing nothing more', async () => {
    const warnings = [{ code: 'REVERSE_CHARGE_ONE_SIDED', message_sv: 'Omvänd moms saknar motrad.', message_en: 'Reverse charge has one side only.', details: {} }]
    bookDirectMock.mockResolvedValue({
      ok: false,
      response: NextResponse.json({ error: { code: 'VOUCHER_NEEDS_CONFIRMATION', message: 'Läs varningarna.', details: { warnings } } }, { status: 409 }),
    })
    const token = await tokenFor()
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { warnings: unknown[] } } }>(await post({ preview_token: token }))
    expect(status).toBe(409)
    expect(body.error.code).toBe('VOUCHER_NEEDS_CONFIRMATION')
    expect(body.error.details.warnings).toEqual(warnings)
    // The first send acknowledges nothing.
    expect(bookDirectMock.mock.calls[0][2]).not.toHaveProperty('acknowledged_warnings')
  })

  it('books the same plan past the warnings the person confirmed', async () => {
    const token = await tokenFor()
    const { status } = await post({ preview_token: token, transaction_id: TX_ID, acknowledged_warnings: ['REVERSE_CHARGE_ONE_SIDED'] })
    expect(status).toBe(200)
    const [, itemId, bookBody] = bookDirectMock.mock.calls[0]
    expect(itemId).toBe(ITEM_ID)
    expect(bookBody).toMatchObject({ entry_date: '2026-10-13', transaction_id: TX_ID, acknowledged_warnings: ['REVERSE_CHARGE_ONE_SIDED'] })
  })

  it('still refuses a stale token when warnings are acknowledged', async () => {
    const token = await tokenFor()
    loads({ ...WISPR, category: 'expense.professional_services.consulting' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post({ preview_token: token, acknowledged_warnings: ['REVERSE_CHARGE_ONE_SIDED'] }))
    expect(status).toBe(409)
    expect(body.error.code).toBe('PREVIEW_STALE')
    expect(bookDirectMock).not.toHaveBeenCalled()
  })

  it('returns 400 for an acknowledged warning that is not a warning code', async () => {
    const token = await tokenFor()
    const { status } = await post({ preview_token: token, acknowledged_warnings: ['NOT_A_WARNING'] })
    expect(status).toBe(400)
    expect(bookDirectMock).not.toHaveBeenCalled()
  })

  it('registers an unpaid invoice, creating its supplier from the reading', async () => {
    loads({ ...CONSULTING, bank: null }, { ...ITEM, description: 'Konsult AB', reading: CONSULTING.reading })
    createSupplierMock.mockResolvedValue({ ok: true, data: { id: SUPPLIER_ID }, created: true })
    convertMock.mockResolvedValue({ ok: true, created: true, data: { invoice: { id: 'si-1', arrival_number: 3 }, items: [], registration_journal_entry_id: 'je-reg', inbox_item_id: ITEM_ID } })
    enqueueMany([{ data: { id: 'je-reg', voucher_series: 'A', voucher_number: 72 } }])
    const token = await tokenFor()
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await post({ preview_token: token }))
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ form: 'register', voucher: 'A72', supplier_created: true, supplier_id: SUPPLIER_ID, supplier_invoice_id: 'si-1' })
    expect(createSupplierMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1' }),
      // The register stores the org number's canonical key.
      expect.objectContaining({ name: 'Konsult AB', supplier_type: 'swedish_business', org_number: '5566778899', country: 'SE' }),
    )
    expect(convertMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1' }),
      ITEM_ID,
      expect.objectContaining({
        supplier_id: SUPPLIER_ID,
        supplier_invoice_number: 'F-1001',
        invoice_date: '2026-09-01',
        due_date: '2026-09-30',
        items: [{ description: 'Konsult AB', amount: 1000, account_number: '6550', vat_rate: 0.25 }],
      }),
    )
    expect(bookDirectMock).not.toHaveBeenCalled()
  })

  it('uses a supplier card created since the plan was read, never a second one', async () => {
    loads({ ...CONSULTING, bank: null }, { ...ITEM, reading: CONSULTING.reading })
    const token = await tokenFor()
    matchSupplierMock.mockResolvedValue({ supplierId: SUPPLIER_ID, matchedOn: 'org_number' })
    convertMock.mockResolvedValue({ ok: true, created: true, data: { invoice: { id: 'si-1', arrival_number: 3 }, items: [], registration_journal_entry_id: null, inbox_item_id: ITEM_ID } })
    const { body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await post({ preview_token: token }))
    expect(createSupplierMock).not.toHaveBeenCalled()
    expect(body.data).toMatchObject({ supplier_created: false, supplier_id: SUPPLIER_ID })
  })

  it('registers and settles an invoice paid three weeks after its date', async () => {
    loads(
      { ...CONSULTING, bank: { ...WISPR.bank!, date: '2026-09-22', amountSek: -1250 }, supplier: { id: SUPPLIER_ID, supplierType: 'swedish_business', defaultExpenseAccount: null, paymentTermsDays: 30 } },
      { ...ITEM, matchedSupplierId: SUPPLIER_ID, reading: CONSULTING.reading },
    )
    settleMock.mockResolvedValue({
      ok: true,
      data: { supplier_invoice_id: 'si-2', arrival_number: 4, registration_journal_entry_id: 'je-reg', settled: true, invoice_status: 'paid', payment_journal_entry_id: 'je-pay', settlement_error: null },
      warnings: [],
    })
    enqueueMany([{ data: { id: 'je-reg', voucher_series: 'A', voucher_number: 73 } }])
    const token = await tokenFor()
    const { status, body } = await parseJsonResponse<{ data: Record<string, unknown> }>(await post({ preview_token: token, transaction_id: TX_ID }))
    expect(status).toBe(200)
    expect(body.data).toMatchObject({ form: 'register_and_settle', voucher: 'A73', settled: true, supplier_invoice_id: 'si-2', supplier_created: false })
    expect(settleMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', requestId: expect.any(String) }),
      ITEM_ID,
      { transaction_id: TX_ID, invoice: expect.objectContaining({ supplier_id: SUPPLIER_ID, invoice_date: '2026-09-01' }) },
    )
  })

  // A payment reference on one other live invoice of the supplier is
  // acknowledged in the editor's review step: one click never registers past it.
  describe('a payment reference a person has to acknowledge', () => {
    const card = { id: SUPPLIER_ID, supplierType: 'swedish_business', defaultExpenseAccount: null, paymentTermsDays: 30 }
    const withReference = reading({
      documentKind: 'supplier_invoice',
      supplier: { name: 'Konsult AB', orgNumber: '556677-8899' },
      invoice: { invoiceNumber: 'F-1002', invoiceDate: '2026-09-01', dueDate: '2026-09-30', paymentReference: '1234567897' },
      totals: { subtotal: 1000, vatAmount: 250, total: 1250 },
    })
    const unpaid: OneClickInput = { ...CONSULTING, reading: withReference, bank: null, supplier: card }
    const item = { ...ITEM, matchedSupplierId: SUPPLIER_ID, description: 'Konsult AB', reading: withReference }
    const registered = { ok: true, created: true, data: { invoice: { id: 'si-1', arrival_number: 3 }, items: [], registration_journal_entry_id: null, inbox_item_id: ITEM_ID } }

    it('registers in one click while no other invoice carries the reference', async () => {
      loads(unpaid, item)
      convertMock.mockResolvedValue(registered)
      const { status } = await post({ preview_token: await tokenFor() })
      expect(status).toBe(200)
      expect(convertMock).toHaveBeenCalledWith(expect.anything(), ITEM_ID, expect.objectContaining({ payment_reference: '1234567897' }))
    })

    it('answers the plan with the editor asked for, and refuses the booking with nothing registered', async () => {
      loads({ ...unpaid, referenceToAcknowledge: true }, item)
      const planned = (await plan()).body.data
      expect(planned.plan).toMatchObject({ form: 'register', ask: 'editor', reason: 'payment_reference_reused' })
      const { status, body } = await parseJsonResponse<{ error: { code: string; details: { ask: string; reason: string } } }>(
        await post({ preview_token: planned.preview_token }),
      )
      expect(status).toBe(422)
      expect(body.error.code).toBe('INKORG_BOOKING_NEEDS_ANSWER')
      expect(body.error.details).toMatchObject({ ask: 'editor', reason: 'payment_reference_reused' })
      expect(convertMock).not.toHaveBeenCalled()
    })

    it('refuses an invoice paid later the same way: nothing registered, nothing settled', async () => {
      loads({ ...unpaid, referenceToAcknowledge: true, bank: { ...WISPR.bank!, date: '2026-09-22', amountSek: -1250 } }, item)
      const planned = (await plan()).body.data
      expect(planned.plan).toMatchObject({ form: 'register_and_settle', ask: 'editor' })
      const { status } = await post({ preview_token: planned.preview_token, transaction_id: TX_ID })
      expect(status).toBe(422)
      expect(settleMock).not.toHaveBeenCalled()
      expect(convertMock).not.toHaveBeenCalled()
    })

    it('refuses a click on a plan read before the other invoice was registered', async () => {
      loads(unpaid, item)
      const token = await tokenFor()
      // Another invoice with the same reference was registered since.
      loads({ ...unpaid, referenceToAcknowledge: true }, item)
      const { status, body } = await parseJsonResponse<{ error: { code: string; details: { preview: { ask: string; reason: string } } } }>(
        await post({ preview_token: token }),
      )
      expect(status).toBe(409)
      expect(body.error.code).toBe('PREVIEW_STALE')
      expect(body.error.details.preview).toMatchObject({ ask: 'editor', reason: 'payment_reference_reused' })
      expect(convertMock).not.toHaveBeenCalled()
    })
  })
})

describe('GET /api/inkorg/items/:id/booking-plan', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await plan()).status).toBe(401)
  })

  it('returns 400 for an answer that is not one', async () => {
    expect((await plan('?seller_country=mars')).status).toBe(400)
  })

  it('returns 404 and 409 as the books say', async () => {
    readMock.mockResolvedValue({ ok: false, code: 'INBOX_ITEM_NOT_FOUND' })
    expect((await plan()).status).toBe(404)
    readMock.mockResolvedValue({ ok: false, code: 'INBOX_ITEM_ALREADY_BOOKED', details: { inbox_item_id: ITEM_ID } })
    expect((await plan()).status).toBe(409)
  })

  it('answers the plan and a token that pins it', async () => {
    const first = await plan()
    expect(first.status).toBe(200)
    expect(first.body.data.plan).toMatchObject({ form: 'direct', ask: null })
    expect(first.body.data.preview_token).toMatch(/^pv1\./)
    // The same books plan the same: the token is deterministic.
    expect((await plan()).body.data.preview_token).toBe(first.body.data.preview_token)
    // Another answer is another plan.
    expect((await plan('?seller_country=eu')).body.data.preview_token).not.toBe(first.body.data.preview_token)
  })
})
