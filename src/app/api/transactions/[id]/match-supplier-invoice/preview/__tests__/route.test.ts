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
