import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  applyRecurringScheduleUpdate,
  type RecurringScheduleItemInput,
} from '../apply-recurring-schedule-update'

/**
 * A combined edit writes two tables over PostgREST, which is not atomic: the
 * header update commits before the item replace runs. These tests pin that BOTH
 * writes are compensated, that an unchecked delete can no longer double-insert,
 * and that a failed compensation is reported instead of swallowed (issue #1275).
 */

const SCHEDULE_ID = 's-1'
const COMPANY_ID = 'company-1'
const STAMP = '2026-07-30T09:00:00.000Z'

function makeItem(
  overrides: Partial<RecurringScheduleItemInput> = {},
): RecurringScheduleItemInput {
  return {
    description: 'Support',
    quantity: 1,
    unit: 'st',
    unit_price: 5000,
    ...overrides,
  }
}

/** A stored item row as SELECT * returns it (server columns included). */
function storedItem(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'item-old-1',
    schedule_id: SCHEDULE_ID,
    created_at: '2026-07-01T00:00:00Z',
    sort_order: 0,
    description: 'Gammal rad',
    quantity: 2,
    unit: 'st',
    unit_price: 500,
    vat_rate: 25,
    dimensions: {},
    ...overrides,
  }
}

const headerRow = {
  id: SCHEDULE_ID,
  company_id: COMPANY_ID,
  name: 'Månadsavgift',
  day_of_month: 25,
  default_dimensions: { '1': 'A' },
  next_run_date: '2026-08-25',
  updated_at: '2026-07-01T00:00:00Z',
}

const SCHEDULES = 'recurring_invoice_schedules'
const ITEMS = 'recurring_invoice_schedule_items'

type Fail = { message: string; code?: string } | null

/**
 * Table-aware harness. Records every update payload and insert rows array per
 * table, plus the `.eq()` filters used on the restore update, and allows
 * injecting an error on the delete, the n:th items insert, or the header
 * writes.
 */
function createHarness(opts: {
  headerSnapshot?: Record<string, unknown> | null
  headerSnapshotError?: Fail
  headerUpdateError?: Fail
  /** Value of updated_at returned by the header update representation. */
  headerStamp?: string | null
  /** Rows matched by the restore update's .select('id'). Default: one row. */
  headerRestoreMatched?: boolean
  headerRestoreError?: Fail
  itemsSnapshot?: Record<string, unknown>[] | null
  itemsSnapshotError?: Fail
  itemsDeleteError?: Fail
  /** Error for the n:th insert on the items table (index 0 = the replace). */
  itemsInsertErrors?: Fail[]
}) {
  const updates: Record<string, Record<string, unknown>[]> = {}
  const inserts: Record<string, Record<string, unknown>[][]> = {}
  const eqFilters: Record<string, unknown[][]> = {}
  const deletes: string[] = []
  let headerUpdateCall = 0
  let itemsInsertCall = 0

  const tables = vi.fn((table: string) => {
    if (table === SCHEDULES) {
      return {
        select: () => ({
          eq: () => ({
            eq: () => ({
              maybeSingle: () =>
                Promise.resolve({
                  data: opts.headerSnapshotError
                    ? null
                    : opts.headerSnapshot === undefined
                      ? headerRow
                      : opts.headerSnapshot,
                  error: opts.headerSnapshotError ?? null,
                }),
            }),
          }),
        }),
        update: (payload: Record<string, unknown>) => {
          ;(updates[table] ??= []).push(payload)
          const call = headerUpdateCall
          headerUpdateCall += 1
          const filters: unknown[] = []
          ;(eqFilters[`${table}:${call}`] ??= []).push(filters)
          const chain: Record<string, unknown> = {
            eq: (...args: unknown[]) => {
              filters.push(args)
              return chain
            },
            select: () => {
              if (call === 0) {
                return {
                  maybeSingle: () =>
                    Promise.resolve({
                      data: opts.headerUpdateError
                        ? null
                        : {
                            updated_at:
                              opts.headerStamp === undefined ? STAMP : opts.headerStamp,
                          },
                      error: opts.headerUpdateError ?? null,
                    }),
                }
              }
              // The restore update reads back the matched ids.
              const matched = opts.headerRestoreMatched === false ? [] : [{ id: SCHEDULE_ID }]
              return Promise.resolve({
                data: opts.headerRestoreError ? null : matched,
                error: opts.headerRestoreError ?? null,
              })
            },
          }
          return chain
        },
      }
    }
    return {
      // The snapshot is read through fetchAllRows, so the chain ends in
      // .order().range() rather than resolving straight after .eq().
      select: () => ({
        eq: () => ({
          order: () => ({
            range: () =>
              Promise.resolve({
                data: opts.itemsSnapshot === undefined ? [storedItem()] : opts.itemsSnapshot,
                error: opts.itemsSnapshotError ?? null,
              }),
          }),
        }),
      }),
      delete: () => ({
        eq: () => {
          deletes.push(table)
          return Promise.resolve({ error: opts.itemsDeleteError ?? null })
        },
      }),
      insert: (rows: Record<string, unknown>[]) => {
        ;(inserts[table] ??= []).push(rows)
        const error = opts.itemsInsertErrors?.[itemsInsertCall] ?? null
        itemsInsertCall += 1
        return Promise.resolve({ error })
      },
    }
  })

  const log = { error: vi.fn() }
  return {
    supabase: { from: tables } as unknown as SupabaseClient,
    from: tables,
    updates,
    inserts,
    eqFilters,
    deletes,
    log,
  }
}

