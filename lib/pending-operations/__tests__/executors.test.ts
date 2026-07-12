/**
 * Unit tests for the executors added to bring every declared op type up to a
 * callable state through `commitPendingOperation`. Tests run through the
 * public dispatcher (executors are not exported individually) so the wiring
 * is exercised alongside executor logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase, makeInvoice, makeFiscalPeriod } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

vi.mock('@/lib/core/bookkeeping/period-service', async () => {
  const actual = await vi.importActual<typeof import('@/lib/core/bookkeeping/period-service')>(
    '@/lib/core/bookkeeping/period-service'
  )
  return {
    ...actual,
    unlockPeriod: vi.fn(),
  }
})

vi.mock('@/lib/import/sie-parser', () => ({
  parseSIEFile: vi.fn(),
  calculateFileHash: vi.fn(async () => 'mock-hash'),
}))

vi.mock('@/lib/import/sie-import', () => ({
  executeSIEImport: vi.fn(),
}))

vi.mock('@/lib/bokslut/assets/depreciation-engine', () => ({
  commitAnnualPostings: vi.fn(),
}))

vi.mock('@/lib/bookkeeping/invoice-entries', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/bookkeeping/invoice-entries')>(
      '@/lib/bookkeeping/invoice-entries'
    )
  return {
    ...actual,
    createCreditNoteJournalEntry: vi.fn(),
  }
})

vi.mock('@/lib/transactions/categorize-core', async () => {
  const actual =
    await vi.importActual<typeof import('@/lib/transactions/categorize-core')>(
      '@/lib/transactions/categorize-core'
    )
  return {
    ...actual,
    categorizeMatchedTransaction: vi.fn(),
  }
})

import { commitPendingOperation } from '../commit'
import { unlockPeriod } from '@/lib/core/bookkeeping/period-service'
import { parseSIEFile } from '@/lib/import/sie-parser'
import { executeSIEImport } from '@/lib/import/sie-import'
import { commitAnnualPostings } from '@/lib/bokslut/assets/depreciation-engine'
import { createCreditNoteJournalEntry } from '@/lib/bookkeeping/invoice-entries'
import { categorizeMatchedTransaction } from '@/lib/transactions/categorize-core'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_customer',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'high',
    created_at: '2026-05-03T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-05-03T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

// ─── unlock_period ──────────────────────────────────────────────────

describe('commitPendingOperation: unlock_period', () => {
  it('happy path: clears locked_at and returns committed', async () => {
    const period = makeFiscalPeriod({ id: 'fp-1', locked_at: null })
    vi.mocked(unlockPeriod).mockResolvedValueOnce(period)

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's pending_operations update

    const op = makePendingOp({
      operation_type: 'unlock_period',
      params: { fiscal_period_id: 'fp-1' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ period_id: 'fp-1', locked_at: null })
    expect(unlockPeriod).toHaveBeenCalledWith(expect.anything(), 'company-1', 'user-1', 'fp-1')
  })

  it('rejects when fiscal_period_id is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update
    const op = makePendingOp({ operation_type: 'unlock_period', params: {} })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(unlockPeriod).not.toHaveBeenCalled()
  })

  it('surfaces underlying service errors', async () => {
    vi.mocked(unlockPeriod).mockRejectedValueOnce(new Error('Period is not locked'))

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update on throw
    const op = makePendingOp({
      operation_type: 'unlock_period',
      params: { fiscal_period_id: 'fp-1' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/not locked/)
  })
})

// ─── post_annual_depreciation ───────────────────────────────────────

describe('commitPendingOperation: post_annual_depreciation', () => {
  it('happy path: routes to commitAnnualPostings and returns the posted entries', async () => {
    vi.mocked(commitAnnualPostings).mockResolvedValueOnce({
      posted: [
        { assetId: 'asset-1', entry: { id: 'je-1', voucher_number: 7 } as never, scheduleId: 'sch-1' },
      ],
      skipped: [],
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher update

    const op = makePendingOp({
      operation_type: 'post_annual_depreciation',
      params: { fiscal_period_id: 'fp-1', asset_ids: ['asset-1'] },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      posted_count: 1,
      skipped_count: 0,
      posted: [{ asset_id: 'asset-1', journal_entry_id: 'je-1', voucher_number: 7, schedule_id: 'sch-1' }],
    })
    expect(commitAnnualPostings).toHaveBeenCalledWith(
      expect.anything(), 'company-1', 'user-1', 'fp-1', { assetIds: ['asset-1'] }
    )
  })

  it('rejects with 400 when fiscal_period_id is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // reject update
    const op = makePendingOp({ operation_type: 'post_annual_depreciation', params: {} })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(commitAnnualPostings).not.toHaveBeenCalled()
  })

  it('surfaces engine errors (e.g. locked period) as a failed commit', async () => {
    vi.mocked(commitAnnualPostings).mockRejectedValueOnce(new Error('Period is locked or closed'))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // reject update
    const op = makePendingOp({
      operation_type: 'post_annual_depreciation',
      params: { fiscal_period_id: 'fp-1' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/locked or closed/)
  })
})

// ─── create_transaction ─────────────────────────────────────────────

describe('commitPendingOperation: create_transaction', () => {
  it('happy path: inserts a transactions row with import_source=mcp and returns the id', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: 'tx-42' }, error: null }) // executor insert
    enqueue({ data: null, error: null }) // dispatcher's update

    const op = makePendingOp({
      operation_type: 'create_transaction',
      params: {
        date: '2026-05-01',
        amount: -129.5,
        description: 'AWS subscription',
        currency: 'USD',
        external_id: 'recAirtable123',
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ transaction_id: 'tx-42' })
  })

  it('rejects with 400 when required fields are missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'create_transaction',
      params: { date: '2026-05-01' }, // missing amount + description
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
  })

  it('returns 409 when external_id collides with an existing row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key' } as never }) // executor insert
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'create_transaction',
      params: {
        date: '2026-05-01',
        amount: 100,
        description: 'test',
        external_id: 'recAirtable123',
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    // 409 collisions are treated as auto-rejected by the dispatcher.
    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(409)
    expect(result.error).toMatch(/already exists/)
  })
})

// ─── import_sie ─────────────────────────────────────────────────────

describe('commitPendingOperation: import_sie', () => {
  it('happy path: parses, imports, returns committed with summary', async () => {
    vi.mocked(parseSIEFile).mockReturnValueOnce({} as never)
    vi.mocked(executeSIEImport).mockResolvedValueOnce({
      success: true,
      importId: 'imp-1',
      fiscalPeriodId: 'fp-1',
      openingBalanceEntryId: 'ob-1',
      journalEntriesCreated: 5,
      journalEntryIds: ['je-1', 'je-2', 'je-3', 'je-4', 'je-5'],
      errors: [],
      warnings: ['minor warning'],
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's update

    const op = makePendingOp({
      operation_type: 'import_sie',
      params: {
        file_content: '#FLAGGA 0\n',
        filename: 'test.sie',
        mappings: [],
        create_fiscal_period: true,
        import_opening_balances: true,
        import_transactions: true,
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      import_id: 'imp-1',
      journal_entries_created: 5,
      warnings: ['minor warning'],
    })
    expect(parseSIEFile).toHaveBeenCalledWith('#FLAGGA 0\n')
    // Operations staged before update_account_names existed (params without
    // the key) must default to true: Boolean(undefined) would flip it off.
    expect(executeSIEImport).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.anything(),
      [],
      expect.objectContaining({ updateAccountNames: true })
    )
  })

  it('passes update_account_names: false through to executeSIEImport', async () => {
    vi.mocked(parseSIEFile).mockReturnValueOnce({} as never)
    vi.mocked(executeSIEImport).mockResolvedValueOnce({
      success: true,
      importId: 'imp-2',
      fiscalPeriodId: 'fp-1',
      openingBalanceEntryId: null,
      journalEntriesCreated: 1,
      journalEntryIds: ['je-1'],
      errors: [],
      warnings: [],
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's update

    const op = makePendingOp({
      operation_type: 'import_sie',
      params: {
        file_content: '#FLAGGA 0\n',
        filename: 'test.sie',
        mappings: [],
        create_fiscal_period: true,
        import_opening_balances: true,
        import_transactions: true,
        update_account_names: false,
      },
    })

    await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(executeSIEImport).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      expect.anything(),
      [],
      expect.objectContaining({ updateAccountNames: false })
    )
  })

  it('rejects when required params are missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update
    const op = makePendingOp({ operation_type: 'import_sie', params: { filename: 'x.sie' } })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(parseSIEFile).not.toHaveBeenCalled()
  })

  it('returns the executeSIEImport errors when success=false', async () => {
    vi.mocked(parseSIEFile).mockReturnValueOnce({} as never)
    vi.mocked(executeSIEImport).mockResolvedValueOnce({
      success: false,
      importId: null,
      fiscalPeriodId: null,
      openingBalanceEntryId: null,
      journalEntriesCreated: 0,
      journalEntryIds: [],
      errors: ['duplicate import'],
      warnings: [],
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update
    const op = makePendingOp({
      operation_type: 'import_sie',
      params: {
        file_content: '#FLAGGA 0\n',
        filename: 'test.sie',
        mappings: [],
        create_fiscal_period: true,
        import_opening_balances: false,
        import_transactions: true,
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/duplicate import/)
  })
})

// ─── credit_invoice ─────────────────────────────────────────────────

describe('commitPendingOperation: credit_invoice', () => {
  it('happy path (accrual): inserts negated credit note and books JE', async () => {
    const original = makeInvoice({
      id: 'inv-1',
      invoice_number: 'F-2024001',
      status: 'sent',
      document_type: 'invoice',
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
    })
    const originalWithItems = {
      ...original,
      items: [
        { sort_order: 0, description: 'Service', quantity: 1, unit: 'st', unit_price: 1000, line_total: 1000, vat_rate: 25, vat_amount: 250 },
      ],
    }

    const creditNoteRow = { ...original, id: 'cn-1', invoice_number: 'KR-F-2024001' }
    const completeCreditNote = { ...creditNoteRow, customer: { name: 'Acme AB' }, items: [] }

    const { supabase, enqueue } = createQueuedMockSupabase()
    // 0: CAS claim
    enqueue({ data: { id: 'op-1' }, error: null })
    // 1: fetch original with items
    enqueue({ data: originalWithItems, error: null })
    // 2: insert credit note
    enqueue({ data: creditNoteRow, error: null })
    // 3: insert items (await thenable)
    enqueue({ data: null, error: null })
    // 4: update original status='credited'
    enqueue({ data: null, error: null })
    // 5: re-fetch complete credit note with customer + items
    enqueue({ data: completeCreditNote, error: null })
    // 6: company_settings
    enqueue({ data: { entity_type: 'aktiebolag', accounting_method: 'accrual' }, error: null })
    // 7: update invoice with journal_entry_id
    enqueue({ data: null, error: null })
    // 8: dispatcher's pending_operations update
    enqueue({ data: null, error: null })

    vi.mocked(createCreditNoteJournalEntry).mockResolvedValueOnce({ id: 'je-1' } as never)

    const op = makePendingOp({
      operation_type: 'credit_invoice',
      params: { invoice_id: 'inv-1', reason: 'Wrong amount' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ credit_note_id: 'cn-1', journal_entry_id: 'je-1' })
    expect(createCreditNoteJournalEntry).toHaveBeenCalled()
  })

  it('skips JE on cash accounting', async () => {
    const original = makeInvoice({ id: 'inv-1', status: 'paid', document_type: 'invoice' })
    const originalWithItems = { ...original, items: [] }
    const creditNoteRow = { ...original, id: 'cn-2', invoice_number: 'KR-F-2024001' }
    const completeCreditNote = { ...creditNoteRow, customer: null, items: [] }

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: originalWithItems, error: null })
    enqueue({ data: creditNoteRow, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: null, error: null })
    enqueue({ data: completeCreditNote, error: null })
    enqueue({ data: { entity_type: 'enskild_firma', accounting_method: 'cash' }, error: null })
    // no JE update; go straight to dispatcher update
    enqueue({ data: null, error: null })

    const op = makePendingOp({
      operation_type: 'credit_invoice',
      params: { invoice_id: 'inv-1' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ credit_note_id: 'cn-2', journal_entry_id: null })
    expect(createCreditNoteJournalEntry).not.toHaveBeenCalled()
  })

  it('auto-rejects when invoice is already credited (409)', async () => {
    const original = makeInvoice({ id: 'inv-1', status: 'credited', document_type: 'invoice' })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { ...original, items: [] }, error: null })
    // dispatcher auto-reject path also does an update
    enqueue({ data: null, error: null })

    const op = makePendingOp({
      operation_type: 'credit_invoice',
      params: { invoice_id: 'inv-1' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(409)
  })

  it('rejects when invoice_id is missing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's reject update
    const op = makePendingOp({ operation_type: 'credit_invoice', params: {} })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
  })

  it('rejects invoices with status outside sent/paid/overdue', async () => {
    const original = makeInvoice({ id: 'inv-1', status: 'draft', document_type: 'invoice' })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { ...original, items: [] }, error: null })
    enqueue({ data: null, error: null }) // dispatcher's reject update

    const op = makePendingOp({
      operation_type: 'credit_invoice',
      params: { invoice_id: 'inv-1' },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
  })
})

// ─── attach_document_to_transaction ─────────────────────────────────

describe('commitPendingOperation: attach_document_to_transaction', () => {
  const baseOp: Partial<PendingOperation> = {
    operation_type: 'attach_document_to_transaction',
    params: { transaction_id: 'tx-1', document_id: 'doc-1' },
  }

  it('auto-rejects 404 when transaction is not in the company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // tx fetch: not found
    enqueue({ data: null, error: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(404)
  })

  it('auto-rejects 409 when existing pinned doc is räkenskapsinformation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: 'tx-1', document_id: 'doc-old', journal_entry_id: null }, error: null })
    enqueue({ data: { journal_entry_id: 'je-99' }, error: null }) // existing doc fetch: locked
    enqueue({ data: null, error: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })

  it('translates BFL_DOCUMENT_IMMUTABILITY trigger error into auto-reject 409', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: null }, error: null })
    enqueue({ data: { id: 'doc-1' }, error: null }) // doc fetch
    enqueue({
      data: null,
      error: {
        code: 'P0001',
        message: 'BFL_DOCUMENT_IMMUTABILITY: cannot detach or swap document …',
      },
    })
    enqueue({ data: null, error: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })

  it('happy path uncategorized: attaches without propagation', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: null }, error: null })
    enqueue({ data: { id: 'doc-1' }, error: null }) // doc fetch
    enqueue({ data: { journal_entry_id: null }, error: null }) // UPDATE returning
    enqueue({ data: null, error: null }) // invoice_inbox_items best-effort link
    enqueue({ data: null, error: null }) // dispatcher commit update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('committed')
  })

  it('propagates to journal entry when tx was categorized between staging and commit', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: null }, error: null })
    enqueue({ data: { id: 'doc-1' }, error: null }) // doc fetch
    enqueue({ data: { journal_entry_id: 'je-7' }, error: null }) // UPDATE returning post-state
    enqueue({ data: null, error: null }) // invoice_inbox_items best-effort link
    enqueue({ data: null, error: null }) // doc propagation update
    enqueue({ data: null, error: null }) // dispatcher commit update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('committed')
  })

  it('still commits when the inbox-link best-effort update errors', async () => {
    // Inbox sync is best-effort: a failure to mark the inbox row as matched
    // must not roll back the (compliant) doc→tx attach. Mirrors the REST
    // route's swallow-and-log behaviour. The Supabase client resolves with
    // { error } rather than rejecting, so we both confirm the op commits AND
    // that the error was actually inspected and logged (not silently dropped).
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: null }, error: null })
    enqueue({ data: { id: 'doc-1' }, error: null }) // doc fetch
    enqueue({ data: { journal_entry_id: null }, error: null }) // tx UPDATE returning
    enqueue({ data: null, error: { message: 'inbox row missing or RLS-blocked' } }) // inbox link: errors
    enqueue({ data: null, error: null }) // dispatcher commit update

    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('committed')
    expect(spy).toHaveBeenCalledWith(
      '[commitAttach] Failed to link inbox item:',
      expect.objectContaining({ message: 'inbox row missing or RLS-blocked' }),
    )
    spy.mockRestore()
  })

  it('touches the invoice_inbox_items table to sync matched_transaction_id', async () => {
    // Argument-level check that the executor actually reaches into
    // invoice_inbox_items to keep the inbox UI in sync with the staged-write
    // path. Otherwise the inbox row stays in "Behöver åtgärd" forever.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: null }, error: null })
    enqueue({ data: { id: 'doc-1' }, error: null }) // doc fetch
    enqueue({ data: { journal_entry_id: null }, error: null }) // tx UPDATE returning
    enqueue({ data: null, error: null }) // invoice_inbox_items link
    enqueue({ data: null, error: null }) // dispatcher commit update

    await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    const tablesTouched = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(tablesTouched).toContain('invoice_inbox_items')
  })

  it('auto-rejects 409 when the document already belongs to a different verifikation', async () => {
    // Without this guard the attach would pin a consumed doc (undetachable
    // per the transactions immutability trigger) and the later propagation
    // would corrupt or be blocked by the doc-metadata immutability trigger.
    // Mirrors the REST route's guard.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: 'je-1' }, error: null })
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-OTHER' }, error: null }) // doc fetch
    enqueue({ data: null, error: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })

  it('skips the propagation write on an idempotent re-attach (doc already on the same verifikation)', async () => {
    // The period-lock trigger raises on ANY journal_entry_id write: even a
    // same-value rewrite: so an unconditional re-run would fail an otherwise
    // idempotent re-attach once the period locks.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: 'tx-1', document_id: 'doc-1', journal_entry_id: 'je-1' }, error: null })
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-1' }, error: null }) // doc fetch: same JE
    enqueue({ data: { journal_entry_id: 'je-1' }, error: null }) // tx UPDATE returning
    enqueue({ data: null, error: null }) // invoice_inbox_items link
    enqueue({ data: null, error: null }) // dispatcher commit update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('committed')
    // document_attachments touched once (the doc fetch): no propagation write.
    const tablesTouched = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map(c => c[0])
    expect(tablesTouched.filter((t) => t === 'document_attachments')).toHaveLength(1)
  })

  it('maps a period-lock propagation failure to auto-reject 409', async () => {
    // A retry could never succeed until the period is unlocked, so the
    // generic 500 "försök igen" would be a false promise. Mirrors the REST
    // route's mapping.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: { id: 'tx-1', document_id: null, journal_entry_id: null }, error: null })
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null }) // doc fetch
    enqueue({ data: { journal_entry_id: 'je-7' }, error: null }) // tx UPDATE returning: booked meanwhile
    enqueue({ data: null, error: null }) // invoice_inbox_items link
    enqueue({
      data: null,
      error: { message: 'cannot link document in a locked/closed fiscal period' },
    }) // propagation blocked by enforce_period_lock
    enqueue({ data: null, error: null }) // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })
})

// ─── link_document_to_voucher ─────────────────────────────────

describe('commitPendingOperation: link_document_to_voucher', () => {
  const baseOp: Partial<PendingOperation> = {
    operation_type: 'link_document_to_voucher',
    params: { document_id: 'doc-1', journal_entry_id: 'je-1' },
  }

  it('auto-rejects 404 when document is not in the company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null })            // doc fetch: not found
    enqueue({ data: null, error: null })            // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(404)
  })

  it('auto-rejects 409 when doc is already linked to a different posted JE (WORM guard)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                              // CAS claim
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-OTHER' }, error: null }) // doc fetch
    enqueue({ data: { status: 'posted' }, error: null })                        // WORM: existing JE status
    enqueue({ data: null, error: null })                                         // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })

  it('allows re-linking when existing linked JE is not yet posted (draft)', async () => {
    // A doc linked to a draft (uncommitted) JE can be moved: only posted
    // verifikationer trigger the WORM guard.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                              // CAS claim
    enqueue({ data: { id: 'doc-1', journal_entry_id: 'je-DRAFT' }, error: null }) // doc fetch
    enqueue({ data: { status: 'draft' }, error: null })                         // WORM: existing JE: not posted
    enqueue({ data: { id: 'je-1' }, error: null })                              // linkToJournalEntry: JE ownership
    enqueue({
      data: { id: 'doc-1', file_name: 'kvitto.pdf', journal_entry_id: 'je-1', journal_entry_line_id: null },
      error: null,
    })                                                                           // linkToJournalEntry: doc update
    enqueue({ data: null, error: null })                                         // dispatcher commit update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('committed')
  })

  it('happy path: links doc to verifikation with no prior journal_entry_id', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                              // CAS claim
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null })     // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // linkToJournalEntry: JE ownership
    enqueue({
      data: { id: 'doc-1', file_name: 'faktura.pdf', journal_entry_id: 'je-1', journal_entry_line_id: null },
      error: null,
    })                                                                           // linkToJournalEntry: doc update
    enqueue({ data: null, error: null })                                         // dispatcher commit update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      document_id: 'doc-1',
      journal_entry_id: 'je-1',
    })
  })

  it('auto-rejects 409 when linkToJournalEntry throws a period-lock error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null })                              // CAS claim
    enqueue({ data: { id: 'doc-1', journal_entry_id: null }, error: null })     // doc fetch
    enqueue({ data: { id: 'je-1' }, error: null })                              // linkToJournalEntry: JE ownership
    enqueue({
      data: null,
      error: { message: 'cannot link document in a locked/closed fiscal period' },
    })                                                                           // linkToJournalEntry: doc update: period locked
    enqueue({ data: null, error: null })                                         // dispatcher reject update

    const result = await commitPendingOperation(
      supabase as never, 'user-1', 'company-1', makePendingOp(baseOp),
    )
    expect(result.status).toBe('rejected')
    expect(result.http_status).toBe(409)
  })
})

// ─── categorize_transaction: dimensions propagation (PR7) ──────────

describe('commitPendingOperation: categorize_transaction: dimensions propagation (PR7)', () => {
  it('threads the staged dimensions bag into categorizeMatchedTransaction opts', async () => {
    vi.mocked(categorizeMatchedTransaction).mockResolvedValueOnce({
      data: { journal_entry_id: 'je-1' },
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: {
        transaction_id: 'tx-1',
        category: 'office_supplies',
        dimensions: { '1': 'KS01', '6': 'P001' },
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(categorizeMatchedTransaction).toHaveBeenCalledTimes(1)
    const call = vi.mocked(categorizeMatchedTransaction).mock.calls[0]
    expect(call[1]).toBe('user-1')
    expect(call[2]).toBe('company-1')
    expect(call[3]).toBe('tx-1')
    expect(call[4].dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
  })

  it('coerces an INVALID staged bag to undefined (drift/tamper gate)', async () => {
    vi.mocked(categorizeMatchedTransaction).mockResolvedValueOnce({
      data: { journal_entry_id: 'je-1' },
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: {
        transaction_id: 'tx-1',
        category: 'office_supplies',
        // '0' is not a valid SIE dimension number: the whole bag is rejected
        // and booking proceeds without dimensions.
        dimensions: { '0': 'X' },
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    const opts = vi.mocked(categorizeMatchedTransaction).mock.calls[0][4]
    expect(opts.dimensions).toBeUndefined()
  })

  it('passes no dimensions when nothing was staged', async () => {
    vi.mocked(categorizeMatchedTransaction).mockResolvedValueOnce({
      data: { journal_entry_id: 'je-1' },
    })

    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-1' }, error: null }) // CAS claim
    enqueue({ data: null, error: null }) // dispatcher's commit update

    const op = makePendingOp({
      operation_type: 'categorize_transaction',
      params: { transaction_id: 'tx-1', category: 'office_supplies' },
    })

    await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    const opts = vi.mocked(categorizeMatchedTransaction).mock.calls[0][4]
    expect(opts.dimensions).toBeUndefined()
  })
})
