import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createMockRequest, createMockRouteParams, createQueuedMockSupabase, makeSupplierInvoice,
} from '@/tests/helpers'
import type { CreateJournalEntryInput } from '@/types'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => supabase }))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/bookkeeping/engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: vi.fn(async (_db: unknown, _company: string, _user: string, input: CreateJournalEntryInput) => ({
    id: 'payment-je', ...input,
  })),
}))
vi.mock('@/lib/core/documents/supplier-invoice-underlag', () => ({ anchorSupplierInvoiceDocument: vi.fn() }))
vi.mock('@/lib/invoices/clear-settled-invoice-suggestions', () => ({ clearSettledInvoiceSuggestions: vi.fn() }))
vi.mock('@/lib/invoices/duplicate-payment-candidates', () => ({
  findDuplicatePaymentCandidatesForSupplierInvoice: vi.fn().mockResolvedValue([]),
}))

import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { eventBus } from '@/lib/events'
import { POST } from '../route'
import { GET } from '../preview/route'

const invoice = makeSupplierInvoice({
  id: 'si-1', status: 'approved', currency: 'USD', total: 37.5, total_sek: 361.55,
  exchange_rate: 9.6414, remaining_amount: 37.5, paid_amount: 0,
  registration_journal_entry_id: 'registration-je', items: [],
})
const params = () => createMockRouteParams({ id: invoice.id })
const request = (overrides = {}) => createMockRequest('/api/supplier-invoices/si-1/mark-paid', {
  method: 'POST', body: { amount: 37.5, payment_date: '2026-09-15', payment_account: '1686', ...overrides },
})
function queueLedger(settledSek = 0, paid = 0, registeredSek = 361.55) {
  enqueue({ data: paid ? [{ id: 'p1', amount: paid, currency: 'USD', journal_entry_id: 'prior-je' }] : [], error: null })
  enqueue({ data: [
    { id: 'registration-je', status: 'posted', correction_of_id: null },
    ...(paid ? [{ id: 'prior-je', status: 'posted', correction_of_id: null }] : []),
  ], error: null })
  enqueue({ data: [], error: null })
  enqueue({ data: [], error: null })
  enqueue({ data: [
    { journal_entry_id: 'registration-je', debit_amount: 0, credit_amount: registeredSek },
    ...(paid ? [{ journal_entry_id: 'prior-je', debit_amount: settledSek, credit_amount: 0 }] : []),
  ], error: null })
}
function queuePayment(overrides: Partial<typeof invoice> = {}, method = 'accrual', settledSek = 0, registeredSek = 361.55, custom = false) {
  enqueue({ data: { ...invoice, ...overrides }, error: null })
  enqueue({ data: { accounting_method: method, last_supplier_payment_account: '1686' }, error: null })
  if (!custom && overrides.registration_journal_entry_id !== null) {
    queueLedger(settledSek, overrides.paid_amount ?? 0, registeredSek)
  }
  enqueue({ data: [{ id: invoice.id }], error: null })
  enqueue({ data: null, error: null })
}
const bookedLines = () => vi.mocked(createJournalEntry).mock.calls[0][3].lines
const amounts = (lines: CreateJournalEntryInput['lines']) => lines.map(l => [l.account_number, l.debit_amount, l.credit_amount])

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  eventBus.clear()
  supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
})

