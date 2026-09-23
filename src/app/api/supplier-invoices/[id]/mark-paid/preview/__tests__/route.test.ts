/**
 * GET /api/supplier-invoices/[id]/mark-paid/preview
 *
 * The kontantmetoden branch runs the REAL buildSupplierInvoiceCashLines (only
 * the engine's two DB-touching functions are mocked), so these tests pin the
 * thing that matters: what the dialog shows is what mark-paid books (#2852).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createQueuedMockSupabase,
  createMockRouteParams,
  parseJsonResponse,
  makeSupplierInvoice,
} from '@/tests/helpers'
import type { CreateJournalEntryInput, SupplierInvoiceItem } from '@/types'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/bookkeeping/engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: vi.fn(
    async (_db: unknown, _company: string, _user: string, input: CreateJournalEntryInput) => ({
      id: 'entry-1',
      ...input,
    }),
  ),
}))

import { createJournalEntry } from '@/lib/bookkeeping/engine'
import { createSupplierInvoiceCashEntry } from '@/lib/bookkeeping/supplier-invoice-entries'
import { GET } from '../route'

type PreviewBody = {
  entry_type: 'clearing' | 'cash'
  lines: Array<{ account_number: string; debit_amount: number; credit_amount: number; description: string }>
}

const mockUser = { id: 'user-1', email: 'test@test.se' }

function makeReq(query = 'amount=1234.56&payment_account=1930') {
  return new Request(`http://localhost/api/supplier-invoices/si-1/mark-paid/preview?${query}`)
}

const items: SupplierInvoiceItem[] = [
  {
    id: 'item-1', supplier_invoice_id: 'si-1', sort_order: 0, description: 'Kontorsmaterial',
    quantity: 1, unit: 'st', unit_price: 987.65, line_total: 987.65, account_number: '6110',
    vat_code: null, vat_rate: 0.25, vat_amount: 246.91, reverse_charge_rate: null,
    created_at: '2026-09-01T00:00:00Z',
  },
]

function roundedInvoice(overrides = {}) {
  return makeSupplierInvoice({
    id: 'si-1', subtotal: 987.65, vat_amount: 246.91, total: 1234.56, remaining_amount: 1234.56,
    ore_rounding: true, ...overrides,
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
})

describe('GET /api/supplier-invoices/[id]/mark-paid/preview', () => {
  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await GET(makeReq(), createMockRouteParams({ id: 'si-1' }))
    expect(res.status).toBe(401)
  })

  it('returns 400 when amount is missing or not positive', async () => {
    for (const query of ['payment_account=1930', 'amount=0', 'amount=abc']) {
      const res = await GET(makeReq(query), createMockRouteParams({ id: 'si-1' }))
      expect(res.status).toBe(400)
    }
  })

  it('returns 404 when the supplier invoice does not exist in the company', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const res = await GET(makeReq(), createMockRouteParams({ id: 'si-1' }))
    expect(res.status).toBe(404)
  })

  it('kontantmetod + öresavrundning: previews the whole-krona payment and the 3740 residual', async () => {
    enqueue({
      data: { ...roundedInvoice(), supplier: { supplier_type: 'swedish_business', name: 'Leverantören AB' }, items },
      error: null,
    })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const res = await GET(makeReq(), createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<PreviewBody>(res)

    expect(status).toBe(200)
    expect(body.entry_type).toBe('cash')
    // The expense books on the item's own account at the ex-VAT line_total,
    // and the VAT is ADDED to it (the hand-rolled preview used a non-existent
    // expense_account, fell back to 4000 and subtracted the VAT).
    expect(body.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['6110', 987.65, 0],
      ['2641', 246.91, 0],
      ['1930', 0, 1235],
      ['3740', 0.44, 0],
    ])
    expect(body.lines[3].description).toBe('Öresavrundning')
  })

  it('kontantmetod: the preview is line-for-line what createSupplierInvoiceCashEntry books', async () => {
    const invoice = roundedInvoice()
    enqueue({
      data: { ...invoice, supplier: { supplier_type: 'swedish_business', name: 'Leverantören AB' }, items },
      error: null,
    })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const res = await GET(makeReq('amount=1234.56&payment_account=1940'), createMockRouteParams({ id: 'si-1' }))
    const { body } = await parseJsonResponse<PreviewBody>(res)

    // The same call the dashboard and v1 mark-paid routes make.
    await createSupplierInvoiceCashEntry(
      null as never, 'company-1', 'user-1', invoice, items, '2026-09-21',
      'swedish_business', 'Leverantören AB', '1940',
    )
    const booked = vi.mocked(createJournalEntry).mock.calls[0][3].lines
    expect(body.lines).toEqual(
      booked.map((l) => ({
        account_number: l.account_number,
        debit_amount: l.debit_amount,
        credit_amount: l.credit_amount,
        description: l.line_description ?? '',
      })),
    )
  })

  it('kontantmetod without öresavrundning: exact öre, no 3740 line', async () => {
    enqueue({
      data: { ...roundedInvoice({ ore_rounding: null }), supplier: { supplier_type: 'swedish_business' }, items },
      error: null,
    })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const res = await GET(makeReq(), createMockRouteParams({ id: 'si-1' }))
    const { body } = await parseJsonResponse<PreviewBody>(res)
    expect(body.lines.find((l) => l.account_number === '1930')?.credit_amount).toBe(1234.56)
    expect(body.lines.some((l) => l.account_number === '3740')).toBe(false)
  })

  it('kontantmetod: a partial amount is refused, as the POST refuses it', async () => {
    enqueue({
      data: { ...roundedInvoice(), supplier: { supplier_type: 'swedish_business' }, items },
      error: null,
    })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const res = await GET(makeReq('amount=500&payment_account=1930'), createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CASH_PARTIAL_UNSUPPORTED')
  })

  it('faktureringsmetod: the 2440 clearing preview is unchanged (rounding timing there is not this fix)', async () => {
    enqueue({
      data: {
        ...roundedInvoice({ registration_journal_entry_id: 'je-registered' }),
        supplier: { supplier_type: 'swedish_business' },
        items,
      },
      error: null,
    })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    const res = await GET(makeReq(), createMockRouteParams({ id: 'si-1' }))
    const { body } = await parseJsonResponse<PreviewBody>(res)
    expect(body.entry_type).toBe('clearing')
    expect(body.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2440', 1234.56, 0],
      ['1930', 0, 1234.56],
    ])
  })
})
