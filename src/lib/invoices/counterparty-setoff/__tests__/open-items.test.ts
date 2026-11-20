/**
 * loadCounterpartyBalance: one relation from every card of the party, the
 * open invoices of both sides with their set-off eligibility, the net per
 * currency and the set-offs. The mock answers each table from its own queue,
 * in the order the reads are made.
 */
import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { loadCounterpartyBalance } from '../open-items'

type Result = { data: unknown; error: null | { message: string } }

const ok = (data: unknown): Result => ({ data, error: null })

/**
 * createTableMockSupabase with the parties table answered by what each chain
 * asks (parallel reads make its order a scheduling detail): `parties.byId`
 * for a single row, the rows of `parties.rows` for an id lookup, and the rows
 * merged into the asked ids for a merged_into lookup.
 */
function tableMock(
  queues: Record<string, Result[]>,
  parties: { rows?: Array<{ id: string; merged_into: string | null }>; byId?: Record<string, unknown> } = {},
) {
  const partiesAnswer = (own: Array<{ method: string; args: unknown[] }>): Result => {
    const single = own.some((c) => c.method === 'maybeSingle')
    const idEq = own.find((c) => c.method === 'eq' && c.args[0] === 'id')
    if (single && idEq) return ok(parties.byId?.[idEq.args[1] as string] ?? null)
    const idIn = own.find((c) => c.method === 'in' && c.args[0] === 'id')
    if (idIn) return ok((parties.rows ?? []).filter((r) => (idIn.args[1] as string[]).includes(r.id)))
    const mergedIn = own.find((c) => c.method === 'in' && c.args[0] === 'merged_into')
    if (mergedIn) {
      return ok((parties.rows ?? []).filter((r) => r.merged_into && (mergedIn.args[1] as string[]).includes(r.merged_into)).map((r) => ({ id: r.id })))
    }
    return ok([])
  }
  // Every table not given answers an empty list.
  const empty = ['customers', 'suppliers', 'counterparty_setoffs', 'invoices', 'supplier_invoices', 'collection_cases', 'payment_orders', 'supplier_payment_batch_items']
  const { supabase, calls } = createTableMockSupabase({
    ...Object.fromEntries(empty.map((table) => [table, ok([])])),
    ...queues,
    parties: partiesAnswer,
  })
  return { supabase, calls }
}

function invoiceRow(over: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    invoice_number: '2631',
    external_invoice_number: null,
    status: 'sent',
    document_type: 'invoice',
    credited_invoice_id: null,
    currency: 'SEK',
    total: 1388,
    remaining_amount: 1388,
    paid_amount: 0,
    deduction_total: 0,
    invoice_date: '2026-08-31',
    due_date: '2026-09-10',
    journal_entry_id: 'je-inv',
    customer_id: 'cust-1',
    ...over,
  }
}

function supplierRow(over: Record<string, unknown> = {}) {
  return {
    id: 'si-1',
    supplier_invoice_number: 'SF-CE-202607',
    arrival_number: 41,
    status: 'registered',
    is_credit_note: false,
    currency: 'SEK',
    total: 4504,
    remaining_amount: 4504,
    paid_amount: 0,
    invoice_date: '2026-09-11',
    due_date: '2026-10-11',
    registration_journal_entry_id: 'je-si',
    bank_entered_at: null,
    supplier_id: 'sup-1',
    ...over,
  }
}