const insertBoom = { message: 'insert boom', code: '23514' }

describe('applyRecurringScheduleUpdate', () => {
  it('writes only the header for a header-only edit', async () => {
    const h = createHarness({})

    const result = await applyRecurringScheduleUpdate(h.supabase, {
      scheduleId: SCHEDULE_ID,
      companyId: COMPANY_ID,
      fields: { name: 'Nytt namn' },
      log: h.log,
    })

    expect(result).toEqual({ ok: true })
    expect(h.updates[SCHEDULES]).toEqual([{ name: 'Nytt namn' }])
    // No snapshot read: exactly one call against the schedules table, and the
    // items table is never touched.
    const tablesTouched = h.from.mock.calls.map((c) => c[0])
    expect(tablesTouched).toEqual([SCHEDULES])
  })

  it('writes only the items for an item-only edit', async () => {
    const h = createHarness({})

    const result = await applyRecurringScheduleUpdate(h.supabase, {
      scheduleId: SCHEDULE_ID,
      companyId: COMPANY_ID,
      fields: {},
      items: [makeItem({ description: 'Rad A' }), makeItem({ description: 'Rad B', vat_rate: 25 })],
      log: h.log,
    })

    expect(result).toEqual({ ok: true })
    // The schedules table is READ (the ownership proof for the schedule_id-only
    // item writes) but never written on an item-only edit.
    expect(h.from.mock.calls.map((c) => c[0])).toContain(SCHEDULES)
    expect(h.updates[SCHEDULES]).toBeUndefined()
    expect(h.inserts[ITEMS]).toHaveLength(1)
    expect(h.inserts[ITEMS][0]).toEqual([
      {
        schedule_id: SCHEDULE_ID,
        sort_order: 0,
        description: 'Rad A',
        quantity: 1,
        unit: 'st',
        unit_price: 5000,
        vat_rate: null,
        dimensions: {},
      },
      {
        schedule_id: SCHEDULE_ID,
        sort_order: 1,
        description: 'Rad B',
        quantity: 1,
        unit: 'st',
        unit_price: 5000,
        vat_rate: 25,
        dimensions: {},
      },
    ])
  })

  it('rolls the header fields back when the items insert fails on a combined edit', async () => {
    const h = createHarness({
      itemsSnapshot: [storedItem(), storedItem({ id: 'item-old-2', sort_order: 1, description: 'Rad 2' })],
      itemsInsertErrors: [insertBoom, null],
    })

    const result = await applyRecurringScheduleUpdate(h.supabase, {
      scheduleId: SCHEDULE_ID,
      companyId: COMPANY_ID,
      fields: { day_of_month: 5, default_dimensions: {} },
      items: [makeItem()],
      log: h.log,
    })

    expect(result).toEqual({
      ok: false,
      stage: 'items_insert',
      error: insertBoom,
      itemsRestored: true,
      headerRestored: true,
    })
    // Second header update restores exactly the written keys, nothing else.
    expect(h.updates[SCHEDULES]).toHaveLength(2)
    expect(h.updates[SCHEDULES][1]).toEqual({
      day_of_month: 25,
      default_dimensions: { '1': 'A' },
    })
    // Guarded on the stamp our own update produced, so a concurrent writer wins.
    expect(h.eqFilters[`${SCHEDULES}:1`][0]).toEqual([
      ['id', SCHEDULE_ID],
      ['company_id', COMPANY_ID],
      ['updated_at', STAMP],
    ])
    // Items restored from the snapshot, server columns stripped.
    expect(h.inserts[ITEMS]).toHaveLength(2)
    const restore = h.inserts[ITEMS][1]
    expect(restore.map((r) => r.description)).toEqual(['Gammal rad', 'Rad 2'])
    for (const row of restore) {
      expect(row.id).toBeUndefined()
      expect(row.created_at).toBeUndefined()
      expect(row.schedule_id).toBe(SCHEDULE_ID)
    }
  })

  it('reports itemsRestored: false and logs the lost rows when the items restore fails', async () => {
    const h = createHarness({
      itemsSnapshot: [storedItem()],
      itemsInsertErrors: [insertBoom, { message: 'restore boom' }],
    })

    const result = await applyRecurringScheduleUpdate(h.supabase, {
      scheduleId: SCHEDULE_ID,
      companyId: COMPANY_ID,
      fields: { name: 'Nytt namn' },
      items: [makeItem()],
      log: h.log,
    })

    expect(result).toMatchObject({
      ok: false,
      stage: 'items_insert',
      itemsRestored: false,
      headerRestored: true,
    })
    const logged = h.log.error.mock.calls.find((c) => /may be left with no items/.test(String(c[0])))
    expect(logged).toBeDefined()
    expect(logged?.[2]).toMatchObject({ scheduleId: SCHEDULE_ID })
    expect((logged?.[2] as { previousItems: unknown[] }).previousItems).toHaveLength(1)
  })

  it('reports headerRestored: false when the rollback update errors', async () => {
    const h = createHarness({
      itemsInsertErrors: [insertBoom, null],
      headerRestoreError: { message: 'restore update boom' },
    })

    const result = await applyRecurringScheduleUpdate(h.supabase, {
      scheduleId: SCHEDULE_ID,
      companyId: COMPANY_ID,
      fields: { day_of_month: 5 },
      items: [makeItem()],
      log: h.log,
    })

    expect(result).toMatchObject({ ok: false, headerRestored: false, itemsRestored: true })
    const logged = h.log.error.mock.calls.find((c) => /half-saved/.test(String(c[0])))
    expect(logged?.[2]).toMatchObject({ restoreRow: { day_of_month: 25 }, headerStamp: STAMP })
  })

  it('reports headerRestored: false when a concurrent writer moved the row on', async () => {
    // 0 rows matched: updated_at changed between our write and the rollback, so
    // the other writer's value must stand rather than be clobbered.
    const h = createHarness({
      itemsInsertErrors: [insertBoom, null],
      headerRestoreMatched: false,
    })

    const result = await applyRecurringScheduleUpdate(h.supabase, {
      scheduleId: SCHEDULE_ID,
      companyId: COMPANY_ID,
      fields: { day_of_month: 5 },
      items: [makeItem()],
      log: h.log,
    })

    expect(result).toMatchObject({ ok: false, headerRestored: false })
    expect(h.log.error.mock.calls.some((c) => /half-saved/.test(String(c[0])))).toBe(true)
  })

  it('writes nothing at all when the header row is missing', async () => {
    // No snapshot means no rollback source and no proof the schedule belongs to
    // this company, so the header must NOT be updated: a write here would be
    // committed in the full knowledge that it could never be undone.
    const h = createHarness({ headerSnapshot: null, itemsInsertErrors: [insertBoom, null] })

    const result = await applyRecurringScheduleUpdate(h.supabase, {
      scheduleId: SCHEDULE_ID,
      companyId: COMPANY_ID,
      fields: { day_of_month: 5 },
      items: [makeItem()],
      log: h.log,
    })

    expect(result).toMatchObject({ ok: false, stage: 'header' })
    expect(h.log.error.mock.calls.some((c) => /nothing was written/.test(String(c[0])))).toBe(true)
    expect(h.updates[SCHEDULES]).toBeUndefined()
    expect(h.inserts[ITEMS]).toBeUndefined()
    expect(h.deletes).toEqual([])
  })

  it('writes nothing at all when the header snapshot read errors', async () => {
    const snapshotBoom = { message: 'snapshot boom', code: '57014' }
    const h = createHarness({ headerSnapshotError: snapshotBoom })

    const result = await applyRecurringScheduleUpdate(h.supabase, {
      scheduleId: SCHEDULE_ID,
      companyId: COMPANY_ID,
      fields: { day_of_month: 5 },
      items: [makeItem()],
      log: h.log,
    })

    expect(result).toEqual({ ok: false, stage: 'header', error: snapshotBoom })
    expect(h.updates[SCHEDULES]).toBeUndefined()
    expect(h.from.mock.calls.map((c) => c[0])).not.toContain(ITEMS)
  })

  it('leaves the items untouched and rolls the header back when the item snapshot errors', async () => {
    // The single branch that can end with a schedule holding zero items: an
    // unreadable snapshot must abort BEFORE the delete, not delete first and
    // report itemsRestored: false afterwards.
    const snapshotBoom = { message: 'items snapshot boom', code: '57014' }
    const h = createHarness({ itemsSnapshotError: snapshotBoom })

    const result = await applyRecurringScheduleUpdate(h.supabase, {
      scheduleId: SCHEDULE_ID,
      companyId: COMPANY_ID,
      fields: { day_of_month: 5 },
      items: [makeItem()],
      log: h.log,
    })

    expect(result).toMatchObject({
      ok: false,
      stage: 'items_delete',
      itemsRestored: true,
      headerRestored: true,
    })
    expect((result as { error: { message: string } }).error.message).toContain(
      'items snapshot boom',
    )
    // Nothing was deleted and nothing was inserted: the schedule keeps its
    // lines, so the cron's "schedule has no items" invariant still holds.
    expect(h.deletes).toEqual([])
    expect(h.inserts[ITEMS]).toBeUndefined()
    // The header edit is undone, so the failure is clean rather than partial.
    expect(h.updates[SCHEDULES]).toHaveLength(2)
    expect(h.updates[SCHEDULES][1]).toEqual({ day_of_month: 25 })
    expect(h.log.error.mock.calls.some((c) => /snapshot unreadable/.test(String(c[0])))).toBe(true)
  })

  it('stops at the delete stage without inserting anything', async () => {
    const deleteBoom = { message: 'delete boom' }
    const h = createHarness({ itemsDeleteError: deleteBoom })

    const result = await applyRecurringScheduleUpdate(h.supabase, {
      scheduleId: SCHEDULE_ID,
      companyId: COMPANY_ID,
      fields: { day_of_month: 5 },
      items: [makeItem()],
      log: h.log,
    })

    expect(result).toEqual({
      ok: false,
      stage: 'items_delete',
      error: deleteBoom,
      itemsRestored: true,
      headerRestored: true,
    })
    // Nothing was removed, so nothing may be inserted: a blind insert after a
    // failed delete would duplicate every line.
    expect(h.inserts[ITEMS]).toBeUndefined()
    // The header edit is still rolled back.
    expect(h.updates[SCHEDULES]).toHaveLength(2)
    expect(h.updates[SCHEDULES][1]).toEqual({ day_of_month: 25 })
  })

  it('stops at the header stage without touching the items table', async () => {
    const headerBoom = { message: 'header boom', code: '23514' }
    const h = createHarness({ headerUpdateError: headerBoom })

    const result = await applyRecurringScheduleUpdate(h.supabase, {
      scheduleId: SCHEDULE_ID,
      companyId: COMPANY_ID,
      fields: { day_of_month: 5 },
      items: [makeItem()],
      log: h.log,
    })

    expect(result).toEqual({ ok: false, stage: 'header', error: headerBoom })
    expect(h.from.mock.calls.map((c) => c[0])).not.toContain(ITEMS)
  })

  it('is a no-op when there is nothing to write', async () => {
    const h = createHarness({})

    const result = await applyRecurringScheduleUpdate(h.supabase, {
      scheduleId: SCHEDULE_ID,
      companyId: COMPANY_ID,
      fields: {},
      log: h.log,
    })

    expect(result).toEqual({ ok: true })
    expect(h.from).not.toHaveBeenCalled()
  })

  it('restores an empty item set without a write when there were no items before', async () => {
    const h = createHarness({ itemsSnapshot: [], itemsInsertErrors: [insertBoom] })

    const result = await applyRecurringScheduleUpdate(h.supabase, {
      scheduleId: SCHEDULE_ID,
      companyId: COMPANY_ID,
      fields: {},
      items: [makeItem()],
      log: h.log,
    })

    expect(result).toMatchObject({ ok: false, itemsRestored: true, headerRestored: true })
    expect(h.inserts[ITEMS]).toHaveLength(1)
  })
})
