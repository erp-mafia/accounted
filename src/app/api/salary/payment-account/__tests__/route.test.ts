/**
 * GET /api/salary/payment-account: the account the payment files pay from,
 * as the run page and the salary settings name it (crm#1483). The real
 * view and paying-account rule run; tables answer by name.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import {
  createMockRequest,
  createTableMockSupabase,
  makePayingCashAccount,
  payingCashAccountsTable,
} from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const URL = '/api/salary/payment-account'
const RUN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const IBAN_1930 = 'SE4550000000058398257466'
const IBAN_1931 = 'SE7150000000058391234567'

const connected1930 = makePayingCashAccount({
  name: 'Företagskonto',
  bank_connection_id: 'bc-1',
  iban: IBAN_1930,
  bank_connection: { bank_name: 'SEB', bic: 'ESSESESS' },
})
const savings1931 = makePayingCashAccount({
  id: 'ca-1931',
  name: 'Sparkonto',
  ledger_account: '1931',
  is_primary: false,
  payee_iban: IBAN_1931,
})

function signedIn(tables: Parameters<typeof createTableMockSupabase>[0]) {
  const mock = createTableMockSupabase(tables)
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase: mock.supabase, error: null })
  return mock
}

describe('GET /api/salary/payment-account', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when not authenticated', async () => {
    requireAuthMock.mockResolvedValue({
      user: null,
      supabase: null,
      error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
    })
    const response = await GET(createMockRequest(URL), { params: Promise.resolve({}) })
    expect(response.status).toBe(401)
  })

  it('returns 400 for a run id that is not a UUID, reading nothing', async () => {
    const mock = signedIn({})
    const response = await GET(createMockRequest(URL, { searchParams: { run_id: 'run-1' } }), {
      params: Promise.resolve({}),
    })
    expect(response.status).toBe(400)
    expect(mock.tables()).toEqual([])
  })

  it('returns 404 SALARY_RUN_NOT_FOUND for a run the company does not have', async () => {
    const mock = signedIn({ salary_runs: { data: null } })
    const response = await GET(createMockRequest(URL, { searchParams: { run_id: RUN_ID } }), {
      params: Promise.resolve({}),
    })
    expect(response.status).toBe(404)
    expect((await response.json()).error.code).toBe('SALARY_RUN_NOT_FOUND')
    expect(mock.findCalls('salary_runs', 'eq')).toContainEqual(['company_id', 'company-1'])
  })

  it('names the primary bank account, its bank instructions, and nothing missing', async () => {
    signedIn({
      company_settings: { data: { iban: IBAN_1931, bic: 'ESSESESS', salary_default_bank: 'swedbank' } },
      cash_accounts: payingCashAccountsTable([connected1930, savings1931]),
    })
    const response = await GET(createMockRequest(URL), { params: Promise.resolve({}) })

    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual({
      account: { cash_account_id: 'ca-1930', name: 'Företagskonto', ledger_account: '1930', iban_last4: '7466' },
      basis: 'primary',
      missing: null,
      // The account's bank (SEB), not the stored pick: the file is uploaded there.
      instruction_bank: 'seb',
      swedbank: false,
    })
  })

  it("answers a booked run's verifikat account, and says when it lacks an IBAN", async () => {
    signedIn({
      salary_runs: { data: { id: RUN_ID, status: 'booked', salary_entry_id: 'je-salary' } },
      journal_entries: {
        data: [
          {
            id: 'je-salary',
            description: 'Lön 2026-04',
            voucher_series: 'K',
            voucher_number: 12,
            lines: [
              { account_number: '7210', line_description: '', debit_amount: 26000, credit_amount: 0 },
              { account_number: '2710', line_description: '', debit_amount: 0, credit_amount: 6000 },
              { account_number: '1940', line_description: '', debit_amount: 0, credit_amount: 20000 },
            ],
          },
        ],
      },
      company_settings: { data: { iban: IBAN_1931, bic: 'ESSESESS', salary_default_bank: 'nordea' } },
      cash_accounts: payingCashAccountsTable([
        connected1930,
        makePayingCashAccount({ id: 'ca-1940', name: 'Lönekonto', ledger_account: '1940', is_primary: false }),
      ]),
    })
    const response = await GET(createMockRequest(URL, { searchParams: { run_id: RUN_ID } }), {
      params: Promise.resolve({}),
    })

    expect(response.status).toBe(200)
    expect((await response.json()).data).toEqual({
      account: { cash_account_id: 'ca-1940', name: 'Lönekonto', ledger_account: '1940', iban_last4: null },
      basis: 'booked',
      missing: 'iban',
      // No IBAN names a bank: the stored pick is the fallback.
      instruction_bank: 'nordea',
      swedbank: false,
    })
  })
})
