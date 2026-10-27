import { describe, it, expect } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { makeCompanySettings, makeCustomer, makeInvoice } from '@/tests/helpers'
import { loadReminderContext, ReminderInvoiceNotFoundError } from '../facts'

type Rows = Record<string, unknown>[]

interface World {
  invoice: Record<string, unknown> | null
  creditNotes?: Rows
  settings?: Record<string, unknown>
  company?: Record<string, unknown> | null
  resetSources?: Rows
  emailDeliveries?: Rows
  peppolDeliveries?: Rows
  imported?: Rows
  reminders?: Rows
  connections?: Rows
  openCases?: Rows
}

/**
 * Answers each table the loader reads with the world's rows. Every builder
 * method chains; a list read resolves when awaited, a single read on
 * maybeSingle. The invoices table answers the invoice on maybeSingle and the
 * credit notes as a list.
 */
function fakeDb(world: World): SupabaseClient {
  const list = (table: string): Rows => {
    switch (table) {
      case 'invoices':
        return world.creditNotes ?? []
      case 'company_migration_resets':
        return world.resetSources ?? []
      case 'invoice_deliveries':
        return world.emailDeliveries ?? []
      case 'peppol_deliveries':
        return world.peppolDeliveries ?? []
      case 'migration_source_records':
        return world.imported ?? []
      case 'invoice_reminders':
        return world.reminders ?? []
      case 'collection_connections':
        return world.connections ?? []
      case 'collection_cases':
        return world.openCases ?? []
      default:
        throw new Error(`unexpected list read of ${table}`)
    }
  }
  const single = (table: string): Record<string, unknown> | null => {
    switch (table) {
      case 'invoices':
        return world.invoice
      case 'company_settings':
        return world.settings ?? (makeCompanySettings({ ore_rounding: false } as never) as unknown as Record<string, unknown>)
      case 'companies':
        return world.company === undefined ? { archived_at: null } : world.company
      default:
        throw new Error(`unexpected single read of ${table}`)
    }
  }
  return {
    from(table: string) {
      const chain: Record<string, unknown> = {}
      for (const method of ['select', 'eq', 'neq', 'in', 'not', 'is', 'order', 'limit', 'range']) chain[method] = () => chain
      chain.maybeSingle = async () => ({ data: single(table), error: null })
      chain.then = (resolve: (value: { data: Rows; error: null }) => void) => resolve({ data: list(table), error: null })
      return chain
    },
  } as unknown as SupabaseClient
}

function invoiceRow(overrides: Record<string, unknown> = {}, customer: Record<string, unknown> | null = {}) {
  return {
    ...makeInvoice({
      id: 'inv-1',
      company_id: 'company-1',
      status: 'sent',
      invoice_date: '2026-11-02',
      due_date: '2026-12-02',
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      paid_amount: null,
      remaining_amount: 1250,
    }),
    ...overrides,
    customer: customer === null ? null : { ...makeCustomer({ email: 'kund@example.se' }), ...customer },
  }
}

const load = (world: World) => loadReminderContext(fakeDb(world), 'company-1', 'inv-1')

