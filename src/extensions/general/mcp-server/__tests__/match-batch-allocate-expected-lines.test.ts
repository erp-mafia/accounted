/**
 * gnubok_match_batch_allocate: the staged preview carries the verifikat rows
 * approval will post (expected_lines).
 *
 * An API customer's review flow must approve exact konto, debet, kredit and
 * date before approve_pending_operation runs. Aggregates alone (count, total)
 * cannot be reviewed against the ledger. The rows come from
 * lib/invoices/batch-allocation-preview.ts, which mirrors the RPC; the invoice
 * columns it needs ride along on the tenant pre-check select.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { mockDetectSet } = vi.hoisted(() => ({ mockDetectSet: vi.fn() }))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectExplainingVoucherSetForTransaction: mockDetectSet,
  detectDuplicatePaymentVoucher: vi.fn(async () => null),
}))

// Kontantmetoden guard (lib/invoices/batch-cash-method-guard.ts). Mocked so
// it consumes no slot in the queued Supabase mock; defaults to "nothing
// unbooked" (accrual). Its own query shape is pinned by
// lib/invoices/__tests__/batch-cash-method-guard.test.ts.
const { mockFindCashUnbooked } = vi.hoisted(() => ({
  mockFindCashUnbooked: vi.fn(async (..._args: unknown[]): Promise<unknown> => ({ ok: true, unbooked: [] })),
}))
vi.mock('@/lib/invoices/batch-cash-method-guard', () => ({
  findCashMethodUnbookedAllocations: mockFindCashUnbooked,
}))

import { tools } from '../server'

const allocate = tools.find((t) => t.name === 'gnubok_match_batch_allocate')!

const TX_ID = '11111111-1111-4111-8111-111111111111'
const INV_A = '22222222-2222-4222-8222-222222222222'
const INV_B = '33333333-3333-4333-8333-333333333333'
const SI_A = '44444444-4444-4444-8444-444444444444'

function enqueueStage(enqueue: (r: { data?: unknown; error?: unknown }) => void) {
  enqueue({ data: { bookkeeping_locked_through: null }, error: null }) // company_settings
  enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null }) // fiscal_periods
  enqueue({ data: { id: 'op-batch-1' }, error: null }) // pending_operations insert
}

type Staged = { staged: boolean; preview: Record<string, unknown>; next?: { description: string } }

beforeEach(() => {
  vi.clearAllMocks()
  mockDetectSet.mockResolvedValue(null)
})

describe('gnubok_match_batch_allocate: expected_lines in the staged preview', () => {
  it('customer batch: one Cr 1510 row per invoice in id order, Dr 1930 for the receipt, persisted in preview_data', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: { id: TX_ID, description: 'BGGIRERING', merchant_name: null, amount: 88250, currency: 'SEK', amount_sek: null, exchange_rate: null, cash_account_id: 'ca-1', date: '2026-07-31', journal_entry_id: null },
      error: null,
    })
    enqueue({
      data: [
        { id: INV_B, document_type: 'invoice', currency: 'SEK', exchange_rate: null, remaining_amount: 25750, total: 25750 },
        { id: INV_A, document_type: 'invoice', currency: 'SEK', exchange_rate: null, remaining_amount: 62500, total: 62500 },
      ],
      error: null,
    })
    enqueueStage(enqueue)

    const result = (await allocate.execute(
      {
        transaction_id: TX_ID,
        allocations: [
          { kind: 'customer_invoice', invoice_id: INV_B, amount: 25750 },
          { kind: 'customer_invoice', invoice_id: INV_A, amount: 62500 },
        ],
      },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' } as never,
    )) as Staged

    expect(result.staged).toBe(true)
    expect(result.preview.expected_entry_date).toBe('2026-07-31')
    expect(result.preview.expected_description).toBe('Samlingsinbetalning 2026-07-31')
    expect(result.preview.expected_fx).toBe('none')
    expect(result.preview.expected_lines_balanced).toBe(true)
    expect(result.preview.expected_lines).toEqual([
      { account_number: '1510', description: 'Kundfaktura 1 av 2', debit: 0, credit: 62500 },
      { account_number: '1510', description: 'Kundfaktura 2 av 2', debit: 0, credit: 25750 },
      { account_number: '1930', description: 'Inbetalning 2026-07-31', debit: 88250, credit: 0 },
    ])
    // The approval card reads the persisted row, so the rows must be there too.
    const inserted = findCall('pending_operations', 'insert')?.[0] as { preview_data: Record<string, unknown> }
    expect(inserted.preview_data.expected_lines).toEqual(result.preview.expected_lines)
    // GDPR posture unchanged: no invoice ids or numbers in the preview.
    expect(JSON.stringify(result.preview)).not.toContain(INV_A)
    expect(result.next?.description).toContain('expected_lines')
  })

  it('supplier batch: Dr 2440 per bill, Cr 1930 for the payment', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: { id: TX_ID, description: 'LB UTBET', merchant_name: null, amount: -1250, currency: 'SEK', amount_sek: null, exchange_rate: null, cash_account_id: 'ca-1', date: '2026-08-05', journal_entry_id: null },
      error: null,
    })
    // 1 249,60 owed, 1 250 paid: the öre lands on 3740 (issue #1717).
    enqueue({ data: [{ id: SI_A, currency: 'SEK', exchange_rate: null, remaining_amount: 1249.6, total: 1249.6 }], error: null })
    enqueueStage(enqueue)

    const result = (await allocate.execute(
      { transaction_id: TX_ID, allocations: [{ kind: 'supplier_invoice', supplier_invoice_id: SI_A, amount: 1250 }] },
      'company-1',
      'user-1',
      supabase as never,
      { type: 'api_key' } as never,
    )) as Staged

    expect(result.preview.expected_lines).toEqual([
      { account_number: '2440', description: 'Leverantörsfaktura 1 av 1', debit: 1249.6, credit: 0 },
      { account_number: '3740', description: 'Öresavrundning', debit: 0.4, credit: 0 },
      { account_number: '1930', description: 'Utbetalning 2026-08-05', debit: 0, credit: 1250 },
    ])
    expect(result.preview.expected_lines_balanced).toBe(true)
  })

  it('refuses to stage unbooked invoices under kontantmetoden and names the per-invoice route', async () => {
    mockFindCashUnbooked.mockResolvedValueOnce({
      ok: true,
      unbooked: [{ kind: 'customer_invoice', id: INV_A, invoice_number: '231' }],
    })
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: { id: TX_ID, description: 'BGGIRERING', merchant_name: null, amount: 62500, currency: 'SEK', amount_sek: null, exchange_rate: null, cash_account_id: 'ca-1', date: '2026-07-31', journal_entry_id: null },
      error: null,
    })
    enqueue({
      data: [{ id: INV_A, document_type: 'invoice', currency: 'SEK', exchange_rate: null, remaining_amount: 62500, total: 62500 }],
      error: null,
    })

    await expect(
      allocate.execute(
        { transaction_id: TX_ID, allocations: [{ kind: 'customer_invoice', invoice_id: INV_A, amount: 62500 }] },
        'company-1',
        'user-1',
        supabase as never,
        { type: 'api_key' } as never,
      ),
    ).rejects.toMatchObject({
      code: 'BATCH_CASH_METHOD_UNBOOKED_INVOICE',
      message: expect.stringContaining('gnubok_match_transaction_to_invoice'),
    })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('keeps the tool description inside the catalog budget', () => {
    expect(allocate.description).toContain('expected_lines')
    expect(allocate.description.length).toBeLessThanOrEqual(280)
  })
})
