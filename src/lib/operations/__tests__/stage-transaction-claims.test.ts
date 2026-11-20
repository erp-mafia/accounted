/**
 * The v1 stage mode (`?stage=true` on POST /transactions/bulk-book) keeps one
 * open proposal per bank row like the MCP door (crm#1264): the same proposal
 * again answers with the pending operation, the same key's newer proposal
 * covering all of an older one's rows supersedes it, and anything else is
 * refused with TRANSACTION_ALREADY_STAGED, a dry run included.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { defineOperation, type OperationOutcome } from '../types'
import { stageOperation } from '../stage'

const TX_1 = '11111111-1111-4111-8111-111111111111'
const TX_2 = '22222222-2222-4222-8222-222222222222'

vi.mock('@/lib/processing-history/append', () => ({ appendProcessingHistory: vi.fn() }))

const run = vi.fn<(...args: unknown[]) => Promise<OperationOutcome<{ ok: boolean }>>>()

// A stand-in for transactions.bulk-book: the door is what is under test.
const bulkBook = defineOperation({
  id: 'test.bulk-book',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'high',
  reversible: false,
  docs: {
    summary: 'Test fixture.',
    description: 'Fixture operation for the claim check.',
    useWhen: 'never: test fixture',
    doNotUseFor: 'anything outside this test file',
    pitfalls: [],
    example: { response: {} },
  },
  input: z.object({ tx_ids: z.array(z.string()), entry_description: z.string() }),
  output: z.object({ ok: z.boolean() }),
  http: { method: 'POST', path: '/api/v1/companies/:companyId/test-bulk-book' },
  mcp: {
    name: 'gnubok_test_bulk_book',
    title: 'Test',
    stage: { pendingType: 'bulk_book_transactions', title: () => 'Samlingsverifikation' },
  },
  run: (...args) => run(...args),
})

const ACTOR = { type: 'api_key' as const, id: 'key-1', label: 'Agent' }
const INPUT = { tx_ids: [TX_1], entry_description: 'Avgifter' }

function pending(overrides: Record<string, unknown> = {}) {
  return {
    id: 'op-first',
    company_id: 'company-1',
    user_id: 'user-1',
    actor_type: 'api_key',
    actor_id: 'key-1',
    operation_type: 'bulk_book_transactions',
    status: 'pending',
    title: 'Samlingsverifikation',
    params: { entry_description: 'Avgifter', tx_ids: [TX_1] },
    preview_data: {},
    risk_level: 'high',
    created_at: '2026-10-16T08:00:00.000Z',
    ...overrides,
  }
}

function ctxWith(open: unknown[]) {
  const mock = createQueuedMockSupabase()
  mock.enqueue({ data: open, error: null }) // open operations naming the rows
  mock.enqueue({ data: { id: 'op-new', status: 'pending' }, error: null }) // pending_operations insert, when reached
  return { mock, ctx: { supabase: mock.supabase as never, companyId: 'company-1', userId: 'user-1', log: createLogger('test') } }
}

beforeEach(() => {
  vi.clearAllMocks()
  run.mockResolvedValue({ ok: true, dryRun: true, preview: {} })
})

describe('stageOperation: rows already in an open proposal', () => {
  it('answers the same proposal again with the pending operation and inserts nothing', async () => {
    const { mock, ctx } = ctxWith([pending()])

    const staged = await stageOperation(bulkBook, ctx, INPUT, ACTOR, { dryRun: false })

    expect(staged).toMatchObject({ ok: true, dryRun: false, row: { id: 'op-first' } })
    expect(mock.findCalls('pending_operations', 'insert')).toHaveLength(0)
  })

  it('refuses another key\'s proposal for the rows, naming the pending operation', async () => {
    const { mock, ctx } = ctxWith([pending({ actor_id: 'key-2', params: { tx_ids: [TX_1, TX_2], entry_description: 'Annat' } })])

    const staged = await stageOperation(bulkBook, ctx, INPUT, ACTOR, { dryRun: false })

    expect(staged).toEqual({
      ok: false,
      outcome: {
        ok: false,
        code: 'TRANSACTION_ALREADY_STAGED',
        details: {
          pending_operations: [
            {
              operation_id: 'op-first',
              operation_type: 'bulk_book_transactions',
              status: 'pending',
              created_at: '2026-10-16T08:00:00.000Z',
              transaction_ids: [TX_1],
            },
          ],
        },
      },
    })
    expect(mock.findCalls('pending_operations', 'insert')).toHaveLength(0)
  })

  it('refuses the same on a dry run', async () => {
    const { ctx } = ctxWith([pending({ actor_id: 'key-2', params: { tx_ids: [TX_1], entry_description: 'Annat' } })])

    const staged = await stageOperation(bulkBook, ctx, INPUT, ACTOR, { dryRun: true })

    expect(staged.ok).toBe(false)
  })

  it("supersedes the same key's older proposal the new one fully covers, through the reject path", async () => {
    const { mock, ctx } = ctxWith([pending({ params: { tx_ids: [TX_1], entry_description: 'Annat' } })])
    mock.enqueue({ data: [{ id: 'op-first', status: 'pending', operation_type: 'bulk_book_transactions', risk_level: 'high' }], error: null })
    mock.enqueue({ data: [{ id: 'op-first' }], error: null })

    const staged = await stageOperation(bulkBook, ctx, { tx_ids: [TX_1, TX_2], entry_description: 'Avgifter' }, ACTOR, { dryRun: false })

    expect(staged).toMatchObject({ ok: true, dryRun: false, row: { id: 'op-new' }, supersededOperationIds: ['op-first'] })
    expect(mock.findCall('pending_operations', 'update')?.[0]).toMatchObject({
      status: 'rejected',
      rejection_category: 'superseded',
      rejection_reason: 'Ersatt av ett nyare förslag för samma banktransaktioner (op-new).',
    })
    expect(appendProcessingHistory).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'PendingOperationRejected', payload: expect.objectContaining({ channel: 'api' }) }),
    )
  })

  it('reports on a dry run what staging would supersede, and writes nothing', async () => {
    const { mock, ctx } = ctxWith([pending({ params: { tx_ids: [TX_1], entry_description: 'Annat' } })])

    const staged = await stageOperation(bulkBook, ctx, INPUT, ACTOR, { dryRun: true })

    expect(staged).toMatchObject({ ok: true, dryRun: true, wouldSupersedeOperationIds: ['op-first'] })
    expect(mock.findCalls('pending_operations', 'insert')).toHaveLength(0)
    expect(mock.findCalls('pending_operations', 'update')).toHaveLength(0)
  })

  it('stages rows no open operation names', async () => {
    const { mock, ctx } = ctxWith([])

    const staged = await stageOperation(bulkBook, ctx, INPUT, ACTOR, { dryRun: false })

    expect(staged).toMatchObject({ ok: true, dryRun: false, row: { id: 'op-new' } })
    expect(mock.findCalls('pending_operations', 'insert')).toHaveLength(1)
  })
})
