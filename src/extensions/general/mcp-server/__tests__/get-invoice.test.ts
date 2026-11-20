/**
 * Tests for gnubok_get_invoice (issue #1642).
 *
 * The round-trip read surface for gnubok_update_invoice: its items are a
 * FULL REPLACE and no other MCP tool returned invoice lines, so an agent
 * fixing a quantity had to rebuild the lines from memory and silently dropped
 * article_id / revenue_account / vat_rate. This tool returns every line with
 * its booking fields in display order, plus editable_draft so the agent knows
 * whether an edit is possible at all. Privacy contract: the invoices row
 * carries the encrypted ROT/RUT personnummer; the tool maps an explicit field
 * list and this suite pins that nothing else leaks.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { ALL_SCOPES, TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'

import { tools, callableViaFor } from '../server'

const getInvoice = tools.find((t) => t.name === 'gnubok_get_invoice')!

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const USER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const INVOICE_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CUSTOMER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const ARTICLE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'

function invoiceRow(overrides: Record<string, unknown> = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: null,
    status: 'draft',
    document_type: 'invoice',
    customer_id: CUSTOMER_ID,
    invoice_date: '2026-08-01',
    due_date: '2026-08-31',
    delivery_date: null,
    currency: 'SEK',
    subtotal: 3400,
    vat_amount: 850,
    total: 4250,
    paid_amount: 0,
    remaining_amount: 4250,
    // The invoice's own öresavrundning choice, so no company read is needed.
    ore_rounding: true,
    deduction_total: 0,
    your_reference: 'Anna',
    our_reference: null,
    notes: null,
    default_dimensions: { '1': 'KS01' },
    journal_entry_id: null,
    is_self_billed: false,
    credited_invoice_id: null,
    customer: { name: 'Synthetic Kund AB' },
    // Deliberately out of display order: PostgREST does not order embeds.
    items: [
      {
        id: 'item-2',
        sort_order: 2,
        line_type: 'product',
        description: 'Resa',
        quantity: 1,
        unit: 'st',
        unit_price: 1000,
        line_total: 1000,
        vat_rate: 25,
        vat_amount: 250,
        article_id: null,
        revenue_account: null,
        deduction_type: null,
        labor_hours: null,
        work_type: null,
        housing_designation: null,
        apartment_number: null,
        brf_org_number: null,
        accrual_period_start: null,
        accrual_period_end: null,
        accrual_balance_account: null,
        dimensions: null,
      },
      {
        id: 'item-1',
        sort_order: 1,
        line_type: 'product',
        description: 'Konsulttimme',
        quantity: 2,
        unit: 'tim',
        unit_price: 1200,
        line_total: 2400,
        vat_rate: 25,
        vat_amount: 600,
        article_id: ARTICLE_ID,
        revenue_account: '3041',
        deduction_type: null,
        labor_hours: null,
        work_type: null,
        housing_designation: null,
        apartment_number: null,
        brf_org_number: null,
        accrual_period_start: null,
        accrual_period_end: null,
        accrual_balance_account: null,
        dimensions: { '6': 'P001' },
      },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_get_invoice: registration', () => {
  it('is registered as a plain read-only tool (not a staged operation)', () => {
    expect(getInvoice).toBeDefined()
    expect(getInvoice.annotations.readOnlyHint).toBe(true)
    expect(getInvoice.annotations.destructiveHint).toBe(false)
    expect(getInvoice.annotations.idempotentHint).toBe(true)
    const outputProps = (getInvoice.outputSchema as { properties: Record<string, unknown> }).properties
    expect(outputProps.items).toBeDefined()
    expect(outputProps.editable_draft).toBeDefined()
    expect(outputProps.staged).toBeUndefined()
  })

  it('requires invoice_id and rejects unknown input properties', () => {
    const schema = getInvoice.inputSchema as { additionalProperties: boolean; required: string[] }
    expect(schema.additionalProperties).toBe(false)
    expect(schema.required).toEqual(['invoice_id'])
  })

  it('is mapped to invoices:read scope', () => {
    expect(TOOL_SCOPE_MAP.gnubok_get_invoice).toBe('invoices:read')
  })

  it('is search-only in the catalog but bridged, and the update tool says so', () => {
    // payload-size.bench.test.ts sits at its ceiling. A search-only READ is
    // still reachable through gnubok_call_tool, unlike the update tool it
    // serves, which had to join the default catalog (issue #2748) and now
    // names the bridge so an agent that only knows tools/list gets here.
    expect(getInvoice.catalogVisibility).toBe('search')
    expect(
      callableViaFor(getInvoice, { anonymous: false, simpleCompanyMode: false, keyScopes: [...ALL_SCOPES] }),
    ).toBe('call_tool')
    const updateInvoice = tools.find((t) => t.name === 'gnubok_update_invoice')!
    const itemsNote = (updateInvoice.inputSchema as { properties: { items: { description: string } } })
      .properties.items.description
    expect(updateInvoice.description).toContain('gnubok_get_invoice')
    expect(updateInvoice.description).toContain('gnubok_call_tool')
    expect(itemsNote).toContain('gnubok_call_tool')
  })

  it('keeps its description within the 280-char budget and names the update tool', () => {
    expect(getInvoice.description.length).toBeLessThanOrEqual(280)
    expect(getInvoice.description).toContain('gnubok_update_invoice')
  })

  it('exposes the booking fields per line in the output schema', () => {
    const itemProps = (
      getInvoice.outputSchema as { properties: { items: { items: { properties: Record<string, unknown> } } } }
    ).properties.items.items.properties
    for (const key of ['invoice_item_id', 'article_id', 'revenue_account', 'vat_rate', 'line_total', 'deduction_type', 'housing_designation', 'apartment_number', 'brf_org_number', 'accrual_period_start', 'dimensions']) {
      expect(itemProps[key], key).toBeDefined()
    }
    expect(itemProps.id).toBeUndefined()
  })
})

describe('gnubok_get_invoice: execute', () => {
  it('returns the header and every line in sort order with its booking fields', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: invoiceRow() })

    const result = (await getInvoice.execute(
      { invoice_id: INVOICE_ID },
      COMPANY_ID,
      USER_ID,
      supabase as never,
      { type: 'api_key' } as never,
    )) as Record<string, unknown> & { items: Array<Record<string, unknown>> }

    expect(result).toMatchObject({
      invoice_id: INVOICE_ID,
      invoice_number: null,
      status: 'draft',
      document_type: 'invoice',
      customer_id: CUSTOMER_ID,
      customer_name: 'Synthetic Kund AB',
      currency: 'SEK',
      subtotal: 3400,
      vat_amount: 850,
      total: 4250,
      remaining_amount: 4250,
      your_reference: 'Anna',
      default_dimensions: { '1': 'KS01' },
      editable_draft: true,
      item_count: 2,
    })
    expect(result.items.map((i) => i.invoice_item_id)).toEqual(['item-1', 'item-2'])
    expect(result.items[0]).toEqual({
      invoice_item_id: 'item-1',
      line_type: 'product',
      description: 'Konsulttimme',
      quantity: 2,
      unit: 'tim',
      unit_price: 1200,
      discount_percent: 0,
      line_total: 2400,
      vat_rate: 25,
      vat_amount: 600,
      article_id: ARTICLE_ID,
      revenue_account: '3041',
      deduction_type: null,
      labor_hours: null,
      work_type: null,
      housing_designation: null,
      apartment_number: null,
      brf_org_number: null,
      accrual_period_start: null,
      accrual_period_end: null,
      accrual_balance_account: null,
      dimensions: { '6': 'P001' },
    })
    expect(result.items[1]).toMatchObject({ article_id: null, revenue_account: null, dimensions: {} })
    // Company scoping is explicit (defense in depth: service-role paths have no RLS).
    expect(supabase.from).toHaveBeenCalledTimes(1)
    expect(supabase.from).toHaveBeenCalledWith('invoices')
    expect(findCalls('invoices', 'eq')).toContainEqual(['company_id', COMPANY_ID])
    expect(findCalls('invoices', 'eq')).toContainEqual(['id', INVOICE_ID])
  })

  // crm#1367: a received self-billed sale has invoice_number null by design;
  // the customer's number is how an agent matches it to the document.
  it('returns the self-billed flag and the customer\'s number on a received self-bill', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: invoiceRow({
        status: 'paid',
        invoice_number: null,
        external_invoice_number: 'S2441',
        is_self_billed: true,
        journal_entry_id: 'je-1',
      }),
    })

    const result = (await getInvoice.execute(
      { invoice_id: INVOICE_ID },
      COMPANY_ID,
      USER_ID,
      supabase as never,
      { type: 'api_key' } as never,
    )) as Record<string, unknown>

    expect(String(findCall('invoices', 'select')?.[0])).toContain('external_invoice_number')
    expect(result).toMatchObject({ invoice_number: null, external_invoice_number: 'S2441', is_self_billed: true })
  })

  it('returns external_invoice_number null and is_self_billed false on an invoice we issued', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: invoiceRow() })

    const result = (await getInvoice.execute(
      { invoice_id: INVOICE_ID },
      COMPANY_ID,
      USER_ID,
      supabase as never,
      { type: 'api_key' } as never,
    )) as Record<string, unknown>

    expect(result).toMatchObject({ external_invoice_number: null, is_self_billed: false })
  })

  it('declares the self-billing fields in its output schema', () => {
    const props = (getInvoice.outputSchema as { properties: Record<string, unknown> }).properties
    expect(props).toHaveProperty('external_invoice_number')
    expect(props).toHaveProperty('is_self_billed')
  })

  it('reports editable_draft false for an issued invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: invoiceRow({ status: 'sent', invoice_number: '2026-0042', journal_entry_id: 'je-1' }) })

    const result = (await getInvoice.execute(
      { invoice_id: INVOICE_ID },
      COMPANY_ID,
      USER_ID,
      supabase as never,
      { type: 'api_key' } as never,
    )) as { editable_draft: boolean; invoice_number: string | null }

    expect(result.editable_draft).toBe(false)
    expect(result.invoice_number).toBe('2026-0042')
  })

  it('reports a sent invoice past its due date as overdue, as gnubok_list_invoices does (crm#1084)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-13T08:00:00Z'))
    try {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: invoiceRow({ status: 'sent', invoice_number: '2026-0042', journal_entry_id: 'je-1' }) })
      const result = (await getInvoice.execute(
        { invoice_id: INVOICE_ID },
        COMPANY_ID,
        USER_ID,
        supabase as never,
        { type: 'api_key' } as never,
      )) as { status: string }
      expect(result.status).toBe('overdue')
    } finally {
      vi.useRealTimers()
    }
  })

  it('returns an empty line list for a draft without lines', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: invoiceRow({ items: [] }) })

    const result = (await getInvoice.execute(
      { invoice_id: INVOICE_ID },
      COMPANY_ID,
      USER_ID,
      supabase as never,
      { type: 'api_key' } as never,
    )) as { items: unknown[]; item_count: number }

    expect(result.items).toEqual([])
    expect(result.item_count).toBe(0)
  })

  it('returns the ROT property identifiers per line so a deduction draft can round-trip', async () => {
    // The housing columns are property identifiers, not personal data; without
    // them an items update on a ROT draft fails at approval with
    // 'Fastighetsbeteckning kravs for ROT-avdrag' (rot-rut-rules.ts).
    const { supabase, enqueue } = createQueuedMockSupabase()
    const base = invoiceRow()
    const items = (base.items as Array<Record<string, unknown>>).map((row) =>
      row.id === 'item-1'
        ? {
            ...row,
            deduction_type: 'rot',
            labor_hours: 10,
            work_type: 'EL',
            housing_designation: 'Almgren 1:23',
            apartment_number: '1101',
            brf_org_number: '769600-1234',
          }
        : row,
    )
    enqueue({ data: { ...base, items } })

    const result = (await getInvoice.execute(
      { invoice_id: INVOICE_ID },
      COMPANY_ID,
      USER_ID,
      supabase as never,
      { type: 'api_key' } as never,
    )) as { items: Array<Record<string, unknown>> }

    expect(result.items[0]).toMatchObject({
      deduction_type: 'rot',
      labor_hours: 10,
      work_type: 'EL',
      housing_designation: 'Almgren 1:23',
      apartment_number: '1101',
      brf_org_number: '769600-1234',
    })
  })

  it('never returns the encrypted ROT/RUT personnummer columns even if selected by mistake', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: invoiceRow({
        deduction_personnummer_encrypted: 'LEAKED-CIPHERTEXT',
        deduction_personnummer_last4: '1234',
      }),
    })

    const result = await getInvoice.execute(
      { invoice_id: INVOICE_ID },
      COMPANY_ID,
      USER_ID,
      supabase as never,
      { type: 'api_key' } as never,
    )

    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain('LEAKED-CIPHERTEXT')
    expect(serialized).not.toContain('deduction_personnummer')
  })

  it('throws Invoice not found for an invoice outside the routed company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    await expect(
      getInvoice.execute(
        { invoice_id: INVOICE_ID },
        COMPANY_ID,
        USER_ID,
        supabase as never,
        { type: 'api_key' } as never,
      ),
    ).rejects.toThrow(/invoice not found/i)
  })

  it('requires invoice_id', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      getInvoice.execute({}, COMPANY_ID, USER_ID, supabase as never, { type: 'api_key' } as never),
    ).rejects.toThrow(/invoice_id is required/)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('surfaces a database error instead of reporting a missing invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'connection reset' } })

    await expect(
      getInvoice.execute(
        { invoice_id: INVOICE_ID },
        COMPANY_ID,
        USER_ID,
        supabase as never,
        { type: 'api_key' } as never,
      ),
    ).rejects.toThrow(/Database error/)
  })
})

/**
 * crm#1131: an invoice registered from the books (gnubok_register_booked_invoice)
 * has no lines by design, and its original is the underlag on the verifikat
 * that booked it. An agent that saw only `items: []` reported the original as
 * never imported, so the read says what the row is and where the original is.
 */
