import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeTransaction,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { BookkeepingDatabaseError, JournalEntryNotBalancedError } from '@/lib/bookkeeping/errors'

const { supabase: mockSupabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(mockSupabase),
}))

vi.mock('@/lib/init', () => ({
  ensureInitialized: vi.fn(),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/auth/require-write', () => ({
  requireWritePermission: vi.fn().mockResolvedValue({ ok: true }),
}))

const mockBuildMappingResultFromCategory = vi.fn()
vi.mock('@/lib/bookkeeping/category-mapping', () => ({
  buildMappingResultFromCategory: (...args: unknown[]) =>
    mockBuildMappingResultFromCategory(...args),
}))

const mockCreateTransactionJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/transaction-entries', () => ({
  createTransactionJournalEntry: (...args: unknown[]) =>
    mockCreateTransactionJournalEntry(...args),
}))

// Booking-time duplicate guard: mocked to "no duplicate" by default so these
// tests exercise categorization, not the guard. The detection query is
// unit-tested in lib/transactions/__tests__/booking-duplicate-detection.test.ts.
const mockDetectDup = vi.fn()
// Spread the real module so pure helpers the route also imports from here
// (resolveTransactionAmountSek) keep their real behaviour; only the DB-backed
// detector is stubbed. A bare factory would leave those exports undefined.
vi.mock('@/lib/transactions/booking-duplicate-detection', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/transactions/booking-duplicate-detection')>()),
  detectBookingDuplicate: (...args: unknown[]) => mockDetectDup(...args),
}))

// Behandlingshistorik append: mocked so we can assert the dismissal is
// persisted without reaching the service-role client.
const mockAppendProcessingHistory = vi.fn()
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...args: unknown[]) => mockAppendProcessingHistory(...args),
}))

const mockSaveUserMappingRule = vi.fn()
vi.mock('@/lib/bookkeeping/mapping-engine', () => ({
  saveUserMappingRule: (...args: unknown[]) => mockSaveUserMappingRule(...args),
  // Mirror the real implementation: rewrite a 1930 bank leg to the settlement
  // account, no-op when the settlement account is 1930.
  applySettlementAccount: (
    result: { debit_account?: string; credit_account?: string },
    bankAccount: string,
  ) =>
    bankAccount === '1930'
      ? result
      : {
          ...result,
          debit_account: result.debit_account === '1930' ? bankAccount : result.debit_account,
          credit_account: result.credit_account === '1930' ? bankAccount : result.credit_account,
        },
}))

vi.mock('@/lib/bookkeeping/counterparty-templates', () => ({
  upsertCounterpartyTemplate: vi.fn().mockResolvedValue(undefined),
}))

// Posted-orphan compensation is centralized and routes through engine storno.
const mockReverseOrphanedJournalEntry = vi.fn()
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  reverseOrphanedJournalEntry: (...args: unknown[]) => mockReverseOrphanedJournalEntry(...args),
}))

// Null-return disambiguation (issue #1947): the route asks checkPeriodLock
// whether the engine's null was a closed covering period or a missing one.
const mockCheckPeriodLock = vi.fn()
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: (...args: unknown[]) => mockCheckPeriodLock(...args),
}))

const mockFindMissingActiveAccounts = vi.fn()
vi.mock('@/lib/bookkeeping/account-validation', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/account-validation')>(
    '@/lib/bookkeeping/account-validation',
  )
  return {
    ...actual,
    findUnresolvableAccounts: (...args: unknown[]) => mockFindMissingActiveAccounts(...args),
  }
})

import { POST } from '../route'

