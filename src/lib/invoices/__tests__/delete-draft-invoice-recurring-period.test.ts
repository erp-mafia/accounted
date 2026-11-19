import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { deleteDraftInvoice } from '@/lib/invoices/delete-draft-invoice'

/**
 * crm#1285: a recurring schedule advances period_start when it spawns a
 * draft. Removing that draft before it was issued (hard delete when
 * unnumbered, makulering when numbered) must give the schedule its period
 * back, or the next run bills the period after it and skips this one.
 */
describe('deleteDraftInvoice gives a recurring schedule its period back', () => {
  const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
  const client = supabase as unknown as SupabaseClient
  const base = { supabase: client, companyId: 'company-1', userId: 'user-1', invoiceId: 'inv-1' }

  function draft(overrides: Record<string, unknown> = {}) {
    return {
      id: 'inv-1',
      status: 'draft',
      invoice_number: null,
      user_id: 'user-1',
      credited_invoice_id: null,
      journal_entry_id: null,
      spawned_by: [{ id: 'sched-1', period_start: '2026-12-01', interval_months: 1 }],
      ...overrides,
    }
  }

  function scheduleFilters(method: 'eq' | 'is'): unknown[][] {
    return findCalls('recurring_invoice_schedules', method)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
    eventBus.clear()
  })

  it('reads the spawning schedule with the invoice, before the delete nulls last_invoice_id', async () => {
    enqueue({ data: draft({ spawned_by: [] }), error: null })
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // hard delete

    await deleteDraftInvoice(base)

    expect(String(findCall('invoices', 'select')?.[0])).toContain(
      'recurring_invoice_schedules!last_invoice_id(id, period_start, interval_months)',
    )
  })

  it('an unnumbered draft that is hard-deleted steps period_start back one interval', async () => {
    enqueue({ data: draft(), error: null })
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // hard delete
    enqueue({ data: [{ id: 'sched-1' }], error: null }) // schedule restore

    const result = await deleteDraftInvoice(base)

    expect(result).toEqual({ ok: true, outcome: 'deleted' })
    expect(findCalls('recurring_invoice_schedules', 'update')).toEqual([[{ period_start: '2026-11-01' }]])
    // Compare-and-set: only the period read with the invoice, and only while
    // no later run took last_invoice_id (the FK nulled it on delete).
    expect(scheduleFilters('eq')).toEqual(
      expect.arrayContaining([
        ['id', 'sched-1'],
        ['company_id', 'company-1'],
        ['period_start', '2026-12-01'],
      ]),
    )
    expect(scheduleFilters('is')).toEqual([['last_invoice_id', null]])
  })

  it('a numbered draft that is makulerad steps the period back too, pinned to this invoice', async () => {
    enqueue({ data: draft({ invoice_number: '021' }), error: null })
    enqueue({ data: [{ id: 'inv-1' }], error: null }) // status -> cancelled
    enqueue({ data: [{ id: 'sched-1' }], error: null }) // schedule restore

    const result = await deleteDraftInvoice(base)

    expect(result).toEqual({ ok: true, outcome: 'cancelled', invoiceNumber: '021' })
    expect(findCalls('recurring_invoice_schedules', 'update')).toEqual([[{ period_start: '2026-11-01' }]])
    expect(scheduleFilters('eq')).toEqual(
      expect.arrayContaining([
        ['period_start', '2026-12-01'],
        ['last_invoice_id', 'inv-1'],
      ]),
    )
  })

  it('steps a quarterly schedule back a whole quarter', async () => {
    enqueue({ data: draft({ spawned_by: [{ id: 'sched-1', period_start: '2027-01-01', interval_months: 3 }] }), error: null })
    enqueue({ data: [{ id: 'inv-1' }], error: null })
    enqueue({ data: [{ id: 'sched-1' }], error: null })

    await deleteDraftInvoice(base)

    expect(findCalls('recurring_invoice_schedules', 'update')).toEqual([[{ period_start: '2026-10-01' }]])
  })

  it('leaves schedules alone for a draft no schedule spawned last', async () => {
    enqueue({ data: draft({ spawned_by: [] }), error: null })
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    const result = await deleteDraftInvoice(base)

    expect(result).toEqual({ ok: true, outcome: 'deleted' })
    expect(findCalls('recurring_invoice_schedules', 'update')).toEqual([])
  })

  it('leaves a schedule without a period alone', async () => {
    enqueue({ data: draft({ spawned_by: [{ id: 'sched-1', period_start: null, interval_months: 1 }] }), error: null })
    enqueue({ data: [{ id: 'inv-1' }], error: null })

    await deleteDraftInvoice(base)

    expect(findCalls('recurring_invoice_schedules', 'update')).toEqual([])
  })

  it('never touches the schedule when the draft could not be removed', async () => {
    enqueue({ data: draft(), error: null })
    enqueue({ data: [], error: null }) // finalized concurrently: nothing deleted

    const result = await deleteDraftInvoice(base)

    expect(result).toEqual({ ok: false, code: 'INVOICE_CANCEL_RACE' })
    expect(findCalls('recurring_invoice_schedules', 'update')).toEqual([])
  })

  it('never touches the schedule for an invoice that is not a draft', async () => {
    enqueue({ data: draft({ status: 'sent', invoice_number: '021' }), error: null })

    const result = await deleteDraftInvoice(base)

    expect(result).toMatchObject({ ok: false, code: 'INVOICE_DELETE_NOT_DRAFT' })
    expect(findCalls('recurring_invoice_schedules', 'update')).toEqual([])
  })

  it('a failed restore never fails the removal itself', async () => {
    enqueue({ data: draft(), error: null })
    enqueue({ data: [{ id: 'inv-1' }], error: null })
    enqueue({ data: null, error: { message: 'boom' } })

    const result = await deleteDraftInvoice(base)

    expect(result).toEqual({ ok: true, outcome: 'deleted' })
  })
})