describe('gnubok_get_invoice: registered from the books', () => {
  const JOURNAL_ENTRY_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
  const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111'
  const OTHER_DOCUMENT_ID = '22222222-2222-4222-8222-222222222222'

  const registeredRow = (overrides: Record<string, unknown> = {}) =>
    invoiceRow({
      status: 'sent',
      invoice_number: 'OLD-7',
      journal_entry_id: JOURNAL_ENTRY_ID,
      items: [],
      // Not yet due: past its due date a sent invoice reports overdue.
      due_date: '2099-12-31',
      ...overrides,
    })
  const voucherRow = { id: JOURNAL_ENTRY_ID, voucher_series: 'A', voucher_number: 47 }

  const run = (supabase: unknown) =>
    getInvoice.execute(
      { invoice_id: INVOICE_ID },
      COMPANY_ID,
      USER_ID,
      supabase as never,
      { type: 'api_key' } as never,
    ) as Promise<Record<string, unknown>>

  it('declares the marker as always present and the verifikat fields as optional', () => {
    const schema = getInvoice.outputSchema as {
      properties: Record<string, { type: unknown }>
      required: string[]
    }
    expect(schema.properties.registered_from_books.type).toBe('boolean')
    expect(schema.required).toContain('registered_from_books')
    // Emitted as null for an unbooked invoice: a bare string type would fail
    // strict clients on a successful call.
    expect(schema.properties.journal_entry_id.type).toContain('null')
    for (const key of ['voucher_label', 'voucher_document_ids', 'note']) {
      expect(schema.properties[key], key).toBeDefined()
      expect(schema.required).not.toContain(key)
    }
  })

  it('names the verifikat and its attached documents, and says the original is there', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: registeredRow() })
    enqueue({ data: voucherRow })
    enqueue({ data: [{ id: DOCUMENT_ID }, { id: OTHER_DOCUMENT_ID }] })

    const result = await run(supabase)

    expect(result).toMatchObject({
      status: 'sent',
      items: [],
      item_count: 0,
      editable_draft: false,
      journal_entry_id: JOURNAL_ENTRY_ID,
      registered_from_books: true,
      voucher_label: 'A47',
      voucher_document_ids: [DOCUMENT_ID, OTHER_DOCUMENT_ID],
    })
    const note = result.note as string
    expect(note).toContain('no lines by design')
    expect(note).toContain('verifikat A47')
    expect(note).toContain('gnubok_get_document_content')
    expect(note).not.toContain('gnubok_link_document_to_voucher')

    // Service-role reads: both are scoped to the routed company, and the
    // documents are the verifikat's current versions, as its page lists them.
    expect(findCalls('journal_entries', 'eq')).toContainEqual(['company_id', COMPANY_ID])
    expect(findCalls('journal_entries', 'eq')).toContainEqual(['id', JOURNAL_ENTRY_ID])
    const documentFilters = findCalls('document_attachments', 'eq')
    expect(documentFilters).toContainEqual(['company_id', COMPANY_ID])
    expect(documentFilters).toContainEqual(['journal_entry_id', JOURNAL_ENTRY_ID])
    expect(documentFilters).toContainEqual(['is_current_version', true])
  })

  it('says so when no document is attached to the verifikat yet', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: registeredRow({ status: 'partially_paid' }) })
    enqueue({ data: voucherRow })
    enqueue({ data: [] })

    const result = await run(supabase)

    expect(result.registered_from_books).toBe(true)
    expect(result.voucher_document_ids).toEqual([])
    const note = result.note as string
    expect(note).toContain('No document is attached to that verifikat yet')
    expect(note).toContain('gnubok_link_document_to_voucher')
    expect(note).not.toContain('gnubok_get_document_content')
  })

  it('fails the call when the documents cannot be read, never reporting none attached', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: registeredRow() })
    enqueue({ data: voucherRow })
    enqueue({ data: null, error: { message: 'connection reset' } })

    await expect(run(supabase)).rejects.toThrow(/Database error/)
  })

  it('reads nothing more for an invoice issued here, and returns its verifikat', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: invoiceRow({ status: 'sent', invoice_number: '2026-0042', journal_entry_id: JOURNAL_ENTRY_ID }) })

    const result = await run(supabase)

    expect(result.registered_from_books).toBe(false)
    expect(result.journal_entry_id).toBe(JOURNAL_ENTRY_ID)
    for (const key of ['voucher_label', 'voucher_document_ids', 'note']) {
      expect(result, key).not.toHaveProperty(key)
    }
    // No read of the verifikat or its documents. The two reads after the
    // invoice are its payment reference's (the settings, its own facts).
    expect(supabase.from.mock.calls.map(([table]) => table)).toEqual(['invoices', 'company_settings', 'invoices'])
  })

  it('does not mark a draft without lines: it has no verifikat', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: invoiceRow({ items: [] }) })

    const result = await run(supabase)

    expect(result.registered_from_books).toBe(false)
    expect(result.journal_entry_id).toBeNull()
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('does not mark the kreditfaktura of a registration: it was issued here', async () => {
    // It mirrors its original's lines, so it has none, and it is booked: the
    // same state as a registration, told apart by credited_invoice_id.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: registeredRow({ invoice_number: 'KR-OLD-7', credited_invoice_id: INVOICE_ID }),
    })

    const result = await run(supabase)

    expect(result.registered_from_books).toBe(false)
    expect(result).not.toHaveProperty('note')
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })
})

