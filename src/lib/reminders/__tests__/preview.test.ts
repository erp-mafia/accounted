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
    expect(preview).toMatchObject({
      invoiceId: 'inv-1',
      invoiceNumber: 'F-1042',
      level: 1,
      decision: { kind: 'remind', level: 1 },
      to: 'kund@example.se',
    })
    expect(preview.subject).toMatch(/^Vänlig påminnelse: Faktura F-1042/)
    expect(preview.html).toContain('https://app.accounted.se/invoice-action/exempel')
  })

  it('says when a pick would send nothing, and why, beside the mail it shows', async () => {
    const sent = (level: 1 | 2 | 3, sentOn: string) => ({ level, status: 'sent' as const, sentOn, providerStatus: null, responseType: null, legacy: false })
    // Level 1 went out two days ago: level 2 waits for its day.
    vi.mocked(loadReminderContext).mockResolvedValue(context({ history: [sent(1, '2026-12-15')] }))
    const notDue = await renderReminderPreview(db({ data: [] }), 'company-1', { invoiceId: 'inv-1', now: NOW })
    expect(notDue.decision).toMatchObject({ kind: 'skip', reason: 'not_due' })

    vi.mocked(loadReminderContext).mockResolvedValue(context({ history: [sent(1, '2026-10-01'), sent(2, '2026-10-15'), sent(3, '2026-11-01')] }))
    expect((await renderReminderPreview(db({ data: [] }), 'company-1', { invoiceId: 'inv-1', now: NOW })).decision).toEqual({ kind: 'skip', reason: 'complete' })

    const excluded = context()
    excluded.facts = { ...excluded.facts, customerExcluded: true }
    vi.mocked(loadReminderContext).mockResolvedValue(excluded)
    expect((await renderReminderPreview(db({ data: [] }), 'company-1', { invoiceId: 'inv-1', now: NOW })).decision).toEqual({ kind: 'skip', reason: 'customer_excluded' })
  })

  it('shows the level asked for', async () => {
    const preview = await renderReminderPreview(db({ data: [] }), 'company-1', { invoiceId: 'inv-1', level: 3, now: NOW })
    expect(preview.subject).toMatch(/^Slutlig påminnelse/)
    // The final reminder's own pay-by row: the preview date plus FINAL_REMINDER_PAY_WITHIN_DAYS.
    expect(preview.html).toContain('Betala senast:</td><td style="padding: 6px 0; text-align: right;">2026-12-25</td>')
  })

  it("takes the company's latest overdue invoice without one, and refuses with none at all", async () => {
    await renderReminderPreview(db({ data: [{ id: 'inv-1' }] }), 'company-1', { now: NOW })
    expect(loadReminderContext).toHaveBeenCalledWith(expect.anything(), 'company-1', 'inv-1')
    await expect(renderReminderPreview(db({ data: [] }), 'company-1', { now: NOW })).rejects.toBeInstanceOf(NoInvoiceToPreviewError)
  })

  it('never samples a sent credit note or a proforma past its date: the one overdue rule (crm#1435)', async () => {
    // The invoices table as rows; the resolver applies the chain's filters, so the test reads the predicate, not the call shape.
    type Row = Record<string, unknown>
    const table = (rows: Row[]) =>
      createTableMockSupabase({
        invoices: (chain) => {
          let out = rows
          for (const { method, args } of chain) {
            const [column, value] = args as [string, unknown]
            if (method === 'eq' || method === 'is') out = out.filter((r) => r[column] === value)
            if (method === 'in') out = out.filter((r) => (value as unknown[]).includes(r[column]))
            if (method === 'gt') out = out.filter((r) => Number(r[column]) > Number(value))
            if (method === 'lt') out = out.filter((r) => String(r[column]) < String(value))
            if (method === 'order') {
              const sign = (args[1] as { ascending?: boolean } | undefined)?.ascending === false ? -1 : 1
              out = [...out].sort((a, b) => (String(a[column]) < String(b[column]) ? -sign : sign))
            }
            if (method === 'limit') out = out.slice(0, Number(args[0]))
          }
          return { data: out.map((r) => ({ id: r.id })) }
        },
      }).supabase as unknown as SupabaseClient
    const row = (id: string, overrides: Row = {}): Row => ({
      id,
      company_id: 'company-1',
      status: 'sent',
      document_type: 'invoice',
      credited_invoice_id: null,
      remaining_amount: 1250,
      invoice_date: '2026-11-02',
      due_date: '2026-12-02',
      ...overrides,
    })
    // A sent credit note (nothing remaining) and a proforma, both due later than the real overdue invoice.
    const creditNote = row('kr-7', { credited_invoice_id: 'inv-7', remaining_amount: 0, invoice_date: '2026-11-20', due_date: '2026-12-10' })
    const proforma = row('pf-1', { document_type: 'proforma', invoice_date: '2026-11-21', due_date: '2026-12-11' })

    await renderReminderPreview(table([creditNote, proforma, row('inv-1')]), 'company-1', { now: NOW })
    expect(loadReminderContext).toHaveBeenLastCalledWith(expect.anything(), 'company-1', 'inv-1')

    // Nothing overdue: the latest issued real invoice, still never the credit note or the proforma.
    await renderReminderPreview(table([creditNote, proforma, row('paid-1', { status: 'paid', remaining_amount: 0 })]), 'company-1', { now: NOW })
    expect(loadReminderContext).toHaveBeenLastCalledWith(expect.anything(), 'company-1', 'paid-1')

    await expect(renderReminderPreview(table([creditNote, proforma]), 'company-1', { now: NOW })).rejects.toBeInstanceOf(NoInvoiceToPreviewError)
  })

  it('refuses an invoice without a customer', async () => {
    vi.mocked(loadReminderContext).mockResolvedValue(context({ customer: null }))
    await expect(renderReminderPreview(db({ data: [] }), 'company-1', { invoiceId: 'inv-1', now: NOW })).rejects.toBeInstanceOf(NoInvoiceToPreviewError)
  })
})
