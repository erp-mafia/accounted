import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createMockRouteParams,
  createTableMockSupabase,
  makeInvoiceInboxItem,
  makeSupplierInvoice,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase: mockSupabase, setTable, findCall, reset } = createTableMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const createCreditEntryMock = vi.fn()
vi.mock('@/lib/bookkeeping/supplier-invoice-entries', () => ({
  createSupplierCreditNoteEntry: (...args: unknown[]) => createCreditEntryMock(...args),
}))

const cancelSchedulesMock = vi.fn()
vi.mock('@/lib/bookkeeping/accruals/service', () => ({
  cancelSchedulesForSource: (...args: unknown[]) => cancelSchedulesMock(...args),
}))

import { eventBus } from '@/lib/events'
import { POST } from '../route'

const INBOX_ITEM_ID = '44444444-4444-4444-8444-444444444444'
const DOC_ID = '55555555-5555-4555-8555-555555555555'

describe('POST /api/supplier-invoices/[id]/credit', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const legacyItem = {
    id: 'item-1',
    supplier_invoice_id: 'invoice-1',
    sort_order: 0,
    description: 'Kontorsmaterial',
    quantity: 1,
    unit: 'st',
    unit_price: 1000,
    line_total: 1000,
    account_number: '5410',
    vat_code: null,
    vat_rate: 25,
    vat_amount: 250,
    reverse_charge_rate: null,
    dimensions: {},
    created_at: '2026-01-01T00:00:00Z',
  }
  const original = {
    ...makeSupplierInvoice({
      id: 'invoice-1',
      status: 'registered',
      invoice_date: '2026-09-01',
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      remaining_amount: 1250,
    }),
    supplier: { name: 'Leverantör AB', supplier_type: 'swedish_business' },
    items: [legacyItem],
  }
  const creditNote = makeSupplierInvoice({
    id: 'credit-1',
    is_credit_note: true,
    credited_invoice_id: 'invoice-1',
  })

  function tables(originalRow: Record<string, unknown> = original, method = 'accrual', postsEntry = true) {
    setTable('supplier_invoices', [
      { data: originalRow },
      { data: creditNote },
      // Linking the verifikat, when one is posted, then flipping the original.
      ...(postsEntry ? [{ data: null }] : []),
      { data: { id: 'invoice-1' } },
    ])
    setTable('company_settings', { data: { accounting_method: method, bookkeeping_locked_through: null } })
    setTable('fiscal_periods', { data: { id: 'fp-1', is_closed: false, locked_at: null } })
    setTable('rpc:get_next_arrival_number', { data: 2 })
  }

  // A raw string is sent as is, so a malformed body can be tested.
  const post = (body?: unknown) =>
    POST(
      typeof body === 'string'
        ? new Request('http://localhost:3000/api/supplier-invoices/invoice-1/credit', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body,
          })
        : createMockRequest('/api/supplier-invoices/invoice-1/credit', { method: 'POST', body }),
      createMockRouteParams({ id: 'invoice-1' }),
    )

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    requireAuthMock.mockResolvedValue({
      user: mockUser,
      supabase: mockSupabase,
      error: null,
    })
    cancelSchedulesMock.mockResolvedValue({ failedReversals: 0 })
    createCreditEntryMock.mockResolvedValue({ id: 'journal-1' })
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: mockSupabase,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })

    const response = await post()

    expect(response.status).toBe(401)
  })

  it('returns 400 for a malformed body without touching the invoice', async () => {
    expect((await post('{not json')).status).toBe(400)
    expect((await post({ amount: 100 })).status).toBe(400)
    expect((await post({ credit_date: '18/9' })).status).toBe(400)
    expect(findCall('supplier_invoices', 'select')).toBeUndefined()
  })

  it('returns 404 when the supplier invoice does not exist', async () => {
    setTable('supplier_invoices', { data: null })

    const response = await post()

    expect(response.status).toBe(404)
  })

  it('returns 409 when the supplier invoice is already credited', async () => {
    setTable('supplier_invoices', { data: { ...original, status: 'credited' } })

    const response = await post()

    expect(response.status).toBe(409)
  })

  it('normalizes copied item storage but keeps original items for reversal', async () => {
    tables()

    const response = await post()
    const { status, body } = await parseJsonResponse<{ data: { id: string }; journal_entry_id: string }>(response)

    expect(status).toBe(200)
    expect(body.data.id).toBe('credit-1')
    expect(body.journal_entry_id).toBe('journal-1')
    // The credit note rests at 'credited' from birth: it is a reversal with
    // nothing to attest or pay, so it must never enter the attest queue.
    const insertedRow = findCall('supplier_invoices', 'insert')?.[0]
    expect(insertedRow).toMatchObject({
      status: 'credited',
      is_credit_note: true,
      credited_invoice_id: 'invoice-1',
      remaining_amount: 0,
      supplier_invoice_number: 'KREDIT-LF-001',
    })
    const insertArgs = findCall('supplier_invoice_items', 'insert')
    const insertedItems = insertArgs?.[0] as Array<{ vat_rate: number }>
    expect(insertedItems[0]?.vat_rate).toBe(0.25)
    expect(createCreditEntryMock).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'credit-1' }),
      original.items,
      'swedish_business',
      'Leverantör AB',
    )
  })

  it('credits from an inbox credit note: its date, number and document', async () => {
    tables()
    setTable('invoice_inbox_items', [
      {
        data: makeInvoiceInboxItem({
          id: INBOX_ITEM_ID,
          document_id: DOC_ID,
          extracted_data: {
            documentKind: 'credit_note',
            invoice: { invoiceNumber: 'KF-9', invoiceDate: '2026-09-15', currency: 'SEK', creditedInvoiceNumber: 'LF-001' },
            totals: { subtotal: -1000, vatAmount: -250, total: -1250 },
          },
        }),
      },
      { data: null },
    ])
    setTable('document_attachments', { data: { id: DOC_ID, journal_entry_id: null } })

    const response = await post({ inbox_item_id: INBOX_ITEM_ID })

    expect(response.status).toBe(200)
    expect(findCall('supplier_invoices', 'insert')?.[0]).toMatchObject({
      supplier_invoice_number: 'KF-9',
      invoice_date: '2026-09-15',
      document_id: DOC_ID,
    })
    expect(findCall('invoice_inbox_items', 'update')?.[0]).toEqual({ created_supplier_invoice_id: 'credit-1' })
  })

  it('refuses a partial credit note with 400 SI_CREDIT_PARTIAL', async () => {
    tables()
    setTable('invoice_inbox_items', {
      data: makeInvoiceInboxItem({
        id: INBOX_ITEM_ID,
        extracted_data: { documentKind: 'credit_note', invoice: { currency: 'SEK' }, totals: { total: -250 } },
      }),
    })

    const response = await post({ inbox_item_id: INBOX_ITEM_ID })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CREDIT_PARTIAL')
    expect(findCall('supplier_invoices', 'insert')).toBeUndefined()
    expect(createCreditEntryMock).not.toHaveBeenCalled()
  })

  it('skips the reversing entry under kontantmetoden while the original is unpaid', async () => {
    // Nothing reached the ledger at registration, so there is no entry to
    // reverse: recognition correctly waits for the refund.
    tables(
      { ...original, status: 'registered', paid_amount: 0, paid_at: null, payment_journal_entry_id: null, registration_journal_entry_id: null },
      'cash',
      false,
    )

    const response = await post()

    expect(response.status).toBe(200)
    expect(createCreditEntryMock).not.toHaveBeenCalled()
  })

  it('reverses under kontantmetoden once the payment already booked the expense', async () => {
    // The payment verifikat booked expense + 2641 ingående moms. Skipping the
    // reversal here would leave both the cost and the moms deduction
    // overstated for as long as the credit stands.
    tables({ ...original, status: 'paid', paid_amount: 1250, paid_at: '2026-03-12', payment_journal_entry_id: 'je-payment' }, 'cash')

    const response = await post()

    expect(response.status).toBe(200)
    expect(createCreditEntryMock).toHaveBeenCalledTimes(1)
  })
})
