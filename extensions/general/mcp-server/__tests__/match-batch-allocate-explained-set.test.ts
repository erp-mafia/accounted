/**
 * gnubok_match_batch_allocate: the already-explained guard at stage time
 * (issue #2294).
 *
 * The dashboard door refuses a batch allocation with
 * BATCH_TX_POSSIBLE_DUPLICATE when posted, unlinked vouchers on the row's
 * settlement account sum exactly to the row (gecko's Bankgirot aggregate, PR
 * #2300). The MCP door used to stage straight past that, so an agent could
 * book the aggregate a second time. Now the same detector runs before
 * staging: the refusal names the vouchers and the link call that resolves
 * the row, and force is bound to exactly those ids.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { mockDetectSet } = vi.hoisted(() => ({ mockDetectSet: vi.fn() }))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectExplainingVoucherSetForTransaction: mockDetectSet,
  detectDuplicatePaymentVoucher: vi.fn(async () => null),
}))

import { tools } from '../server'

const allocate = tools.find((t) => t.name === 'gnubok_match_batch_allocate')!

const TX_ID = '11111111-1111-4111-8111-111111111111'
const INV_ID = '22222222-2222-4222-8222-222222222222'
const JE_A = '55555555-5555-4555-8555-555555555555'
const JE_B = '66666666-6666-4666-8666-666666666666'

const txRow = {
  id: TX_ID,
  description: 'BGGIRERING',
  merchant_name: null,
  amount: 88250,
  currency: 'SEK',
  amount_sek: null,
  exchange_rate: null,
  cash_account_id: 'ca-1',
  date: '2026-07-31',
  journal_entry_id: null,
}

const explainingSet = {
  vouchers: [
    { journal_entry_id: JE_A, voucher_label: 'A57', entry_date: '2026-07-31', description: 'Inbetalning kundfaktura 063', source_type: 'invoice_paid', amount: 62500, bank_account_number: '1930' },
    { journal_entry_id: JE_B, voucher_label: 'A58', entry_date: '2026-07-31', description: 'Inbetalning kundfaktura 064', source_type: 'invoice_paid', amount: 25750, bank_account_number: '1930' },
  ],
  total: 88250,
  bank_account_number: '1930',
  same_date: true,
}

const args = (extra: Record<string, unknown> = {}) => ({
  transaction_id: TX_ID,
  allocations: [{ kind: 'customer_invoice', invoice_id: INV_ID, amount: 88250 }],
  ...extra,
})

function run(supabase: unknown, extra: Record<string, unknown> = {}) {
  return allocate.execute(args(extra), 'company-1', 'user-1', supabase as never, { type: 'api_key' } as never)
}

/** tx fetch + invoice tenant pre-check: everything the tool reads before the guard. */
function enqueuePreGuard(enqueue: (r: { data?: unknown; error?: unknown }) => void) {
  enqueue({ data: txRow, error: null })
  enqueue({ data: [{ id: INV_ID, document_type: 'invoice' }], error: null })
}

/** period_status lookups + the pending_operations insert. */
function enqueueStage(enqueue: (r: { data?: unknown; error?: unknown }) => void) {
  enqueue({ data: { bookkeeping_locked_through: null }, error: null }) // company_settings
  enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null }) // fiscal_periods
  enqueue({ data: { id: 'op-batch-1' }, error: null }) // pending_operations insert
}

beforeEach(() => {
  vi.clearAllMocks()
  mockDetectSet.mockResolvedValue(null)
})

describe('gnubok_match_batch_allocate: already-explained guard at stage time', () => {
  it('refuses to stage, coded BATCH_TX_POSSIBLE_DUPLICATE, naming the vouchers, the link call and the force binding', async () => {
    mockDetectSet.mockResolvedValue(explainingSet)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueuePreGuard(enqueue)

    const err = await run(supabase).then(() => null, (e: Error & { code?: string }) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err!.code).toBe('BATCH_TX_POSSIBLE_DUPLICATE')
    expect(err!.message).toContain('A57 + A58')
    expect(err!.message).toContain('gnubok_reconcile_match')
    expect(err!.message).toContain('bank:ca-1')
    expect(err!.message).toContain(`expected_journal_entry_ids=${JSON.stringify([JE_A, JE_B])}`)
    // The row the tool already holds goes to the detector: no second fetch.
    expect(mockDetectSet).toHaveBeenCalledWith(supabase, 'company-1', expect.objectContaining({ id: TX_ID, cash_account_id: 'ca-1' }))
    // Nothing was staged.
    const tables = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(tables).not.toContain('pending_operations')
  })

  it('points a single explaining voucher at the 1:1 link tool too', async () => {
    mockDetectSet.mockResolvedValue({ ...explainingSet, vouchers: [explainingSet.vouchers[0]] })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueuePreGuard(enqueue)

    await expect(run(supabase)).rejects.toThrow(/gnubok_link_transaction_to_journal_entry/)
  })

  it('stages with a compliance warning when force names exactly the detected set, and persists the binding', async () => {
    mockDetectSet.mockResolvedValue(explainingSet)
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueuePreGuard(enqueue)
    enqueueStage(enqueue)

    const result = (await run(supabase, { force: true, expected_journal_entry_ids: [JE_B, JE_A] })) as {
      staged: boolean
      operation_id?: string
      message: string
      preview: Record<string, unknown>
    }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-batch-1')
    expect(result.preview.compliance_warning).toContain('A57 + A58')
    expect(result.message).toContain('WARNING')
    // The commit executor re-validates against the set detected at commit,
    // so the binding must travel with the op.
    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).toMatchObject({
      transaction_id: TX_ID,
      force: true,
      expected_journal_entry_ids: [JE_B, JE_A],
    })
  })

  it('refuses force whose ids are not exactly the set detected now', async () => {
    mockDetectSet.mockResolvedValue(explainingSet)
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueuePreGuard(enqueue)

    const err = await run(supabase, { force: true, expected_journal_entry_ids: [JE_A] }).then(
      () => null,
      (e: Error & { code?: string }) => e,
    )
    expect(err!.code).toBe('BATCH_TX_POSSIBLE_DUPLICATE')
    expect(err!.message).toMatch(/^force=true avvisad/)
    const tables = (supabase.from as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0])
    expect(tables).not.toContain('pending_operations')
  })

  it('rejects force without expected_journal_entry_ids before any query runs', async () => {
    const { supabase } = createQueuedMockSupabase()
    const err = await run(supabase, { force: true }).then(() => null, (e: Error & { code?: string }) => e)
    expect(err!.code).toBe('VALIDATION_ERROR')
    expect(err!.message).toContain('expected_journal_entry_ids is required when force=true')
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('does not persist a binding on a plain stage', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueuePreGuard(enqueue)
    enqueueStage(enqueue)

    const result = (await run(supabase)) as { staged: boolean; preview: Record<string, unknown> }
    expect(result.staged).toBe(true)
    expect(result.preview.compliance_warning).toBeUndefined()
    const inserted = findCall('pending_operations', 'insert')?.[0] as { params: Record<string, unknown> }
    expect(inserted.params).not.toHaveProperty('force')
    expect(inserted.params).not.toHaveProperty('expected_journal_entry_ids')
  })

  it('fails open when the detector throws: the commit guard and the RPC still decide', async () => {
    mockDetectSet.mockRejectedValue(new Error('ledger scan timed out'))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueuePreGuard(enqueue)
    enqueueStage(enqueue)

    const result = (await run(supabase)) as { staged: boolean }
    expect(result.staged).toBe(true)
  })
})