describe('gnubok_get_invoice: quote progress (crm#1196)', () => {
  it('lists the live invoices converted from a quote with invoiced so far and what remains', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: invoiceRow({ document_type: 'quote', invoice_number: 'OF-012', quote_status: 'accepted', subtotal: 25000 }) })
    enqueue({ data: [{ id: 'inv-1', invoice_number: 'F-001', status: 'sent', subtotal: 12500 }] })

    const result = (await getInvoice.execute(
      { invoice_id: INVOICE_ID },
      COMPANY_ID,
      USER_ID,
      supabase as never,
      { type: 'api_key' } as never,
    )) as { quote_invoicing: Record<string, unknown> }

    expect(result.quote_invoicing).toEqual({
      invoiced: 12500,
      remaining: 12500,
      fully_invoiced: false,
      invoices: [{ invoice_id: 'inv-1', invoice_number: 'F-001', status: 'sent', subtotal: 12500 }],
    })
    expect(findCalls('invoices', 'eq')).toContainEqual(['converted_from_id', INVOICE_ID])
  })

  it('names the source of a converted invoice and reads nothing more for it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: invoiceRow({ converted_from_id: 'quote-1' }) })

    const result = (await getInvoice.execute(
      { invoice_id: INVOICE_ID },
      COMPANY_ID,
      USER_ID,
      supabase as never,
      { type: 'api_key' } as never,
    )) as Record<string, unknown>

    expect(result.converted_from_id).toBe('quote-1')
    expect(result.quote_invoicing).toBeUndefined()
  })
})