describe('POST /api/transactions/[id]/categorize', () => {
  const mockUser = { id: 'user-1', email: 'test@test.se' }
  const defaultMappingResult = {
    rule: null,
    debit_account: '6200',
    credit_account: '1930',
    risk_level: 'NONE',
    confidence: 1,
    requires_review: false,
    default_private: false,
    vat_lines: [{ account_number: '2641', debit_amount: 62.5, credit_amount: 0, description: 'Ingående moms' }],
    description: 'Test expense',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: mockUser } })
    mockBuildMappingResultFromCategory.mockReturnValue(defaultMappingResult)
    // Default: every mapped account exists and is active. Tests covering the
    // missing-account path override this per-case.
    mockFindMissingActiveAccounts.mockResolvedValue([])
    // Default: no booking-time duplicate. The dedicated guard test overrides this.
    mockDetectDup.mockResolvedValue(null)
    mockAppendProcessingHistory.mockResolvedValue('evt-1')
    mockReverseOrphanedJournalEntry.mockResolvedValue(undefined)
    // Default: no covering period at all. The closed-period test overrides this.
    mockCheckPeriodLock.mockResolvedValue({ locked: false, reason: 'no_fiscal_period' })
  })

  it('delegates the CAS-race orphan to engine-backed storno compensation', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'GitHub',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null }) // fetch transaction
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null }) // settings
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: [{ id: 'period-1' }], error: null }) // ensureFiscalPeriod

    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    mockSaveUserMappingRule.mockResolvedValue(undefined)

    // Lost the CAS: another request stamped journal_entry_id first.
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: unknown }>(response)

    expect(status).toBe(409)
    expect((body.error as { code: string }).code).toBe('TX_CATEGORIZE_RACE')

    // No hand-rolled insert: the helper owns the real column set.
    expect(mockReverseOrphanedJournalEntry).toHaveBeenCalledTimes(1)
    expect(mockReverseOrphanedJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-1',
      'Kategoriseringsverifikation utan transaktionskoppling; automatisk storno misslyckades. Manuell avstämning krävs.',
    )
  })

  it('returns 401 when not authenticated', async () => {
    mockSupabase.auth.getUser.mockResolvedValue({ data: { user: null } })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse(response)

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 404 when transaction not found', async () => {
    enqueue({ data: null, error: { message: 'Not found' } })

    const request = createMockRequest('/api/transactions/tx-999/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-999' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(404)
    expect((body.error as unknown as { code: string }).code).toBe('TX_CATEGORIZE_TX_NOT_FOUND')
  })

  it('updates category only when transaction already has journal entry', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: 'je-existing',
      category: 'uncategorized',
    })
    // Fetch transaction
    enqueue({ data: tx, error: null })
    // Update transaction
    enqueue({ data: [{ ...tx, is_business: true, category: 'expense_software' }], error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      already_had_journal_entry: boolean
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.already_had_journal_entry).toBe(true)
    expect(body.journal_entry_id).toBe('je-existing')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
    expect(
      findCalls('transactions', 'eq').filter(([column]) => column === 'company_id'),
    ).toHaveLength(2)
  })

  it('creates journal entry for business expense', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'GitHub',
      journal_entry_id: null,
    })

    // Fetch transaction
    enqueue({ data: tx, error: null })
    // Fetch company settings
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    // ensureFiscalPeriod: check existing
    enqueue({ data: [{ id: 'period-1' }], error: null })

    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    mockSaveUserMappingRule.mockResolvedValue(undefined)

    // Update transaction (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'tx-1' }], error: null })

    const emitSpy = vi.spyOn(eventBus, 'emit')

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_created: boolean
      journal_entry_id: string
      category: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_created).toBe(true)
    expect(body.journal_entry_id).toBe('je-1')
    expect(body.category).toBe('expense_software')
    expect(mockSaveUserMappingRule).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'GitHub',
      '6200',
      '1930',
      false,
      undefined,
      undefined
    )
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'transaction.categorized' })
    )
  })

  it('books a standardmall bank leg on the single enabled cash account when cash_account_id is NULL (#1722)', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'Banken',
      journal_entry_id: null,
      cash_account_id: null,
    })

    // Fetch transaction
    enqueue({ data: tx, error: null })
    // Fetch company settings
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    // resolveSettlementAccount currency fallback: the company's ONLY enabled
    // SEK cash account is a PlusGiro on 1920, so the template's hardcoded
    // 1930 leg must be rewritten to 1920 before posting.
    enqueue({ data: [{ ledger_account: '1920' }], error: null })
    // ensureFiscalPeriod: check existing
    enqueue({ data: [{ id: 'period-1' }], error: null })

    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    mockSaveUserMappingRule.mockResolvedValue(undefined)

    // Update transaction (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'tx-1' }], error: null })
    enqueue({ data: [], error: null }) // inbox propagation: no matched items

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, template_id: 'bank_fees' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_created: boolean
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_created).toBe(true)
    // The posted mapping carries the real settlement account, not the
    // template's hardcoded 1930 (bank_fees is Dr 6570 / Cr 1930).
    const mappingArg = mockCreateTransactionJournalEntry.mock.calls[0][4] as {
      debit_account: string
      credit_account: string
    }
    expect(mappingArg.debit_account).toBe('6570')
    expect(mappingArg.credit_account).toBe('1920')
    // The fallback listing was narrowed to enabled accounts in the
    // transaction's currency.
    const eqArgs = findCalls('cash_accounts', 'eq')
    expect(eqArgs).toContainEqual(['enabled', true])
    expect(eqArgs).toContainEqual(['currency', 'SEK'])
  })

  it('books a transaction dated before the first fiscal year without minting a period (pre-FY, issue #1825)', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      date: '2026-03-10',
      amount: 25000,
      merchant_name: null,
      journal_entry_id: null,
      description: 'Insättning aktiekapital',
    })

    enqueue({ data: tx, error: null }) // fetch transaction
    enqueue({ data: { entity_type: 'aktiebolag', fiscal_year_start_month: 1 }, error: null }) // settings
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: [], error: null }) // ensureFiscalPeriod: no covering open period
    enqueue({ data: [{ period_start: '2026-05-12' }], error: null }) // ensureFiscalPeriod: earliest period

    // The clamp inside createTransactionJournalEntry (unit-tested in
    // lib/bookkeeping/__tests__/transaction-entries.test.ts) books into the
    // first open period; here it is mocked to the successful outcome.
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })

    enqueue({ data: [{ id: 'tx-1' }], error: null }) // guarded update matched

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'income_other' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_created: boolean
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_created).toBe(true)
    expect(body.journal_entry_id).toBe('je-1')
    // The pre-FY guard must not upsert a calendar-year (pre-registration) period.
    expect(findCalls('fiscal_periods', 'upsert')).toHaveLength(0)
  })
  it('atomically unignores an ignored transaction when categorizing it', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: null,
      journal_entry_id: null,
      is_ignored: true,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: [{ ...tx, is_business: false, category: 'private', is_ignored: false, journal_entry_id: 'je-1' }], error: null })

    const categorizedHandler = vi.fn()
    eventBus.on('transaction.categorized', categorizedHandler)

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: false },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))

    expect(response.status).toBe(200)
    expect(findCalls('transactions', 'update')).toContainEqual([
      expect.objectContaining({
        is_business: false,
        category: 'private',
        is_ignored: false,
        journal_entry_id: 'je-1',
      }),
    ])
    expect(categorizedHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction: expect.objectContaining({ is_ignored: false }),
      }),
    )
  })

  it('passes body.dimensions onto the mapping result the engine books', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'GitHub',
      journal_entry_id: null,
    })
    // Fresh copy: the route mutates the mapping result in place, and the
    // shared defaultMappingResult object would leak dimensions across tests.
    mockBuildMappingResultFromCategory.mockReturnValue({ ...defaultMappingResult })

    enqueue({ data: tx, error: null }) // fetch transaction
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null }) // settings
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: [{ id: 'period-1' }], error: null }) // fiscal period check
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: [{ id: 'tx-1' }], error: null }) // tx update (CAS matched)

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: {
        is_business: true,
        category: 'expense_software',
        dimensions: { '1': 'KS1', '6': 'P001' },
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    expect(mockCreateTransactionJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.objectContaining({ id: 'tx-1' }),
      expect.objectContaining({ dimensions: { '1': 'KS1', '6': 'P001' } }),
    )
  })

  it('rejects a malformed dimensions bag with 400', async () => {
    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: {
        is_business: true,
        category: 'expense_software',
        // Key must be a SIE dim number: 'projekt' is not.
        dimensions: { projekt: 'P001' },
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(400)
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('flags an inbox underlag matched to the transaction as booked', async () => {
    // A document was attached to this transaction in the inbox
    // (matched_transaction_id) but not booked from there. Booking the
    // transaction here (no inbox_item_id in the body) must still stamp the
    // matched inbox item with the new journal entry and link its document.
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'GitHub',
      journal_entry_id: null,
      document_id: null, // ensure document_attachments is touched ONLY by the inbox propagation
    })

    enqueue({ data: tx, error: null }) // fetch transaction
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null }) // settings
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: [{ id: 'period-1' }], error: null }) // fiscal period check
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: [{ id: 'tx-1' }], error: null }) // tx update (CAS matched)
    // Inbox propagation: one matched item with a document
    enqueue({ data: [{ id: 'inbox-1', document_id: 'doc-1' }], error: null })
    enqueue({ data: null, error: null }) // document_attachments update
    enqueue({ data: null, error: null }) // invoice_inbox_items update

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; journal_entry_id: string }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-1')
    // The propagation looked up matched inbox items and linked the document.
    expect(mockSupabase.from).toHaveBeenCalledWith('invoice_inbox_items')
    expect(mockSupabase.from).toHaveBeenCalledWith('document_attachments')
  })

  it('does not touch the inbox when no underlag is matched to the transaction', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'GitHub',
      journal_entry_id: null,
      document_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: [{ id: 'tx-1' }], error: null }) // tx update
    enqueue({ data: [], error: null }) // inbox propagation: no matched items

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status } = await parseJsonResponse(response)

    expect(status).toBe(200)
    // No matched underlag → no document/inbox writes from the propagation.
    expect(mockSupabase.from).not.toHaveBeenCalledWith('document_attachments')
  })

  describe('fails closed when the verifikat cannot be created (issue #1947)', () => {
    // Queue order up to the engine call: tx fetch, settings, settlement
    // accounts, ensureFiscalPeriod. Nothing after that: a refused verifikat
    // must not reach the transactions update.
    const enqueueUpToEngine = () => {
      const tx = makeTransaction({
        id: 'tx-1',
        amount: -500,
        merchant_name: 'Test',
        journal_entry_id: null,
      })
      enqueue({ data: tx, error: null })
      enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
      enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
      enqueue({ data: [{ id: 'period-1' }], error: null })
    }

    const categorize = async () => {
      const request = createMockRequest('/api/transactions/tx-1/categorize', {
        method: 'POST',
        body: { is_business: true, category: 'expense_software' },
      })
      const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
      return parseJsonResponse<{
        error: {
          code: string
          message: string
          message_en?: string
          details?: { cause?: string; reason?: string; fiscal_period_id?: string }
        }
      }>(response)
    }

    it('refuses the booking and leaves the row untouched when the period is locked', async () => {
      enqueueUpToEngine()
      mockCreateTransactionJournalEntry.mockRejectedValue(
        new BookkeepingDatabaseError('commit_entry', 'Cannot write to locked/closed fiscal period "2025"'),
      )

      const { status, body } = await categorize()

      expect(status).toBe(409)
      expect(body.error.code).toBe('TX_CATEGORIZE_JOURNAL_ENTRY_FAILED')
      expect(body.error.message).toBe(
        'Perioden är låst. Verifikationen kan inte skapas i en stängd eller låst period.',
      )
      // The sv/en pair is derived from the SAME underlying error, per the
      // errorResponseFromCode contract (provide both or neither): the English
      // side must not stay on the generic registry text while the Swedish
      // side names the period lock, and must never carry envelope-field prose.
      expect(body.error.message_en).toBe('Bookkeeping database operation failed.')
      expect(body.error.message_en).not.toContain('details.cause')
      expect(body.error.details?.cause).toBe('BOOKKEEPING_DATABASE_ERROR')
      // Nothing persisted: is_business/category stay NULL so the row keeps
      // matching the worklist predicate and stays in "Att bokföra".
      expect(findCalls('transactions', 'update')).toEqual([])
      expect(mockSaveUserMappingRule).not.toHaveBeenCalled()
      expect(mockReverseOrphanedJournalEntry).not.toHaveBeenCalled()
    })

    it('translates typed engine errors to Swedish in the refusal (issue #337)', async () => {
      enqueueUpToEngine()
      mockCreateTransactionJournalEntry.mockRejectedValue(new JournalEntryNotBalancedError(100, 80))

      const { status, body } = await categorize()

      expect(status).toBe(409)
      expect(body.error.code).toBe('TX_CATEGORIZE_JOURNAL_ENTRY_FAILED')
      expect(body.error.message).toContain('balanserar inte')
      expect(body.error.message).toMatch(/100/)
      expect(body.error.message).toMatch(/80/)
      expect(body.error.message).not.toContain('not balanced')
      expect(body.error.message).not.toContain('check constraint')
      expect(findCalls('transactions', 'update')).toEqual([])
    })

    it('maps untyped errors to the Swedish transaction fallback without leaking the raw text', async () => {
      enqueueUpToEngine()
      mockCreateTransactionJournalEntry.mockRejectedValue(new Error('boom'))

      const { status, body } = await categorize()

      expect(status).toBe(409)
      expect(body.error.code).toBe('TX_CATEGORIZE_JOURNAL_ENTRY_FAILED')
      expect(body.error.message).toBe('Kunde inte hantera transaktionen. Försök igen.')
      expect(body.error.message).not.toContain('boom')
      expect(findCalls('transactions', 'update')).toEqual([])
    })

    it('returns NO_OPEN_PERIOD_FOR_DATE when the engine finds no covering period (null entry)', async () => {
      enqueueUpToEngine()
      mockCreateTransactionJournalEntry.mockResolvedValue(null)
      mockCheckPeriodLock.mockResolvedValue({ locked: false, reason: 'no_fiscal_period' })

      const { status, body } = await categorize()

      expect(status).toBe(400)
      expect(body.error.code).toBe('NO_OPEN_PERIOD_FOR_DATE')
      expect(body.error.details?.reason).toBe('no_fiscal_period')
      // Refused before the CAS write: no update, no orphan, so no storno.
      expect(findCalls('transactions', 'update')).toEqual([])
      expect(mockSaveUserMappingRule).not.toHaveBeenCalled()
      expect(mockReverseOrphanedJournalEntry).not.toHaveBeenCalled()
    })

    it('returns PERIOD_LOCKED (reason period_is_closed) when the covering year is closed', async () => {
      // findFiscalPeriod filters is_closed = false, so a klarmarkerad year
      // also surfaces as the engine's null return. The route must not claim
      // the räkenskapsår does not exist when it exists and is closed.
      enqueueUpToEngine()
      mockCreateTransactionJournalEntry.mockResolvedValue(null)
      mockCheckPeriodLock.mockResolvedValue({
        locked: true,
        reason: 'period_is_closed',
        fiscal_period_id: 'fp-2024',
      })

      const { status, body } = await categorize()

      expect(status).toBe(400)
      expect(body.error.code).toBe('PERIOD_LOCKED')
      expect(body.error.details?.reason).toBe('period_is_closed')
      expect(body.error.details?.fiscal_period_id).toBe('fp-2024')
      expect(findCalls('transactions', 'update')).toEqual([])
      expect(mockSaveUserMappingRule).not.toHaveBeenCalled()
      expect(mockReverseOrphanedJournalEntry).not.toHaveBeenCalled()
    })
  })

  it('returns 500 when transaction update fails', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: null,
      merchant_name: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: [{ id: 'period-1' }], error: null })

    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })

    // Transaction update fails
    enqueue({ data: null, error: { message: 'Update failed' } })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(500)
    expect((body.error as unknown as { code: string }).code).toBe('INTERNAL_ERROR')
    expect(mockReverseOrphanedJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-1',
      expect.any(String),
    )
  })

  it('maps an ignored-row constraint to a typed conflict and stornos the posted orphan', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: null,
      merchant_name: null,
      is_ignored: true,
    })
    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({
      data: null,
      error: {
        code: '23514',
        message:
          'new row for relation "transactions" violates check constraint "transactions_is_ignored_no_journal_entry"',
      },
    })

    const response = await POST(
      createMockRequest('/api/transactions/tx-1/categorize', {
        method: 'POST',
        body: { is_business: false },
      }),
      createMockRouteParams({ id: 'tx-1' }),
    )
    const { status, body } = await parseJsonResponse<{ error: { code: string; message: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_IGNORED_CONFLICT')
    expect(body.error.message).not.toContain('check constraint')
    expect(mockReverseOrphanedJournalEntry).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-1',
      expect.any(String),
    )
  })

  it('returns 400 when mapping result has empty debit_account', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '',
    })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: string }>(response)

    expect(status).toBe(400)
    expect((body.error as unknown as { code: string }).code).toBe('TX_CATEGORIZE_INVALID_MAPPING')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 409 TX_CATEGORIZE_SUGGEST_SI_MATCH when 2440 mapping matches an open supplier invoice', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -10000,
      merchant_name: 'Leverantör AB',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '2440',
    })

    // Prong B: supplier lookup
    enqueue({ data: [{ id: 'sup-1' }], error: null })
    // Open supplier invoices candidate query
    enqueue({
      data: [
        {
          id: 'si-1',
          supplier_invoice_number: 'INV-2026-0042',
          invoice_date: '2026-05-01',
          remaining_amount: 10000,
          currency: 'SEK',
          supplier: { name: 'Leverantör AB' },
        },
      ],
      error: null,
    })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string; details: { candidates: unknown[] } } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_SUGGEST_SI_MATCH')
    expect(body.error.details.candidates).toHaveLength(1)
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('proceeds with 2440 categorization when confirm_no_match=true', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -10000,
      merchant_name: 'Leverantör AB',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '2440',
    })

    // No supplier/invoice lookups happen because confirm_no_match=true skips the block
    // ensureFiscalPeriod
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    // Transaction update
    enqueue({ data: [{ id: 'tx-1' }], error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software', confirm_no_match: true },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_created: boolean
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_created).toBe(true)
    expect(body.journal_entry_id).toBe('je-1')
  })

  it('does not trigger SI suggestion when 2440 has no matching open supplier invoice', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -10000,
      merchant_name: 'Leverantör AB',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '2440',
    })

    // Supplier lookup returns a supplier
    enqueue({ data: [{ id: 'sup-1' }], error: null })
    // No open invoices in the amount window
    enqueue({ data: [], error: null })
    // ensureFiscalPeriod
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    // Transaction update
    enqueue({ data: [{ id: 'tx-1' }], error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; journal_entry_created: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_created).toBe(true)
  })

  // ── Suggestion-guard currency. `transactions.amount` is denominated in
  // `transactions.currency`; `remaining_amount` is denominated in the invoice's
  // currency. A plus-minus 2 % band around a EUR bank row applied to a kronor
  // `remaining_amount` column is off by the whole exchange rate.
  const eurExpenseTx = (over: Record<string, unknown> = {}) =>
    makeTransaction({
      id: 'tx-1',
      amount: -1000,
      currency: 'EUR',
      amount_sek: null,
      exchange_rate: 11.5,
      merchant_name: 'Leverantör AB',
      journal_entry_id: null,
      ...over,
    })

  const sekSupplierInvoice = (remaining: number) => ({
    id: 'si-1',
    supplier_invoice_number: 'INV-2026-0042',
    invoice_date: '2026-05-01',
    remaining_amount: remaining,
    total: remaining,
    currency: 'SEK',
    total_sek: remaining,
    exchange_rate: null,
    supplier: { name: 'Leverantör AB' },
  })

  it('EUR transaction: a 1 000 SEK supplier invoice is not suggested for a 1 000 EUR payment', async () => {
    enqueue({ data: eurExpenseTx(), error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '2440',
    })

    enqueue({ data: [{ id: 'sup-1' }], error: null })
    // First sweep returns the same-magnitude kronor invoice the old EUR band
    // selected; the shared-unit re-check must drop it.
    enqueue({ data: [sekSupplierInvoice(1000)], error: null })
    enqueue({ data: [], error: null })
    // ensureFiscalPeriod + transaction update
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: [{ id: 'tx-1' }], error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_created: boolean
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_created).toBe(true)
  })

  it('EUR transaction with a rate: the 11 500 SEK supplier invoice IS suggested', async () => {
    enqueue({ data: eurExpenseTx(), error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '2440',
    })

    enqueue({ data: [{ id: 'sup-1' }], error: null })
    // EUR sweep finds nothing; the kronor sweep finds the invoice at the
    // converted magnitude.
    enqueue({ data: [], error: null })
    enqueue({ data: [sekSupplierInvoice(11500)], error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidates: Array<{ supplier_invoice_id: string }> } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_SUGGEST_SI_MATCH')
    expect(body.error.details.candidates.map((c) => c.supplier_invoice_id)).toEqual(['si-1'])
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('EUR transaction without a rate: kronor invoices are excluded, never compared raw', async () => {
    enqueue({ data: eurExpenseTx({ exchange_rate: null }), error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '2440',
    })

    enqueue({ data: [{ id: 'sup-1' }], error: null })
    // Only the EUR sweep is planned; the kronor invoice it returns here has no
    // shared unit with the bank row and must be dropped.
    enqueue({ data: [sekSupplierInvoice(1000)], error: null })
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: [{ id: 'tx-1' }], error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })

  it('EUR transaction: a 1 000 EUR supplier invoice still matches in its own currency', async () => {
    enqueue({ data: eurExpenseTx(), error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '2440',
    })

    enqueue({ data: [{ id: 'sup-1' }], error: null })
    enqueue({
      data: [
        {
          ...sekSupplierInvoice(1000),
          currency: 'EUR',
          total_sek: 11500,
          exchange_rate: 11.5,
        },
      ],
      error: null,
    })
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ error: { code: string } }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_SUGGEST_SI_MATCH')
  })

  it('EUR inbound transaction: a 1 000 SEK customer invoice is not suggested', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: 1000,
      currency: 'EUR',
      amount_sek: null,
      exchange_rate: 11.5,
      description: 'Inbetalning Acme AB',
      merchant_name: 'Acme AB',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '1930',
      credit_account: '1510',
    })

    // Customer lookups (merchant_name, description)
    enqueue({ data: [{ id: 'cust-1' }], error: null })
    enqueue({ data: [{ id: 'cust-1' }], error: null })
    // EUR sweep returns the same-magnitude kronor invoice; kronor sweep empty.
    enqueue({
      data: [
        {
          id: 'inv-1',
          invoice_number: '2026-0042',
          invoice_date: '2026-05-01',
          due_date: '2026-05-31',
          remaining_amount: 1000,
          total: 1000,
          currency: 'SEK',
          total_sek: 1000,
          exchange_rate: null,
          customer: { name: 'Acme AB' },
        },
      ],
      error: null,
    })
    enqueue({ data: [], error: null })
    // ensureFiscalPeriod + transaction update
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    enqueue({ data: [{ id: 'tx-1' }], error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'income_services' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
  })

  it('EUR inbound transaction with a rate: the 11 500 SEK customer invoice IS suggested', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: 1000,
      currency: 'EUR',
      amount_sek: 11500,
      exchange_rate: null,
      description: 'Inbetalning Acme AB',
      merchant_name: 'Acme AB',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '1930',
      credit_account: '1510',
    })

    enqueue({ data: [{ id: 'cust-1' }], error: null })
    enqueue({ data: [{ id: 'cust-1' }], error: null })
    // EUR sweep empty; kronor sweep finds the invoice at the converted amount.
    enqueue({ data: [], error: null })
    enqueue({
      data: [
        {
          id: 'inv-1',
          invoice_number: '2026-0042',
          invoice_date: '2026-05-01',
          due_date: '2026-05-31',
          remaining_amount: 11500,
          total: 11500,
          currency: 'SEK',
          total_sek: 11500,
          exchange_rate: null,
          customer: { name: 'Acme AB' },
        },
      ],
      error: null,
    })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'income_services' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidates: Array<{ invoice_id: string }> } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_SUGGEST_CI_MATCH')
    expect(body.error.details.candidates.map((c) => c.invoice_id)).toEqual(['inv-1'])
  })

  it('returns 409 TX_CATEGORIZE_SUGGEST_CI_MATCH when 1930/1510 mapping matches an open customer invoice', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: 12500,
      description: 'Inbetalning Acme AB',
      merchant_name: 'Acme AB',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '1930',
      credit_account: '1510',
    })

    // Customer lookup pass 1 (merchant_name): one match
    enqueue({ data: [{ id: 'cust-1' }], error: null })
    // Customer lookup pass 2 (description)
    enqueue({ data: [{ id: 'cust-1' }], error: null })
    // Open invoices by customer
    enqueue({
      data: [
        {
          id: 'inv-1',
          invoice_number: '2026-0042',
          invoice_date: '2026-05-01',
          remaining_amount: 12500,
          total: 12500,
          currency: 'SEK',
          customer: { name: 'Acme AB' },
        },
      ],
      error: null,
    })
    // OCR pass: tx.reference is null so the route still runs the OCR query
    // with a no-op result. Provide an empty data set so the chain resolves.
    enqueue({ data: [], error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'income_services' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidates: Array<{ invoice_id: string; match_reason: string }> } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TX_CATEGORIZE_SUGGEST_CI_MATCH')
    expect(body.error.details.candidates).toHaveLength(1)
    expect(body.error.details.candidates[0].invoice_id).toBe('inv-1')
    expect(body.error.details.candidates[0].match_reason).toBe('name_amount_fuzzy')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('proceeds with 1930/1510 categorization when confirm_no_match=true (customer side)', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: 12500,
      description: 'Inbetalning Acme AB',
      merchant_name: 'Acme AB',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    mockBuildMappingResultFromCategory.mockReturnValue({
      ...defaultMappingResult,
      debit_account: '1930',
      credit_account: '1510',
    })

    // No customer/invoice lookups: confirm_no_match=true skips the block.
    // ensureFiscalPeriod
    enqueue({ data: [{ id: 'period-1' }], error: null })
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    // Transaction update
    enqueue({ data: [{ id: 'tx-1' }], error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'income_services', confirm_no_match: true },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_id: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_id).toBe('je-1')
  })

  it('warns (409) and books nothing when a booked sibling shares date+amount', async () => {
    const tx = makeTransaction({ id: 'tx-1', amount: -500, journal_entry_id: null })
    enqueue({ data: tx, error: null }) // fetch: guard runs right after, before any booking work

    mockDetectDup.mockResolvedValue({
      transaction_id: '660e8400-e29b-41d4-a716-446655440111',
      journal_entry_id: 'je-existing',
      voucher_label: 'A142',
      entry_date: '2025-01-15',
      description: 'redan bokförd',
      amount: -500,
    })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'income_services', confirm_no_match: true },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { candidate: { voucher_label: string } } }
    }>(response)

    expect(status).toBe(409)
    expect(body.error.code).toBe('TRANSACTION_BOOK_POSSIBLE_DUPLICATE')
    expect(body.error.details.candidate.voucher_label).toBe('A142')
    // The duplicate guard fires before any verifikat is created.
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
    // Blocking a duplicate is not a dismissal: nothing is logged.
    expect(mockAppendProcessingHistory).not.toHaveBeenCalled()
  })

  it('persists a behandlingshistorik event when force=true dismisses a duplicate', async () => {
    const SIBLING_UUID = '660e8400-e29b-41d4-a716-446655440111'
    const tx = makeTransaction({ id: 'tx-1', amount: -500, merchant_name: 'GitHub', journal_entry_id: null })

    enqueue({ data: tx, error: null }) // fetch
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null }) // settings
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: [{ id: 'period-1' }], error: null }) // ensureFiscalPeriod existing check
    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })
    mockSaveUserMappingRule.mockResolvedValue(undefined)
    enqueue({ data: [{ id: 'tx-1' }], error: null }) // tx update (CAS matched)

    mockDetectDup.mockResolvedValue({
      transaction_id: SIBLING_UUID,
      journal_entry_id: 'je-existing',
      voucher_label: 'A142',
      entry_date: '2025-01-15',
      description: null,
      amount: -500,
    })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: {
        is_business: true,
        category: 'expense_software',
        force: true,
        expected_duplicate_transaction_id: SIBLING_UUID,
      },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{ success: boolean; journal_entry_created: boolean }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_created).toBe(true)
    // The dismissal is recorded to behandlingshistorik (BFNAR 2013:2 kap 8).
    expect(mockAppendProcessingHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: 'BankTransactionDuplicateDismissed',
        aggregateType: 'BankTransaction',
        aggregateId: 'tx-1',
        actor: { type: 'user', id: 'user-1' },
        payload: expect.objectContaining({ dismissed_transaction_id: SIBLING_UUID }),
      }),
    )
  })

  it('categorizes as private when is_business is false', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: null,
      merchant_name: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    enqueue({ data: [{ id: 'period-1' }], error: null })

    mockCreateTransactionJournalEntry.mockResolvedValue({ id: 'je-1' })

    // Update transaction (CAS guard: returns matched row)
    enqueue({ data: [{ id: 'tx-1' }], error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: false },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      category: string
    }>(response)

    expect(status).toBe(200)
    expect(body.category).toBe('private')
    // Should NOT save mapping rule for private transactions
    expect(mockSaveUserMappingRule).not.toHaveBeenCalled()
  })

  it('returns 400 ACCOUNTS_NOT_IN_CHART when the mapped debit account is not active in the chart', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'GitHub',
      journal_entry_id: null,
    })

    // Fetch transaction
    enqueue({ data: tx, error: null })
    // Fetch company settings
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    // Mapping built from category, but the debit account is missing/inactive
    // in this company's kontoplan. findMissingActiveAccounts is mocked at the
    // module level; flag the debit account here to simulate the same outcome
    // the engine would otherwise hit at AccountsNotInChartError.
    mockFindMissingActiveAccounts.mockResolvedValueOnce(['6200'])

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; account_numbers: string[]; message: string }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(body.error.account_numbers).toEqual(['6200'])
    expect(body.error.message).toMatch(/Följande konton behöver aktiveras/)
    // Engine must NOT be called once validation flagged a missing account.
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
    // No save of mapping rule either: the categorization didn't go through.
    expect(mockSaveUserMappingRule).not.toHaveBeenCalled()
  })

  it('returns 400 ACCOUNTS_NOT_IN_CHART listing every missing/inactive account', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -1000,
      merchant_name: 'Acme',
      journal_entry_id: null,
    })
    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930

    // Multiple accounts missing: covers the common "imported a template with
    // accounts that this kontoplan never enabled" case.
    mockFindMissingActiveAccounts.mockResolvedValueOnce(['5410', '2641'])

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_office' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; account_numbers: string[]; message: string }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    // AccountsNotInChartError sorts + dedupes its input.
    expect(body.error.account_numbers).toEqual(['2641', '5410'])
    expect(body.error.message).toContain('2641')
    expect(body.error.message).toContain('5410')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })

  it('returns 400 ACCOUNTS_NOT_IN_CHART when the engine throws AccountsNotInChartError (defense in depth)', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'GitHub',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    // ensureFiscalPeriod existing-period check
    enqueue({ data: [{ id: 'period-1' }], error: null })

    // Pre-validation says everything is fine: simulates a race where an
    // account got deactivated between our chart_of_accounts read and the
    // engine's resolveAccountIds read. The engine throws and the route must
    // surface a structured 400 rather than the partial-success path that
    // would have marked the row bokförd with no verifikation.
    const { AccountsNotInChartError } = await import('@/lib/bookkeeping/errors')
    mockCreateTransactionJournalEntry.mockRejectedValue(
      new AccountsNotInChartError(['6200']),
    )

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; account_numbers: string[] }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('ACCOUNTS_NOT_IN_CHART')
    expect(body.error.account_numbers).toEqual(['6200'])
    // Transaction update must NOT have run: if it had, the test would have
    // had to enqueue a response for it. The absence of an enqueue here plus
    // the 400 status is the assertion that the route did not fall through.
  })

  // The transactions page surfaces TX_CATEGORIZE_INVALID_ACCOUNT with an
  // inline "Aktivera och bokför" toast and reads details.accountNumber to
  // call POST /accounts/activate. This test pins the error shape that flow
  // depends on: if the field name changes the recovery UI silently breaks.
  it('returns 400 TX_CATEGORIZE_INVALID_ACCOUNT with details.accountNumber when account_override is not in the chart', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -869.25,
      merchant_name: 'Paddle',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [], error: null }) // resolveSettlementAccount: no enabled cash accounts -> 1930
    // chart_of_accounts lookup for '5420': not in the company's chart.
    // Using a plain expense account (Programvaror) avoids the implication
    // that 4535 (Inköp av varor från annat EU-land, reverse-charge) would
    // be a valid override on a domestic transaction without its paired
    // moms legs (2614/2645): see the Swedish compliance review note.
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software', account_override: '5420' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      error: { code: string; details: { accountNumber?: string } }
    }>(response)

    expect(status).toBe(400)
    expect(body.error.code).toBe('TX_CATEGORIZE_INVALID_ACCOUNT')
    expect(body.error.details.accountNumber).toBe('5420')
    expect(mockCreateTransactionJournalEntry).not.toHaveBeenCalled()
  })
})
