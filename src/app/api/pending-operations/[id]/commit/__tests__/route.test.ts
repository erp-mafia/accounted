import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  createMockRouteParams,
  parseJsonResponse,
  createQueuedMockSupabase,
  makeTransaction,
  makeCompanySettings,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import { AccountsNotInChartError } from '@/lib/bookkeeping/errors'

const { supabase: mockSupabase, enqueue, enqueueMany, reset, findCalls } = createQueuedMockSupabase()
// suggestion_log is recorded around every booking; its own reads and writes
// are covered in lib/suggestion-log, not by this file's queued client.
// Booking review rules (accounted#130): none in these tests; the queued mock
// would otherwise hand their read a response queued for the operation.
vi.mock('@/lib/booking-review/rules', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/booking-review/rules')>()),
  loadActiveBookingReviewRules: vi.fn(async () => []),
}))
vi.mock('@/lib/suggestion-log/record', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/suggestion-log/record')>()),
  snapshotSuggestions: vi.fn(async (_supabase: unknown, companyId: string) => ({ companyId, byTransaction: new Map() })),
  recordDecisions: vi.fn(async () => undefined),
}))

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))
vi.mock('@/lib/init', () => ({ ensureInitialized: vi.fn() }))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

// Mock the counterparty templates (non-critical side effect)
vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  upsertCounterpartyTemplate: vi.fn().mockResolvedValue(undefined),
}))

// Mock createTransactionJournalEntry
const mockCreateJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: (...args: unknown[]) => mockCreateJournalEntry(...args),
}))

vi.mock('@/lib/transactions/booking-duplicate-detection', () => ({
  detectBookingDuplicate: vi.fn().mockResolvedValue(null),
}))

// Mock VAT validation
vi.mock('@/lib/vat/vies-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/vat/vies-client')>()),
  validateVatNumber: vi.fn().mockResolvedValue({ valid: true }),
}))

// Mock exchange rate
vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: vi.fn().mockResolvedValue({ rate: 11.5, date: '2026-03-25' }),
  convertToSEK: vi.fn((amount: number, rate: number) => Math.round(amount * rate * 100) / 100),
}))

// The categorize service's chart pre-validation and period-lock pre-check
// have their own tests; open and complete here.
vi.mock('@/lib/bookkeeping/account-validation', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }),
}))
const mockRecordAppApproval = vi.fn()
vi.mock('@/lib/pending-operations/record-app-approval', () => ({
  recordAppApproval: (...args: unknown[]) => mockRecordAppApproval(...args),
}))

import { POST } from '../route'
import { detectBookingDuplicate } from '@/lib/transactions/booking-duplicate-detection'