// crm#1568: the read returned the exact total and remaining_amount only, so an
// agent reported 3116,25 kr for an invoice whose "Att betala" is 3116 kr.
describe('gnubok_get_invoice: what the invoice asks for (crm#1568)', () => {
  const execute = (supabase: unknown) =>
    getInvoice.execute(
      { invoice_id: INVOICE_ID },
      COMPANY_ID,
      USER_ID,
      supabase as never,
      { type: 'api_key' } as never,
    ) as Promise<Record<string, unknown>>

  it('returns amount_to_pay and ore_rounding_amount next to the exact total', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: invoiceRow({
        status: 'sent',
        invoice_number: 'F-1002',
        due_date: '2099-12-31',
        subtotal: 2493,
        vat_amount: 623.25,
        total: 3116.25,
        remaining_amount: 3116.25,
        ore_rounding: true,
        journal_entry_id: 'je-1',
      }),
    })

    const result = await execute(supabase)

    const columns = String(findCall('invoices', 'select')?.[0])
    expect(columns).toContain('ore_rounding')
    expect(columns).toContain('deduction_total')
    expect(result).toMatchObject({ total: 3116.25, amount_to_pay: 3116, ore_rounding_amount: -0.25, remaining_amount: 3116.25 })
    // Its own choice, frozen at issue: the company's rounding is not read.
    // The one settings read is the payment reference's.
    expect(findCalls('company_settings', 'select')).toEqual([['*']])
  })

  it('computes a draft without a choice of its own with the company setting', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: invoiceRow({ total: 4312.5, remaining_amount: 4312.5, ore_rounding: null }) })
    enqueue({ data: { ore_rounding: true } })

    const result = await execute(supabase)

    expect(findCall('company_settings', 'eq')).toEqual(['company_id', COMPANY_ID])
    expect(result).toMatchObject({ total: 4312.5, amount_to_pay: 4313, ore_rounding_amount: 0.5 })
  })

  it('nets the ROT/RUT deduction the customer does not pay', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: invoiceRow({ status: 'sent', due_date: '2099-12-31', total: 10000.4, remaining_amount: 7000.4, deduction_total: 3000 }) })

    const result = await execute(supabase)

    expect(result).toMatchObject({ total: 10000.4, amount_to_pay: 7000, ore_rounding_amount: -0.4 })
  })

  it('declares both figures in its output schema', () => {
    const props = (getInvoice.outputSchema as { properties: Record<string, { description?: string }> }).properties
    expect(props.amount_to_pay.description).toMatch(/Att betala/)
    expect(props.ore_rounding_amount).toBeDefined()
  })
})

