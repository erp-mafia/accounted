import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams, createQueuedMockSupabase, parseJsonResponse } from '@/tests/helpers'

const { supabase: mockSupabase, enqueueMany, findCalls, reset } = createQueuedMockSupabase()

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({ requireAuth: (...args: unknown[]) => requireAuthMock(...args) }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
const requireWriteMock = vi.fn()
vi.mock('@/lib/auth/require-write', () => ({ requireWritePermission: (...args: unknown[]) => requireWriteMock(...args) }))

const convertMock = vi.fn()
vi.mock('@/lib/documents/inbox-convert', () => ({
  convertInboxItemToSupplierInvoice: (...args: unknown[]) => convertMock(...args),
}))
const settleMock = vi.fn()
vi.mock('@/lib/invoices/book-supplier-bank-match', () => ({
  bookSupplierBankMatch: (...args: unknown[]) => settleMock(...args),
}))
const readProposalMock = vi.fn()
vi.mock('@/lib/documents/inbox-bank-match', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/documents/inbox-bank-match')>()),
  readInboxBankMatch: (...args: unknown[]) => readProposalMock(...args),
}))

import { POST } from '../route'

const ITEM_ID = '6f1c2a40-0000-4000-8000-0000000000a1'
const TX_ID = '6f1c2a40-0000-4000-8000-0000000000b2'
const OTHER_TX_ID = '6f1c2a40-0000-4000-8000-0000000000b3'
const SUPPLIER_ID = '6f1c2a40-0000-4000-8000-0000000000c3'
const SI_ID = '6f1c2a40-0000-4000-8000-0000000000d4'

const INVOICE_BODY = {
  supplier_id: SUPPLIER_ID,
  supplier_invoice_number: 'F-1001',
  invoice_date: '2026-10-01',
  due_date: '2026-10-31',
  payment_reference: '1234567897',
  items: [{ description: 'Konsulttjänst', amount: 1000, account_number: '6550', vat_rate: 0.25 }],
}
const BODY = { transaction_id: TX_ID, invoice: INVOICE_BODY }

const ITEM = {
  id: ITEM_ID,
  document_id: 'doc-1',
  extracted_data: { documentKind: 'supplier_invoice' },
  kind_hint: null,
  matched_supplier_id: SUPPLIER_ID,
  matched_transaction_id: null,
  created_supplier_invoice_id: null,
  created_journal_entry_id: null,
  routed_to_arkiv_at: null,
  bank_match_transaction_id: TX_ID,
  bank_match_basis: 'rule_ocr_reference',
  bank_match_evidence_level: 'exakt',
  bank_match_source_key: 'v1:abc',
}
const PROPOSAL = {
  transaction_id: TX_ID,
  date: '2026-10-03',
  amount: -1250,
  currency: 'SEK',
  counterparty: 'Leverantören AB',
  basis: 'rule_ocr_reference',
  evidence_level: 'exakt',
}
const TX = { id: TX_ID, date: '2026-10-03', amount: -1250, currency: 'SEK', amount_sek: -1250, cash_account_id: 'ca-1', document_id: null }
const REGISTERED = {
  ok: true,
  created: true,
  data: {
    invoice: { id: SI_ID, arrival_number: 17 },
    items: [],
    registration_journal_entry_id: 'je-reg',
    inbox_item_id: ITEM_ID,
  },
}
const INVOICE = { id: SI_ID, status: 'registered', registration_journal_entry_id: 'je-reg', total: 1250, remaining_amount: 1250, currency: 'SEK' }
const ACCRUAL = { accounting_method: 'accrual', defer_invoice_booking: false }

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1', email: 'a@b.se' }, supabase: mockSupabase, error: null })
  requireWriteMock.mockResolvedValue({ ok: true })
  readProposalMock.mockResolvedValue(PROPOSAL)
  convertMock.mockResolvedValue(REGISTERED)
  settleMock.mockResolvedValue({
    ok: true,
    journalEntryId: 'je-pay',
    plan: { newStatus: 'paid', newPaidAmount: 1250, newRemaining: 0 },
    settledInvoice: { ...INVOICE, status: 'paid' },
    paidAt: '2026-10-03',
  })
})

