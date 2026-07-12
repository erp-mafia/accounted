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

// Pure account-mapping helpers; mocked to keep the test off the real engine
// import chain (mirrors the POST route test). buildInvoicePaymentClearingLines
// and resolveSekAmount are pure and kept real so the preview lines are the
// genuine ones the dialog would render.
vi.mock('@/lib/bookkeeping/invoice-entries', () => ({
  getRevenueAccount: vi.fn().mockReturnValue('3001'),
  getOutputVatAccount: vi.fn().mockReturnValue('2611'),
}))

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
  it('cross-currency partial under kontantmetoden previews a clearing entry, not a cash entry', async () => {
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
      entry_type: string
      is_fully_paid: boolean
      lines: Array<{ account_number: string }>
      fx_conversion: { required: boolean; paid_in_invoice_currency?: number }
    }>(response)

    expect(status).toBe(200)
    // The crux of the bug: NOT a cash entry, NOT fully paid.
    expect(body.entry_type).toBe('clearing')
    expect(body.is_fully_paid).toBe(false)
    // Clearing lines clear 1510 and never recognise revenue on a 30xx account.
    const accounts = body.lines.map((l) => l.account_number)
    expect(accounts).toContain('1510')
    expect(accounts).not.toContain('3001')
    // FX surfaced with the invoice-currency equivalent (1000 / 10.45 ≈ 95.69),
    // matching what the POST handler accumulates.
    expect(body.fx_conversion.required).toBe(true)
    expect(body.fx_conversion.paid_in_invoice_currency).toBeCloseTo(95.69, 1)
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
    expect(bank?.debit_amount).toBe(5212.5)
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
