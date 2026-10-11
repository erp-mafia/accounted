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
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'

import { tools, isStagingTool } from '../server'
import { toolCallableVia } from '../tool-reach'

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
    expect(toolCallableVia(getInvoice, isStagingTool(getInvoice))).toBe('call_tool')
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
    expect(supabase.from).toHaveBeenCalledTimes(1)
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
