/**
 * A pro-rata kontantmetoden installment on the posting port: its event is a
 * sale.payment_received that states the installment's own share of the moms
 * and the kronor on its payment leg, not the whole invoice's moms.
 */
import { describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

const port = vi.hoisted(() => ({
  postJournalEntry: vi.fn(async (request: { input: unknown }) => ({ id: 'je-1', ...(request.input as object) })),
}))
vi.mock('@/lib/posting/port', () => ({ postingPort: port }))
vi.mock('../engine', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../engine')>()),
  findFiscalPeriod: vi.fn(async () => 'period-1'),
}))

const { createInvoiceCashPartialEntry } = await import('../invoice-entries')
const { installmentOutputVat } = await import('../invoice-lines')

const LINES = [
  { account_number: '1689', debit_amount: 500, credit_amount: 0 },
  { account_number: '3001', debit_amount: 0, credit_amount: 320 },
  { account_number: '3002', debit_amount: 0, credit_amount: 89.29 },
  { account_number: '2611', debit_amount: 0, credit_amount: 80 },
  { account_number: '2621', debit_amount: 0, credit_amount: 10.71 },
]

describe('installmentOutputVat', () => {
  it('sums the net credit on the moms lines, to the öre', () => {
    expect(installmentOutputVat(LINES)).toBe(90.71)
    expect(installmentOutputVat([{ account_number: '1930', debit_amount: 100, credit_amount: 0 }])).toBe(0)
  })
})

describe('createInvoiceCashPartialEntry: the event', () => {
  it('states the installment, not the invoice: its moms share and the kronor on its payment leg', async () => {
    await createInvoiceCashPartialEntry(
      {} as SupabaseClient,
      'company-1',
      'user-1',
      'inv-1',
      { description: 'Kontant delbetalning kundfaktura 2026-042', lines: LINES },
      '2026-09-30',
      () => ({
        invoice: { id: 'inv-1', customer_id: 'cust-1', currency: 'SEK', exchange_rate: null, vat_treatment: 'standard_25' },
        context: { settledAmount: 500 },
      }),
    )
    const request = port.postJournalEntry.mock.calls[0][0] as unknown as { event: () => Record<string, unknown>; input: Record<string, unknown> }
    expect(request.input).toMatchObject({ source_type: 'invoice_cash_payment', source_id: 'inv-1', entry_date: '2026-09-30', lines: LINES })
    expect(request.event()).toMatchObject({
      kind: 'sale.payment_received',
      occurredOn: '2026-09-30',
      subject: { type: 'invoice', id: 'inv-1' },
      party: { type: 'customer', id: 'cust-1' },
      amount: 500,
      amountSek: 500,
      taxAmounts: [{ tax: 'vat', treatment: 'standard_25', amount_sek: 90.71 }],
    })
  })
})