describe('POST /api/pending-operations/:id/commit', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const routeParams = createMockRouteParams({ id: 'op-1' })

  beforeEach(() => {
    vi.clearAllMocks()
    eventBus.clear()
    reset()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockCreateJournalEntry.mockResolvedValue({ id: 'je-1' })
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
    const response = await POST(request, routeParams)
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(401)
  })

  it('returns 404 when operation not found', async () => {
    enqueue({ data: null, error: { message: 'not found' } })

    const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
    const response = await POST(request, routeParams)
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect(body.error).toContain('not found')
    expect(mockRecordAppApproval).not.toHaveBeenCalled()
  })

  it('returns 409 when operation already committed', async () => {
    enqueue({
      data: {
        id: 'op-1',
        user_id: 'user-1',
        operation_type: 'categorize_transaction',
        status: 'committed',
        params: {},
        preview_data: {},
      },
    })
    enqueue({ data: null, error: null }) // CAS UPDATE returns 0 rows since status != 'pending'

    const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
    const response = await POST(request, routeParams)
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)

    expect(status).toBe(409)
    // A second approval of an operation already approved (the row a click
    // hit before the list dropped it): the registered "already handled"
    // answer the v1 approve door gives, not the generic conflict text that
    // read as a failed approval in the toast. Swedish, never raw English.
    expect(body.error.code).toBe('PENDING_OPERATION_NOT_PENDING')
    expect(body.error.message).toBe('Åtgärden är redan hanterad och kan inte godkännas eller avvisas igen.')
    // The attempt is recorded with its outcome, as the MCP and API doors do.
    expect(mockRecordAppApproval).toHaveBeenCalledWith(
      expect.objectContaining({ commitMethod: 'user_accept', outcome: 'failed' }),
    )
  })

  describe('categorize_transaction', () => {
    const pendingOp = {
      id: 'op-1',
      user_id: 'user-1',
      operation_type: 'categorize_transaction',
      status: 'pending',
      title: 'Kategorisera: test',
      params: {
        transaction_id: 'tx-1',
        category: 'expense_office',
        vat_treatment: null,
      },
      preview_data: {},
    }

    it('commits successfully', async () => {
      const tx = makeTransaction({ id: 'tx-1', amount: -500, journal_entry_id: null })
      const settings = makeCompanySettings()

      enqueueMany([
        { data: pendingOp },                         // fetch pending op
        { data: { id: 'op-1' } },                    // CAS claim
        { data: tx },                                 // fetch transaction
        { data: [] },                                 // the gate: no posted verifikat booked from the row (#203)
        { data: settings },                           // fetch company settings
        { data: [] },                                 // resolveSettlementAccount: no cash accounts -> 1930
        { data: [{ id: 'fp-1' }] },                  // fiscal period check
        { data: [{ id: 'tx-1' }], error: null },      // transaction CAS matched
        { data: null, error: null },                  // upsert counterparty template
        { data: null, error: null },                  // update pending op status
      ])

      const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
      const response = await POST(request, routeParams)
      const { status, body } = await parseJsonResponse<{ data: { journal_entry_id: string } }>(response)

      expect(status).toBe(200)
      expect(body.data.journal_entry_id).toBe('je-1')
      expect(mockCreateJournalEntry).toHaveBeenCalledTimes(1)
    })

    it('returns the structured ACCOUNTS_NOT_IN_CHART envelope when the chart lacks accounts', async () => {
      // The booking is valid but posts to reverse-charge accounts (2614/2645)
      // not active in the chart. The engine throws AccountsNotInChartError; the
      // dispatcher must release the op back to 'pending' (retryable, see the
      // 6th enqueued response) and the route must return the structured error
      // with code + account_numbers so the chat can offer activation: NOT a
      // raw error string.
      const tx = makeTransaction({ id: 'tx-1', amount: -500, journal_entry_id: null })
      const settings = makeCompanySettings()
      mockCreateJournalEntry.mockRejectedValueOnce(new AccountsNotInChartError(['2645', '2614']))

      enqueueMany([
        { data: pendingOp },                         // route fetch op
        { data: { id: 'op-1' } },                    // CAS claim (pending -> committing)
        { data: tx },                                 // fetch transaction
        { data: [] },                                 // the gate: no posted verifikat booked from the row (#203)
        { data: settings },                           // fetch company settings
        { data: [] },                                 // resolveSettlementAccount: no cash accounts -> 1930
        { data: [{ id: 'fp-1' }] },                  // fiscal period exists
        { data: null, error: null },                  // dispatcher releases op back to 'pending'
      ])

      const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
      const response = await POST(request, routeParams)
      const { status, body } = await parseJsonResponse<{
        error: { code: string; account_numbers: string[] }
      }>(response)

      expect(status).toBe(400)
      expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
      // Numeric sort puts 2614 before 2645 regardless of input order.
      expect(body.error.account_numbers).toEqual(['2614', '2645'])
    })

    it('answers a possible duplicate with the candidate and keeps the proposal pending', async () => {
      const candidate = {
        transaction_id: null,
        journal_entry_id: '7b1f6f0e-51c4-4a0a-9a1e-0f5e3c1b2a10',
        voucher_label: 'A2',
        entry_date: '2026-03-30',
        description: 'Inbetalning kundfaktura 2026001',
        amount: -500,
      }
      vi.mocked(detectBookingDuplicate).mockResolvedValueOnce(candidate as never)
      const tx = makeTransaction({ id: 'tx-1', amount: -500, journal_entry_id: null })

      enqueueMany([
        { data: pendingOp },                         // fetch pending op
        { data: { id: 'op-1' } },                    // CAS claim
        { data: tx },                                 // fetch transaction
        { data: [] },                                 // the gate: no posted verifikat booked from the row
        { data: null, error: null },                  // dispatcher releases the op back to 'pending'
      ])

      const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
      const response = await POST(request, routeParams)
      const { status, body } = await parseJsonResponse<{
        error: { code: string; details: { candidate: { journal_entry_id: string } } }
      }>(response)

      expect(status).toBe(409)
      expect(body.error.code).toBe('TRANSACTION_BOOK_POSSIBLE_DUPLICATE')
      expect(body.error.details.candidate.journal_entry_id).toBe(candidate.journal_entry_id)
      // Claimed, then handed back: never rejected.
      const updates = findCalls('pending_operations', 'update').map(([payload]) => (payload as { status: string }).status)
      expect(updates).toEqual(['committing', 'pending'])
      expect(mockCreateJournalEntry).not.toHaveBeenCalled()
    })

    it('returns 400 for a book-anyway that names no verifikat id, before reading the operation', async () => {
      const request = createMockRequest('/api/pending-operations/op-1/commit', {
        method: 'POST',
        body: { expected_duplicate_journal_entry_id: 'not-a-uuid' },
      })
      const response = await POST(request, routeParams)

      expect(response.status).toBe(400)
      expect(mockSupabase.from).not.toHaveBeenCalled()
    })

    it('returns 409 when transaction already categorized', async () => {
      const tx = makeTransaction({ id: 'tx-1', journal_entry_id: 'existing-je' })

      enqueueMany([
        { data: pendingOp },                         // fetch pending op
        { data: { id: 'op-1' } },                    // CAS claim
        { data: tx },                                 // fetch transaction (already has JE)
        { data: [{ id: 'existing-je', status: 'posted' }] }, // assertTransactionBookable: existing JE is live
        { data: null, error: null },                  // auto-reject update
      ])

      const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
      const response = await POST(request, routeParams)
      const { status, body } = await parseJsonResponse<{
        error: { code: string; message: string; details: { operation_status: string } }
      }>(response)

      expect(status).toBe(409)
      // The structured refusal (#206): the code, Swedish for a person (#337),
      // and that this refusal closed the proposal.
      expect(body.error.code).toBe('TRANSACTION_ALREADY_CATEGORIZED')
      expect(body.error.message).toBe(
        'Transaktionen är redan bokförd. Ångra kategoriseringen om du vill ändra den.',
      )
      expect(body.error.details.operation_status).toBe('rejected')
    })
  })

  describe('create_customer', () => {
    const pendingOp = {
      id: 'op-1',
      user_id: 'user-1',
      operation_type: 'create_customer',
      status: 'pending',
      title: 'Ny kund: Acme AB',
      params: {
        name: 'Acme AB',
        customer_type: 'swedish_business',
        email: 'info@acme.se',
      },
      preview_data: {},
    }

    it('commits successfully', async () => {
      enqueueMany([
        { data: pendingOp },                         // fetch pending op
        { data: { id: 'op-1' } },                    // CAS claim
        { data: null, error: null },                  // company_settings read (payment-terms default)
        { data: { id: 'cust-1', name: 'Acme AB' } }, // insert customer
        { data: null, error: null },                  // update pending op status
      ])

      const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
      const response = await POST(request, routeParams)
      const { status, body } = await parseJsonResponse<{ data: { customer_id: string } }>(response)

      expect(status).toBe(200)
      expect(body.data.customer_id).toBe('cust-1')
      // A person approving in the app leaves the same approval record as
      // the MCP and API doors, so the approval channel is never unknown.
      expect(mockRecordAppApproval).toHaveBeenCalledTimes(1)
      expect(mockRecordAppApproval).toHaveBeenCalledWith({
        companyId: 'company-1',
        userId: 'user-1',
        operation: expect.objectContaining({ id: 'op-1', operation_type: 'create_customer' }),
        commitMethod: 'user_accept',
        outcome: 'committed',
      })
    })
  })

  describe('create_invoice', () => {
    const pendingOp = {
      id: 'op-1',
      user_id: 'user-1',
      operation_type: 'create_invoice',
      status: 'pending',
      title: 'Ny faktura: Acme AB 15000 SEK',
      params: {
        customer_id: 'cust-1',
        items: [{ description: 'Konsulttjänster', quantity: 1, unit: 'st', unit_price: 15000 }],
        invoice_date: '2026-03-25',
        due_date: '2026-04-24',
        currency: 'SEK',
      },
      preview_data: {},
    }

    it('commits successfully', async () => {
      const customer = {
        id: 'cust-1',
        name: 'Acme AB',
        customer_type: 'swedish_business',
        vat_number_validated: false,
        default_payment_terms: 30,
      }

      enqueueMany([
        { data: pendingOp },                          // fetch pending op
        { data: { id: 'op-1' } },                     // CAS claim
        { data: customer },                           // fetch customer
        { data: { vat_registered: true } },           // company_settings VAT registration gate
        { data: { id: 'inv-1', invoice_number: null } }, // insert invoice (no number: assigned at send)
        { data: null, error: null },                  // insert items
        { data: { id: 'inv-1', invoice_number: null, customer: customer, items: [] } }, // fetch complete invoice
        { data: null, error: null },                  // update pending op status
      ])

      const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
      const response = await POST(request, routeParams)
      const { status, body } = await parseJsonResponse<{ data: { invoice_id: string; invoice_number: string | null } }>(response)

      expect(status).toBe(200)
      expect(body.data.invoice_id).toBe('inv-1')
      // Drafts no longer reserve a number: assigned at send time instead
      expect(body.data.invoice_number).toBeNull()
    })

    it('returns 404 when customer not found', async () => {
      enqueueMany([
        { data: pendingOp },                          // fetch pending op
        { data: { id: 'op-1' } },                     // CAS claim
        { data: null, error: { message: 'not found' } }, // customer not found
        { data: null, error: null },                  // auto-reject update
      ])

      const request = createMockRequest('/api/pending-operations/op-1/commit', { method: 'POST' })
      const response = await POST(request, routeParams)
      const { status, body } = await parseJsonResponse<{ error: string }>(response)

      expect(status).toBe(404)
      // English executor message → Swedish HTTP-404 fallback (issue #337).
      expect(body.error).toBe('Resursen kunde inte hittas.')
    })
  })
})
