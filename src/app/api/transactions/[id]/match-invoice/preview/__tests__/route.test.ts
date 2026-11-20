import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeTransaction,
  makeInvoice,
} from '@/tests/helpers'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

const mockFetchExchangeRate = vi.fn()
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: (...args: unknown[]) => mockFetchExchangeRate(...args),
}))

// The preview renders its rows with the booking's own pure builders
// (buildInvoiceCashLines, buildInvoiceMatchClearingLines): kept real so the
// preview lines are the genuine ones the dialog shows and the POST books.
vi.mock('@/lib/bookkeeping/invoice-entries', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bookkeeping/invoice-entries')>()
  return { buildInvoiceCashLines: actual.buildInvoiceCashLines }
})

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000'

describe('GET /api/transactions/[id]/match-invoice/preview', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
  })

  // PR #615 P1 regression (Greptile). A 1 000 SEK bank tx against a 140 USD
  // invoice is a PARTIAL payment (≈95.69 USD at 10.45). The preview must
  // convert to invoice currency BEFORE deciding fully-paid / cash-vs-clearing.
  // Before the fix, comparing the raw 1 000 SEK against 140 USD made
  // newRemaining go negative → is_fully_paid=true → a cash-method unbooked
  // invoice previewed a cash entry (Dr 1930 / Cr 30xx) while the POST: which
  // converts first: commits the clearing entry (Dr 1930 / Cr 1510). The user
  // approved one verifikat and a different one was booked.
  it('cross-currency partial under kontantmetoden is rejected like the POST handler', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: 1000,
      currency: 'SEK',
      date: '2026-05-30',
      invoice_id: null,
    })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      currency: 'USD',
      exchange_rate: 9.3,
      total: 140,
      remaining_amount: 140,
      paid_amount: 0,
      // journal_entry_id left undefined → unbooked (kontantmetoden candidate)
    })
    enqueue({ data: tx, error: null }) // transactions
    enqueue({ data: invoice, error: null }) // invoices
    enqueue({ data: { accounting_method: 'cash', entity_type: 'enskild_firma' }, error: null }) // company_settings

    mockFetchExchangeRate.mockResolvedValue({ currency: 'USD', rate: 10.45, date: '2026-05-30' })

    const request = createMockRequest('/api/transactions/tx-1/match-invoice/preview', {
      searchParams: { invoice_id: VALID_UUID },
    })
    const response = await GET(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details?: { reason?: string } }
    }>(response)

    // The preview must never show a verifikat the POST refuses to book: a
    // partial payment of a never-booked kontantmetoden invoice is rejected on
    // both surfaces (the old clearing fallback credited an empty 1510 with no
    // revenue and no moms). The original PR #615 regression (preview showing
    // cash while POST books clearing) stays covered: both now agree.
    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED')
    expect(body.error.details?.reason).toBe('partial_payment')
  })

  // Guard the cash path the fix reorders around: a same-currency full payment
  // of an unbooked invoice under kontantmetoden still previews the cash entry,
  // and no Riksbanken lookup happens for a same-currency settlement.
  it('same-currency full payment under kontantmetoden still previews a cash entry', async () => {
    const tx = makeTransaction({
      id: 'tx-2',
      amount: 12500,
      currency: 'SEK',
      date: '2026-05-30',
      invoice_id: null,
    })
    const invoice = makeInvoice({
      id: VALID_UUID,
      status: 'sent',
      currency: 'SEK',
      total: 12500,
      remaining_amount: 12500,
      paid_amount: 0,
    })
    enqueue({ data: tx, error: null })
    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'cash', entity_type: 'enskild_firma' }, error: null })

    const request = createMockRequest('/api/transactions/tx-2/match-invoice/preview', {
      searchParams: { invoice_id: VALID_UUID },
    })
    const response = await GET(request, createMockRouteParams({ id: 'tx-2' }))
    const { status, body } = await parseJsonResponse<{
      entry_type: string
      is_fully_paid: boolean
      fx_conversion: { required: boolean }
    }>(response)

    expect(status).toBe(200)
    expect(body.entry_type).toBe('cash')
    expect(body.is_fully_paid).toBe(true)
    expect(body.fx_conversion.required).toBe(false)
    expect(mockFetchExchangeRate).not.toHaveBeenCalled()
  })

  // Regression for the F-2026080 bug: the cash-entry preview double-subtracted
  // VAT (sub = line_total - vat_amount) even though line_total is ALREADY the
  // net line amount, producing 3001=3127.5 against a 1930 debit of 5212.5: an
  // unbalanced verifikat. The existing 'same-currency full payment' test above
  // uses an itemless invoice, so it only hits the fallback branch and never the
  // buggy per-item loop. This invoice mirrors F-2026080 exactly.
  it('multi-item SEK cash entry balances (line_total is net, not gross)', async () => {
    const tx = makeTransaction({
      id: 'tx-3',
      amount: 5213,
      currency: 'SEK',
      date: '2026-05-18',
      invoice_id: null,
    })
    const invoice = {
      ...makeInvoice({
        id: VALID_UUID,
        status: 'sent',
        currency: 'SEK',
        total: 5212.5,
        subtotal: 4170,
        vat_amount: 1042.5,
        remaining_amount: 5212.5,
        paid_amount: 0,
      }),
      // line_total is NET (excludes VAT); each vat_amount = line_total * 0.25.
      items: [
        { vat_rate: 25, line_total: 420, vat_amount: 105 },
        { vat_rate: 25, line_total: 1500, vat_amount: 375 },
        { vat_rate: 25, line_total: 2250, vat_amount: 562.5 },
      ],
    }
    enqueue({ data: tx, error: null })
    enqueue({ data: invoice, error: null })
    enqueue({ data: { accounting_method: 'cash', entity_type: 'enskild_firma' }, error: null })

    const request = createMockRequest('/api/transactions/tx-3/match-invoice/preview', {
      searchParams: { invoice_id: VALID_UUID },
    })
    const response = await GET(request, createMockRouteParams({ id: 'tx-3' }))
    const { status, body } = await parseJsonResponse<{
      entry_type: string
      lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>
    }>(response)

    expect(status).toBe(200)
    expect(body.entry_type).toBe('cash')

    const totalDebit = body.lines.reduce((s, l) => s + l.debit_amount, 0)
    const totalCredit = body.lines.reduce((s, l) => s + l.credit_amount, 0)
    // The crux: the previewed verifikat must balance.
    expect(Math.round((totalDebit - totalCredit) * 100)).toBe(0)

    const revenue = body.lines.find((l) => l.account_number === '3001')
    const vat = body.lines.find((l) => l.account_number === '2611')
    const bank = body.lines.find((l) => l.account_number === '1930')
    expect(revenue?.credit_amount).toBe(4170) // net subtotal, NOT 3127.5
    expect(vat?.credit_amount).toBe(1042.5)
    // The whole-krona bank row (5 213) is what 1930 takes; the 0,50 over the
    // invoice is öresavrundning on 3740, revenue and moms unchanged.
    expect(bank?.debit_amount).toBe(5213)
    const ore = body.lines.find((l) => l.account_number === '3740')
    expect(ore).toMatchObject({ debit_amount: 0, credit_amount: 0.5 })
  })

  // Settlement-account resolution (customer-invoice counterpart of the
  // supplier-side fix): the bank leg must reflect THIS transaction's own
  // linked cash account, not a hardcoded 1930, so a receipt into a secondary
  // account previews the exact verifikat the POST handler will commit.
  describe('settlement account resolution', () => {
    it('clearing entry: previews the bank leg on the transaction\'s own linked cash account, not 1930', async () => {
      const tx = makeTransaction({
        id: 'tx-4',
        amount: 1250,
        currency: 'SEK',
        date: '2026-05-30',
        invoice_id: null,
        cash_account_id: 'ca-1940',
      })
      const invoice = makeInvoice({
        id: VALID_UUID,
        status: 'sent',
        currency: 'SEK',
        total: 1250,
        remaining_amount: 1250,
        paid_amount: 0,
        journal_entry_id: 'je-original', // already booked → clearing path
      })
      enqueue({ data: tx, error: null }) // transactions
      enqueue({ data: invoice, error: null }) // invoices
      enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null }) // company_settings
      enqueue({ data: { ledger_account: '1940' }, error: null }) // cash_accounts lookup

      const request = createMockRequest('/api/transactions/tx-4/match-invoice/preview', {
        searchParams: { invoice_id: VALID_UUID },
      })
      const response = await GET(request, createMockRouteParams({ id: 'tx-4' }))
      const { status, body } = await parseJsonResponse<{
        entry_type: string
        lines: Array<{ account_number: string; debit_amount: number }>
      }>(response)

      expect(status).toBe(200)
      expect(body.entry_type).toBe('clearing')
      const accounts = body.lines.map((l) => l.account_number)
      expect(accounts).toContain('1940')
      expect(accounts).not.toContain('1930')
      expect(body.lines.find((l) => l.account_number === '1940')?.debit_amount).toBe(1250)
    })

    it('cash entry: previews the bank leg on the transaction\'s own linked cash account, not 1930', async () => {
      const tx = makeTransaction({
        id: 'tx-5',
        amount: 12500,
        currency: 'SEK',
        date: '2026-05-30',
        invoice_id: null,
        cash_account_id: 'ca-1940',
      })
      const invoice = makeInvoice({
        id: VALID_UUID,
        status: 'sent',
        currency: 'SEK',
        total: 12500,
        remaining_amount: 12500,
        paid_amount: 0,
      })
      enqueue({ data: tx, error: null })
      enqueue({ data: invoice, error: null })
      enqueue({ data: { accounting_method: 'cash', entity_type: 'enskild_firma' }, error: null })
      enqueue({ data: { ledger_account: '1940' }, error: null }) // cash_accounts lookup

      const request = createMockRequest('/api/transactions/tx-5/match-invoice/preview', {
        searchParams: { invoice_id: VALID_UUID },
      })
      const response = await GET(request, createMockRouteParams({ id: 'tx-5' }))
      const { status, body } = await parseJsonResponse<{
        entry_type: string
        lines: Array<{ account_number: string; debit_amount: number }>
      }>(response)

      expect(status).toBe(200)
      expect(body.entry_type).toBe('cash')
      const accounts = body.lines.map((l) => l.account_number)
      expect(accounts).toContain('1940')
      expect(accounts).not.toContain('1930')
      expect(body.lines.find((l) => l.account_number === '1940')?.debit_amount).toBe(12500)
    })

    it('defaults to 1930 when the transaction has no linked cash account', async () => {
      const tx = makeTransaction({
        id: 'tx-6',
        amount: 1250,
        currency: 'SEK',
        date: '2026-05-30',
        invoice_id: null,
        cash_account_id: null,
      })
      const invoice = makeInvoice({
        id: VALID_UUID,
        status: 'sent',
        currency: 'SEK',
        total: 1250,
        remaining_amount: 1250,
        paid_amount: 0,
        journal_entry_id: 'je-original',
      })
      enqueue({ data: tx, error: null })
      enqueue({ data: invoice, error: null })
      enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
      // No cash_accounts enqueue: resolveSettlementAccount short-circuits to
      // '1930' when cash_account_id is null, with no DB call.

      const request = createMockRequest('/api/transactions/tx-6/match-invoice/preview', {
        searchParams: { invoice_id: VALID_UUID },
      })
      const response = await GET(request, createMockRouteParams({ id: 'tx-6' }))
      const { status, body } = await parseJsonResponse<{
        lines: Array<{ account_number: string; debit_amount: number }>
      }>(response)

      expect(status).toBe(200)
      expect(body.lines.find((l) => l.account_number === '1930')?.debit_amount).toBe(1250)
    })

    it('aborts with 500 BOOKKEEPING_DATABASE_ERROR when the cash_accounts lookup errors', async () => {
      const tx = makeTransaction({
        id: 'tx-7',
        amount: 1250,
        currency: 'SEK',
        date: '2026-05-30',
        invoice_id: null,
        cash_account_id: 'ca-broken',
      })
      const invoice = makeInvoice({
        id: VALID_UUID,
        status: 'sent',
        currency: 'SEK',
        total: 1250,
        remaining_amount: 1250,
        paid_amount: 0,
        journal_entry_id: 'je-original',
      })
      enqueue({ data: tx, error: null })
      enqueue({ data: invoice, error: null })
      enqueue({ data: { accounting_method: 'accrual', entity_type: 'enskild_firma' }, error: null })
      enqueue({ data: null, error: { message: 'connection reset' } }) // cash_accounts lookup errors

      const request = createMockRequest('/api/transactions/tx-7/match-invoice/preview', {
        searchParams: { invoice_id: VALID_UUID },
      })
      const response = await GET(request, createMockRouteParams({ id: 'tx-7' }))
      const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

      expect(status).toBe(500)
      expect(body.error.code).toBe('BOOKKEEPING_DATABASE_ERROR')
    })
  })
})