// crm#1886: the reference the invoice PDF prints, as gnubok_list_invoices and
// the v1 responses report it.
describe('gnubok_get_invoice: payment_reference (crm#1886)', () => {
  const execute = (supabase: unknown) =>
    getInvoice.execute(
      { invoice_id: INVOICE_ID },
      COMPANY_ID,
      USER_ID,
      supabase as never,
      { type: 'api_key' } as never,
    ) as Promise<Record<string, unknown>>
  const facts = (overrides: Record<string, unknown> = {}) => ({
    id: INVOICE_ID,
    payment_details: null,
    autogiro_payer_number: null,
    customer: { language: 'sv' },
    ...overrides,
  })

  it('declares both fields in the output schema', () => {
    const props = (getInvoice.outputSchema as { properties: Record<string, { type: unknown }> }).properties
    expect(props.payment_reference.type).toEqual(['string', 'null'])
    expect(props.payment_reference_type.type).toEqual(['string', 'null'])
  })

  it('returns the OCR reference of an issued invoice that prints a giro', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: invoiceRow({ status: 'sent', invoice_number: '0073', journal_entry_id: 'je-1' }) })
    enqueue({ data: { bankgiro: '5050-1055' } }) // company_settings
    enqueue({ data: [facts()] })

    const result = await execute(supabase)

    // 0073 plus its Luhn check digit, as the PDF prints "OCR/Referens".
    expect(result).toMatchObject({ invoice_number: '0073', payment_reference: '00737', payment_reference_type: 'ocr' })
  })

  it('returns the invoice number when the PDF prints no OCR', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: invoiceRow({ status: 'sent', invoice_number: '0073', journal_entry_id: 'je-1' }) })
    enqueue({ data: { bankgiro: null, plusgiro: null } }) // company_settings: no giro to pay an OCR to
    enqueue({ data: [facts()] })

    expect(await execute(supabase)).toMatchObject({ payment_reference: '0073', payment_reference_type: 'invoice_number' })
  })

  it('is null on a draft without a number, and reads nothing for it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: invoiceRow() })

    const result = await execute(supabase)

    expect(result).toMatchObject({ invoice_number: null, payment_reference: null, payment_reference_type: null })
    expect(supabase.from).toHaveBeenCalledTimes(1)
  })

  it('is null on an invoice debited by Autogiro', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: invoiceRow({ status: 'sent', invoice_number: '0073', journal_entry_id: 'je-1' }) })
    enqueue({ data: { bankgiro: '5050-1055' } })
    enqueue({ data: [facts({ autogiro_payer_number: '4711' })] })

    expect(await execute(supabase)).toMatchObject({ payment_reference: null, payment_reference_type: null })
  })

  it('fails the call when the settings cannot be read, never guessing the reference', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: invoiceRow({ status: 'sent', invoice_number: '0073', journal_entry_id: 'je-1' }) })
    enqueue({ error: { message: 'permission denied' } }) // company_settings

    await expect(execute(supabase)).rejects.toThrow(/company_settings/)
  })
})
