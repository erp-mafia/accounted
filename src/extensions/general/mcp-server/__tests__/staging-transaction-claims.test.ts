/**
 * One bank row, one open proposal (crm#1264). An agent staged
 * gnubok_bulk_book_transactions with force=true, then staged the same rows
 * again without an idempotency_key before the first was approved, and the
 * queue held two approvable cards for each bank row. Staging now reads the
 * company's open operations first:
 *   - the same proposal again answers with the pending one;
 *   - the same key's newer proposal covering all of an older pending one's
 *     rows replaces it (rejected as superseded, through the reject path);
 *   - anything else (another key, rows the new one leaves out, an approval
 *     running now) is refused naming the operation.
 * force does not bypass any of it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, makeTransaction } from '@/tests/helpers'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { roundOre } from '@/lib/money'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { detectBookingDuplicate } from '@/lib/transactions/booking-duplicate-detection'
import { toToolError } from '../tool-result'

vi.mock('@/lib/transactions/booking-duplicate-detection', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/transactions/booking-duplicate-detection')>()
  return { ...actual, detectBookingDuplicate: vi.fn() }
})
vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: vi.fn() }))
// The categorize dry run's chart pre-validation and period-lock pre-check
// have their own tests; complete and open here.
vi.mock('@/lib/bookkeeping/account-validation', async (importActual) => ({
  ...(await importActual<typeof import('@/lib/bookkeeping/account-validation')>()),
  findUnresolvableAccounts: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/lib/api/v1/check-period-lock', () => ({
  checkPeriodLock: vi.fn().mockResolvedValue({ locked: false }),
}))

import { tools } from '../server'

const bulkBook = tools.find((t) => t.name === 'gnubok_bulk_book_transactions')!
const categorize = tools.find((t) => t.name === 'gnubok_categorize_transaction')!

const TX_1 = '11111111-1111-4111-8111-111111111111'
const TX_2 = '22222222-2222-4222-8222-222222222222'
const TX_3 = '55555555-5555-4555-8555-555555555555'
const JE_1 = '33333333-3333-4333-8333-333333333333'
const JE_2 = '44444444-4444-4444-8444-444444444444'

/** The agent's connection: an API key, as the ticket's ChatGPT connector. */
const AGENT = { type: 'api_key' as const, id: 'key-1', label: 'ChatGPT' }

const FEE_ROW = { id: TX_1, amount: -4.29, currency: 'SEK', description: 'Stripe fee', merchant_name: null, date: '2026-08-07', journal_entry_id: null }

/** A posted verifikat whose 1930 leg moves by the rows' sum: the bank net the link needs. */
function voucherLines(rows: Array<{ amount: number }>) {
  const sum = roundOre(rows.reduce((s, r) => s + r.amount, 0))
  return [
    { account_number: '1930', debit_amount: Math.max(sum, 0), credit_amount: Math.max(-sum, 0) },
    { account_number: '6570', debit_amount: Math.max(-sum, 0), credit_amount: Math.max(sum, 0) },
  ]
}

/** What the first staging stored: the params the generated tool stages for a link with force. */
const FIRST_PARAMS = { tx_ids: [TX_1], existing_journal_entry_id: JE_1, force: true }

function openOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'op-first',
    company_id: 'company-1',
    user_id: 'user-1',
    actor_type: 'api_key',
    actor_id: 'key-1',
    operation_type: 'bulk_book_transactions',
    status: 'pending',
    title: 'Länka 1 transaktioner -4,29 SEK 2026-08-07 till verifikat: Stripe fee',
    // Stored jsonb comes back with its own key order.
    params: { force: true, existing_journal_entry_id: JE_1, tx_ids: [TX_1] },
    preview_data: { tx_count: 1, tx_sum: -4.29, mode: 'link_existing' },
    risk_level: 'high',
    created_at: '2026-10-16T08:43:14.000Z',
    ...overrides,
  }
}

/**
 * A link staging of `rows`: the dry run's reads, the open-claims read
 * answering `open`, the insert, then (when it supersedes) the reject path's
 * read and compare-and-set.
 */
function stageLink(args: Record<string, unknown>, open: unknown[], rows: unknown[] = [FEE_ROW], actor: unknown = AGENT) {
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: rows, error: null }) // transactions fetch
  mock.enqueue({
    data: { id: JE_1, entry_date: '2026-08-31', status: 'posted', journal_entry_lines: voucherLines(rows as Array<{ amount: number }>) },
    error: null,
  }) // link target
  mock.enqueue({ data: [], error: null }) // the rows' ledger: no cash account, 1930
  mock.enqueue({ data: null, error: null }) // resolvePeriodStatusForDate: 2 layers
  mock.enqueue({ data: null, error: null })
  mock.enqueue({ data: open, error: null }) // open operations naming the rows
  mock.enqueue({ data: { id: 'op-second' }, error: null }) // pending_operations insert, when reached
  const run = () => bulkBook.execute(args, 'company-1', 'user-1', mock.supabase as never, actor as never)
  return { ...mock, run }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(detectBookingDuplicate).mockResolvedValue(null)
})

