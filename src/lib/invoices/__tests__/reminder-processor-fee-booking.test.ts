/**
 * processOverdueReminders: the påminnelseavgift is charged only when its
 * verifikat exists, and it carries the reminded invoice's dimensions.
 *
 * A fee in the email (and on the invoice_reminders row the public action
 * page reads) with no booking is a claim the ledger does not know about, the
 * sent-but-unbooked class. When the fee booking fails or is skipped (no open
 * fiscal period), the reminder still goes out, without the fee.
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
vi.mock('@/lib/email/brand-sender', () => ({
  getSenderForCompany: vi.fn().mockResolvedValue({ brand: null }),
  getBaseUrlForBrand: vi.fn().mockReturnValue('https://app.accounted.test'),
}))

import { processOverdueReminders } from '../reminder-processor'

function overdueSekInvoice(defaultDimensions?: Record<string, string>) {
  const due = new Date()
  due.setDate(due.getDate() - 20)
  return {
    ...makeInvoice({
      id: 'inv-sek',
      invoice_number: 'F2026100',
      currency: 'SEK',
      total: 1_000,
      status: 'sent',
      due_date: due.toISOString().split('T')[0],
      ...(defaultDimensions ? { default_dimensions: defaultDimensions } : {}),
    }),
    customer: makeCustomer({ email: 'kund@example.se' }),
    credit_notes: [],
  }
}

function reminderRow(): Record<string, unknown> {
  const insert = state.inserts.find((i) => i.table === 'invoice_reminders')
  return insert!.payload as Record<string, unknown>
}

function emailedText(): string {
  return (mockSendEmail.mock.calls[0][0] as { text: string }).text
}

describe('processOverdueReminders: the fee is charged only when it is booked', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    state.inserts.length = 0
    state.company = makeCompanySettings({
      bankgiro: '123-4567',
      reminder_fee_enabled: true,
      reminder_fee_amount: 60,
    } as never)
    mockSendEmail.mockResolvedValue({ success: true })
    mockCreateReminderFeeEntry.mockResolvedValue({ journal_entry_id: 'je-fee' })
  })

  it('books the fee with a tagged invoice\'s dimensions and charges it', async () => {
    state.invoices = [overdueSekInvoice({ '6': 'P001' })]

    const result = await processOverdueReminders()

    expect(result.sent).toBe(1)
    expect(mockCreateReminderFeeEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ invoiceId: 'inv-sek', feeAmount: 60, invoiceDefaultDimensions: { '6': 'P001' } }),
    )
    expect(reminderRow()).toMatchObject({ reminder_fee: 60, fee_journal_entry_id: 'je-fee' })
    expect(emailedText()).toContain('Påminnelseavgift: ')
  })

  it('books an untagged invoice\'s fee without dimensions, as before', async () => {
    state.invoices = [overdueSekInvoice()]

    await processOverdueReminders()

    expect(mockCreateReminderFeeEntry).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ invoiceDefaultDimensions: null }),
    )
    expect(reminderRow()).toMatchObject({ reminder_fee: 60, fee_journal_entry_id: 'je-fee' })
  })

  it('sends the reminder without the fee when the fee booking fails', async () => {
    state.invoices = [overdueSekInvoice()]
    mockCreateReminderFeeEntry.mockRejectedValue(
      new Error('Konto 3990 kräver Projekt: välj ett värde innan bokföring.'),
    )

    const result = await processOverdueReminders()

    // The reminder still goes out, but no fee is claimed without a verifikat:
    // not in the email, not on the row the action page reads.
    expect(result.sent).toBe(1)
    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(emailedText()).not.toContain('Påminnelseavgift: ')
    expect(reminderRow()).toMatchObject({ reminder_fee: 0, fee_journal_entry_id: null })
  })

  it('sends the reminder without the fee when no open fiscal period took the booking', async () => {
    state.invoices = [overdueSekInvoice()]
    mockCreateReminderFeeEntry.mockResolvedValue(null)

    await processOverdueReminders()

    expect(mockSendEmail).toHaveBeenCalledTimes(1)
    expect(emailedText()).not.toContain('Påminnelseavgift: ')
    expect(reminderRow()).toMatchObject({ reminder_fee: 0, fee_journal_entry_id: null })
  })
})
