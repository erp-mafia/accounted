/**
 * gnubok_get_invoice: the read half of the invoice-update round trip
 * (issue #1642). gnubok_update_invoice items are a FULL REPLACE, and before
 * this tool existed no MCP surface returned invoice line items at all, so an
 * agent editing a draft had to reconstruct the lines from memory and silently
 * dropped article_id / revenue_account / vat_rate. This tool returns every
 * line field the update path can write, so lines can be fed back losslessly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { tools } from '../server'

const tool = () => tools.find((t) => t.name === 'gnubok_get_invoice')!

const INVOICE_ID = '22222222-2222-4222-8222-222222222222'

const INVOICE_ROW = {
  id: INVOICE_ID,
  invoice_number: null,
  status: 'draft',
  document_type: 'invoice',
  customer_id: 'cust-1',
  journal_entry_id: null,
  is_self_billed: false,
  credited_invoice_id: null,
  invoice_date: '2026-08-01',
  due_date: '2026-08-31',
  delivery_date: null,
  currency: 'SEK',
  subtotal: 3600,
  vat_amount: 900,
  total: 4500,
  vat_treatment: 'standard_25',
  your_reference: null,
  our_reference: 'JW',
  notes: null,
  default_dimensions: { '6': 'P001' },
  customers: { name: 'Synthetic Kund AB' },
}

const ITEM_ROW = {
  id: 'item-1',
  line_type: 'product',
  description: 'Konsulttimme',
  quantity: 3,
  unit: 'tim',
  unit_price: 1200,
  line_total: 3600,
  vat_rate: 25,
  vat_amount: 900,
  article_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  revenue_account: '3041',
  deduction_type: null,
  deduction_amount: 0,
  labor_hours: null,
  work_type: null,
  housing_designation: null,
  apartment_number: null,
  brf_org_number: null,
  accrual_period_start: null,
  accrual_period_end: null,
  accrual_balance_account: null,
  dimensions: {},
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_get_invoice: registration', () => {
  it('is a strict read-only invoices:read tool, discoverable via search', () => {
    expect(tool()).toBeDefined()
    expect(tool().inputSchema.additionalProperties).toBe(false)
    expect(tool().annotations.readOnlyHint).toBe(true)
    expect(tool().annotations.idempotentHint).toBe(true)
    expect(tool().catalogVisibility).toBe('search')
    expect(TOOL_SCOPE_MAP.gnubok_get_invoice).toBe('invoices:read')
  })

  it('keeps its description within budget and points at the update round trip', () => {
    expect(tool().description.length).toBeLessThanOrEqual(280)
    expect(tool().description).toMatch(/gnubok_update_invoice/)
    expect(tool().description).toMatch(/FULL REPLACE/)
  })

  it('declares the line fields the update path can write in its output schema', () => {
    const schema = tool().outputSchema as {
      properties: { items: { items: { properties: Record<string, unknown> } } }
    }
    const lineProps = schema.properties.items.items.properties
    for (const field of ['invoice_item_id', 'line_type', 'article_id', 'revenue_account', 'vat_rate', 'dimensions']) {
      expect(lineProps, `items schema must declare ${field}`).toHaveProperty(field)
    }
  })
})

describe('gnubok_get_invoice: execution', () => {
  it('requires invoice_id', async () => {
    const { supabase } = createQueuedMockSupabase()

    await expect(
      tool().execute({}, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/invoice_id/i)
    expect(supabase.from).not.toHaveBeenCalled()
  })

  it('fails when the invoice is outside the selected company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })

    await expect(
      tool().execute({ invoice_id: INVOICE_ID }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/not found/i)
  })

  it('returns the invoice with full line items, article linkage included', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: INVOICE_ROW })
    enqueue({ data: [ITEM_ROW] })

    const result = (await tool().execute(
      { invoice_id: INVOICE_ID },
      'company-1',
      'user-1',
      supabase as never,
    )) as Record<string, unknown> & { items: Array<Record<string, unknown>> }

    expect(result).toMatchObject({
      invoice_id: INVOICE_ID,
      invoice_number: null,
      status: 'draft',
      customer_id: 'cust-1',
      customer_name: 'Synthetic Kund AB',
      currency: 'SEK',
      total: 4500,
      default_dimensions: { '6': 'P001' },
      is_editable_draft: true,
      item_count: 1,
    })
    expect(result.items[0]).toMatchObject({
      invoice_item_id: 'item-1',
      line_type: 'product',
      description: 'Konsulttimme',
      quantity: 3,
      unit: 'tim',
      unit_price: 1200,
      vat_rate: 25,
      article_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      revenue_account: '3041',
    })
  })

  it('reports a sent invoice as not editable', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ...INVOICE_ROW, status: 'sent', invoice_number: 'F-2026-0042', journal_entry_id: 'je-1' } })
    enqueue({ data: [ITEM_ROW] })

    const result = (await tool().execute(
      { invoice_id: INVOICE_ID },
      'company-1',
      'user-1',
      supabase as never,
    )) as { is_editable_draft: boolean; invoice_number: string }

    expect(result.is_editable_draft).toBe(false)
    expect(result.invoice_number).toBe('F-2026-0042')
  })
})
