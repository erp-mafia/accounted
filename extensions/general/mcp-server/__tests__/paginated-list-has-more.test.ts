import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import { tools } from '../server'

/**
 * paginatedSchema() marks has_more as required, so a handler that omits it
 * makes the MCP client reject the entire response on output validation: the
 * tool is unusable, not merely missing a field. gnubok_list_invoices and
 * gnubok_list_recurring_schedules both shipped without it (caught in
 * production 2026-07-31). These tests pin the envelope contract for both tools.
 */

const invoicesTool = tools.find((t) => t.name === 'gnubok_list_invoices')!
const schedulesTool = tools.find((t) => t.name === 'gnubok_list_recurring_schedules')!

type Envelope = { count: number; total_count: number; has_more: boolean }

const invoiceRow = (id: string) => ({
  id,
  invoice_number: '180',
  status: 'sent',
  customer_id: 'cust-1',
  total: 148045,
  currency: 'SEK',
  invoice_date: '2026-07-31',
  due_date: '2026-08-30',
  document_type: 'invoice',
  default_dimensions: null,
  customers: { name: 'CGI Sverige AB' },
})

const scheduleRow = (id: string) => ({
  id,
  name: 'Månadsavtal',
  status: 'active',
  customer_id: 'cust-1',
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
  customer: { name: 'CGI Sverige AB' },
  items: [],
})

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe.each([
  { label: 'gnubok_list_invoices', tool: invoicesTool, itemsKey: 'invoices', row: invoiceRow },
  {
    label: 'gnubok_list_recurring_schedules',
    tool: schedulesTool,
    itemsKey: 'schedules',
    row: scheduleRow,
  },
])('$label pagination envelope', ({ tool, itemsKey, row }) => {
  it('declares has_more as required in its output schema', () => {
    expect(tool).toBeDefined()
    expect(tool.annotations?.readOnlyHint).toBe(true)
    const schema = tool.outputSchema as { required: string[]; properties: Record<string, unknown> }
    expect(schema.required).toContain('has_more')
    expect(schema.properties[itemsKey]).toBeDefined()
  })

  it('returns has_more false when the page holds every match', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [row('a'), row('b')], error: null, count: 2 })

    const result = (await tool.execute(
      { limit: 50 },
      'company-1',
      'user-1',
      supabase as never,
    )) as Envelope

    expect(result.count).toBe(2)
    expect(result.total_count).toBe(2)
    expect(result.has_more).toBe(false)
  })

  it('returns has_more true when matches exceed the page', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [row('a'), row('b')], error: null, count: 137 })

    const result = (await tool.execute(
      { limit: 2 },
      'company-1',
      'user-1',
      supabase as never,
    )) as Envelope

    expect(result.count).toBe(2)
    expect(result.total_count).toBe(137)
    expect(result.has_more).toBe(true)
  })

  it('returns a complete envelope for an empty result', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [], error: null, count: 0 })

    const result = (await tool.execute({}, 'company-1', 'user-1', supabase as never)) as Envelope

    expect(result.count).toBe(0)
    expect(result.total_count).toBe(0)
    expect(result.has_more).toBe(false)
  })

  it('falls back to the page size when the driver returns a null count', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [row('a')], error: null, count: null })

    const result = (await tool.execute({}, 'company-1', 'user-1', supabase as never)) as Envelope

    expect(result.total_count).toBe(1)
    expect(result.has_more).toBe(false)
  })

  it('throws on a database error', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'connection refused' }, count: null })

    await expect(tool.execute({}, 'company-1', 'user-1', supabase as never)).rejects.toThrow(
      /connection refused/,
    )
  })
})
