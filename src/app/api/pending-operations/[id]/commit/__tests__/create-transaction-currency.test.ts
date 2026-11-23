/**
 * Approving a staged gnubok_create_transactions row whose ledger_account
 * already holds a kassakonto in another currency. A ledger holds one currency
 * (cash_accounts is UNIQUE on company and ledger), so the row can never be
 * stored there. The approval used to end in the dispatcher's generic catch:
 * a 500 that told the approver to try again, on a proposal it had already
 * closed with the raw English message. It is a refusal before anything is
 * stored: the structured code, a Swedish sentence naming the two
 * currencies, and the proposal closed as one to stage again, as the
 * bank-file door refuses the same account
 * (BANK_FILE_SETTLEMENT_ACCOUNT_UNAVAILABLE).
 *
 * The route, the dispatcher, the executor and ensureManualCashAccount all
 * run for real here; only the database, the exchange rate and ingest are
 * stand-ins.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  createTableMockSupabase,
  parseJsonResponse,
  type TableMockResolver,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'

const { supabase: mockSupabase, setTable, reset, payloads } = createTableMockSupabase()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
  createServiceClient: () => mockSupabase,
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))
vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))
vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))
vi.mock('@/lib/pending-operations/record-app-approval', () => ({
  recordAppApproval: vi.fn(async () => undefined),
}))
vi.mock('@/lib/booking-review/rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/booking-review/rules')>()),
  loadActiveBookingReviewRules: vi.fn(async () => []),
}))
vi.mock('@/lib/currency/riksbanken', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/currency/riksbanken')>()),
  fetchExchangeRate: vi.fn(async () => ({ currency: 'GBP', rate: 13.4, date: '2026-11-20' })),
  isExchangeRateTemporarilyUnavailable: vi.fn(() => false),
}))
const mockIngest = vi.fn()
vi.mock('@/lib/transactions/ingest', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/transactions/ingest')>()),
  ingestTransactions: (...args: unknown[]) => mockIngest(...args),
}))

import { POST } from '../route'

type Envelope = {
  data?: Record<string, unknown>
  error?: { code: string; message: string; details?: Record<string, unknown> } | string
}

const routeParams = createMockRouteParams({ id: 'op-1' })

function stagedRow(currency: string) {
  const params = {
    date: '2026-11-20',
    amount: -42.5,
    description: 'Kortköp London',
    currency,
    ledger_account: '1948',
    bank_connection_id: null,
    external_id: null,
  }
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_transaction',
    status: 'pending',
    risk_level: 'medium',
    title: 'Ny transaktion',
    params,
    preview_data: params,
  }
}

/** The operation for the route's read, the claim for the dispatcher's CAS, nothing for every later status write. */
function pendingOperations(currency: string): TableMockResolver {
  return (chain) => {
    const first = chain[0]
    if (first?.method === 'select') return { data: stagedRow(currency) }
    const claim = first?.method === 'update' && (first.args[0] as { status?: string }).status === 'committing'
    return claim ? { data: { id: 'op-1', updated_at: '2026-11-21T14:49:51Z' } } : { data: null }
  }
}

/** The kassakonto already on 1948: a manual EUR account, as the company had. */
const EUR_ACCOUNT_ON_1948 = {
  data: { id: 'ca-1948', currency: 'EUR', enabled: true, bank_connection_id: null, invoice_payee: false },
}

async function approve(): Promise<{ status: number; body: Envelope }> {
  const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
  return parseJsonResponse<Envelope>(await POST(request, routeParams))
}

describe('POST /api/pending-operations/:id/commit: create_transaction on a kassakonto in another currency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
    setTable('cash_accounts', EUR_ACCOUNT_ON_1948)
  })

  it('refuses a GBP row on the EUR kassakonto with 409, the code and a Swedish sentence, storing nothing', async () => {
    setTable('pending_operations', pendingOperations('GBP'))

    const { status, body } = await approve()

    expect(status).toBe(409)
    const error = body.error as { code: string; message: string; details?: Record<string, unknown> }
    expect(error.code).toBe('CASH_ACCOUNT_CURRENCY_MISMATCH')
    expect(error.message).toContain('1948')
    expect(error.message).toContain('EUR')
    expect(error.message).toContain('GBP')
    expect(error.message).not.toMatch(/denominated|Cash account/)
    expect(error.details).toMatchObject({
      ledger_account: '1948',
      account_currency: 'EUR',
      currency: 'GBP',
      operation_status: 'rejected',
    })
    expect(mockIngest).not.toHaveBeenCalled()
    // Closed as a refusal the agent can stage again, with the code kept,
    // never as a thrown failure.
    const closed = payloads('pending_operations', 'update').at(-1) as Record<string, unknown>
    expect(closed).toMatchObject({
      status: 'rejected',
      rejection_category: 'failed',
      result_data: { auto_rejected: true, error_code: 'CASH_ACCOUNT_CURRENCY_MISMATCH' },
    })
    expect((closed.result_data as Record<string, unknown>).threw).toBeUndefined()
  })

  it('stores a EUR row on the EUR kassakonto and answers 200 with the transaction', async () => {
    setTable('pending_operations', pendingOperations('EUR'))
    mockIngest.mockResolvedValueOnce({ transaction_ids: ['tx-1'], skipped: [] })

    const { status, body } = await approve()

    expect(status).toBe(200)
    expect(body.data).toEqual({ transaction_id: 'tx-1', cash_account_id: 'ca-1948' })
    expect(mockIngest).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'user-1',
      [expect.objectContaining({ currency: 'EUR', amount: -42.5 })],
      { settlementAccount: '1948', skipAutoCategorization: true },
    )
    expect(payloads('pending_operations', 'update').at(-1)).toMatchObject({ status: 'committed' })
  })
})
