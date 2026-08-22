/**
 * processOverdueReminders: the payment-account gate runs BEFORE any write.
 *
 * A reminder that cannot go out (no usable payment account for the invoice
 * currency) must leave no trace: no reminder-fee journal entry, no
 * invoice_reminders row (which would burn the level), no email. Once an
 * account exists, the same invoice books the fee, inserts the row and sends.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'

const { mockSendEmail, mockCreateReminderFeeEntry, state } = vi.hoisted(() => ({
  mockSendEmail: vi.fn(),
  mockCreateReminderFeeEntry: vi.fn(),
  state: {
    invoices: [] as unknown[],
    company: null as unknown,
    inserts: [] as Array<{ table: string; payload: unknown }>,
  },
}))

vi.mock('@supabase/ssr', () => {
  // Table-aware chain: `then` resolves the list for the table, `single`
  // resolves the single-row shape, `insert` is recorded.
  const buildChain = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) =>
              resolve({
                data: table === 'invoices' ? state.invoices : [],
                error: null,
                count: null,
              })
          }
          if (prop === 'single') {
            return async () => {
              if (table === 'company_settings') return { data: state.company, error: null }
              if (table === 'invoices') return { data: { status: 'sent', credit_notes: [] }, error: null }
              if (table === 'invoice_reminders') return { data: { action_token: 'tok-1' }, error: null }
              return { data: null, error: null }
            }
          }
          if (prop === 'insert') {
            return (payload: unknown) => {
              state.inserts.push({ table, payload })
              return buildChain(table)
            }
          }
          return () => buildChain(table)
        },
      },
    )
  return {
    createServerClient: vi.fn(() => ({
      from: vi.fn((table: string) => buildChain(table)),
      rpc: vi.fn(() => buildChain('rpc')),
    })),
  }
})

vi.mock('@/lib/email/invoice-sender', () => ({
  resolveInvoiceSender: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/email/service', () => ({
  getEmailService: () => ({ sendEmail: mockSendEmail }),
}))
vi.mock('@/lib/bookkeeping/reminder-fee-entries', () => ({
  createReminderFeeEntry: mockCreateReminderFeeEntry,
}))

import { processOverdueReminders } from '../reminder-processor'

function overdueEurInvoice() {
  const due = new Date()
  due.setDate(due.getDate() - 20)
  return {
    ...makeInvoice({
      id: 'inv-eur',
      invoice_number: 'F2026099',
      currency: 'EUR',
      total: 1_000,
      status: 'sent',
      due_date: due.toISOString().split('T')[0],
    }),
    customer: makeCustomer({ email: 'kund@example.se' }),
    credit_notes: [],
  }
}

describe('processOverdueReminders: payment-account gate before writes', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.invoices = [overdueEurInvoice()]
    state.inserts.length = 0
    mockSendEmail.mockResolvedValue({ success: true })
    mockCreateReminderFeeEntry.mockResolvedValue({ journal_entry_id: 'je-fee' })
  })

  it('books nothing and inserts nothing when the company has no account for the invoice currency', async () => {
    state.company = makeCompanySettings({
      bankgiro: '123-4567',
      iban: 'SE4550000000058398257466',
      reminder_fee_enabled: true,
      reminder_fee_amount: 60,
    } as never)

    const result = await processOverdueReminders()

    expect(result.processed).toBe(1)
    expect(result.failed).toBe(1)
    expect(result.results[0]).toMatchObject({
      invoiceId: 'inv-eur',
      reminderLevel: 1,
      success: false,
      error: 'INVOICE_PAYMENT_ACCOUNT_MISSING:EUR',
    })
    expect(mockCreateReminderFeeEntry).not.toHaveBeenCalled()
    expect(state.inserts.filter((i) => i.table === 'invoice_reminders')).toHaveLength(0)
    expect(mockSendEmail).not.toHaveBeenCalled()
  })

  it('books the fee, inserts the row and sends once a EUR account is configured', async () => {
    state.company = makeCompanySettings({
      reminder_fee_enabled: true,
      reminder_fee_amount: 60,
      invoice_payment_accounts: { EUR: { iban: 'DE89370400440532013000', bic: 'DEUTDEFF' } },
    } as never)

    const result = await processOverdueReminders()

    expect(result.sent).toBe(1)
    expect(mockCreateReminderFeeEntry).toHaveBeenCalledTimes(1)
    expect(state.inserts.filter((i) => i.table === 'invoice_reminders')).toHaveLength(1)
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    const html = (mockSendEmail.mock.calls[0][0] as { html: string }).html
    expect(html).toContain('DE89370400440532013000')
    expect(html).not.toContain('SE4550000000058398257466')
  })
})