describe('GET /api/transactions/[id]/match-invoice/preview: a customer overpayment (crm#1045)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
  })

  async function preview(searchParams: Record<string, string> = {}) {
    const request = createMockRequest('/api/transactions/tx-1/match-invoice/preview', {
      searchParams: { invoice_id: VALID_UUID, ...searchParams },
    })
    const response = await GET(request, createMockRouteParams({ id: 'tx-1' }))
    return parseJsonResponse<{
      lines: unknown[]
      is_fully_paid: boolean
      overpayment: { excess: number; accounts: string[]; account: string | null } | null
      error: { code: string; details?: Record<string, unknown> }
    }>(response)
  }

  function enqueueSek(amount: number) {
    enqueue({ data: makeTransaction({ id: 'tx-1', amount, currency: 'SEK', date: '2026-05-30', invoice_id: null }), error: null })
    enqueue({
      data: makeInvoice({ id: VALID_UUID, status: 'sent', total: 812.4, remaining_amount: 812.4, paid_amount: 0, journal_entry_id: 'je-sent' }),
      error: null,
    })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null })
    enqueue({ data: [], error: null }) // cash accounts -> 1930
  }

  it('an excess of 10 kr or more offers only 2420 and previews no rows until it is named', async () => {
    enqueueSek(1312.4)
    const { status, body } = await preview()
    expect(status).toBe(200)
    expect(body.lines).toEqual([])
    expect(body.is_fully_paid).toBe(true)
    expect(body.overpayment).toEqual({ excess: 500, accounts: ['2420'], account: null })
  })

  it('an exact payment carries no overpayment', async () => {
    enqueueSek(812.4)
    const { status, body } = await preview()
    expect(status).toBe(200)
    expect(body.overpayment).toBeNull()
    expect(body.lines).not.toEqual([])
  })

  it('refuses 3740 for an excess at its cap, as the POST does', async () => {
    enqueueSek(1312.4)
    const { status, body } = await preview({ overpayment_account: '3740' })
    expect(status).toBe(400)
    expect(body.error.code).toBe('MATCH_OVERPAYMENT_ROUNDING_CAP')
  })

  it('returns 400 for an account that may not take an overpayment', async () => {
    const { status, body } = await preview({ overpayment_account: '1510' })
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details).toMatchObject({ field: 'overpayment_account' })
  })

  it('a cross-currency overshoot is refused like the POST refuses it, not previewed as paid', async () => {
    enqueue({ data: makeTransaction({ id: 'tx-1', amount: 2000, currency: 'SEK', date: '2026-05-30', invoice_id: null }), error: null })
    enqueue({
      data: makeInvoice({ id: VALID_UUID, status: 'sent', currency: 'USD', exchange_rate: 10, total: 140, remaining_amount: 140, paid_amount: 0, journal_entry_id: 'je-sent' }),
      error: null,
    })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null })
    enqueue({ data: [], error: null }) // cash accounts -> 1930
    mockFetchExchangeRate.mockResolvedValue({ currency: 'USD', rate: 10, date: '2026-05-30' })

    const { status, body } = await preview()
    expect(status).toBe(400)
    expect(body.error.code).toBe('MATCH_AMOUNT_EXCEEDS_REMAINING')
  })

  // PH 227: a EUR invoice paid in full arrives converted at the bank's rate,
  // 0.6 % under Riksbanken's. It previews (and so books) as paid, 1510 cleared
  // at the booking rate and the difference a kursförlust on 7960, not as a
  // partial payment with a kursvinst on 3960.
  it('a cross-currency payment within the band previews the invoice paid with the kursdifferens', async () => {
    enqueue({ data: makeTransaction({ id: 'tx-1', amount: 97419.96, currency: 'SEK', date: '2026-10-26', invoice_id: null }), error: null })
    enqueue({
      data: makeInvoice({ id: VALID_UUID, status: 'sent', currency: 'EUR', exchange_rate: 11.1145, total: 8800, remaining_amount: 8800, paid_amount: 0, journal_entry_id: 'je-sent' }),
      error: null,
    })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null })
    enqueue({ data: [], error: null }) // cash accounts -> 1930
    mockFetchExchangeRate.mockResolvedValue({ currency: 'EUR', rate: 11.1385, date: '2026-10-26' })

    const { status, body } = await preview()
    expect(status).toBe(200)
    expect(body.is_fully_paid).toBe(true)
    const rows = (body.lines as Array<{ account_number: string; debit_amount: number; credit_amount: number }>).map(
      (l) => [l.account_number, l.debit_amount, l.credit_amount],
    )
    expect(rows).toEqual(
      expect.arrayContaining([
        ['1930', 97419.96, 0],
        ['1510', 0, 97807.6],
        ['7960', 387.64, 0],
      ]),
    )
    expect(rows.some(([account]) => account === '3960')).toBe(false)
  })

  it('previews the clearing of what the registration left, the öre on the kursdifferens', async () => {
    enqueue({ data: makeTransaction({ id: 'tx-1', amount: 1965.43, currency: 'SEK', date: '2026-10-26', invoice_id: null }), error: null })
    enqueue({
      data: makeInvoice({ id: VALID_UUID, status: 'sent', currency: 'EUR', exchange_rate: 11.123, total: 176.7, remaining_amount: 176.7, paid_amount: 0, journal_entry_id: 'je-sent' }),
      error: null,
    })
    enqueue({ data: { accounting_method: 'accrual', entity_type: 'aktiebolag' }, error: null })
    enqueue({ data: [], error: null }) // cash accounts -> 1930
    enqueue({ data: { ok: true, sek: 1965.44 }, error: null }) // what 1510 carries
    mockFetchExchangeRate.mockResolvedValue({ currency: 'EUR', rate: 11.123, date: '2026-10-26' })

    const { status, body } = await preview()
    expect(status).toBe(200)
    const rows = (body.lines as Array<{ account_number: string; debit_amount: number; credit_amount: number }>).map(
      (l) => [l.account_number, l.debit_amount, l.credit_amount],
    )
    expect(rows).toEqual(
      expect.arrayContaining([
        ['1930', 1965.43, 0],
        ['1510', 0, 1965.44],
        ['7960', 0.01, 0],
      ]),
    )
  })
})

