import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { readInboxPairings } from '../inbox-pairings'

const COMPANY = 'company-1'

const INVOICE_READ = {
  documentKind: 'supplier_invoice',
  supplier: { name: 'Resend, Inc.' },
  invoice: { invoiceNumber: 'INV-2026-10', invoiceDate: '2026-10-01', dueDate: '2026-10-01', currency: 'USD' },
  totals: { total: 20 },
}
const RECEIPT_READ = { ...INVOICE_READ, documentKind: 'receipt', payment: { method: 'card', cardLast4: '3667' } }

function item(id: string, extracted: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: 'received',
    source: 'email',
    document_id: `doc-${id}`,
    resend_email_id: 'mail-resend',
    channel_context: null,
    kind_hint: null,
    extracted_data: extracted,
    routed_to_arkiv_at: null,
    matched_transaction_id: null,
    created_supplier_invoice_id: null,
    created_journal_entry_id: null,
    ...overrides,
  }
}

/** The mail's attachments for the sibling read; arrivals none. */
function db(siblings: unknown[], extra: Record<string, TableMockResolver | { data: unknown; error?: unknown }> = {}) {
  return createTableMockSupabase({
    invoice_inbox_items: (calls) => (calls.some((c) => c.method === 'in' && c.args[0] === 'resend_email_id') ? { data: siblings } : { data: [] }),
    arrival_outputs: { data: [] },
    ...extra,
  })
}

const ENTRY = { id: 'je-41', voucher_series: 'A', voucher_number: 41, fiscal_period: { is_closed: false, locked_at: null } }

describe('readInboxPairings for a door that has the open items only (the Att göra count)', () => {
  it('reads the delivery and finds the booked receipt of an open invoice, with its verifikat', async () => {
    const invoice = item('invoice', INVOICE_READ)
    const booked = item('receipt', RECEIPT_READ, { created_journal_entry_id: 'je-41' })
    const { supabase, findCalls } = db([invoice, booked], { journal_entries: { data: [ENTRY] } })
    const pairings = await readInboxPairings(supabase as unknown as SupabaseClient, COMPANY, [invoice], { readDeliveries: true })
    expect(pairings.get('invoice')).toEqual({
      role: 'booked_companion',
      booked_item_id: 'receipt',
      booked_kind: 'receipt',
      basis: 'invoice_number',
      journal_entry_id: 'je-41',
      voucher: 'A41',
      locked: false,
    })
    // Every read in this company.
    expect(findCalls('invoice_inbox_items', 'eq')).toContainEqual(['company_id', COMPANY])
    expect(findCalls('journal_entries', 'eq')).toContainEqual(['company_id', COMPANY])
  })

  it('an open receipt whose invoice is registered and paid rides on the payment verifikat', async () => {
    const paid = item('invoice', INVOICE_READ, { created_supplier_invoice_id: 'si-1' })
    const receipt = item('receipt', RECEIPT_READ)
    const { supabase } = db([paid, receipt], {
      supplier_invoices: { data: [{ id: 'si-1', status: 'paid', payment_journal_entry_id: 'je-41' }] },
      journal_entries: { data: [ENTRY] },
    })
    const pairings = await readInboxPairings(supabase as unknown as SupabaseClient, COMPANY, [receipt], { readDeliveries: true })
    expect(pairings.get('receipt')).toMatchObject({ role: 'booked_companion', booked_item_id: 'invoice', booked_kind: 'invoice', voucher: 'A41', locked: false })
  })

  it('an open receipt whose invoice is registered and unpaid waits with it as its companion', async () => {
    const registered = item('invoice', INVOICE_READ, { created_supplier_invoice_id: 'si-1' })
    const receipt = item('receipt', RECEIPT_READ)
    const { supabase } = db([registered, receipt], { supplier_invoices: { data: [{ id: 'si-1', status: 'registered', payment_journal_entry_id: null }] } })
    const pairings = await readInboxPairings(supabase as unknown as SupabaseClient, COMPANY, [receipt], { readDeliveries: true })
    expect(pairings.get('receipt')).toEqual({ role: 'receipt', invoice_item_id: 'invoice', basis: 'invoice_number' })
  })

  it('says a locked verifikat is locked', async () => {
    const invoice = item('invoice', INVOICE_READ)
    const booked = item('receipt', RECEIPT_READ, { created_journal_entry_id: 'je-41' })
    const { supabase } = db([invoice, booked], { journal_entries: { data: [{ ...ENTRY, fiscal_period: { is_closed: true, locked_at: null } }] } })
    const pairings = await readInboxPairings(supabase as unknown as SupabaseClient, COMPANY, [invoice], { readDeliveries: true })
    expect(pairings.get('invoice')).toMatchObject({ role: 'booked_companion', locked: true })
  })

  it('pairs nothing for halves with different amounts, and reads nothing for items that cannot pair', async () => {
    const invoice = item('invoice', INVOICE_READ)
    const booked = item('receipt', { ...RECEIPT_READ, totals: { total: 25 } }, { created_journal_entry_id: 'je-41' })
    const differ = db([invoice, booked], { journal_entries: { data: [ENTRY] } })
    expect((await readInboxPairings(differ.supabase as unknown as SupabaseClient, COMPANY, [invoice], { readDeliveries: true })).size).toBe(0)

    const unread = db([])
    expect((await readInboxPairings(unread.supabase as unknown as SupabaseClient, COMPANY, [item('x', null)], { readDeliveries: true })).size).toBe(0)
    expect(unread.findCalls('invoice_inbox_items', 'select')).toEqual([])
  })
})
