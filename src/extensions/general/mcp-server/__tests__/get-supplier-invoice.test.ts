/**
 * Tests for gnubok_get_supplier_invoice: the supplier twin of
 * gnubok_get_invoice. Agents of every client guessed this name and, finding
 * nothing, rebuilt an invoice from the list and the journal, which cannot
 * tell two payments of the same amount apart. The tool returns the header,
 * the lines and the payments with the verifikat each one points at; voucher
 * labels repeat per fiscal year, so every reference carries its entry date.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { ALL_SCOPES, TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'

import { tools, callableViaFor } from '../server'

const getSupplierInvoice = tools.find((t) => t.name === 'gnubok_get_supplier_invoice')!

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SUPPLIER_INVOICE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const SUPPLIER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const REGISTRATION_JE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const PAYMENT_JE_1 = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const PAYMENT_JE_2 = '99999999-9999-4999-8999-999999999999'

function supplierInvoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SUPPLIER_INVOICE_ID,
    supplier_id: SUPPLIER_ID,
    arrival_number: 22,
    supplier_invoice_number: '0647634513',
    invoice_date: '2026-09-02',
    due_date: '2026-09-30',
    status: 'paid',
    currency: 'SEK',
    exchange_rate: null,
    total: 413.5,
    total_sek: 413.5,
    vat_amount: 0,
    paid_amount: 413.5,
    remaining_amount: 0,
    approved_at: '2026-09-03T08:00:00Z',
    auto_debit: false,
    is_credit_note: false,
    credited_invoice_id: null,
    document_id: 'doc-1',
    registration_journal_entry_id: REGISTRATION_JE,
    payment_journal_entry_id: PAYMENT_JE_2,
    supplier: { name: 'Synthetic Finans AB' },
    // Deliberately out of display order: PostgREST does not order embeds.
    items: [
      { id: 'item-2', sort_order: 2, description: 'Avgift', quantity: 1, unit: 'st', unit_price: 13.5, line_total: 13.5, account_number: '6570', vat_code: null, vat_rate: 0, vat_amount: 0, dimensions: null },
      { id: 'item-1', sort_order: 1, description: 'Ränta', quantity: 1, unit: 'st', unit_price: 400, line_total: 400, account_number: '8410', vat_code: null, vat_rate: 0, vat_amount: 0, dimensions: null },
    ],
    payments: [
      { id: 'pay-2', payment_date: '2026-09-30', amount: 206.75, currency: 'SEK', exchange_rate: null, exchange_rate_difference: null, journal_entry_id: PAYMENT_JE_2, transaction_id: 'tx-2', notes: null, created_at: '2026-09-30T10:00:00Z' },
      { id: 'pay-1', payment_date: '2026-09-15', amount: 206.75, currency: 'SEK', exchange_rate: null, exchange_rate_difference: null, journal_entry_id: PAYMENT_JE_1, transaction_id: 'tx-1', notes: null, created_at: '2026-09-15T10:00:00Z' },
    ],
    ...overrides,
  }
}

const journalEntryRows = [
  { id: REGISTRATION_JE, voucher_series: 'D', voucher_number: 24, entry_date: '2026-09-02', status: 'posted' },
  { id: PAYMENT_JE_1, voucher_series: 'E', voucher_number: 7, entry_date: '2026-09-15', status: 'posted' },
  { id: PAYMENT_JE_2, voucher_series: 'E', voucher_number: 9, entry_date: '2026-09-30', status: 'posted' },
]

function run(supabase: unknown, args: Record<string, unknown> = { supplier_invoice_id: SUPPLIER_INVOICE_ID }) {
  return getSupplierInvoice.execute(args, COMPANY_ID, USER_ID, supabase as never, { type: 'api_key' } as never) as Promise<
    Record<string, unknown> & { items: Array<Record<string, unknown>>; payments: Array<Record<string, unknown>> }
  >
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_get_supplier_invoice: registration', () => {
  it('is a plain read-only tool (not a staged operation)', () => {
    expect(getSupplierInvoice).toBeDefined()
    expect(getSupplierInvoice.annotations.readOnlyHint).toBe(true)
    expect(getSupplierInvoice.annotations.destructiveHint).toBe(false)
    expect(getSupplierInvoice.annotations.idempotentHint).toBe(true)
    const outputProps = (getSupplierInvoice.outputSchema as { properties: Record<string, unknown> }).properties
    expect(outputProps.staged).toBeUndefined()
    expect(outputProps.id).toBeUndefined()
  })

  it('requires supplier_invoice_id and rejects unknown input properties', () => {
    const schema = getSupplierInvoice.inputSchema as { additionalProperties: boolean; required: string[] }
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['supplier_invoice_id'])
  })

  it('is mapped to suppliers:read, like the list tool', () => {
    expect(TOOL_SCOPE_MAP.gnubok_get_supplier_invoice).toBe('suppliers:read')
  })

  it('is search-only but reachable through gnubok_call_tool', () => {
    expect(getSupplierInvoice.catalogVisibility).toBe('search')
    expect(
      callableViaFor(getSupplierInvoice, { anonymous: false, simpleCompanyMode: false, keyScopes: [...ALL_SCOPES] }),
    ).toBe('call_tool')
  })

  it('keeps its description within the 280-char budget and names where ids come from', () => {
    expect(getSupplierInvoice.description.length).toBeLessThanOrEqual(280)
    expect(getSupplierInvoice.description).toContain('gnubok_list_supplier_invoices')
  })
})

describe('gnubok_get_supplier_invoice: execute', () => {
  it('returns the header, lines in display order and payments in date order with their verifikat', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: supplierInvoiceRow() })
    enqueue({ data: journalEntryRows })

    const result = await run(supabase)

    expect(result).toMatchObject({
      supplier_invoice_id: SUPPLIER_INVOICE_ID,
      supplier_id: SUPPLIER_ID,
      supplier_name: 'Synthetic Finans AB',
      arrival_number: 22,
      supplier_invoice_number: '0647634513',
      status: 'paid',
      total: 413.5,
      remaining_amount: 0,
      auto_debit: false,
      document_id: 'doc-1',
      item_count: 2,
      registration_voucher: { journal_entry_id: REGISTRATION_JE, voucher: 'D24', entry_date: '2026-09-02', status: 'posted' },
      payment_voucher: { journal_entry_id: PAYMENT_JE_2, voucher: 'E9', entry_date: '2026-09-30', status: 'posted' },
    })
    expect(result.id).toBeUndefined()
    expect(result.supplier).toBeUndefined()

    expect(result.items.map((item) => item.supplier_invoice_item_id)).toEqual(['item-1', 'item-2'])
    expect(result.items[0]).toEqual({
      supplier_invoice_item_id: 'item-1',
      description: 'Ränta',
      quantity: 1,
      unit: 'st',
      unit_price: 400,
      line_total: 400,
      account_number: '8410',
      vat_code: null,
      vat_rate: 0,
      vat_amount: 0,
      dimensions: null,
    })

    // Two payments of the same amount: the verifikat and the bank
    // transaction are what tell them apart.
    expect(result.payments).toEqual([
      {
        supplier_invoice_payment_id: 'pay-1',
        payment_date: '2026-09-15',
        amount: 206.75,
        currency: 'SEK',
        exchange_rate: null,
        exchange_rate_difference: null,
        journal_entry_id: PAYMENT_JE_1,
        transaction_id: 'tx-1',
        notes: null,
        voucher: { journal_entry_id: PAYMENT_JE_1, voucher: 'E7', entry_date: '2026-09-15', status: 'posted' },
      },
      {
        supplier_invoice_payment_id: 'pay-2',
        payment_date: '2026-09-30',
        amount: 206.75,
        currency: 'SEK',
        exchange_rate: null,
        exchange_rate_difference: null,
        journal_entry_id: PAYMENT_JE_2,
        transaction_id: 'tx-2',
        notes: null,
        voucher: { journal_entry_id: PAYMENT_JE_2, voucher: 'E9', entry_date: '2026-09-30', status: 'posted' },
      },
    ])

    // Both reads are scoped to the routed company.
    expect(findCalls('supplier_invoices', 'eq')).toContainEqual(['company_id', COMPANY_ID])
    expect(findCalls('supplier_invoices', 'eq')).toContainEqual(['id', SUPPLIER_INVOICE_ID])
    expect(findCalls('journal_entries', 'eq')).toContainEqual(['company_id', COMPANY_ID])
    const [[, ids]] = findCalls('journal_entries', 'in') as [[string, string[]]]
    expect([...ids].sort()).toEqual([REGISTRATION_JE, PAYMENT_JE_1, PAYMENT_JE_2].sort())
  })

  it('selects one literal column list, never the payee account columns', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: supplierInvoiceRow() })
    enqueue({ data: journalEntryRows })

    await run(supabase)

    const [[select]] = findCalls('supplier_invoices', 'select') as [[string]]
    expect(select).toContain('registration_journal_entry_id')
    expect(select).toContain('auto_debit')
    expect(select).not.toMatch(/payee_/)
    expect(select).not.toContain('*')
  })

  it('reads no journal entries for an invoice nothing has booked yet', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: supplierInvoiceRow({
        status: 'registered',
        registration_journal_entry_id: null,
        payment_journal_entry_id: null,
        paid_amount: 0,
        remaining_amount: 413.5,
        payments: [],
      }),
    })

    const result = await run(supabase)

    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(result.registration_voucher).toBeNull()
    expect(result.payment_voucher).toBeNull()
    expect(result.payments).toEqual([])
  })

  it('gives a draft verifikat no voucher label', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: supplierInvoiceRow({ payment_journal_entry_id: null, payments: [] }) })
    enqueue({ data: [{ id: REGISTRATION_JE, voucher_series: 'D', voucher_number: null, entry_date: '2026-09-02', status: 'draft' }] })

    const result = await run(supabase)

    expect(result.registration_voucher).toEqual({ journal_entry_id: REGISTRATION_JE, voucher: null, entry_date: '2026-09-02', status: 'draft' })
  })

  it('refuses an id that is not a UUID before reading anything', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(run(supabase, { supplier_invoice_id: 'D-24' })).rejects.toThrow(/supplier_invoice_id must be a supplier invoice UUID/)
    await expect(run(supabase, {})).rejects.toThrow(/supplier_invoice_id must be a supplier invoice UUID/)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('throws not found for an invoice outside the routed company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    await expect(run(supabase)).rejects.toThrow(/supplier invoice not found/i)
  })

  it('fails the call when the invoice cannot be read', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'connection reset' } })

    await expect(run(supabase)).rejects.toThrow(/Database error/)
  })

  it('fails the call when the verifikat cannot be read, never reporting them as unbooked', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: supplierInvoiceRow() })
    enqueue({ data: null, error: { message: 'connection reset' } })

    await expect(run(supabase)).rejects.toThrow(/Database error/)
  })
})