describe('loadReminderContext', () => {
  it('reads a delivered, owed invoice of our own with no history', async () => {
    const ctx = await load({ invoice: invoiceRow(), emailDeliveries: [{ status: 'sent', provider_status: 'delivered' }] })
    expect(ctx.companyInactive).toBe(false)
    expect(ctx.facts).toEqual({
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
    })
    expect(ctx.history).toEqual([])
  })

  it('owes what is left after a part payment, and nothing when the books say nothing remains', async () => {
    expect((await load({ invoice: invoiceRow({ status: 'partially_paid', paid_amount: 1000, remaining_amount: 250 }) })).facts.remaining).toBe(250)
    expect((await load({ invoice: invoiceRow({ remaining_amount: 0 }) })).facts.remaining).toBe(0)
    expect((await load({ invoice: invoiceRow({ status: 'partially_paid', paid_amount: 1000, remaining_amount: 250 }) })).amount).toBe(1250)
  })

  it('tells a credit note, a quote and a credited invoice apart from an owed one', async () => {
    expect((await load({ invoice: invoiceRow({ credited_invoice_id: 'inv-0' }) })).facts.kind).toBe('other')
    expect((await load({ invoice: invoiceRow({ document_type: 'quote' }) })).facts.kind).toBe('other')
    expect((await load({ invoice: invoiceRow(), creditNotes: [{ status: 'draft' }] })).facts.credited).toBe(true)
  })

  it('reads imported, undelivered, autogiro, excluded and addressless invoices', async () => {
    expect((await load({ invoice: invoiceRow(), imported: [{ id: 'm1' }] })).facts.imported).toBe(true)
    expect((await load({ invoice: invoiceRow(), emailDeliveries: [{ status: 'sent', provider_status: 'bounced' }] })).facts.delivery).toBe(
      'not_delivered',
    )
    expect((await load({ invoice: invoiceRow({ autogiro_payer_number: '778899' }) })).facts.autogiro).toBe(true)
    expect((await load({ invoice: invoiceRow({}, { reminders_excluded: true }) })).facts.customerExcluded).toBe(true)
    expect((await load({ invoice: invoiceRow({}, { email: 'not an address' }) })).facts.recipient).toBeNull()
    expect((await load({ invoice: invoiceRow({}, null) })).facts.recipient).toBeNull()
  })

  it('sees the collections provider: an open case, or a connected company', async () => {
    expect((await load({ invoice: invoiceRow(), openCases: [{ invoice_id: 'inv-1' }] })).facts.withCollections).toBe(true)
    expect((await load({ invoice: invoiceRow(), connections: [{ company_id: 'company-1' }] })).facts.withCollections).toBe(true)
  })

  it('marks an archived company, a reset source and a sandbox inactive', async () => {
    expect((await load({ invoice: invoiceRow(), company: { archived_at: '2026-10-01T00:00:00Z' } })).companyInactive).toBe(true)
    expect((await load({ invoice: invoiceRow(), resetSources: [{ source_company_id: 'company-1' }] })).companyInactive).toBe(true)
    const sandbox = { ...makeCompanySettings(), is_sandbox: true } as unknown as Record<string, unknown>
    expect((await load({ invoice: invoiceRow(), settings: sandbox })).companyInactive).toBe(true)
  })

  it("maps the reminder history, the old sender's rows as legacy", async () => {
    const ctx = await load({
      invoice: invoiceRow(),
      reminders: [
        { reminder_level: 1, status: 'sent', sent_at: '2026-12-16T23:30:00Z', provider_status: 'delivered', response_type: null, mode: 'approved' },
        { reminder_level: 2, status: 'reserved', sent_at: null, provider_status: null, response_type: null, mode: 'automatic' },
        { reminder_level: 1, status: 'sent', sent_at: '2026-05-21T08:00:00Z', provider_status: null, response_type: 'disputed', mode: null },
      ],
    })
    expect(ctx.history).toEqual([
      // 23:30 UTC on 12-16 is 12-17 in Stockholm.
      { level: 1, status: 'sent', sentOn: '2026-12-17', providerStatus: 'delivered', responseType: null, legacy: false },
      { level: 2, status: 'reserved', sentOn: null, providerStatus: null, responseType: null, legacy: false },
      { level: 1, status: 'sent', sentOn: '2026-05-21', providerStatus: null, responseType: 'disputed', legacy: true },
    ])
  })

  it('reads a failed send as unknown unless the refusal is on record', async () => {
    const failed = { reminder_level: 1, status: 'failed', sent_at: null, provider_status: null, response_type: null, mode: 'approved' }
    const ctx = await load({
      invoice: invoiceRow(),
      reminders: [
        { ...failed, outcome_unknown: false },
        { ...failed, reminder_level: 2, outcome_unknown: true },
        { ...failed, reminder_level: 3, outcome_unknown: null },
      ],
    })
    expect(ctx.history.map((h) => h.outcomeUnknown)).toEqual([false, true, true])
  })

  it('refuses an invoice the company does not have', async () => {
    await expect(load({ invoice: null })).rejects.toBeInstanceOf(ReminderInvoiceNotFoundError)
  })
})
