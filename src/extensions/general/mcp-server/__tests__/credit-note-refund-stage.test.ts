/**
 * gnubok_mark_invoice_as_paid on a kreditfaktura stages the refund of its
 * credit (lib/invoices/refund-credit-note.ts, follow-up of crm#1435): the
 * service's dry run is the plan, so a refusal there is refused at staging
 * and nothing is staged. The service is stubbed (it has its own suite).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'

const { mockRefund } = vi.hoisted(() => ({ mockRefund: vi.fn() }))
vi.mock('@/lib/invoices/refund-credit-note', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/invoices/refund-credit-note')>()),
  refundCreditNote: mockRefund,
}))

import { tools } from '../server'

const markPaid = tools.find((t) => t.name === 'gnubok_mark_invoice_as_paid')!
const CREDIT_NOTE_ID = '55555555-5555-4555-8555-555555555555'
const ACTOR = { type: 'api_key' } as never

function setup() {
  return createTableMockSupabase({
    invoices: {
      data: {
        id: CREDIT_NOTE_ID,
        invoice_number: 'KR-1001',
        status: 'sent',
        document_type: 'invoice',
        credited_invoice_id: '66666666-6666-4666-8666-666666666666',
        journal_entry_id: 'je-credit',
        payment_cash_account_id: null,
        total: -12500,
        currency: 'SEK',
        paid_amount: null,
        remaining_amount: 0,
        customer: { id: 'cust-1', name: 'Testkund AB' },
      },
    },
    invoice_items: { data: [] },
    company_settings: { data: { accounting_method: 'accrual', entity_type: 'aktiebolag', bookkeeping_locked_through: null } },
    fiscal_periods: { data: { id: 'fp-1', is_closed: false, locked_at: null } },
    pending_operations: { data: { id: 'op-1' } },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_mark_invoice_as_paid staging: a kreditfaktura', () => {
  it('stages the refund with its lines and never a payment', async () => {
    const { supabase, findCall } = setup()
    mockRefund.mockResolvedValue({
      ok: true,
      dryRun: true,
      amount: 12500,
      owedAfter: 0,
      lines: [
        { account_number: '1510', debit_amount: 12500, credit_amount: 0, line_description: 'Återbetalning kreditfaktura KR-1001' },
        { account_number: '1930', debit_amount: 0, credit_amount: 12500, line_description: 'Återbetalning kreditfaktura KR-1001' },
      ],
      journalEntryId: null,
      paidAmount: -12500,
      refundedAt: '2026-10-20T12:00:00Z',
    })

    const result = (await markPaid.execute(
      { invoice_id: CREDIT_NOTE_ID, payment_date: '2026-10-20' },
      'company-1', 'user-1', supabase as never, ACTOR,
    )) as { staged: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(true)
    expect(result.preview).toMatchObject({
      refund_amount: 12500,
      source_type: 'invoice_paid',
      journal_entry_preview: { total_debit: 12500, total_credit: 12500 },
    })
    expect(mockRefund.mock.calls[0][3]).toMatchObject({ refundDate: '2026-10-20', dryRun: true, force: false, settlementAccountNumber: '1930' })
    expect(findCall('pending_operations', 'insert')).toBeDefined()
  })

  it('refuses at staging with the service code and stages nothing', async () => {
    const { supabase, findCall } = setup()
    mockRefund.mockResolvedValue({
      ok: false,
      code: 'CREDIT_NOTE_REFUND_LIKELY_BOOKED',
      details: { amount: 12500, candidates: [{ journal_entry_id: 'je-1', entry_date: '2026-10-19', voucher: 'A1077', source_type: 'bank_transaction' }] },
    })

    await expect(
      markPaid.execute({ invoice_id: CREDIT_NOTE_ID, payment_date: '2026-10-20' }, 'company-1', 'user-1', supabase as never, ACTOR),
    ).rejects.toMatchObject({ code: 'CREDIT_NOTE_REFUND_LIKELY_BOOKED', message: expect.stringContaining('A1077') })
    expect(findCall('pending_operations', 'insert')).toBeUndefined()
  })

  it('passes allow_duplicate on as force', async () => {
    const { supabase } = setup()
    mockRefund.mockResolvedValue({ ok: false, code: 'CREDIT_NOTE_REFUND_NOTHING_OWED', details: { refunded: 0, credit_used: 0 } })

    await expect(
      markPaid.execute(
        { invoice_id: CREDIT_NOTE_ID, payment_date: '2026-10-20', allow_duplicate: true },
        'company-1', 'user-1', supabase as never, ACTOR,
      ),
    ).rejects.toMatchObject({ code: 'CREDIT_NOTE_REFUND_NOTHING_OWED' })
    expect(mockRefund.mock.calls[0][3]).toMatchObject({ force: true })
  })
})
