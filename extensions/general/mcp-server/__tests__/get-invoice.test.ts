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

import { tools } from '../server'

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

  it('is search-only in the catalog (tools/list context budget)', () => {
    // payload-size.bench.test.ts sits at its ceiling, and the tool this one
    // serves (gnubok_update_invoice) is search-only as well.
    expect(getInvoice.catalogVisibility).toBe('search')
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
