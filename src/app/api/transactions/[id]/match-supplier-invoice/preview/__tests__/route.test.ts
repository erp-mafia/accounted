import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createQueuedMockSupabase,
  createMockRouteParams,
  parseJsonResponse,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'
import { buildSupplierInvoicePaymentLines } from '@/lib/bookkeeping/supplier-invoice-entries'

const mockUser = { id: 'user-1', email: 'test@test.se' }
const TX_UUID = '11111111-1111-4111-8111-111111111111'
const SI_UUID = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
})

function makeReq() {
  return new Request(
    `http://localhost/api/transactions/${TX_UUID}/match-supplier-invoice/preview?supplier_invoice_id=${SI_UUID}`,
  )
}

// Regression: the sticky company_settings.last_supplier_payment_account
// (written whenever a supplier invoice is marked paid "with private funds",
// e.g. crediting 2893) used to be the previewed credit account for ANY
// matched transaction, including one linked to the company's real 1930 bank
// account. The preview must credit the transaction's own linked cash
// account, not that unrelated sticky setting.
describe('GET /api/transactions/[id]/match-supplier-invoice/preview: settlement account resolution', () => {
  it('previews a credit to the transaction\'s linked cash account, ignoring a stale last_supplier_payment_account', async () => {
    enqueue({
      data: {
        id: TX_UUID,
        date: '2026-02-01',
        amount: -1001,
        currency: 'SEK',
        amount_sek: null,
        cash_account_id: 'ca-1930',
      },
      error: null,
    })
    enqueue({
      data: {
        id: SI_UUID,
        currency: 'SEK',
        exchange_rate: null,
        total: 1001,
        remaining_amount: 1001,
        registration_journal_entry_id: 'je-registered',
        items: [],
      },
      error: null,
    })
    // Stale sticky setting from an earlier private-funds payment: must be
    // ignored now that the route resolves the account from the transaction.
    enqueue({ data: { accounting_method: 'accrual', last_supplier_payment_account: '2893' }, error: null })
    enqueue({ data: { ledger_account: '1930' }, error: null }) // cash_accounts lookup

    const res = await GET(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { body } = await parseJsonResponse<{
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }>(res)

    expect(body.lines.find((l) => l.account_number === '1930')?.credit_amount).toBe(1001)
    expect(body.lines.some((l) => l.account_number === '2893')).toBe(false)
  })

  it('defaults to 1930 when the transaction has no linked cash account', async () => {
    enqueue({
      data: {
        id: TX_UUID,
        date: '2026-02-01',
        amount: -750,
        currency: 'SEK',
        amount_sek: null,
        cash_account_id: null,
      },
      error: null,
    })
    enqueue({
      data: {
        id: SI_UUID,
        currency: 'SEK',
        exchange_rate: null,
        total: 750,
        remaining_amount: 750,
        registration_journal_entry_id: 'je-registered',
        items: [],
      },
      error: null,
    })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    const res = await GET(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { body } = await parseJsonResponse<{
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }>(res)

    expect(body.lines.find((l) => l.account_number === '1930')?.credit_amount).toBe(750)
  })

  it('kontantmetod: the cash preview includes the SLP pair the POST will book for a flagged 741x line', async () => {
    // Regression: the cash branch previewed expense + VAT + bank only, while
    // createSupplierInvoiceCashEntry also books 7533 D / 2514 K for items
    // flagged apply_slp on a 741x pension account. The user approved four
    // lines and the POST committed six.
    enqueue({
      data: {
        id: TX_UUID,
        date: '2026-02-01',
        amount: -10000,
        currency: 'SEK',
        amount_sek: null,
        cash_account_id: null,
      },
      error: null,
    })
    enqueue({
      data: {
        id: SI_UUID,
        currency: 'SEK',
        exchange_rate: null,
        total: 10000,
        remaining_amount: 10000,
        paid_amount: 0,
        registration_journal_entry_id: null,
        items: [
          {
            description: 'Tjänstepension',
            line_total: 10000,
            // The preview now runs the engine's own builder, which (like the
            // POST) treats a missing vat_rate as 25 %; the column is NOT NULL.
            vat_rate: 0,
            vat_amount: 0,
            account_number: '7412',
            apply_slp: true,
          },
        ],
      },
      error: null,
    })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const res = await GET(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { body } = await parseJsonResponse<{
      entry_type: string
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }>(res)

    expect(body.entry_type).toBe('cash')
    // 10 000 × 0.2426 = 2 426: mirrors generateSlpLines in the engine.
    expect(body.lines.find((l) => l.account_number === '7533')?.debit_amount).toBe(2426)
    expect(body.lines.find((l) => l.account_number === '2514')?.credit_amount).toBe(2426)
    // The pair nets to zero: the bank credit stays at the invoice total.
    expect(body.lines.find((l) => l.account_number === '1930')?.credit_amount).toBe(10000)
  })

  // #2852: kontantmetoden + öresavrundning. The preview runs the engine's own
  // buildSupplierInvoiceCashLines with the settledBankSek the POST passes, so
  // a whole-krona bank row previews the bank amount on the payment account and
  // the residual on 3740, and the invoice settles in full.
  it.each([
    { label: 'rounded UP', bank: 1235, lineTotal: 987.65, vat: 246.91, total: 1234.56, ore: ['3740', 0.44, 0] },
    { label: 'rounded DOWN', bank: 1234, lineTotal: 987.55, vat: 246.89, total: 1234.44, ore: ['3740', 0, 0.44] },
  ])('kontantmetod: a $label whole-krona bank row previews the bank amount and the 3740 residual', async ({ bank, lineTotal, vat, total, ore }) => {
    enqueue({
      data: { id: TX_UUID, date: '2026-02-01', amount: -bank, currency: 'SEK', amount_sek: null, cash_account_id: null },
      error: null,
    })
    enqueue({
      data: {
        id: SI_UUID,
        supplier_invoice_number: 'LF-1',
        currency: 'SEK',
        exchange_rate: null,
        total,
        remaining_amount: total,
        paid_amount: 0,
        // The flag is OFF: on the match door the bank row decides, exactly as
        // on the accrual clearing path.
        ore_rounding: false,
        vat_treatment: 'standard_25',
        reverse_charge: false,
        registration_journal_entry_id: null,
        supplier: { supplier_type: 'swedish_business' },
        items: [
          { description: 'Kontorsmaterial', line_total: lineTotal, vat_rate: 0.25, vat_amount: vat, account_number: '6110' },
        ],
      },
      error: null,
    })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const res = await GET(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      entry_type: string
      is_fully_paid: boolean
      ore_rounding: boolean
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }>(res)

    expect(status).toBe(200)
    expect(body.entry_type).toBe('cash')
    expect(body.is_fully_paid).toBe(true)
    expect(body.ore_rounding).toBe(true)
    // Expense on the item's own account at the ex-VAT amount, VAT added on
    // 2641 (the hand-rolled preview booked 4000 and subtracted the VAT).
    expect(body.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['6110', lineTotal, 0],
      ['2641', vat, 0],
      ['1930', 0, bank],
      ore,
    ])
  })

  it('kontantmetod: a shortfall of a krona or more is still refused as a partial', async () => {
    enqueue({
      data: { id: TX_UUID, date: '2026-02-01', amount: -1233, currency: 'SEK', amount_sek: null, cash_account_id: null },
      error: null,
    })
    enqueue({
      data: {
        id: SI_UUID, currency: 'SEK', exchange_rate: null, total: 1234.44, remaining_amount: 1234.44,
        paid_amount: 0, registration_journal_entry_id: null, supplier: { supplier_type: 'swedish_business' },
        items: [{ description: 'x', line_total: 987.55, vat_rate: 0.25, vat_amount: 246.89, account_number: '6110' }],
      },
      error: null,
    })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const res = await GET(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_CASH_PARTIAL_UNSUPPORTED')
  })

  it('previews a credit to the linked cash account when it is not the primary 1930', async () => {
    enqueue({
      data: {
        id: TX_UUID,
        date: '2026-02-01',
        amount: -500,
        currency: 'SEK',
        amount_sek: null,
        cash_account_id: 'ca-1940',
      },
      error: null,
    })
    enqueue({
      data: {
        id: SI_UUID,
        currency: 'SEK',
        exchange_rate: null,
        total: 500,
        remaining_amount: 500,
        registration_journal_entry_id: 'je-registered',
        items: [],
      },
      error: null,
    })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })
    enqueue({ data: { ledger_account: '1940' }, error: null }) // cash_accounts lookup

    const res = await GET(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { body } = await parseJsonResponse<{
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }>(res)

    expect(body.lines.find((l) => l.account_number === '1940')?.credit_amount).toBe(500)
  })
})

describe('GET /api/transactions/[id]/match-supplier-invoice/preview: bank fee on top of the invoice', () => {
  it('previews a EUR card overpayment as a full settlement with the fee on 6570', async () => {
    // Same row as the POST test: 1 749,70 EUR (19 382,30 kr) drawn for a
    // 1 739,43 EUR invoice booked at 11,055. The preview is what the user
    // approves, so it must show the lines the POST books.
    enqueue({
      data: {
        id: TX_UUID,
        date: '2026-07-22',
        amount: -1749.7,
        currency: 'EUR',
        amount_sek: -19382.3,
        cash_account_id: null,
      },
      error: null,
    })
    enqueue({
      data: {
        id: SI_UUID,
        currency: 'EUR',
        exchange_rate: 11.055,
        total: 1739.43,
        remaining_amount: 1739.43,
        registration_journal_entry_id: 'je-registered',
        items: [],
      },
      error: null,
    })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    const res = await GET(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
      is_fully_paid: boolean
      bank_fee_sek: number
    }>(res)

    expect(status).toBe(200)
    expect(body.is_fully_paid).toBe(true)
    expect(body.bank_fee_sek).toBe(113.77)
    expect(body.lines).toEqual([
      expect.objectContaining({ account_number: '2440', debit_amount: 19229.4 }),
      expect.objectContaining({ account_number: '1930', credit_amount: 19382.3 }),
      expect.objectContaining({ account_number: '7960', debit_amount: 39.13 }),
      expect.objectContaining({ account_number: '6570', debit_amount: 113.77 }),
    ])
  })
})

describe('GET /api/transactions/[id]/match-supplier-invoice/preview: the preview is the booking, dimensions included', () => {
  const BAG = { '6': 'P1', '1': 'KS1' }
  type Line = {
    account_number: string
    debit_amount: number
    credit_amount: number
    description: string
    dimensions?: Record<string, string>
  }
  type Body = { lines: Line[]; document_dimensions?: Record<string, string> }

  function enqueueMatch(opts: {
    tx: { amount: number; currency: string; amount_sek?: number | null }
    invoice: Record<string, unknown>
    accountingMethod?: string
  }) {
    enqueue({
      data: { id: TX_UUID, date: '2026-05-12', cash_account_id: null, amount_sek: null, ...opts.tx },
      error: null,
    })
    enqueue({ data: { id: SI_UUID, items: [], ...opts.invoice }, error: null })
    enqueue({ data: { accounting_method: opts.accountingMethod ?? 'accrual' }, error: null })
  }

  const toPreview = (l: { account_number: string; debit_amount: number; credit_amount: number; line_description?: string; dimensions?: Record<string, string> }) => ({
    account_number: l.account_number,
    debit_amount: l.debit_amount,
    credit_amount: l.credit_amount,
    description: l.line_description ?? '',
    ...(l.dimensions ? { dimensions: l.dimensions } : {}),
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })
    const res = await GET(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(res.status).toBe(401)
  })

  it('returns 400 for a supplier_invoice_id that is not a UUID', async () => {
    const res = await GET(
      new Request(`http://localhost/api/transactions/${TX_UUID}/match-supplier-invoice/preview?supplier_invoice_id=nope`),
      createMockRouteParams({ id: TX_UUID }),
    )
    expect(res.status).toBe(400)
  })

  it('returns 404 when the transaction does not exist', async () => {
    enqueue({ data: null, error: { message: 'not found' } })
    const res = await GET(makeReq(), createMockRouteParams({ id: TX_UUID }))
    expect(res.status).toBe(404)
  })

  it('previews a pure-SEK settlement with the bank fee exactly as the POST books it, every leg tagged', async () => {
    const invoice = {
      currency: 'SEK', exchange_rate: null, total: 1000, remaining_amount: 1000, paid_amount: 0,
      supplier_invoice_number: 'LF-9', arrival_number: 9,
      registration_journal_entry_id: 'je-registered', default_dimensions: BAG,
    }
    enqueueMatch({ tx: { amount: -1050, currency: 'SEK' }, invoice })

    const res = await GET(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<Body>(res)

    expect(status).toBe(200)
    // The POST's arguments for this row (dashboard route, pure-SEK branch).
    const booked = buildSupplierInvoicePaymentLines(invoice, {
      paymentAmount: 1000, paymentAccount: '1930', bankFeeSek: 50, sekClearingDebt: 1000,
    })
    expect(body.lines).toEqual(booked.lines.map(toPreview))
    expect(body.lines.map((l) => [l.account_number, l.dimensions])).toEqual([
      ['2440', BAG], ['1930', BAG], ['6570', BAG],
    ])
    expect(body.document_dimensions).toEqual(BAG)
  })

  it('previews a foreign settlement with the POST line texts and the kursdifferens tagged', async () => {
    // 100 EUR booked at 11.00 (1 100 kr on 2440); the bank paid 1 080 kr.
    const invoice = {
      currency: 'EUR', exchange_rate: 11, total: 100, remaining_amount: 100, paid_amount: 0,
      supplier_invoice_number: 'LF-10', arrival_number: 10,
      registration_journal_entry_id: 'je-registered', default_dimensions: BAG,
    }
    enqueueMatch({ tx: { amount: -1080, currency: 'SEK' }, invoice })

    const res = await GET(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { body } = await parseJsonResponse<Body>(res)

    const booked = buildSupplierInvoicePaymentLines(invoice, {
      paymentAmount: 1100, exchangeRateDifference: 20, paymentAccount: '1930', bankFeeSek: 0,
    })
    expect(body.lines).toEqual(booked.lines.map(toPreview))
    expect(body.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount, l.dimensions])).toEqual([
      ['2440', 1100, 0, BAG],
      ['1930', 0, 1080, BAG],
      ['3960', 0, 20, BAG],
    ])
  })

  it('tags the kontantmetod cash preview from the cash builder, fee included', async () => {
    const invoice = {
      currency: 'SEK', exchange_rate: null, subtotal: 800, vat_amount: 200, total: 1000,
      remaining_amount: 1000, paid_amount: 0, registration_journal_entry_id: null,
      supplier: { supplier_type: 'swedish_business' }, default_dimensions: BAG,
      items: [{ description: 'x', line_total: 800, vat_rate: 0.25, vat_amount: 200, account_number: '6110' }],
    }
    enqueueMatch({ tx: { amount: -1025, currency: 'SEK' }, invoice, accountingMethod: 'cash' })

    const res = await GET(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<Body>(res)

    expect(status).toBe(200)
    expect(body.lines.map((l) => l.account_number)).toEqual(['6110', '2641', '1930', '6570'])
    for (const line of body.lines) expect(line.dimensions).toEqual(BAG)
    expect(body.document_dimensions).toEqual(BAG)
  })

  it('leaves an untagged invoice untagged: no bag on the lines, none for added rows', async () => {
    const invoice = {
      currency: 'SEK', exchange_rate: null, total: 1000, remaining_amount: 1000, paid_amount: 0,
      supplier_invoice_number: 'LF-11', arrival_number: 11,
      registration_journal_entry_id: 'je-registered',
    }
    enqueueMatch({ tx: { amount: -1000, currency: 'SEK' }, invoice })

    const res = await GET(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { body } = await parseJsonResponse<Body>(res)

    expect(body.lines).toHaveLength(2)
    for (const line of body.lines) expect('dimensions' in line).toBe(false)
    expect(body.document_dimensions).toBeUndefined()
  })
})

// The preview plans through planSupplierBankMatch, the POST's own plan (#3253),
// so it refuses where the commit refuses instead of previewing rows the POST
// will never book. It used to preview an overshoot as a full settlement.
describe('GET /api/transactions/[id]/match-supplier-invoice/preview: refuses what the POST refuses', () => {
  it('refuses an overshoot past the fee cap with the POST code', async () => {
    enqueue({
      data: { id: TX_UUID, date: '2026-05-12', amount: -50000, currency: 'SEK', amount_sek: null, cash_account_id: null },
      error: null,
    })
    enqueue({
      data: {
        id: SI_UUID, currency: 'SEK', exchange_rate: null, total: 5000, remaining_amount: 5000,
        paid_amount: 0, registration_journal_entry_id: 'je-registered', items: [],
      },
      error: null,
    })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    const res = await GET(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('MATCH_SI_AMOUNT_EXCEEDS_REMAINING')
  })

  it('previews an excess of exactly one krona as a 6570 fee, 1930 equal to the bank row', async () => {
    enqueue({
      data: { id: TX_UUID, date: '2026-05-12', amount: -1001, currency: 'SEK', amount_sek: null, cash_account_id: null },
      error: null,
    })
    enqueue({
      data: {
        id: SI_UUID, currency: 'SEK', exchange_rate: null, total: 1000, remaining_amount: 1000,
        paid_amount: 0, registration_journal_entry_id: 'je-registered', items: [],
      },
      error: null,
    })
    enqueue({ data: { accounting_method: 'accrual' }, error: null })

    const res = await GET(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
      is_fully_paid: boolean
      ore_rounding: boolean
      bank_fee_sek: number
    }>(res)
    expect(status).toBe(200)
    expect(body.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2440', 1000, 0], ['1930', 0, 1001], ['6570', 1, 0],
    ])
    expect(body).toMatchObject({ is_fully_paid: true, ore_rounding: false, bank_fee_sek: 1 })
  })

  it('refuses a rate-less foreign kontantmetoden invoice with the POST code', async () => {
    enqueue({
      data: { id: TX_UUID, date: '2026-05-12', amount: -1100, currency: 'SEK', amount_sek: null, cash_account_id: null },
      error: null,
    })
    enqueue({
      data: {
        id: SI_UUID, currency: 'EUR', exchange_rate: null, total: 100, remaining_amount: 100,
        paid_amount: 0, registration_journal_entry_id: null, supplier: { supplier_type: 'swedish_business' },
        items: [],
      },
      error: null,
    })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const res = await GET(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('SI_FX_RATE_MISSING')
  })

  it('refuses a partial kontantmetoden payment across rates with the POST code', async () => {
    enqueue({
      data: { id: TX_UUID, date: '2026-05-12', amount: -50, currency: 'EUR', amount_sek: -560, cash_account_id: null },
      error: null,
    })
    enqueue({
      data: {
        id: SI_UUID, currency: 'EUR', exchange_rate: 11, total: 100, remaining_amount: 100,
        paid_amount: 0, registration_journal_entry_id: null, supplier: { supplier_type: 'swedish_business' },
        items: [],
      },
      error: null,
    })
    enqueue({ data: { accounting_method: 'cash' }, error: null })

    const res = await GET(makeReq(), createMockRouteParams({ id: TX_UUID }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(res)
    expect(status).toBe(400)
    expect(body.error.code).toBe('MATCH_SI_CASH_FX_UNSUPPORTED')
  })
})