describe('gnubok_bulk_book_transactions: rows already in an open proposal', () => {
  it('answers a replay without idempotency_key with the operation already pending, and stages nothing', async () => {
    const s = stageLink({ ...FIRST_PARAMS }, [openOperation()])

    const result = (await s.run()) as Record<string, unknown>

    expect(result).toMatchObject({
      staged: true,
      idempotency_replay: true,
      operation_id: 'op-first',
      risk_level: 'high',
      approve: { tool: 'gnubok_approve_pending_operation', args: { operation_id: 'op-first', company_id: 'company-1' } },
    })
    expect(result.message).toContain('Already staged: pending_operation op-first')
    expect(result.preview).toMatchObject({ tx_count: 1, mode: 'link_existing' })
    expect(s.findCalls('pending_operations', 'insert')).toHaveLength(0)
    expect(s.findCalls('pending_operations', 'update')).toHaveLength(0)
  })

  it('reads only open operations of the booking types, in this company', async () => {
    const s = stageLink({ ...FIRST_PARAMS }, [])
    await s.run()

    const ins = s.findCalls('pending_operations', 'in')
    // Rejected (by a person or the 30-day expiry) and committed operations claim nothing.
    expect(ins).toContainEqual(['status', ['pending', 'committing']])
    expect(ins).toContainEqual(['operation_type', ['categorize_transaction', 'bulk_book_transactions']])
    expect(s.findCalls('pending_operations', 'eq')).toContainEqual(['company_id', 'company-1'])
    expect(s.findCalls('pending_operations', 'insert')).toHaveLength(1)
  })

  it("replaces the same key's earlier proposal for the rows (the ticket's replay with other text), force or not", async () => {
    // Not byte-identical (another link target, description or line text):
    // the agent's newer proposal for the same rows.
    const s = stageLink({ ...FIRST_PARAMS }, [openOperation({ params: { tx_ids: [TX_1], existing_journal_entry_id: JE_2, force: true } })])
    s.enqueue({ data: [{ id: 'op-first', status: 'pending', operation_type: 'bulk_book_transactions', risk_level: 'high' }], error: null }) // reject path: read
    s.enqueue({ data: [{ id: 'op-first' }], error: null }) // reject path: compare-and-set on pending

    const result = (await s.run()) as Record<string, unknown>

    expect(result).toMatchObject({ staged: true, operation_id: 'op-second', superseded_operation_ids: ['op-first'] })
    expect(result.message).toContain('replaces your earlier proposal(s) op-first')
    expect(s.findCalls('pending_operations', 'insert')).toHaveLength(1)
    expect(s.findCall('pending_operations', 'update')?.[0]).toMatchObject({
      status: 'rejected',
      rejection_category: 'superseded',
      rejection_reason: 'Ersatt av ett nyare förslag för samma banktransaktioner (op-second).',
      result_data: { rejected_by: 'user-1', rejected_via: 'api_key', actor_id: 'key-1' },
    })
    // The update is a compare-and-set: an approval that got there first wins.
    expect(s.findCalls('pending_operations', 'eq')).toContainEqual(['status', 'pending'])
    expect(appendProcessingHistory).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'PendingOperationRejected', aggregateId: 'op-first', payload: expect.objectContaining({ channel: 'mcp' }) }),
    )
  })

  it('stages but reports nothing superseded when the older proposal was approved in between', async () => {
    const s = stageLink({ ...FIRST_PARAMS }, [openOperation({ params: { tx_ids: [TX_1], existing_journal_entry_id: JE_2 } })])
    s.enqueue({ data: [{ id: 'op-first', status: 'committing', operation_type: 'bulk_book_transactions', risk_level: 'high' }], error: null })

    const result = (await s.run()) as Record<string, unknown>

    expect(result).toMatchObject({ staged: true, operation_id: 'op-second' })
    expect(result).not.toHaveProperty('superseded_operation_ids')
    expect(s.findCalls('pending_operations', 'update')).toHaveLength(0)
  })

  it("refuses another key's proposal for the rows, naming it, even with force=true", async () => {
    const s = stageLink({ ...FIRST_PARAMS }, [openOperation({ actor_id: 'key-2', params: { tx_ids: [TX_1], existing_journal_entry_id: JE_2 } })])

    const err = await s.run().catch((e: unknown) => e)

    expect(getStructuredError(err).code).toBe('TRANSACTION_ALREADY_STAGED')
    expect(getStructuredError(err).retryable).toBe(false)
    expect((err as Error).message).toContain('pending_operation op-first (bulk_book_transactions, pending')
    expect((err as Error).message).toContain(TX_1)
    expect((err as Error).message).toContain('force/allow_duplicate do not change that')
    // The envelope carries the operations to approve or reject first.
    expect(toToolError(err).error.details).toEqual({
      pending_operations: [
        {
          operation_id: 'op-first',
          operation_type: 'bulk_book_transactions',
          status: 'pending',
          created_at: '2026-10-16T08:43:14.000Z',
          transaction_ids: [TX_1],
        },
      ],
    })
    expect(s.findCalls('pending_operations', 'insert')).toHaveLength(0)
    expect(s.findCalls('pending_operations', 'update')).toHaveLength(0)
  })

  it('refuses when the older proposal holds rows the new one leaves out: superseding would drop their proposal', async () => {
    const s = stageLink({ ...FIRST_PARAMS }, [openOperation({ params: { tx_ids: [TX_1, TX_2], existing_journal_entry_id: JE_1 } })])

    const err = await s.run().catch((e: unknown) => e)

    expect(getStructuredError(err).code).toBe('TRANSACTION_ALREADY_STAGED')
    expect(s.findCalls('pending_operations', 'insert')).toHaveLength(0)
  })

  it('refuses rows a proposal being approved right now holds, even the same proposal', async () => {
    const s = stageLink({ ...FIRST_PARAMS }, [openOperation({ status: 'committing' })])

    const err = await s.run().catch((e: unknown) => e)

    expect(getStructuredError(err).code).toBe('TRANSACTION_ALREADY_STAGED')
    expect((err as Error).message).toContain('committing')
  })

  it("replaces the same key's pending categorize_transaction the batch now covers", async () => {
    const s = stageLink({ ...FIRST_PARAMS }, [
      openOperation({ id: 'op-cat', operation_type: 'categorize_transaction', params: { transaction_id: TX_1, category: 'expense_bank_fees' } }),
    ])
    s.enqueue({ data: [{ id: 'op-cat', status: 'pending', operation_type: 'categorize_transaction', risk_level: 'low' }], error: null })
    s.enqueue({ data: [{ id: 'op-cat' }], error: null })

    const result = (await s.run()) as Record<string, unknown>

    expect(result).toMatchObject({ staged: true, operation_id: 'op-second', superseded_operation_ids: ['op-cat'] })
  })

  it('dry run: reports what staging would supersede and changes nothing', async () => {
    const s = stageLink({ ...FIRST_PARAMS, dry_run: true }, [openOperation({ params: { tx_ids: [TX_1], existing_journal_entry_id: JE_2 } })])

    const result = (await s.run()) as Record<string, unknown>

    expect(result).toMatchObject({ staged: false, dry_run: true, would_supersede_operation_ids: ['op-first'] })
    expect(result.message).toContain('supersede your pending proposal(s) op-first')
    expect(s.findCalls('pending_operations', 'insert')).toHaveLength(0)
    expect(s.findCalls('pending_operations', 'update')).toHaveLength(0)
  })

  it("dry run: refuses rows another key's proposal holds, as the staging would", async () => {
    const s = stageLink({ ...FIRST_PARAMS, dry_run: true }, [openOperation({ actor_id: 'key-2', params: { tx_ids: [TX_1, TX_2], existing_journal_entry_id: JE_1 } })])

    const err = await s.run().catch((e: unknown) => e)

    expect(getStructuredError(err).code).toBe('TRANSACTION_ALREADY_STAGED')
  })

  it('stages a disjoint second batch next to the first', async () => {
    const other = { ...FEE_ROW, id: TX_3, date: '2026-08-08' }
    const s = stageLink({ tx_ids: [TX_3], existing_journal_entry_id: JE_1, force: true }, [openOperation()], [other])

    const result = (await s.run()) as Record<string, unknown>

    expect(result).toMatchObject({ staged: true, operation_id: 'op-second' })
    expect(result).not.toHaveProperty('idempotency_replay')
    expect(result).not.toHaveProperty('superseded_operation_ids')
    expect(s.findCalls('pending_operations', 'insert')).toHaveLength(1)
  })

  it('stages again once the first proposal is rejected or expired (no open operation names the rows)', async () => {
    const s = stageLink({ ...FIRST_PARAMS }, [])

    const result = (await s.run()) as Record<string, unknown>

    expect(result).toMatchObject({ staged: true, operation_id: 'op-second' })
    expect(s.findCalls('pending_operations', 'insert')).toHaveLength(1)
  })

  it('replays a keyed retry from the idempotency cache, never a second operation', async () => {
    const key = '0f2b6f5e-3f2a-4b9e-9c1d-6e9c2a1b7d55'
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [FEE_ROW], error: null }) // transactions fetch
    mock.enqueue({
      data: { id: JE_1, entry_date: '2026-08-31', status: 'posted', journal_entry_lines: voucherLines([FEE_ROW]) },
      error: null,
    }) // link target
    mock.enqueue({ data: [], error: null }) // the rows' ledger: no cash account, 1930
    mock.enqueue({ data: null, error: null }) // resolvePeriodStatusForDate: 2 layers
    mock.enqueue({ data: null, error: null })
    mock.enqueue({ data: [openOperation()], error: null }) // the first staging, still pending
    const { hashRequest } = await import('@/lib/api/idempotency')
    mock.enqueue({
      data: {
        request_hash: hashRequest({ operationType: 'bulk_book_transactions', params: FIRST_PARAMS, companyId: 'company-1' }),
        response_status: 'success',
        response_body: { staged: true, operation_id: 'op-first', preview: { tx_count: 1 } },
        expires_at: '2999-01-01T00:00:00Z',
      },
    }) // idempotency_keys lookup: hit

    const result = (await bulkBook.execute(
      { ...FIRST_PARAMS, idempotency_key: key },
      'company-1',
      'user-1',
      mock.supabase as never,
      AGENT as never,
    )) as Record<string, unknown>

    expect(result).toMatchObject({ staged: true, idempotency_replay: true, operation_id: 'op-first' })
    expect(mock.findCalls('pending_operations', 'insert')).toHaveLength(0)
  })
})

