/**
 * Approving a staged gnubok_create_transactions row whose ledger_account
 * holds a bank account the company turned off and that is marked to be
 * printed on invoices. ensureManualCashAccount turns a disabled account back
 * on when rows land on it, but never an invoice payee: its payment details
 * may be stale, and turning it on is for an owner or admin
 * (CASH_ACCOUNT_DISABLED_PAYEE). The approval used to end in the
 * dispatcher's generic catch: a 500 that told the approver to try again,
 * on a proposal it had already closed with the raw English message.
 *
 * It is a refusal before anything is stored, and what is wrong lies outside
 * the proposal: the structured code, a Swedish sentence naming the account,
 * and the proposal kept for the same approval once an owner or admin has
 * turned the account on or hidden it on invoices (fixable-refusals.ts).
 *
 * The route, the dispatcher, the executor, ensureManualCashAccount and
 * reenableIfUnused run for real here. Stand-ins: the database, ingest, the
 * session's company and write permission, the approval record and the
 * booking-review rules.
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

const STAGED_PARAMS = {
  date: '2026-11-20',
  amount: -1250,
  description: 'Hyra november',
  currency: 'SEK',
  ledger_account: '1930',
  bank_connection_id: null,
  external_id: null,
}

/** The operation for the route's read, the claim for the dispatcher's CAS, nothing for every later status write. */
const pendingOperations: TableMockResolver = (chain) => {
  const first = chain[0]
  if (first?.method === 'select') {
    return {
      data: {
        id: 'op-1',
        user_id: 'user-1',
        company_id: 'company-1',
        operation_type: 'create_transaction',
        status: 'pending',
        risk_level: 'medium',
        title: 'Ny transaktion',
        params: STAGED_PARAMS,
        preview_data: STAGED_PARAMS,
      },
    }
  }
  const claim = first?.method === 'update' && (first.args[0] as { status?: string }).status === 'committing'
  return claim ? { data: { id: 'op-1', updated_at: '2026-11-22T21:10:00Z' } } : { data: null }
}

/** The manual SEK account on 1930, held by no bank connection. */
function accountOn1930(state: { enabled: boolean; invoice_payee: boolean }) {
  return {
    data: { id: 'ca-1930', currency: 'SEK', bank_connection_id: null, ...state },
  }
}

async function approve(): Promise<{ status: number; body: Envelope }> {
  const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
  return parseJsonResponse<Envelope>(await POST(request, routeParams))
}

describe('POST /api/pending-operations/:id/commit: create_transaction on a turned-off invoice payee', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } } })
    setTable('pending_operations', pendingOperations)
  })

  it('refuses with 409, the code and a Swedish sentence naming the account, storing nothing and keeping the proposal', async () => {
    setTable('cash_accounts', accountOn1930({ enabled: false, invoice_payee: true }))

    const { status, body } = await approve()

    expect(status).toBe(409)
    const error = body.error as { code: string; message: string; details?: Record<string, unknown> }
    expect(error.code).toBe('CASH_ACCOUNT_DISABLED_PAYEE')
    expect(error.message).toBe(
      'Bankkontot på 1930 är avstängt och markerat att visas på fakturor, så transaktionen sparades inte. ' +
        'En ägare eller administratör behöver aktivera det under Inställningar → Bokföring (då visas det på fakturor igen) ' +
        'eller dölja det på fakturor under Inställningar → Fakturering.',
    )
    expect(error.details).toEqual({ ledger_account: '1930', operation_status: 'pending' })
    expect(mockIngest).not.toHaveBeenCalled()
    // The account stays off: turning a payee on is for an owner or admin.
    expect(payloads('cash_accounts', 'update')).toEqual([])
    // Handed back to 'pending' for the same approval once the account is on,
    // never closed as a thrown failure.
    expect(payloads('pending_operations', 'update').at(-1)).toEqual({ status: 'pending' })
  })

  // The other fix the sentence names: hidden on invoices, the account is an
  // ordinary turned-off account, which the same approval turns back on.
  it('stores the row once the account is hidden on invoices, turning it on', async () => {
    setTable('cash_accounts', [
      accountOn1930({ enabled: false, invoice_payee: false }),
      { data: [{ id: 'ca-1930' }] }, // the guarded re-enable matched the row
    ])
    mockIngest.mockResolvedValueOnce({ transaction_ids: ['tx-1'], skipped: [] })

    const { status, body } = await approve()

    expect(status).toBe(200)
    expect(body.data).toEqual({ transaction_id: 'tx-1', cash_account_id: 'ca-1930' })
    expect(payloads('cash_accounts', 'update')).toEqual([{ enabled: true }])
    expect(payloads('pending_operations', 'update').at(-1)).toMatchObject({ status: 'committed' })
  })

  it('stores the row once the account is on, and answers 200 with the transaction', async () => {
    setTable('cash_accounts', accountOn1930({ enabled: true, invoice_payee: true }))
    mockIngest.mockResolvedValueOnce({ transaction_ids: ['tx-1'], skipped: [] })

    const { status, body } = await approve()

    expect(status).toBe(200)
    expect(body.data).toEqual({ transaction_id: 'tx-1', cash_account_id: 'ca-1930' })
    expect(mockIngest).toHaveBeenCalledWith(
      mockSupabase,
      'company-1',
      'user-1',
      [expect.objectContaining({ currency: 'SEK', amount: -1250 })],
      { settlementAccount: '1930', skipAutoCategorization: true },
    )
    expect(payloads('pending_operations', 'update').at(-1)).toMatchObject({ status: 'committed' })
  })
})
