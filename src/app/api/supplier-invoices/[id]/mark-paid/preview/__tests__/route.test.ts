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
import {
  createSupplierInvoiceCashEntry,
  createSupplierInvoicePaymentEntry,
} from '@/lib/bookkeeping/supplier-invoice-entries'
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

describe('GET /api/supplier-invoices/[id]/mark-paid/preview: dimensions travel with the lines', () => {
  const BAG = { '6': 'P1', '1': 'KS1' }
  type TaggedBody = {
    lines: Array<{
      account_number: string
      debit_amount: number
      credit_amount: number
      description: string
      dimensions?: Record<string, string>
    }>
    document_dimensions?: Record<string, string>
  }
  const toPreview = (l: CreateJournalEntryInput['lines'][number]) => ({
    account_number: l.account_number,
    debit_amount: l.debit_amount,
    credit_amount: l.credit_amount,
    description: l.line_description ?? '',
    ...(l.dimensions ? { dimensions: l.dimensions } : {}),
  })

  it('faktureringsmetod: the clearing preview is line-for-line what createSupplierInvoicePaymentEntry books, tags included', async () => {
    const invoice = roundedInvoice({
      registration_journal_entry_id: 'je-registered',
      supplier_invoice_number: 'LF-77',
      arrival_number: 77,
      default_dimensions: BAG,
    })
    enqueue({
      data: { ...invoice, supplier: { supplier_type: 'swedish_business', name: 'Leverantören AB' }, items },
      error: null,
    })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    const res = await GET(makeReq('amount=1234.56&payment_account=1930'), createMockRouteParams({ id: 'si-1' }))
    const { body } = await parseJsonResponse<TaggedBody>(res)

    // The call the dashboard mark-paid route makes for this request.
    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', invoice, 1234.56, '2026-09-21',
      undefined, 'Leverantören AB', '1930',
    )
    const booked = vi.mocked(createJournalEntry).mock.calls[0][3].lines
    expect(body.lines).toEqual(booked.map(toPreview))
    for (const line of body.lines) expect(line.dimensions).toEqual(BAG)
    expect(body.document_dimensions).toEqual(BAG)
  })

  it('kontantmetod: the cash preview carries the invoice bag on every line', async () => {
    enqueue({
      data: {
        ...roundedInvoice({ ore_rounding: null, default_dimensions: BAG }),
        supplier: { supplier_type: 'swedish_business' },
        items,
      },
      error: null,
    })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const res = await GET(makeReq(), createMockRouteParams({ id: 'si-1' }))
    const { body } = await parseJsonResponse<TaggedBody>(res)
    expect(body.lines.map((l) => l.account_number)).toEqual(['6110', '2641', '1930'])
    for (const line of body.lines) expect(line.dimensions).toEqual(BAG)
    expect(body.document_dimensions).toEqual(BAG)
  })

  it('an untagged invoice previews untagged lines and offers no bag for added rows', async () => {
    enqueue({
      data: {
        ...roundedInvoice({ registration_journal_entry_id: 'je-registered', default_dimensions: {} }),
        supplier: { supplier_type: 'swedish_business' },
        items,
      },
      error: null,
    })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    const res = await GET(makeReq(), createMockRouteParams({ id: 'si-1' }))
    const { body } = await parseJsonResponse<TaggedBody>(res)
    expect(body.lines).toHaveLength(2)
    for (const line of body.lines) expect('dimensions' in line).toBe(false)
    expect(body.document_dimensions).toBeUndefined()
  })
})

describe('GET /api/supplier-invoices/[id]/mark-paid/preview: a foreign-currency invoice previews SEK (#2955)', () => {
  type SekBody = PreviewBody & { currency: string; clearing_sek: number | null; paid_sek: number }

  // 37.50 USD at 9.6414, registered at 361.55 kr on 2440.
  const usd = () =>
    makeSupplierInvoice({
      id: 'si-1', currency: 'USD', exchange_rate: 9.6414, subtotal: 37.5, vat_amount: 0,
      total: 37.5, total_sek: 361.55, remaining_amount: 37.5, paid_amount: 0,
      registration_journal_entry_id: 'je-reg', supplier_invoice_number: 'INV-9', arrival_number: 9,
    })

  function enqueueUsd() {
    enqueue({ data: { ...usd(), supplier: { supplier_type: 'eu_business', name: 'Supplier Inc' }, items: [] } })
    enqueue({ data: { accounting_method: 'accrual' } })
    // The ledger read: registration posted, not shared, no payments, 244x.
    enqueue({ data: { id: 'je-reg', status: 'posted' } })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'l-1', journal_entry_id: 'je-reg', debit_amount: 0, credit_amount: 361.55 }] })
  }

  it('the ticket: 37.50 USD against 1686 previews D 2440 361.55 / K 1686 361.55, not 37.50', async () => {
    enqueueUsd()
    const res = await GET(makeReq('amount=37.5&payment_account=1686'), createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<SekBody>(res)
    expect(status).toBe(200)
    expect(body.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2440', 361.55, 0],
      ['1686', 0, 361.55],
    ])
    expect(body).toMatchObject({ currency: 'USD', clearing_sek: 361.55, paid_sek: 361.55 })
  })

  it('amount_sek above the cleared SEK previews the kursförlust on 7960', async () => {
    enqueueUsd()
    const res = await GET(
      makeReq('amount=37.5&payment_account=1930&amount_sek=365'),
      createMockRouteParams({ id: 'si-1' }),
    )
    const { body } = await parseJsonResponse<SekBody>(res)
    expect(body.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2440', 361.55, 0],
      ['1930', 0, 365],
      ['7960', 3.45, 0],
    ])
    expect(body.paid_sek).toBe(365)
  })

  it('the preview is line-for-line what the POST books for the same resolved SEK', async () => {
    enqueueUsd()
    const res = await GET(
      makeReq('amount=37.5&payment_account=1930&amount_sek=358'),
      createMockRouteParams({ id: 'si-1' }),
    )
    const { body } = await parseJsonResponse<SekBody>(res)

    // What the dashboard POST hands the generator for this request: the
    // resolver's clearing SEK and kursdifferens (361.55, 361.55 - 358).
    await createSupplierInvoicePaymentEntry(
      null as never, 'company-1', 'user-1', usd(), 361.55, '2026-09-15',
      3.55, 'Supplier Inc', '1930',
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
    expect(body.lines.find((l) => l.account_number === '3960')?.credit_amount).toBe(3.55)
  })

  it('amount_sek on a SEK invoice is a 400, not silently ignored', async () => {
    enqueue({ data: { ...roundedInvoice(), supplier: { supplier_type: 'swedish_business' }, items } })
    const res = await GET(makeReq('amount=1234.56&amount_sek=1234.56'), createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { field: string } } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details.field).toBe('amount_sek')
  })

  it('an ambiguous ledger refuses to preview instead of guessing', async () => {
    enqueue({ data: { ...usd(), supplier: { supplier_type: 'eu_business' }, items: [] } })
    enqueue({ data: { accounting_method: 'accrual' } })
    enqueue({ data: { id: 'je-reg', status: 'posted' } })
    enqueue({ data: [{ id: 'si-other' }] }) // another invoice on the same registration
    const res = await GET(makeReq('amount=37.5'), createMockRouteParams({ id: 'si-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { reason: string } } }>(res)
    expect(status).toBe(409)
    expect(body.error.code).toBe('SI_PAID_SEK_UNRESOLVED')
    expect(body.error.details.reason).toBe('registration_voucher_shared')
  })
})