// crm#1364: a SEK payout short of the invoice by the payment provider's fee.
describe('GET /api/transactions/[id]/match-invoice/preview: a payment provider fee (crm#1364)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
  })

  type Line = { account_number: string; debit_amount: number; credit_amount: number }
  async function preview(searchParams: Record<string, string> = {}) {
    const request = createMockRequest('/api/transactions/tx-1/match-invoice/preview', {
      searchParams: { invoice_id: VALID_UUID, ...searchParams },
    })
    const response = await GET(request, createMockRouteParams({ id: 'tx-1' }))
    return parseJsonResponse<{
      entry_type: string
      lines: Line[]
      is_fully_paid: boolean
      payment_fee: { fee: number; account: string | null; required: boolean } | null
      error: { code: string; details?: Record<string, unknown> }
    }>(response)
  }
  const rows = (lines: Line[]) => lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])

  // 10 000 + 2 500 moms = 12 500, paid out as 12 262,50 (a 237,50 fee).
  function enqueueMatch(amount: number, method: 'accrual' | 'cash') {
    enqueue({ data: makeTransaction({ id: 'tx-1', amount, currency: 'SEK', date: '2026-10-21', invoice_id: null }), error: null })
    enqueue({
      data: makeInvoice({
        id: VALID_UUID,
        status: 'sent',
        total: 12500,
        remaining_amount: 12500,
        paid_amount: 0,
        journal_entry_id: method === 'accrual' ? 'je-sent' : null,
      }),
      error: null,
    })
    enqueue({ data: { accounting_method: method, entity_type: 'aktiebolag' }, error: null })
    enqueue({ data: [], error: null }) // cash accounts -> 1930
  }

  it('faktureringsmetoden: previews the partial and offers the fee account', async () => {
    enqueueMatch(12262.5, 'accrual')
    const { status, body } = await preview()
    expect(status).toBe(200)
    expect(rows(body.lines)).toEqual([
      ['1930', 12262.5, 0],
      ['1510', 0, 12262.5],
    ])
    expect(body.is_fully_paid).toBe(false)
    expect(body.payment_fee).toEqual({ fee: 237.5, account: null, required: false })
  })

  it('with fee_account 6570: 1510 cleared in full, the fee on 6570, invoice paid', async () => {
    enqueueMatch(12262.5, 'accrual')
    const { status, body } = await preview({ fee_account: '6570' })
    expect(status).toBe(200)
    expect(rows(body.lines)).toEqual([
      ['1930', 12262.5, 0],
      ['1510', 0, 12500],
      ['6570', 237.5, 0],
    ])
    expect(body.is_fully_paid).toBe(true)
    expect(body.payment_fee).toEqual({ fee: 237.5, account: '6570', required: false })
  })

  it('kontantmetoden: no rows until the fee is named, instead of refusing the partial', async () => {
    enqueueMatch(12262.5, 'cash')
    const { status, body } = await preview()
    expect(status).toBe(200)
    expect(body.lines).toEqual([])
    expect(body.payment_fee).toEqual({ fee: 237.5, account: null, required: true })
  })

  it('kontantmetoden with fee_account: revenue and moms on the invoice, 1930 the payout, 6570 the fee', async () => {
    enqueueMatch(12262.5, 'cash')
    const { status, body } = await preview({ fee_account: '6570' })
    expect(status).toBe(200)
    expect(body.entry_type).toBe('cash')
    expect(rows(body.lines)).toEqual([
      ['1930', 12262.5, 0],
      ['3001', 0, 10000],
      ['2611', 0, 2500],
      ['6570', 237.5, 0],
    ])
    expect(body.is_fully_paid).toBe(true)
    // Still required: the dialog offers no partial to switch back to.
    expect(body.payment_fee).toEqual({ fee: 237.5, account: '6570', required: true })
  })

  it('kontantmetoden: a gap too large for a fee is refused as the partial it is', async () => {
    enqueueMatch(10000, 'cash')
    const { status, body } = await preview()
    expect(status).toBe(400)
    expect(body.error.code).toBe('INVOICE_PAID_CASH_PARTIAL_UNSUPPORTED')
  })

  it('refuses fee_account for a gap of a tenth or more, as the POST does', async () => {
    enqueueMatch(10000, 'accrual')
    const { status, body } = await preview({ fee_account: '6570' })
    expect(status).toBe(400)
    expect(body.error.code).toBe('MATCH_PAYMENT_FEE_NOT_ALLOWED')
  })

  it('returns 400 for any other fee account', async () => {
    const { status, body } = await preview({ fee_account: '6064' })
    expect(status).toBe(400)
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(body.error.details).toMatchObject({ field: 'fee_account' })
  })

  it('an exact payment carries no fee', async () => {
    enqueueMatch(12500, 'accrual')
    const { status, body } = await preview()
    expect(status).toBe(200)
    expect(body.payment_fee).toBeNull()
  })
})
