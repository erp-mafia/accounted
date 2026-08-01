import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const invoiceRow = (id: string) => ({
  id,
  invoice_number: 'INV-100',
  status: 'sent',
  customer_id: 'customer-1',
  total: 1250,
  currency: 'SEK',
  invoice_date: '2026-08-01',
  due_date: '2026-08-31',
  document_type: 'invoice',
  default_dimensions: null,
  customers: { name: 'Example Customer AB' },
})

const scheduleRow = (id: string) => ({
  id,
  name: 'Monthly support',
  status: 'active',
  customer_id: 'customer-1',
  day_of_month: 25,
  send_hour: 9,
  payment_terms_days: 30,
  currency: 'SEK',
  auto_send: false,
  default_dimensions: null,
  next_run_date: '2026-08-25',
  last_run_at: null,
  last_invoice_id: null,
  last_run_warning: null,
  generated_count: 0,
  customer: { name: 'Example Customer AB' },
  items: [],
})

const cases = [
  {
    name: 'gnubok_list_invoices',
    table: 'invoices',
    itemsKey: 'invoices',
    primaryOrder: 'invoice_date',
    row: invoiceRow,
  },
  {
    name: 'gnubok_list_recurring_schedules',
    table: 'recurring_invoice_schedules',
    itemsKey: 'schedules',
    primaryOrder: 'created_at',
    row: scheduleRow,
  },
] as const

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe.each(cases)('$name continuation', ({ name, table, itemsKey, primaryOrder, row }) => {
  const tool = tools.find((candidate) => candidate.name === name)!

  it('advertises optional offset input and the complete pagination envelope', () => {
    expect(tool).toBeDefined()

    const input = tool.inputSchema as {
      required?: string[]
      properties: Record<string, { type?: string; minimum?: number }>
    }
    expect(input.properties.offset).toMatchObject({ type: 'integer', minimum: 0 })
    expect(input.required ?? []).not.toContain('offset')

    const output = tool.outputSchema as { required: string[]; properties: Record<string, unknown> }
    expect(output.required).toEqual(expect.arrayContaining([itemsKey, 'count', 'total_count', 'has_more']))
    expect(output.properties.next_offset).toBeDefined()
  })

  it('continues from offset and returns the next offset when more rows exist', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [row('row-5'), row('row-6')], error: null, count: 9 })

    const result = (await tool.execute(
      { limit: 2, offset: 4 },
      'company-1',
      'user-1',
      supabase as never,
    )) as Record<string, unknown>

    expect(findCall(table, 'range')).toEqual([4, 6])
    expect(findCalls(table, 'order')).toEqual([
      [primaryOrder, { ascending: false }],
      ['id', { ascending: false }],
    ])
    expect((result[itemsKey] as unknown[])).toHaveLength(2)
    expect(result).toMatchObject({
      count: 2,
      total_count: 9,
      has_more: true,
      next_offset: 6,
    })
  })

  it('preserves the first-page default and omits next_offset on the last page', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [row('only-row')], error: null, count: 1 })

    const result = (await tool.execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
    )) as Record<string, unknown>

    expect(findCall(table, 'range')).toEqual([0, 50])
    expect(result).toMatchObject({
      count: 1,
      total_count: 1,
      has_more: false,
    })
    expect(result).not.toHaveProperty('next_offset')
  })

  it('returns an empty terminal page', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [], error: null, count: 0 })

    const result = (await tool.execute(
      { limit: 2, offset: 4 },
      'company-1',
      'user-1',
      supabase as never,
    )) as Record<string, unknown>

    expect(result[itemsKey]).toEqual([])
    expect(result).toMatchObject({
      count: 0,
      total_count: 0,
      has_more: false,
    })
    expect(result).not.toHaveProperty('next_offset')
  })

  it('normalizes fractional offsets for direct execution', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [row('row-5')], error: null, count: 6 })

    const result = (await tool.execute(
      { limit: 2, offset: 4.9 },
      'company-1',
      'user-1',
      supabase as never,
    )) as Record<string, unknown>

    expect(findCall(table, 'range')).toEqual([4, 6])
    expect(result).toMatchObject({
      count: 1,
      total_count: 6,
      has_more: true,
      next_offset: 5,
    })
  })

  it('uses a lookahead row when the exact count is unavailable', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [row('row-5'), row('row-6'), row('lookahead-row')], error: null, count: null })

    const result = (await tool.execute(
      { limit: 2, offset: 4 },
      'company-1',
      'user-1',
      supabase as never,
    )) as Record<string, unknown>

    expect(result[itemsKey]).toHaveLength(2)
    expect(result).toMatchObject({
      count: 2,
      total_count: 7,
      has_more: true,
      next_offset: 6,
    })
  })

  it('reports database errors', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'connection reset' }, count: null })

    await expect(tool.execute(
      {},
      'company-1',
      'user-1',
      supabase as never,
    )).rejects.toThrow('Database error: connection reset')
  })
})
