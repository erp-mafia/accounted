import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PendingOperation } from '@/types'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events/bus'
import { getStockholmDateHour } from '@/lib/invoices/recurring-schedule-service'
import { commitPendingOperation } from '../commit'

const CUSTOMER_ID = '11111111-1111-4111-8111-111111111111'
const SCHEDULE_ID = '22222222-2222-4222-8222-222222222222'

function makePendingOp(
  operationType: 'create_recurring_schedule' | 'update_recurring_schedule',
  params: Record<string, unknown>,
): PendingOperation {
  return {
    id: 'op-recurring-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: operationType,
    status: 'pending',
    title: 'Recurring schedule',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'api_key',
    actor_id: 'key-1',
    actor_label: 'Test key',
    risk_level: 'medium',
    agent_metadata: null,
    rejection_category: null,
    rejection_reason: null,
    created_at: '2026-07-27T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-07-27T00:00:00Z',
  }
}

const createParams = {
  customer_id: CUSTOMER_ID,
  name: 'Månadsavgift',
  day_of_month: 25,
  send_hour: 8,
  payment_terms_days: 30,
  currency: 'SEK',
  auto_send: false,
  start_date: '2999-09-25',
  items: [{ description: 'Support', quantity: 1, unit: 'st', unit_price: 5000 }],
}

/**
 * Proxy-based mock that captures update payloads per table (same pattern as
 * customer-executor.test.ts) for asserting exactly what lands in updateRow.
 */
function createCapturingSupabase(results: Array<{ data: unknown; error: unknown }>) {
  const queue = [...results]
  const updates: Record<string, Record<string, unknown>[]> = {}
  const supabase = {
    from: vi.fn((table: string) => {
      const result = queue.shift() ?? { data: null, error: null }
      const chain: Record<string, unknown> = new Proxy(
        {},
        {
          get(_target, prop) {
            if (prop === 'then') {
              return (resolve: (value: unknown) => void) => resolve(result)
            }
            if (prop === 'update') {
              return (payload: Record<string, unknown>) => {
                ;(updates[table] ??= []).push(payload)
                return chain
              }
            }
            return () => chain
          },
        },
      )
      return chain
    }),
  }
  return { supabase, updates }
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: create_recurring_schedule', () => {
  it('creates the schedule with its items and returns qualified ids', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-recurring-1' } }) // claim
    enqueue({ data: { id: CUSTOMER_ID, email: 'billing@example.test' } }) // customer
    enqueue({ data: { id: SCHEDULE_ID } }) // schedule insert
    enqueue({ data: null }) // items insert
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('create_recurring_schedule', createParams),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      recurring_schedule_id: SCHEDULE_ID,
      customer_id: CUSTOMER_ID,
      status: 'active',
      auto_send: false,
      next_run_date: '2999-09-25',
      item_count: 1,
    })
    expect(supabase.from).toHaveBeenNthCalledWith(2, 'customers')
    expect(supabase.from).toHaveBeenNthCalledWith(3, 'recurring_invoice_schedules')
    expect(supabase.from).toHaveBeenNthCalledWith(4, 'recurring_invoice_schedule_items')
  })

  it('rolls back the schedule row when the items insert fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-recurring-1' } }) // claim
    enqueue({ data: { id: CUSTOMER_ID, email: null } }) // customer
    enqueue({ data: { id: SCHEDULE_ID } }) // schedule insert
    enqueue({ error: { message: 'items insert failed' } }) // items insert
    enqueue({ data: null }) // rollback delete
    enqueue({ data: null }) // status update to rejected

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('create_recurring_schedule', createParams),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(500)
    // The 5th from() call is the compensating delete on the parent row.
    expect(supabase.from).toHaveBeenNthCalledWith(5, 'recurring_invoice_schedules')
  })

  it('auto-rejects when the customer no longer exists', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-recurring-1' } }) // claim
    enqueue({ data: null }) // customer missing
    enqueue({ data: null }) // status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('create_recurring_schedule', createParams),
    )

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(404)
  })

  it('rejects auto_send at commit when the customer has no email', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-recurring-1' } }) // claim
    enqueue({ data: { id: CUSTOMER_ID, email: null } }) // customer
    enqueue({ data: null }) // status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('create_recurring_schedule', { ...createParams, auto_send: true }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/email/i)
  })

  it('rejects a start_date off the day_of_month grid at commit', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-recurring-1' } }) // claim
    enqueue({ data: { id: CUSTOMER_ID, email: null } }) // customer
    enqueue({ data: null }) // status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('create_recurring_schedule', { ...createParams, start_date: '2999-09-24' }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/day_of_month/)
  })

  it('rejects tampered params at the commit boundary', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-recurring-1' } }) // claim
    enqueue({ data: null }) // status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('create_recurring_schedule', { ...createParams, company_id: 'other-company' }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/unrecognized key/i)
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })
})

