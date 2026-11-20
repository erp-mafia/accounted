import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { pairAlreadyBookedMessages, pairSiblingAlreadyBooked, refuseWhenPairBooked } from '../inbox-pair-guard'

const COMPANY = 'company-1'
// The reported case (2026-10-15): one vendor mail, its invoice and its receipt, each booked as an utlägg.
const INVOICE_READ = {
  documentKind: 'supplier_invoice',
  supplier: { name: 'Anthropic, PBC' },
  invoice: { invoiceNumber: 'ANTH-2026-1015', invoiceDate: '2026-10-15', dueDate: '2026-10-15', currency: 'SEK' },
  totals: { total: 1879.2 },
}
const RECEIPT_READ = { ...INVOICE_READ, documentKind: 'receipt', payment: { method: 'card', cardLast4: '4242' } }

function row(id: string, extracted: unknown, overrides: Record<string, unknown> = {}) {
  return {
    id,
    status: 'received',
    source: 'email',
    document_id: `doc-${id}`,
    resend_email_id: 'mail-anthropic',
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

function db(rows: Array<Record<string, unknown>>, extra: Record<string, TableMockResolver | { data: unknown; error?: unknown }> = {}) {
  return createTableMockSupabase({
    invoice_inbox_items: (calls) => {
      if (calls.some((c) => c.method === 'maybeSingle')) {
        const id = calls.find((c) => c.method === 'eq' && c.args[0] === 'id')?.args[1]
        return { data: rows.find((r) => r.id === id) ?? null }
      }
      if (calls.some((c) => c.method === 'in' && c.args[0] === 'resend_email_id')) return { data: rows }
      return { data: [] }
    },
    arrival_outputs: { data: [] },
    journal_entries: { data: [{ id: 'je-66', voucher_series: 'A', voucher_number: 66, fiscal_period: { is_closed: false, locked_at: null } }] },
    ...extra,
  })
}

describe('pairSiblingAlreadyBooked', () => {
  it('the receipt booked as an utlägg: the invoice of the same mail is refused, naming A66', async () => {
    const { supabase } = db([row('invoice', INVOICE_READ), row('receipt', RECEIPT_READ, { created_journal_entry_id: 'je-66' })])
    expect(await pairSiblingAlreadyBooked(supabase as unknown as SupabaseClient, COMPANY, 'invoice')).toEqual({
      sibling_item_id: 'receipt',
      sibling_kind: 'receipt',
      journal_entry_id: 'je-66',
      voucher: 'A66',
      supplier_invoice_id: null,
    })
  })

  it('the invoice booked first: the receipt of the same mail is refused the same way', async () => {
    const { supabase } = db([row('invoice', INVOICE_READ, { created_journal_entry_id: 'je-66' }), row('receipt', RECEIPT_READ)])
    expect(await pairSiblingAlreadyBooked(supabase as unknown as SupabaseClient, COMPANY, 'receipt')).toMatchObject({ sibling_item_id: 'invoice', sibling_kind: 'invoice', voucher: 'A66' })
  })

  it('the invoice held by a verifikat with no stamp: the receipt is refused the same way, naming it', async () => {
    const { supabase } = db([row('invoice', INVOICE_READ, { document_hold: { journal_entry_id: 'je-66', entry: { status: 'posted' } } }), row('receipt', RECEIPT_READ)])
    expect(await pairSiblingAlreadyBooked(supabase as unknown as SupabaseClient, COMPANY, 'receipt')).toMatchObject({ sibling_item_id: 'invoice', sibling_kind: 'invoice', journal_entry_id: 'je-66', voucher: 'A66' })
  })

  it('a receipt whose invoice is registered as a supplier invoice, still unpaid, is refused: the payment books it', async () => {
    const { supabase } = db([row('invoice', INVOICE_READ, { created_supplier_invoice_id: 'si-1' }), row('receipt', RECEIPT_READ)], {
      supplier_invoices: { data: [{ id: 'si-1', status: 'registered', payment_journal_entry_id: null }] },
    })
    const found = await pairSiblingAlreadyBooked(supabase as unknown as SupabaseClient, COMPANY, 'receipt')
    expect(found).toMatchObject({ sibling_item_id: 'invoice', supplier_invoice_id: 'si-1', voucher: null })
    expect(pairAlreadyBookedMessages(found!).messageSv).toContain('registrerad som leverantörsfaktura')
  })

  it('refuses nothing for the first half of a pair still open, another amount, or an item alone', async () => {
    const bothOpen = db([row('invoice', INVOICE_READ), row('receipt', RECEIPT_READ)])
    expect(await pairSiblingAlreadyBooked(bothOpen.supabase as unknown as SupabaseClient, COMPANY, 'invoice')).toBeNull()
    const differ = db([row('invoice', INVOICE_READ), row('receipt', { ...RECEIPT_READ, totals: { total: 551.56 } }, { created_journal_entry_id: 'je-66' })])
    expect(await pairSiblingAlreadyBooked(differ.supabase as unknown as SupabaseClient, COMPANY, 'invoice')).toBeNull()
    const alone = db([row('invoice', INVOICE_READ)])
    expect(await pairSiblingAlreadyBooked(alone.supabase as unknown as SupabaseClient, COMPANY, 'invoice')).toBeNull()
  })

  it('a pairing that cannot be read refuses nothing', async () => {
    const { supabase } = createTableMockSupabase({ invoice_inbox_items: { data: null, error: { message: 'boom' } } })
    expect(await pairSiblingAlreadyBooked(supabase as unknown as SupabaseClient, COMPANY, 'invoice')).toBeNull()
  })
})

describe('refuseWhenPairBooked', () => {
  it('answers the structured code with the Swedish sentence naming the verifikat', async () => {
    const { supabase } = db([row('invoice', INVOICE_READ), row('receipt', RECEIPT_READ, { created_journal_entry_id: 'je-66' })])
    const refusal = await refuseWhenPairBooked(supabase as unknown as SupabaseClient, COMPANY, 'invoice')
    expect(refusal).toMatchObject({ ok: false, code: 'INBOX_ITEM_PAIR_ALREADY_BOOKED', details: { inbox_item_id: 'invoice', journal_entry_id: 'je-66' } })
    expect(refusal?.messageSv).toBe('Kvittot från samma köp är redan bokfört på verifikat A66. Lägg till det här underlaget där i stället, så bokförs köpet inte två gånger.')
    expect(refusal?.messageEn).toContain('voucher A66')
  })
})
