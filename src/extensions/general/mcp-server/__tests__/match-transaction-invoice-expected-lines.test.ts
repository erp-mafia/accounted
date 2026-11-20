/**
 * gnubok_match_transaction_to_invoice: the staged preview carries the rows
 * the payment verifikat will post (expected_lines), as
 * gnubok_match_batch_allocate's preview does (crm#1813).
 *
 * The preview listed only the bank row's and the invoice's totals, so the
 * kursförlust on a foreign invoice first showed after approval. The rows are
 * built by customerMatchExpectedLines (its own suite:
 * lib/invoices/__tests__/customer-match-expected-lines.test.ts); here, that
 * they reach the staged operation, and that staging is unchanged without them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/invoices/sale-first', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/sale-first')>()),
  planSaleBeforeSettlement: vi.fn(async () => ({ ok: true, required: false })),
}))
vi.mock('@/lib/invoices/duplicate-payment-detection', () => ({
  detectDuplicatePaymentVoucher: vi.fn(async () => null),
  detectExplainingVoucherSetForTransaction: vi.fn(async () => null),
}))
vi.mock('@/lib/invoices/book-customer-bank-match', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/book-customer-bank-match')>()),
  refuseCustomerBankMatch: vi.fn(async () => null),
}))
const { mockExpected } = vi.hoisted(() => ({ mockExpected: vi.fn() }))
vi.mock('@/lib/invoices/customer-match-expected-lines', () => ({
  customerMatchExpectedLines: mockExpected,
}))
import { createQueuedMockSupabase } from '@/tests/helpers'

import { tools } from '../server'

const match = tools.find((t) => t.name === 'gnubok_match_transaction_to_invoice')!

const TX_ID = '11111111-1111-4111-8111-111111111111'
const INV_ID = '22222222-2222-4222-8222-222222222222'

const LINES = [
  { account_number: '1930', description: 'Inbetalning kundfaktura F-1', debit: 812.4, credit: 0 },
  { account_number: '1510', description: 'Inbetalning kundfaktura F-1', debit: 0, credit: 812.4 },
]

function stageWith(expected: unknown) {
  mockExpected.mockResolvedValue(expected)
  const { supabase, enqueue, findCall } = createQueuedMockSupabase()
  enqueue({
    data: {
      id: TX_ID, description: 'BG INBET', merchant_name: null, amount: 812.4, currency: 'SEK',
      amount_sek: null, exchange_rate: null, date: '2026-09-30', invoice_id: null,
    },
    error: null,
  })
  enqueue({
    data: {
      id: INV_ID, invoice_number: 'F-1', status: 'sent', document_type: 'invoice', total: 812.4,
      paid_amount: 0, remaining_amount: 812.4, currency: 'SEK', invoice_date: '2026-09-01',
      customer: { name: 'Kund AB' },
    },
    error: null,
  })
  enqueue({ data: { bookkeeping_locked_through: null }, error: null }) // company_settings
  enqueue({ data: { id: 'fp-1', is_closed: false, locked_at: null }, error: null }) // fiscal_periods
  enqueue({ data: { id: 'op-match-1' }, error: null }) // pending_operations insert
  const run = match.execute(
    { transaction_id: TX_ID, invoice_id: INV_ID },
    'company-1', 'user-1', supabase as never, { type: 'api_key' } as never,
  ) as Promise<{ staged: boolean; preview: Record<string, unknown>; next?: { description: string } }>
  return { run, findCall }
}

beforeEach(() => vi.clearAllMocks())

describe('gnubok_match_transaction_to_invoice: expected_lines on the staged preview', () => {
  it('stages the rows approval posts, for the agent and on the stored operation', async () => {
    const { run, findCall } = stageWith({ expected_lines: LINES, expected_lines_balanced: true })
    const result = await run

    expect(result.staged).toBe(true)
    expect(result.preview).toMatchObject({ expected_lines: LINES, expected_lines_balanced: true })
    expect(result.next?.description).toContain('preview.expected_lines')
    const inserted = findCall('pending_operations', 'insert')?.[0] as { preview_data: Record<string, unknown>; params: Record<string, unknown> }
    expect(inserted.preview_data).toMatchObject({ expected_lines: LINES, expected_lines_balanced: true })
    // Preview only: what approval books is decided by the same params as before.
    expect(inserted.params).toEqual({ transaction_id: TX_ID, invoice_id: INV_ID })
    // Built from the plan the staging already made for this row and invoice.
    expect(mockExpected).toHaveBeenCalledTimes(1)
    expect(mockExpected.mock.calls[0][1]).toMatchObject({ id: TX_ID })
    expect(mockExpected.mock.calls[0][2]).toMatchObject({ id: INV_ID })
    expect(mockExpected.mock.calls[0][3]).toMatchObject({ ok: true })
  })

  it('stages as before when the rows cannot be built', async () => {
    const { run, findCall } = stageWith(null)
    const result = await run

    expect(result.staged).toBe(true)
    expect(result.preview).not.toHaveProperty('expected_lines')
    expect(result.next?.description).not.toContain('expected_lines')
    const inserted = findCall('pending_operations', 'insert')?.[0] as { preview_data: Record<string, unknown> }
    expect(inserted.preview_data).toMatchObject({ invoice_number: 'F-1', transaction_amount: 812.4 })
  })
})
