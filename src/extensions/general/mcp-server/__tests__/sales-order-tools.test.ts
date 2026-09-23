/**
 * Unit tests for the kundorder (sales order) MCP tools: registration,
 * scope/risk/catalog wiring, the staging-time refusals, and the dry-run
 * previews. The lib/sales-orders loaders are mocked; the commit executors
 * are covered in lib/pending-operations/__tests__/sales-order-executors.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase, makeCustomer } from '@/tests/helpers'
import type { SalesOrder, SalesOrderItem } from '@/types'

vi.mock('@/lib/sales-orders/load', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sales-orders/load')>()),
  loadSalesOrder: vi.fn(),
  fetchInvoicedQuantities: vi.fn(),
}))
vi.mock('@/lib/sales-orders/write', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/sales-orders/write')>()),
  hasOpenInvoices: vi.fn(),
}))

import { loadSalesOrder, fetchInvoicedQuantities } from '@/lib/sales-orders/load'
import { hasOpenInvoices } from '@/lib/sales-orders/write'
import { tools, isDefaultCatalogTool } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'

const byName = (name: string) => tools.find((t) => t.name === name)!

const ORDER_ID = '00000000-0000-4000-8000-0000000000aa'
const CUSTOMER_ID = '00000000-0000-4000-8000-0000000000bb'
const ITEM_ID = '00000000-0000-4000-8000-0000000000cc'
const TEXT_ID = '00000000-0000-4000-8000-0000000000ce'

function makeItem(overrides: Partial<SalesOrderItem> = {}): SalesOrderItem {
  return {
    id: ITEM_ID,
    company_id: 'company-1',
    sales_order_id: ORDER_ID,
    sort_order: 0,
    line_type: 'product',
    description: 'Konsulttimmar',
    quantity: 10,
    delivered_qty: 0,
    unit: 'tim',
    unit_price: 100,
    discount_percent: 0,
    vat_rate: 25,
    line_total: 1000,
    article_id: null,
    revenue_account: null,
    dimensions: {},
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    invoiced_qty: 0,
    remaining_qty: 10,
    ...overrides,
  }
}

function makeOrder(overrides: Partial<SalesOrder> = {}): SalesOrder {
  return {
    id: ORDER_ID,
    company_id: 'company-1',
    user_id: 'user-1',
    customer_id: CUSTOMER_ID,
    order_number: 'OR-7',
    status: 'confirmed',
    source_invoice_id: null,
    order_date: '2026-09-01',
    requested_delivery_date: null,
    last_delivery_date: null,
    currency: 'SEK',
    subtotal: 1000,
    vat_amount: 250,
    total: 1250,
    your_reference: null,
    our_reference: null,
    notes: null,
    default_dimensions: {},
    confirmed_at: '2026-09-01T00:00:00Z',
    completed_at: null,
    cancelled_at: null,
    created_at: '2026-09-01T00:00:00Z',
    updated_at: '2026-09-01T00:00:00Z',
    customer: makeCustomer({ id: CUSTOMER_ID, name: 'Testbrand AB', default_payment_terms: 30 }),
    items: [makeItem()],
    delivery_progress: 'none',
    invoicing_progress: 'none',
    ...overrides,
  }
}

const WRITE_TOOLS = [
  'gnubok_create_sales_order',
  'gnubok_transition_sales_order',
  'gnubok_register_sales_order_delivery',
  'gnubok_create_invoice_from_sales_order',
]
const READ_TOOLS = ['gnubok_list_sales_orders', 'gnubok_get_sales_order']

beforeEach(() => {
  vi.clearAllMocks()
})

describe('sales order tools: registration', () => {
  it('registers all six tools with strict input schemas', () => {
    for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) {
      const tool = byName(name)
      expect(tool, name).toBeDefined()
      expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties, name).toBe(false)
    }
  })

  it('keeps the list read in the default catalog and the rest search-only (tools/list budget)', () => {
    expect(isDefaultCatalogTool(byName('gnubok_list_sales_orders'))).toBe(true)
    expect(isDefaultCatalogTool(byName('gnubok_get_sales_order'))).toBe(false)
    for (const name of WRITE_TOOLS) expect(isDefaultCatalogTool(byName(name)), name).toBe(false)
  })

  it('maps reads to invoices:read and writes to invoices:write', () => {
    for (const name of READ_TOOLS) expect(TOOL_SCOPE_MAP[name], name).toBe('invoices:read')
    for (const name of WRITE_TOOLS) expect(TOOL_SCOPE_MAP[name], name).toBe('invoices:write')
  })

  it('every write stages (staged output schema + prose) and carries the expected risk tier', () => {
    for (const name of WRITE_TOOLS) {
      const tool = byName(name)
      expect((tool.outputSchema as { required?: string[] })?.required, name).toContain('staged')
      expect(tool.description, name).toMatch(/stag(e|ing)/i)
      expect(tool.annotations.readOnlyHint, name).toBe(false)
    }
    expect(OPERATION_RISK_TIERS.create_sales_order).toBe('low')
    expect(OPERATION_RISK_TIERS.transition_sales_order).toBe('low')
    expect(OPERATION_RISK_TIERS.register_sales_order_delivery).toBe('low')
    expect(OPERATION_RISK_TIERS.create_invoice_from_sales_order).toBe('medium')
  })
})

describe('gnubok_list_sales_orders', () => {
  it('returns qualified ids with derived progress and pagination', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        {
          id: ORDER_ID,
          order_number: 'OR-7',
          status: 'confirmed',
          customer_id: CUSTOMER_ID,
          order_date: '2026-09-01',
          requested_delivery_date: null,
          last_delivery_date: '2026-09-02',
          currency: 'SEK',
          subtotal: 1000,
          vat_amount: 250,
          total: 1250,
          customer: { name: 'Testbrand AB' },
          items: [{ id: ITEM_ID, line_type: 'product', quantity: 10, delivered_qty: 4, sort_order: 0 }],
        },
      ],
      count: 1,
    })
    vi.mocked(fetchInvoicedQuantities).mockResolvedValue({ ok: true, byItem: new Map([[ITEM_ID, 10]]) })

    const result = (await byName('gnubok_list_sales_orders').execute(
      { status: 'confirmed' }, 'company-1', 'user-1', supabase as never,
    )) as { sales_orders: Record<string, unknown>[]; count: number; total_count: number; has_more: boolean }

    expect(result.count).toBe(1)
    expect(result.total_count).toBe(1)
    expect(result.has_more).toBe(false)
    expect(result.sales_orders[0]).toMatchObject({
      sales_order_id: ORDER_ID,
      order_number: 'OR-7',
      customer_name: 'Testbrand AB',
      delivery_progress: 'partial',
      invoicing_progress: 'full',
      line_count: 1,
    })
    expect(result.sales_orders[0]).not.toHaveProperty('id')
    expect(fetchInvoicedQuantities).toHaveBeenCalledWith(supabase, [ORDER_ID])
  })

  it('rejects an unknown status before any DB call', async () => {
    const noop = { from: vi.fn() }
    await expect(
      byName('gnubok_list_sales_orders').execute({ status: 'shipped' }, 'company-1', 'user-1', noop as never),
    ).rejects.toThrow(/Invalid status/)
    expect(noop.from).not.toHaveBeenCalled()
  })
})

describe('gnubok_get_sales_order', () => {
  it('returns the decorated order with qualified line ids and its invoices', async () => {
    vi.mocked(loadSalesOrder).mockResolvedValue({ ok: true, order: makeOrder() })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'inv-1', invoice_number: null, status: 'draft', invoice_date: '2026-09-02', total: 500, currency: 'SEK' }] })

    const result = (await byName('gnubok_get_sales_order').execute(
      { sales_order_id: ORDER_ID }, 'company-1', 'user-1', supabase as never,
    )) as Record<string, unknown>

    expect(result).toMatchObject({ sales_order_id: ORDER_ID, status: 'confirmed', item_count: 1 })
    expect((result.items as Record<string, unknown>[])[0]).toMatchObject({
      sales_order_item_id: ITEM_ID,
      invoiced_qty: 0,
      remaining_qty: 10,
    })
    expect((result.invoices as Record<string, unknown>[])[0]).toMatchObject({ invoice_id: 'inv-1', status: 'draft' })
  })

  it('maps SALES_ORDER_NOT_FOUND onto a not-found error with a remediation hint', async () => {
    vi.mocked(loadSalesOrder).mockResolvedValue({ ok: false, code: 'SALES_ORDER_NOT_FOUND' })
    await expect(
      byName('gnubok_get_sales_order').execute({ sales_order_id: ORDER_ID }, 'company-1', 'user-1', {} as never),
    ).rejects.toThrow(/not found.*gnubok_list_sales_orders/i)
  })
})

describe('gnubok_create_sales_order', () => {
  it('dry run: previews totals from the shared line math and stages nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeCustomer({ id: CUSTOMER_ID, name: 'Testbrand AB', customer_type: 'swedish_business', vat_number_validated: false }) })

    const result = (await byName('gnubok_create_sales_order').execute(
      {
        customer_id: CUSTOMER_ID,
        items: [
          { description: 'Konsulttimmar', quantity: 10, unit: 'tim', unit_price: 100, discount_percent: 10 },
          { line_type: 'text', description: 'Enligt offert' },
        ],
        dry_run: true,
      },
      'company-1', 'user-1', supabase as never,
    )) as { staged: boolean; dry_run?: boolean; preview: Record<string, unknown> }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    // 10 x 100 net of 10 % = 900; 25 % VAT = 225.
    expect(result.preview).toMatchObject({ customer_name: 'Testbrand AB', subtotal: 900, vat_amount: 225, total: 1125, currency: 'SEK' })
    expect((result.preview.items as Record<string, unknown>[])[0]).toMatchObject({ line_total: 900, vat_rate: 25 })
    expect((result.preview.items as Record<string, unknown>[])[1]).toMatchObject({ line_type: 'text', line_total: 0 })
    expect(findCalls('pending_operations', 'insert')).toEqual([])
  })

  it('refuses a VAT rate outside the customer permitted set (same gate as the service)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeCustomer({ id: CUSTOMER_ID, customer_type: 'swedish_business', vat_number_validated: false }) })

    await expect(
      byName('gnubok_create_sales_order').execute(
        { customer_id: CUSTOMER_ID, items: [{ description: 'X', quantity: 1, unit: 'st', unit_price: 100, vat_rate: 7 }], dry_run: true },
        'company-1', 'user-1', supabase as never,
      ),
    ).rejects.toThrow(/INVOICE_CREATE_VAT_RULE_VIOLATION/)
  })
})

describe('gnubok_transition_sales_order', () => {
  it('refuses cancel while invoices exist (SALES_ORDER_HAS_INVOICES)', async () => {
    vi.mocked(loadSalesOrder).mockResolvedValue({ ok: true, order: makeOrder() })
    vi.mocked(hasOpenInvoices).mockResolvedValue({ ok: true, open: true })
    await expect(
      byName('gnubok_transition_sales_order').execute(
        { sales_order_id: ORDER_ID, action: 'cancel', dry_run: true }, 'company-1', 'user-1', {} as never,
      ),
    ).rejects.toThrow(/SALES_ORDER_HAS_INVOICES/)
  })

  it('refuses a transition the current status does not allow', async () => {
    vi.mocked(loadSalesOrder).mockResolvedValue({ ok: true, order: makeOrder({ status: 'confirmed' }) })
    await expect(
      byName('gnubok_transition_sales_order').execute(
        { sales_order_id: ORDER_ID, action: 'confirm', dry_run: true }, 'company-1', 'user-1', {} as never,
      ),
    ).rejects.toThrow(/SALES_ORDER_INVALID_STATE/)
  })

  it('dry run: previews confirm on a draft', async () => {
    vi.mocked(loadSalesOrder).mockResolvedValue({ ok: true, order: makeOrder({ status: 'draft', confirmed_at: null }) })
    const { supabase } = createQueuedMockSupabase()
    const result = (await byName('gnubok_transition_sales_order').execute(
      { sales_order_id: ORDER_ID, action: 'confirm', dry_run: true }, 'company-1', 'user-1', supabase as never,
    )) as { staged: boolean; risk_level: string; preview: Record<string, unknown> }
    expect(result.staged).toBe(false)
    expect(result.risk_level).toBe('low')
    expect(result.preview).toMatchObject({ current_status: 'draft', new_status: 'confirmed', order_number: 'OR-7' })
  })
})

describe('gnubok_register_sales_order_delivery', () => {
  it('refuses delivered_qty above the ordered quantity', async () => {
    vi.mocked(loadSalesOrder).mockResolvedValue({ ok: true, order: makeOrder() })
    await expect(
      byName('gnubok_register_sales_order_delivery').execute(
        { sales_order_id: ORDER_ID, lines: [{ sales_order_item_id: ITEM_ID, delivered_qty: 11 }], dry_run: true },
        'company-1', 'user-1', {} as never,
      ),
    ).rejects.toThrow(/SALES_ORDER_OVER_DELIVERED/)
  })

  it('refuses delivery on a draft order', async () => {
    vi.mocked(loadSalesOrder).mockResolvedValue({ ok: true, order: makeOrder({ status: 'draft' }) })
    await expect(
      byName('gnubok_register_sales_order_delivery').execute(
        { sales_order_id: ORDER_ID, lines: [{ sales_order_item_id: ITEM_ID, delivered_qty: 1 }], dry_run: true },
        'company-1', 'user-1', {} as never,
      ),
    ).rejects.toThrow(/SALES_ORDER_INVALID_STATE/)
  })

  it('dry run: previews the cumulative delivery per line and skips text rows', async () => {
    vi.mocked(loadSalesOrder).mockResolvedValue({
      ok: true,
      order: makeOrder({
        items: [makeItem({ delivered_qty: 4 }), makeItem({ id: TEXT_ID, line_type: 'text', quantity: 0, sort_order: 1 })],
      }),
    })
    const { supabase } = createQueuedMockSupabase()
    const result = (await byName('gnubok_register_sales_order_delivery').execute(
      {
        sales_order_id: ORDER_ID,
        delivery_date: '2026-09-03',
        lines: [{ sales_order_item_id: ITEM_ID, delivered_qty: 7 }, { sales_order_item_id: TEXT_ID, delivered_qty: 0 }],
        dry_run: true,
      },
      'company-1', 'user-1', supabase as never,
    )) as { staged: boolean; preview: { lines: Record<string, unknown>[]; delivery_date: string } }
    expect(result.staged).toBe(false)
    expect(result.preview.delivery_date).toBe('2026-09-03')
    expect(result.preview.lines).toHaveLength(1)
    expect(result.preview.lines[0]).toMatchObject({ sales_order_item_id: ITEM_ID, delivered_before: 4, delivered_after: 7, delta: 3 })
  })
})

describe('gnubok_create_invoice_from_sales_order', () => {
  it('refuses a draft order with a confirm hint', async () => {
    vi.mocked(loadSalesOrder).mockResolvedValue({ ok: true, order: makeOrder({ status: 'draft' }) })
    await expect(
      byName('gnubok_create_invoice_from_sales_order').execute(
        { sales_order_id: ORDER_ID, dry_run: true }, 'company-1', 'user-1', {} as never,
      ),
    ).rejects.toThrow(/SALES_ORDER_INVALID_STATE.*gnubok_transition_sales_order/)
  })

  it('refuses when nothing is left to invoice', async () => {
    vi.mocked(loadSalesOrder).mockResolvedValue({
      ok: true,
      order: makeOrder({ items: [makeItem({ invoiced_qty: 10, remaining_qty: 0 })] }),
    })
    await expect(
      byName('gnubok_create_invoice_from_sales_order').execute(
        { sales_order_id: ORDER_ID, dry_run: true }, 'company-1', 'user-1', {} as never,
      ),
    ).rejects.toThrow(/SALES_ORDER_NOTHING_TO_INVOICE/)
  })

  it('refuses an explicit pick above remaining_qty', async () => {
    vi.mocked(loadSalesOrder).mockResolvedValue({
      ok: true,
      order: makeOrder({ items: [makeItem({ invoiced_qty: 8, remaining_qty: 2 })] }),
    })
    await expect(
      byName('gnubok_create_invoice_from_sales_order').execute(
        { sales_order_id: ORDER_ID, lines: [{ sales_order_item_id: ITEM_ID, quantity: 3 }], dry_run: true },
        'company-1', 'user-1', {} as never,
      ),
    ).rejects.toThrow(/SALES_ORDER_OVER_INVOICED/)
  })

  it('dry run: previews the delivered-not-invoiced quantities with line totals and due date', async () => {
    vi.mocked(loadSalesOrder).mockResolvedValue({
      ok: true,
      order: makeOrder({ last_delivery_date: '2026-09-02', items: [makeItem({ delivered_qty: 4, invoiced_qty: 1, remaining_qty: 9 })] }),
    })
    const { supabase, findCalls } = createQueuedMockSupabase()
    const result = (await byName('gnubok_create_invoice_from_sales_order').execute(
      { sales_order_id: ORDER_ID, mode: 'delivered', invoice_date: '2026-09-05', dry_run: true },
      'company-1', 'user-1', supabase as never,
    )) as { staged: boolean; risk_level: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(false)
    expect(result.risk_level).toBe('medium')
    // delivered 4 - invoiced 1 = 3 x 100 = 300 net, 75 VAT.
    expect(result.preview).toMatchObject({
      mode: 'delivered',
      subtotal: 300,
      vat_amount: 75,
      total: 375,
      invoice_date: '2026-09-05',
      due_date: '2026-10-05',
      delivery_date: '2026-09-02',
    })
    expect((result.preview.items as Record<string, unknown>[])[0]).toMatchObject({
      sales_order_item_id: ITEM_ID,
      quantity: 3,
      line_total: 300,
      remaining_after: 6,
    })
    expect(findCalls('pending_operations', 'insert')).toEqual([])
  })
})