describe('gnubok_categorize_transaction: the row already in an open proposal', () => {
  const CATEGORIZE_PARAMS = {
    transaction_id: 'tx-1',
    category: 'expense_office',
    vat_treatment: null,
    vat_amount: null,
    account_override: null,
    notes: null,
    allow_duplicate: true,
  }

  function stageCategorize(open: unknown[]) {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: makeTransaction({ id: 'tx-1', amount: -500, cash_account_id: 'cash-1' }), error: null })
    mock.enqueue({ data: [], error: null }) // the gate: no posted verifikat booked from the row (#203)
    mock.enqueue({ data: { entity_type: 'enskild_firma', fiscal_year_start_month: 1 }, error: null })
    mock.enqueue({ data: { ledger_account: '1930', currency: 'SEK' }, error: null })
    mock.enqueue({ data: null, error: null }) // resolvePeriodStatusForDate: 2 layers
    mock.enqueue({ data: null, error: null })
    mock.enqueue({ data: open, error: null }) // open operations naming the row
    mock.enqueue({ data: { id: 'op-second' }, error: null }) // pending_operations insert, when reached
    const run = () =>
      categorize.execute(
        { transaction_id: 'tx-1', category: 'expense_office', allow_duplicate: true },
        'company-1',
        'user-1',
        mock.supabase as never,
        AGENT as never,
      )
    return { ...mock, run }
  }

  const pendingCategorize = (params: Record<string, unknown>, overrides: Record<string, unknown> = {}) =>
    openOperation({ id: 'op-cat-first', operation_type: 'categorize_transaction', params, risk_level: 'low', ...overrides })

  it('answers a blind retry with the operation already pending', async () => {
    const s = stageCategorize([pendingCategorize(CATEGORIZE_PARAMS)])

    const result = (await s.run()) as Record<string, unknown>

    expect(result).toMatchObject({ staged: true, idempotency_replay: true, operation_id: 'op-cat-first' })
    expect(s.findCalls('pending_operations', 'insert')).toHaveLength(0)
  })

  it("replaces the same key's earlier kontering for the row", async () => {
    const s = stageCategorize([pendingCategorize({ ...CATEGORIZE_PARAMS, category: 'expense_software' })])
    s.enqueue({ data: [{ id: 'op-cat-first', status: 'pending', operation_type: 'categorize_transaction', risk_level: 'low' }], error: null })
    s.enqueue({ data: [{ id: 'op-cat-first' }], error: null })

    const result = (await s.run()) as Record<string, unknown>

    expect(result).toMatchObject({ staged: true, operation_id: 'op-second', superseded_operation_ids: ['op-cat-first'] })
  })

  it("refuses another key's kontering for the row, allow_duplicate or not", async () => {
    const s = stageCategorize([pendingCategorize({ ...CATEGORIZE_PARAMS, category: 'expense_software' }, { actor_id: 'key-2' })])

    const err = await s.run().catch((e: unknown) => e)

    expect(getStructuredError(err).code).toBe('TRANSACTION_ALREADY_STAGED')
    expect((err as Error).message).toContain('pending_operation op-cat-first (categorize_transaction')
    expect(s.findCalls('pending_operations', 'insert')).toHaveLength(0)
  })

  it('stages when no open operation names the row', async () => {
    const s = stageCategorize([])

    const result = (await s.run()) as Record<string, unknown>

    expect(result).toMatchObject({ staged: true, operation_id: 'op-second' })
  })
})
