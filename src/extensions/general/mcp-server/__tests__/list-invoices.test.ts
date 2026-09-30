/**
 * gnubok_list_invoices: open balance per row and the partially_paid filter
 * (MCP feedback seqs 817418 / 817440). A partially paid invoice used to list
 * with status and total only, so its residual took a second call to see, and
 * the status enum had no partially_paid for a strict client to send.
 */
import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const listInvoices = tools.find((t) => t.name === 'gnubok_list_invoices')!

const invoiceRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'inv-pp',
  invoice_number: '2026024',
  status: 'partially_paid',
  customer_id: 'cust-1',
  total: 15625,
  paid_amount: 15000,
  remaining_amount: 625,
  currency: 'SEK',
  invoice_date: '2026-06-01',
  due_date: '2026-07-01',
  document_type: 'invoice',
  valid_until: null,
  quote_status: null,
  default_dimensions: {},
  customers: { name: 'Kunden AB' },
  ...overrides,
})

type ListResult = { invoices: Array<Record<string, unknown>> }

describe('gnubok_list_invoices: paid and remaining amounts', () => {
  it('accepts partially_paid as a status filter', async () => {
    const props = (listInvoices.inputSchema as { properties: Record<string, { enum?: string[] }> })
      .properties
    expect(props.status.enum).toContain('partially_paid')

    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [invoiceRow()], count: 1 })

    const result = (await listInvoices.execute(
      { status: 'partially_paid' },
      'company-1',
      'user-1',
      supabase as never,
    )) as ListResult

    expect(findCalls('invoices', 'eq')).toContainEqual(['status', 'partially_paid'])
    expect(result.invoices).toHaveLength(1)
  })

  it('returns paid_amount and remaining_amount on every row', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: [
        invoiceRow(),
        // Nothing paid yet: paid_amount is NULL in the table.
        invoiceRow({
          id: 'inv-sent',
          invoice_number: '2026025',
          status: 'sent',
          total: 1000,
          paid_amount: null,
          remaining_amount: 1000,
        }),
      ],
      count: 2,
    })

    const result = (await listInvoices.execute({}, 'company-1', 'user-1', supabase as never)) as ListResult

    const columns = String(findCall('invoices', 'select')?.[0])
    expect(columns).toContain('paid_amount')
    expect(columns).toContain('remaining_amount')
    expect(result.invoices[0]).toMatchObject({
      invoice_number: '2026024',
      status: 'partially_paid',
      total: 15625,
      paid_amount: 15000,
      remaining_amount: 625,
    })
    expect(result.invoices[1]).toMatchObject({
      invoice_number: '2026025',
      status: 'sent',
      paid_amount: 0,
      remaining_amount: 1000,
    })
  })
})
