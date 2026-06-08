import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  createMockRequest,
  parseJsonResponse,
  createMockRouteParams,
  createQueuedMockSupabase,
  makeTransaction,
} from '@/tests/helpers'
import { eventBus } from '@/lib/events'

const { supabase: mockSupabase, enqueue, reset } = createQueuedMockSupabase()
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

const mockFindMissingActiveAccounts = vi.fn()
vi.mock('@/lib/bookkeeping/account-validation', async () => {
  const actual = await vi.importActual<typeof import('@/lib/bookkeeping/account-validation')>(
    '@/lib/bookkeeping/account-validation',
  )
  return {
    ...actual,
    findMissingActiveAccounts: (...args: unknown[]) => mockFindMissingActiveAccounts(...args),
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
    enqueue({ data: null, error: null })

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

  it('flags an inbox underlag matched to the transaction as booked', async () => {
    // A document was attached to this transaction in the inbox
    // (matched_transaction_id) but not booked from there. Booking the
    // transaction here — no inbox_item_id in the body — must still stamp the
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

  it('returns success with error when journal entry creation fails (non-blocking)', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      merchant_name: 'Test',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    enqueue({ data: [{ id: 'period-1' }], error: null })

    mockCreateTransactionJournalEntry.mockRejectedValue(new Error('Period locked'))

    // Update transaction
    enqueue({ data: null, error: null })

    const request = createMockRequest('/api/transactions/tx-1/categorize', {
      method: 'POST',
      body: { is_business: true, category: 'expense_software' },
    })
    const response = await POST(request, createMockRouteParams({ id: 'tx-1' }))
    const { status, body } = await parseJsonResponse<{
      success: boolean
      journal_entry_created: boolean
      journal_entry_error: string
    }>(response)

    expect(status).toBe(200)
    expect(body.success).toBe(true)
    expect(body.journal_entry_created).toBe(false)
    expect(body.journal_entry_error).toBe('Period locked')
  })

  it('returns 500 when transaction update fails', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: null,
      merchant_name: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
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
  })

  it('returns 400 when mapping result has empty debit_account', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -500,
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })

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

  it('categorizes as private when is_business is false', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      journal_entry_id: null,
      merchant_name: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
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

    // Mapping built from category — but the debit account is missing/inactive
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
    // No save of mapping rule either — the categorization didn't go through.
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

    // Multiple accounts missing — covers the common "imported a template with
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
    // ensureFiscalPeriod existing-period check
    enqueue({ data: [{ id: 'period-1' }], error: null })

    // Pre-validation says everything is fine — simulates a race where an
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
    // Transaction update must NOT have run — if it had, the test would have
    // had to enqueue a response for it. The absence of an enqueue here plus
    // the 400 status is the assertion that the route did not fall through.
  })

  // The transactions page surfaces TX_CATEGORIZE_INVALID_ACCOUNT with an
  // inline "Aktivera och bokför" toast and reads details.accountNumber to
  // call POST /accounts/activate. This test pins the error shape that flow
  // depends on — if the field name changes the recovery UI silently breaks.
  it('returns 400 TX_CATEGORIZE_INVALID_ACCOUNT with details.accountNumber when account_override is not in the chart', async () => {
    const tx = makeTransaction({
      id: 'tx-1',
      amount: -869.25,
      merchant_name: 'Paddle',
      journal_entry_id: null,
    })

    enqueue({ data: tx, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    // chart_of_accounts lookup for '5420' — not in the company's chart.
    // Using a plain expense account (Programvaror) avoids the implication
    // that 4535 (Inköp av varor från annat EU-land, reverse-charge) would
    // be a valid override on a domestic transaction without its paired
    // moms legs (2614/2645) — see the Swedish compliance review note.
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
