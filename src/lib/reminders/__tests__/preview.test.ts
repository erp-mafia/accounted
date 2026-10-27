import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, makeCompanySettings, makeCustomer, makeInvoice, type TableMockResult } from '@/tests/helpers'
import type { ReminderContext } from '../facts'

vi.mock('../facts', () => ({ loadReminderContext: vi.fn() }))
vi.mock('@/lib/email/brand-sender', () => ({ getBaseUrlForCompany: vi.fn(async () => 'https://app.accounted.se') }))
const { loadReminderContext } = await import('../facts')
const { renderReminderPreview, NoInvoiceToPreviewError } = await import('../preview')

const NOW = new Date('2026-12-17T11:00:00Z')

function context(overrides: Partial<ReminderContext> = {}): ReminderContext {
  return {
    invoice: makeInvoice({ id: 'inv-1', invoice_number: 'F-1042', invoice_date: '2026-11-02', due_date: '2026-12-02', status: 'sent', currency: 'SEK' }),
    customer: makeCustomer({ name: 'Kund AB', email: 'kund@example.se' }),
    company: makeCompanySettings({ company_name: 'Säljaren AB' }),
    companyInactive: false,
    amount: 1250,
    facts: {
      kind: 'invoice',
      status: 'sent',
      invoiceDate: '2026-11-02',
      dueDate: '2026-12-02',
      remaining: 1250,
      credited: false,
      delivery: 'delivered',
      imported: false,
      autogiro: false,
      recipient: 'kund@example.se',
      customerExcluded: false,
      withCollections: false,
    },
    history: [],
    ...overrides,
  }
}

const db = (invoices: TableMockResult) => createTableMockSupabase({ invoices }).supabase as unknown as SupabaseClient

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(loadReminderContext).mockResolvedValue(context())
})

describe('renderReminderPreview', () => {
  it("renders the invoice's reminder at the level a pick would send, with an inert answer link", async () => {
    const preview = await renderReminderPreview(db({ data: [] }), 'company-1', { invoiceId: 'inv-1', now: NOW })
    expect(preview).toMatchObject({ invoiceId: 'inv-1', invoiceNumber: 'F-1042', level: 1, to: 'kund@example.se' })
    expect(preview.subject).toMatch(/^Vänlig påminnelse: Faktura F-1042/)
    expect(preview.html).toContain('https://app.accounted.se/invoice-action/exempel')
  })

  it('shows the level asked for', async () => {
    const preview = await renderReminderPreview(db({ data: [] }), 'company-1', { invoiceId: 'inv-1', level: 3, now: NOW })
    expect(preview.subject).toMatch(/^Slutlig påminnelse/)
  })

  it("takes the company's latest overdue invoice without one, and refuses with none at all", async () => {
    await renderReminderPreview(db({ data: [{ id: 'inv-1' }] }), 'company-1', { now: NOW })
    expect(loadReminderContext).toHaveBeenCalledWith(expect.anything(), 'company-1', 'inv-1')
    await expect(renderReminderPreview(db({ data: [] }), 'company-1', { now: NOW })).rejects.toBeInstanceOf(NoInvoiceToPreviewError)
  })

  it('refuses an invoice without a customer', async () => {
    vi.mocked(loadReminderContext).mockResolvedValue(context({ customer: null }))
    await expect(renderReminderPreview(db({ data: [] }), 'company-1', { invoiceId: 'inv-1', now: NOW })).rejects.toBeInstanceOf(NoInvoiceToPreviewError)
  })
})