const post = (body: unknown = BODY, id = ITEM_ID) =>
  POST(
    createMockRequest(`/api/inkorg/items/${id}/register-and-settle`, { method: 'POST', body }),
    createMockRouteParams({ id }),
  )

/** The reads up to the registration: the item, then the bank row. */
function enqueueBeforeRegistration(item: Record<string, unknown> | null = ITEM, tx: Record<string, unknown> | null = TX) {
  enqueueMany([{ data: item }, { data: tx }])
}

interface Answer {
  data: {
    supplier_invoice_id: string
    arrival_number: number
    registration_journal_entry_id: string | null
    settled: boolean
    invoice_status: string
    payment_journal_entry_id?: string
    settlement_error: { code: string; message: string; message_en?: string } | null
  }
}

describe('POST /api/inkorg/items/:id/register-and-settle', () => {
  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({ user: null, supabase: mockSupabase, error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }) })
    expect((await post()).status).toBe(401)
    expect(convertMock).not.toHaveBeenCalled()
  })

  it('refuses a viewer', async () => {
    requireWriteMock.mockResolvedValue({ ok: false, response: NextResponse.json({ error: 'Forbidden' }, { status: 403 }) })
    expect((await post()).status).toBe(403)
    expect(convertMock).not.toHaveBeenCalled()
  })

  it('returns 400 without a bank row, without an invoice, or for a privately paid invoice', async () => {
    expect((await post({ invoice: INVOICE_BODY })).status).toBe(400)
    expect((await post({ transaction_id: TX_ID })).status).toBe(400)
    expect((await post({ transaction_id: 'not-a-uuid', invoice: INVOICE_BODY })).status).toBe(400)
    expect((await post({ transaction_id: TX_ID, invoice: { ...INVOICE_BODY, paid_with_private_funds: true } })).status).toBe(400)
    expect(convertMock).not.toHaveBeenCalled()
  })

  it('returns 404 for an item of another company or none at all', async () => {
    enqueueBeforeRegistration(null)
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(status).toBe(404)
    expect(body.error.code).toBe('INBOX_ITEM_NOT_FOUND')
    expect(findCalls('invoice_inbox_items', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(convertMock).not.toHaveBeenCalled()
  })

  it('refuses an item that is already a supplier invoice', async () => {
    enqueueBeforeRegistration({ ...ITEM, created_supplier_invoice_id: 'si-old' })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(status).toBe(409)
    expect(body.error.code).toBe('INBOX_ITEM_ALREADY_CONVERTED')
    expect(convertMock).not.toHaveBeenCalled()
  })

  it('writes nothing when the proposal no longer stands or names another bank row', async () => {
    readProposalMock.mockResolvedValueOnce(null)
    enqueueBeforeRegistration()
    const gone = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(gone.status).toBe(409)
    expect(gone.body.error.code).toBe('INBOX_BANK_MATCH_STALE')

    readProposalMock.mockResolvedValueOnce({ ...PROPOSAL, transaction_id: OTHER_TX_ID })
    enqueueBeforeRegistration()
    expect((await post()).status).toBe(409)
    expect(convertMock).not.toHaveBeenCalled()
    expect(settleMock).not.toHaveBeenCalled()
  })

  it('writes nothing for a bank row that is not money out', async () => {
    enqueueBeforeRegistration(ITEM, { ...TX, amount: 1250 })
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(status).toBe(400)
    expect(body.error.code).toBe('MATCH_SI_NOT_EXPENSE')
    expect(convertMock).not.toHaveBeenCalled()
  })

  it('answers the registration refusal and settles nothing when the invoice cannot be registered', async () => {
    convertMock.mockResolvedValue({ ok: false, code: 'SUPPLIER_NOT_FOUND' })
    enqueueBeforeRegistration()
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(await post())
    expect(status).toBe(404)
    expect(body.error.code).toBe('SUPPLIER_NOT_FOUND')
    expect(settleMock).not.toHaveBeenCalled()
  })

  it('registers the invoice and settles it against the proposed row (faktureringsmetoden)', async () => {
    enqueueBeforeRegistration()
    enqueueMany([{ data: INVOICE }, { data: ACCRUAL }])
    const { status, body } = await parseJsonResponse<Answer>(await post())

    expect(status).toBe(200)
    expect(body.data).toEqual({
      supplier_invoice_id: SI_ID,
      arrival_number: 17,
      registration_journal_entry_id: 'je-reg',
      settled: true,
      invoice_status: 'paid',
      payment_journal_entry_id: 'je-pay',
      settlement_error: null,
    })
    // The convert door's own service, with the body as the person confirmed it.
    expect(convertMock).toHaveBeenCalledWith(
      expect.objectContaining({ companyId: 'company-1', userId: 'user-1' }),
      ITEM_ID,
      expect.objectContaining({ supplier_invoice_number: 'F-1001', payment_reference: '1234567897' }),
    )
    // The match door's own service: the bank row, the new invoice, and why they are linked.
    expect(settleMock).toHaveBeenCalledWith(
      mockSupabase,
      expect.objectContaining({
        transaction: expect.objectContaining({ id: TX_ID }),
        invoice: expect.objectContaining({ id: SI_ID }),
        userId: 'user-1',
        companyId: 'company-1',
        match: expect.objectContaining({ action: 'matched', method: 'inbox_bank_match' }),
        linkBasis: { basis: 'user_confirmed', evidence: { rule_id: 'inbox_bank_match:rule_ocr_reference' } },
      }),
    )
  })

  it('settles a kontantmetoden invoice, which has no registration verifikat, against the row', async () => {
    convertMock.mockResolvedValue({ ...REGISTERED, data: { ...REGISTERED.data, registration_journal_entry_id: null } })
    enqueueBeforeRegistration()
    enqueueMany([{ data: { ...INVOICE, registration_journal_entry_id: null } }, { data: { accounting_method: 'cash', defer_invoice_booking: false } }])
    const { status, body } = await parseJsonResponse<Answer>(await post())
    expect(status).toBe(200)
    expect(body.data.settled).toBe(true)
    expect(body.data.registration_journal_entry_id).toBeNull()
    expect(settleMock).toHaveBeenCalledTimes(1)
  })

  it('keeps the invoice registered and unpaid when settling fails, and says why', async () => {
    settleMock.mockResolvedValue({ ok: false, code: 'INVOICE_PAID_NO_FISCAL_PERIOD', details: { paymentDate: '2026-10-03' } })
    enqueueBeforeRegistration()
    enqueueMany([{ data: INVOICE }, { data: ACCRUAL }])
    const { status, body } = await parseJsonResponse<Answer>(await post())

    expect(status).toBe(200)
    expect(body.data.supplier_invoice_id).toBe(SI_ID)
    expect(body.data.settled).toBe(false)
    expect(body.data.invoice_status).toBe('registered')
    expect(body.data.settlement_error?.code).toBe('INVOICE_PAID_NO_FISCAL_PERIOD')
    expect(body.data.settlement_error?.message).toBeTruthy()
    // Nothing undoes the registration.
    expect(findCalls('supplier_invoices', 'delete')).toEqual([])
  })

  it('does not settle an invoice the company books in a separate step, and keeps it registered', async () => {
    convertMock.mockResolvedValue({ ...REGISTERED, data: { ...REGISTERED.data, registration_journal_entry_id: null } })
    enqueueBeforeRegistration()
    enqueueMany([{ data: { ...INVOICE, registration_journal_entry_id: null } }, { data: { accounting_method: 'accrual', defer_invoice_booking: true } }])
    const { status, body } = await parseJsonResponse<Answer>(await post())

    expect(status).toBe(200)
    expect(body.data.settled).toBe(false)
    expect(body.data.settlement_error?.code).toBe('INBOX_SETTLE_INVOICE_NOT_BOOKED')
    expect(settleMock).not.toHaveBeenCalled()
  })
})