describe('manual supplier payment currency boundary (#2955)', () => {
  it.each(['accrual', 'cash'])('clears a registered USD invoice in SEK under the current %s setting', async (method) => {
    queuePayment({}, method)
    const response = await POST(request(), params())
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ status: 'paid', paid_amount: 37.5, remaining_amount: 0 })
    expect(amounts(bookedLines())).toEqual([['2440', 361.55, 0], ['1686', 0, 361.55]])
    expect(findCalls('supplier_invoice_payments', 'insert')[0][0]).toMatchObject({
      amount: 37.5, currency: 'USD', journal_entry_id: 'payment-je',
    })
  })

  it.each([10, -10])('uses a SEK exchange difference of %s without converting it again', async (difference) => {
    queuePayment()
    expect((await POST(request({ exchange_rate_difference: difference }), params())).status).toBe(200)
    expect(amounts(bookedLines())).toEqual([
      ['2440', 361.55, 0], ['1686', 0, 361.55 - difference],
      difference > 0 ? ['3960', 0, 10] : ['7960', 10, 0],
    ])
  })

  it('settles the last partial payment without an ore residual', async () => {
    queuePayment({ paid_amount: 18.75, remaining_amount: 18.75, status: 'partially_paid' }, 'accrual', 180.78)
    expect((await POST(request({ amount: 18.75 }), params())).status).toBe(200)
    expect(amounts(bookedLines())).toEqual([['2440', 180.77, 0], ['1686', 0, 180.77]])
    expect(findCalls('supplier_invoices', 'update')[0][0]).toMatchObject({ paid_amount: 37.5, remaining_amount: 0 })
  })

  it('previews the same SEK amounts as the posting path', async () => {
    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    queueLedger()
    const response = await GET(new Request('http://localhost/api/supplier-invoices/si-1/mark-paid/preview?amount=37.5&payment_account=1686'), params())
    expect(response.status).toBe(200)
    const preview = await response.json()
    queuePayment()
    expect((await POST(request(), params())).status).toBe(200)
    expect(amounts(preview.lines)).toEqual(amounts(bookedLines()))
    expect(amounts(preview.lines)).toEqual([['2440', 361.55, 0], ['1686', 0, 361.55]])
  })

  it.each([9.6414, null])('keeps edited SEK lines unchanged with invoice rate %s', async (exchange_rate) => {
    const lines = [
      { account_number: '2440', debit_amount: 361.55, credit_amount: 0 },
      { account_number: '1686', debit_amount: 0, credit_amount: 351.55 },
      { account_number: '3960', debit_amount: 0, credit_amount: 10 },
    ]
    queuePayment({ exchange_rate, total_sek: null }, 'accrual', 0, 361.55, true)
    expect((await POST(request({ lines, exchange_rate_difference: 10 }), params())).status).toBe(200)
    expect(bookedLines()).toEqual(lines)
    expect(findCalls('supplier_invoice_payments', 'insert')[0][0]).toMatchObject({ amount: 37.5, currency: 'USD' })
  })

  it('refuses an unknown FX conversion for automatic posting', async () => {
    queuePayment({ total_sek: null, exchange_rate: null, registration_journal_entry_id: null })
    const response = await POST(request(), params())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'SI_FX_RATE_MISSING' } })
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(findCalls('supplier_invoices', 'update')).toEqual([])
  })

  it('refuses to preview an unknown FX conversion', async () => {
    queuePayment({ total_sek: null, exchange_rate: null, registration_journal_entry_id: null })
    const response = await GET(new Request('http://localhost/api/supplier-invoices/si-1/mark-paid/preview?amount=37.5'), params())
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { code: 'SI_FX_RATE_MISSING' } })
  })

  it.each([
    { name: 'separately rounded registration', paid: 0, settled: 0, registered: 361.56, expected: 361.56 },
    { name: 'reversed first partial', paid: 18.75, settled: 180.77, registered: 361.55, expected: 180.78 },
    { name: 'bank-matched partials', paid: 25, settled: 241.04, registered: 361.55, expected: 120.51 },
  ])('previews and posts the actual liability after $name', async ({ paid, settled, registered, expected }) => {
    const remaining = 37.5 - paid
    const overrides = { paid_amount: paid, remaining_amount: remaining }
    enqueue({ data: { ...invoice, ...overrides }, error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    queueLedger(settled, paid, registered)
    const previewResponse = await GET(new Request(`http://localhost/api/supplier-invoices/si-1/mark-paid/preview?amount=${remaining}&payment_account=1686`), params())
    expect(previewResponse.status).toBe(200)
    const preview = await previewResponse.json()
    queuePayment(overrides, 'accrual', settled, registered)
    const response = await POST(request({ amount: remaining }), params())
    expect(response.status).toBe(200)
    expect(amounts(bookedLines())).toEqual([['2440', expected, 0], ['1686', 0, expected]])
    expect(amounts(preview.lines)).toEqual(amounts(bookedLines()))
    expect(findCalls('supplier_invoice_payments', 'insert')[0][0]).toMatchObject({ amount: remaining, currency: 'USD' })
    expect(await response.json()).toMatchObject({ status: 'paid', paid_amount: 37.5, remaining_amount: 0 })
  })

  it.each(['post', 'preview'])('refuses missing payment history in %s before any write', async door => {
    enqueue({ data: { ...invoice, paid_amount: 18.75, remaining_amount: 18.75 }, error: null })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    enqueue({ data: [], error: null })
    const response = door === 'post'
      ? await POST(request({ amount: 18.75 }), params())
      : await GET(new Request('http://localhost/api/supplier-invoices/si-1/mark-paid/preview?amount=18.75'), params())
    expect(response.status).toBe(409)
    expect(await response.json()).toMatchObject({ error: { code: 'SI_PAYMENT_BALANCE_UNAVAILABLE' } })
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(findCalls('supplier_invoices', 'update')).toEqual([])
    expect(findCalls('supplier_invoice_payments', 'insert')).toEqual([])
  })
})