describe('commitPendingOperation: update_recurring_schedule', () => {
  const existingRow = {
    id: SCHEDULE_ID,
    status: 'active',
    auto_send: false,
    customer_id: CUSTOMER_ID,
    day_of_month: 25,
    next_run_date: '2999-01-25',
  }

  it('replaces all items when items are provided', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-recurring-1' } }) // claim
    enqueue({ data: existingRow }) // existing schedule
    // The helper re-reads the header row scoped by company_id before touching
    // the items: the items table has no company_id of its own, so this read is
    // what keeps the schedule_id-scoped delete/insert inside the tenant on the
    // service-role (RLS-off) executor path.
    enqueue({ data: existingRow }) // header ownership read
    enqueue({
      data: [
        { sort_order: 0, description: 'Old', quantity: 1, unit: 'st', unit_price: 100, vat_rate: null },
      ],
    }) // items snapshot
    enqueue({ data: null }) // delete old items
    enqueue({ data: null }) // insert new items
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('update_recurring_schedule', {
        schedule_id: SCHEDULE_ID,
        changes: {
          items: [
            { description: 'Ny rad', quantity: 2, unit: 'tim', unit_price: 1200 },
            { description: 'Ny rad 2', quantity: 1, unit: 'st', unit_price: 300, vat_rate: 25 },
          ],
        },
      }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      recurring_schedule_id: SCHEDULE_ID,
      items_replaced: true,
      item_count: 2,
    })
    expect(supabase.from).toHaveBeenNthCalledWith(3, 'recurring_invoice_schedules')
    expect(supabase.from).toHaveBeenNthCalledWith(4, 'recurring_invoice_schedule_items')
    expect(supabase.from).toHaveBeenNthCalledWith(5, 'recurring_invoice_schedule_items')
    expect(supabase.from).toHaveBeenNthCalledWith(6, 'recurring_invoice_schedule_items')
  })

  it('keeps existing items when items are omitted', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-recurring-1' } }) // claim
    enqueue({ data: existingRow }) // existing schedule
    enqueue({ data: null }) // schedule update
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('update_recurring_schedule', {
        schedule_id: SCHEDULE_ID,
        changes: { name: 'Nytt namn' },
      }),
    )

    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({
      recurring_schedule_id: SCHEDULE_ID,
      items_replaced: false,
      updated_fields: ['name'],
    })
    const touchedTables = supabase.from.mock.calls.map((c) => c[0])
    expect(touchedTables).not.toContain('recurring_invoice_schedule_items')
  })

  it('pauses via the status field without touching next_run_date', async () => {
    const { supabase, updates } = createCapturingSupabase([
      { data: { id: 'op-recurring-1' }, error: null }, // claim
      { data: existingRow, error: null }, // existing schedule
      { data: null, error: null }, // schedule update
      { data: null, error: null }, // finalize
    ])

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('update_recurring_schedule', {
        schedule_id: SCHEDULE_ID,
        changes: { status: 'paused' },
      }),
    )

    expect(result.status).toBe('committed')
    expect(updates.recurring_invoice_schedules).toEqual([{ status: 'paused' }])
  })

  it('resume from a stale date rolls next_run_date to a strictly future day and clears the warning', async () => {
    const { supabase, updates } = createCapturingSupabase([
      { data: { id: 'op-recurring-1' }, error: null }, // claim
      { data: { ...existingRow, status: 'paused', next_run_date: '2020-01-01' }, error: null },
      { data: null, error: null }, // schedule update
      { data: null, error: null }, // finalize
    ])

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('update_recurring_schedule', {
        schedule_id: SCHEDULE_ID,
        changes: { status: 'active' },
      }),
    )

    expect(result.status).toBe('committed')
    const payload = updates.recurring_invoice_schedules?.[0]
    expect(payload).toMatchObject({ status: 'active', last_run_warning: null })
    const { date: todayStockholm } = getStockholmDateHour(new Date())
    expect(payload?.next_run_date).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    // Strictly future: never today, so approval cannot trigger a same-hour send.
    expect(String(payload?.next_run_date) > todayStockholm).toBe(true)
  })

  it('resume with a future next_run_date leaves the date untouched', async () => {
    const { supabase, updates } = createCapturingSupabase([
      { data: { id: 'op-recurring-1' }, error: null }, // claim
      { data: { ...existingRow, status: 'paused' }, error: null }, // next_run_date 2999-01-25
      { data: null, error: null }, // schedule update
      { data: null, error: null }, // finalize
    ])

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('update_recurring_schedule', {
        schedule_id: SCHEDULE_ID,
        changes: { status: 'active' },
      }),
    )

    expect(result.status).toBe('committed')
    expect(updates.recurring_invoice_schedules).toEqual([
      { status: 'active', last_run_warning: null },
    ])
  })

  it('writes an explicit future next_run_date verbatim and skips the recompute', async () => {
    const { supabase, updates } = createCapturingSupabase([
      { data: { id: 'op-recurring-1' }, error: null }, // claim
      { data: { ...existingRow, interval_months: 12 }, error: null },
      { data: null, error: null }, // schedule update
      { data: null, error: null }, // finalize
    ])

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('update_recurring_schedule', {
        schedule_id: SCHEDULE_ID,
        changes: { day_of_month: 20, next_run_date: '2999-02-20' },
      }),
    )

    expect(result.status).toBe('committed')
    expect(updates.recurring_invoice_schedules).toEqual([
      { day_of_month: 20, next_run_date: '2999-02-20' },
    ])
  })

  it('rolls a next_run_date that went stale before approval forward on its own grid', async () => {
    const { supabase, updates } = createCapturingSupabase([
      { data: { id: 'op-recurring-1' }, error: null }, // claim
      { data: { ...existingRow, interval_months: 12 }, error: null },
      { data: null, error: null }, // schedule update
      { data: null, error: null }, // finalize
    ])

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('update_recurring_schedule', {
        schedule_id: SCHEDULE_ID,
        changes: { next_run_date: '2020-02-25' },
      }),
    )

    expect(result.status).toBe('committed')
    const next = String(updates.recurring_invoice_schedules?.[0]?.next_run_date)
    const { date: todayStockholm } = getStockholmDateHour(new Date())
    // Strictly future, and still a February 25 (the chosen phase survives).
    expect(next > todayStockholm).toBe(true)
    expect(next.slice(5)).toBe('02-25')
  })

  it('rejects a next_run_date off the day_of_month grid at commit', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-recurring-1' } }) // claim
    enqueue({ data: existingRow }) // existing
    enqueue({ data: null }) // status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('update_recurring_schedule', {
        schedule_id: SCHEDULE_ID,
        changes: { next_run_date: '2999-02-24' },
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/day_of_month/)
  })

  it('rejects enabling auto_send at commit when the customer has no email', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-recurring-1' } }) // claim
    enqueue({ data: existingRow }) // existing schedule
    enqueue({ data: { id: CUSTOMER_ID, email: null } }) // customer check
    enqueue({ data: null }) // status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('update_recurring_schedule', {
        schedule_id: SCHEDULE_ID,
        changes: { auto_send: true },
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/email/i)
  })

  it('auto-rejects when the schedule no longer exists', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-recurring-1' } }) // claim
    enqueue({ data: null }) // schedule missing
    enqueue({ data: null }) // status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('update_recurring_schedule', {
        schedule_id: SCHEDULE_ID,
        changes: { status: 'paused' },
      }),
    )

    expect(result.status).toBe('rejected')
    expect(result.auto_rejected).toBe(true)
    expect(result.http_status).toBe(404)
  })

  /**
   * A combined edit writes the header and then replaces the items, which
   * PostgREST cannot do atomically. Issue #1275: an item-insert failure used to
   * leave the header update committed, so the edit half-applied.
   */
  const fullExistingRow = {
    ...existingRow,
    name: 'Månadsavgift',
    updated_at: '2026-07-01T00:00:00Z',
  }
  const snapshotItem = {
    id: 'item-old-1',
    created_at: '2026-07-01T00:00:00Z',
    schedule_id: SCHEDULE_ID,
    sort_order: 0,
    description: 'Old',
    quantity: 1,
    unit: 'st',
    unit_price: 100,
    vat_rate: null,
    dimensions: {},
  }
  const combinedChanges = {
    schedule_id: SCHEDULE_ID,
    changes: {
      name: 'Nytt namn',
      items: [{ description: 'Ny rad', quantity: 2, unit: 'tim', unit_price: 1200 }],
    },
  }

  it('restores the prior header field when the items insert fails on a combined edit', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-recurring-1' } }) // claim
    enqueue({ data: fullExistingRow }) // existing schedule
    enqueue({ data: fullExistingRow }) // header snapshot
    enqueue({ data: { updated_at: '2026-07-30T09:00:00.000Z' } }) // header update
    enqueue({ data: [snapshotItem] }) // items snapshot
    enqueue({ data: null }) // delete old items
    enqueue({ error: { message: 'items insert failed', code: '23514' } }) // items insert
    enqueue({ data: null }) // items restore insert
    enqueue({ data: [{ id: SCHEDULE_ID }] }) // header restore update
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('update_recurring_schedule', combinedChanges),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(500)
    const updates = findCalls('recurring_invoice_schedules', 'update')
    expect(updates).toHaveLength(2)
    // The rollback puts the prior name back rather than leaving it half-saved.
    expect(updates[1][0]).toEqual({ name: 'Månadsavgift' })
  })

  it('reports the partial-state message when the items restore also fails', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-recurring-1' } }) // claim
    enqueue({ data: fullExistingRow }) // existing schedule
    enqueue({ data: fullExistingRow }) // header snapshot
    enqueue({ data: { updated_at: '2026-07-30T09:00:00.000Z' } }) // header update
    enqueue({ data: [snapshotItem] }) // items snapshot
    enqueue({ data: null }) // delete old items
    enqueue({ error: { message: 'items insert failed', code: '23514' } }) // items insert
    enqueue({ error: { message: 'restore boom' } }) // items restore insert fails
    enqueue({ data: [{ id: SCHEDULE_ID }] }) // header restore update
    enqueue({ data: null }) // finalize

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('update_recurring_schedule', combinedChanges),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(500)
    // Same registry sentence the PATCH route returns.
    expect(result.error).toMatch(/halvsparat/)
    // And the same machine-readable code, so an MCP caller can detect the
    // partial state without substring-matching the Swedish prose.
    expect(result.code).toBe('INVOICE_RECURRING_UPDATE_PARTIAL')
  })

  it('rejects tampered change fields at the commit boundary', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: 'op-recurring-1' } }) // claim
    enqueue({ data: null }) // status update

    const result = await commitPendingOperation(
      supabase as never,
      'user-1',
      'company-1',
      makePendingOp('update_recurring_schedule', {
        schedule_id: SCHEDULE_ID,
        changes: { company_id: 'other-company', name: 'X' },
      }),
    )

    expect(result.status).toBe('failed')
    expect(result.http_status).toBe(400)
    expect(result.error).toMatch(/unrecognized key/i)
    expect(supabase.from).toHaveBeenCalledTimes(2)
  })
})
