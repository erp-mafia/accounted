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
