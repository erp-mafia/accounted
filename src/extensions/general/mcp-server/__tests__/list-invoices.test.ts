/**
 * gnubok_list_invoices: open balance per row and the partially_paid filter
 * (MCP feedback seqs 817418 / 817440). A partially paid invoice used to list
 * with status and total only, so its residual took a second call to see, and
 * the status enum had no partially_paid for a strict client to send.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
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
          // Not yet due: a sent invoice past its due date reports overdue.
          due_date: '2099-12-31',
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

describe('gnubok_list_invoices: overdue follows the due date (crm#1084)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('status=overdue filters on the due date and the open remainder, never the stored status', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-13T08:00:00Z'))
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [invoiceRow({ id: 'inv-late', status: 'sent', due_date: '2026-09-30', remaining_amount: 1000 })], count: 1 })

    const result = (await listInvoices.execute({ status: 'overdue' }, 'company-1', 'user-1', supabase as never)) as ListResult

    expect(findCalls('invoices', 'eq')).not.toContainEqual(['status', 'overdue'])
    expect(findCalls('invoices', 'in')).toContainEqual(['status', ['sent', 'overdue', 'partially_paid']])
    expect(findCalls('invoices', 'lt')).toContainEqual(['due_date', '2026-10-13'])
    expect(findCalls('invoices', 'gt')).toContainEqual(['remaining_amount', 0])
    // The stored 'sent' reports as what it is: overdue.
    expect(result.invoices[0]).toMatchObject({ id: 'inv-late', status: 'overdue' })
  })

  it('reports a sent invoice past due as overdue and keeps partially_paid as stored', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-13T08:00:00Z'))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        invoiceRow({ id: 'a', status: 'sent', due_date: '2026-10-12', remaining_amount: 10 }),
        invoiceRow({ id: 'b', status: 'sent', due_date: '2026-10-13', remaining_amount: 10 }),
        invoiceRow({ id: 'c', status: 'overdue', due_date: '2026-11-01', remaining_amount: 10 }),
        invoiceRow({ id: 'd', status: 'partially_paid', due_date: '2026-09-01', remaining_amount: 10 }),
      ],
      count: 4,
    })

    const result = (await listInvoices.execute({}, 'company-1', 'user-1', supabase as never)) as ListResult

    expect(result.invoices.map((inv) => [inv.id, inv.status])).toEqual([
      ['a', 'overdue'],
      ['b', 'sent'],
      ['c', 'sent'],
      ['d', 'partially_paid'],
    ])
  })
})