describe('loadCounterpartyBalance', () => {
  it("shows a two-way counterparty relation: both cards, both open invoices, we pay 3 116 kr net", async () => {
    const { supabase, calls } = tableMock({
      customers: [ok({ party_id: 'party-1' }), ok([{ id: 'cust-1', name: 'Exempel Energi AB (Anläggning Norr)' }])],
      suppliers: [ok([{ id: 'sup-1', name: 'Exempel Energi AB (Anläggning)' }])],
      counterparty_setoffs: [ok([])],
      invoices: [ok([invoiceRow()])],
      supplier_invoices: [ok([supplierRow()])],
      collection_cases: [ok([])],
      payment_orders: [ok([])],
      supplier_payment_batch_items: [ok([])],
    }, {
      rows: [{ id: 'party-1', merged_into: null }],
      byId: { 'party-1': { id: 'party-1', display_name: 'Exempel Energi', legal_name: 'Exempel Energi AB', org_number: '5599887766' } },
    })
    const balance = await loadCounterpartyBalance(supabase as never, 'company-1', { customerId: 'cust-1' })
    expect(balance).toEqual({
      party: { party_id: 'party-1', name: 'Exempel Energi AB', org_number: '5599887766' },
      customers: [{ customer_id: 'cust-1', name: 'Exempel Energi AB (Anläggning Norr)' }],
      suppliers: [{ supplier_id: 'sup-1', name: 'Exempel Energi AB (Anläggning)' }],
      receivables: [
        {
          invoice_id: 'inv-1',
          customer_id: 'cust-1',
          number: '2631',
          invoice_date: '2026-08-31',
          due_date: '2026-09-10',
          currency: 'SEK',
          total: 1388,
          remaining_amount: 1388,
          status: 'sent',
          setoff_eligible: true,
          ineligible_reason: null,
        },
      ],
      payables: [
        {
          supplier_invoice_id: 'si-1',
          supplier_id: 'sup-1',
          number: 'SF-CE-202607',
          arrival_number: 41,
          invoice_date: '2026-09-11',
          due_date: '2026-10-11',
          currency: 'SEK',
          total: 4504,
          remaining_amount: 4504,
          status: 'registered',
          setoff_eligible: true,
          ineligible_reason: null,
        },
      ],
      totals: [{ currency: 'SEK', receivable: 1388, payable: 4504, net: -3116, direction: 'we_pay' }],
      setoffs: [],
    })
    // Credit notes and other documents stay out of the open items.
    expect(calls).toContainEqual({ table: 'invoices', method: 'eq', args: ['document_type', 'invoice'] })
    expect(calls).toContainEqual({ table: 'invoices', method: 'is', args: ['credited_invoice_id', null] })
    expect(calls).toContainEqual({ table: 'supplier_invoices', method: 'eq', args: ['is_credit_note', false] })
    // Every card is company-scoped.
    expect(calls.filter((c) => c.method === 'eq' && c.args[0] === 'company_id').every((c) => c.args[1] === 'company-1')).toBe(true)
  })

  it('marks what cannot be set off now, and why', async () => {
    const { supabase } = tableMock({
      customers: [ok([{ id: 'cust-1', name: 'Exempel Energi' }])],
      suppliers: [ok([{ id: 'sup-1', name: 'Exempel Energi' }])],
      counterparty_setoffs: [
        ok([{ id: 'set-0', setoff_date: '2026-09-30', amount: '500.00', status: 'reversed', invoice_id: 'inv-0', supplier_invoice_id: 'si-0', journal_entry_id: 'je-0', note: null }]),
      ],
      invoices: [ok([invoiceRow(), invoiceRow({ id: 'inv-2', invoice_number: '2632', currency: 'EUR', total: 100, remaining_amount: 100 })])],
      supplier_invoices: [ok([supplierRow(), supplierRow({ id: 'si-2', supplier_invoice_number: null, arrival_number: 42, total: 200, remaining_amount: 200 })])],
      collection_cases: [ok([{ invoice_id: 'inv-1' }])],
      payment_orders: [ok([{ supplier_invoice_id: 'si-2', status: 'approved', supplier_invoice_payment_id: null }])],
      supplier_payment_batch_items: [ok([])],
    }, {
      rows: [{ id: 'party-1', merged_into: null }],
      byId: { 'party-1': { id: 'party-1', display_name: 'Exempel Energi', legal_name: null, org_number: null } },
    })
    const balance = await loadCounterpartyBalance(supabase as never, 'company-1', { partyId: 'party-1' })
    expect(balance?.receivables.map((r) => [r.invoice_id, r.ineligible_reason])).toEqual([
      ['inv-1', 'collection_open'],
      ['inv-2', 'currency'],
    ])
    expect(balance?.payables.map((p) => [p.supplier_invoice_id, p.ineligible_reason])).toEqual([
      ['si-1', null],
      ['si-2', 'payment_in_flight'],
    ])
    expect(balance?.totals).toEqual([
      { currency: 'EUR', receivable: 100, payable: 0, net: 100, direction: 'they_pay' },
      { currency: 'SEK', receivable: 1388, payable: 4704, net: -3316, direction: 'we_pay' },
    ])
    expect(balance?.party.name).toBe('Exempel Energi')
    expect(balance?.setoffs).toEqual([
      { setoff_id: 'set-0', setoff_date: '2026-09-30', amount: 500, status: 'reversed', invoice_id: 'inv-0', supplier_invoice_id: 'si-0', journal_entry_id: 'je-0', note: null },
    ])
  })

  it('follows a merged party to its survivor and gathers the cards of every merged party', async () => {
    const { supabase, calls } = tableMock({
      suppliers: [ok({ party_id: 'party-old' }), ok([{ id: 'sup-1', name: 'Exempel Energi' }])],
      customers: [ok([])],
      counterparty_setoffs: [ok([])],
      supplier_invoices: [ok([])],
    }, {
      rows: [
        { id: 'party-old', merged_into: 'party-1' },
        { id: 'party-1', merged_into: null },
      ],
      byId: { 'party-1': { id: 'party-1', display_name: 'Exempel Energi', legal_name: null, org_number: '5599887766' } },
    })
    const balance = await loadCounterpartyBalance(supabase as never, 'company-1', { supplierId: 'sup-1' })
    expect(balance?.party.party_id).toBe('party-1')
    expect(calls).toContainEqual({ table: 'suppliers', method: 'in', args: ['party_id', ['party-1', 'party-old']] })
    expect(balance?.totals).toEqual([])
  })

  it('answers null for a card without a party', async () => {
    const { supabase } = tableMock({ customers: [ok({ party_id: null })] })
    expect(await loadCounterpartyBalance(supabase as never, 'company-1', { customerId: 'cust-1' })).toBeNull()
  })

  it('throws on a failed read instead of answering a partial balance', async () => {
    const { supabase } = tableMock(
      { customers: [{ data: null, error: { message: 'boom' } }] },
      { rows: [{ id: 'party-1', merged_into: null }], byId: { 'party-1': { id: 'party-1', display_name: 'X', legal_name: null, org_number: null } } },
    )
    await expect(loadCounterpartyBalance(supabase as never, 'company-1', { partyId: 'party-1' })).rejects.toThrow(/customer cards lookup failed/)
  })
})
