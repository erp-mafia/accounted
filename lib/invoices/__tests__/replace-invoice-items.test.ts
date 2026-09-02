import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { replaceInvoiceItems } from '../replace-invoice-items'
import type { InvoiceWriteItemRow } from '@/lib/invoices/build-invoice-write'

/**
 * Delete + insert over PostgREST is not atomic: an insert failure after a
 * successful delete used to leave the draft with ZERO items (the user's line
 * content gone). These tests pin the snapshot/restore added for that: the
 * pre-delete rows are best-effort reinserted and the result says whether the
 * restore worked.
 */

function makeItem(overrides: Partial<InvoiceWriteItemRow> = {}): InvoiceWriteItemRow {
  return {
    sort_order: 0,
    line_type: 'product',
    description: 'Konsulttimmar',
    quantity: 1,
    unit: 'tim',
    unit_price: 1000,
    discount_percent: 0,
    line_total: 1000,
    vat_rate: 25,
    vat_amount: 250,
    article_id: null,
    revenue_account: null,
    sales_order_item_id: null,
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
    ...overrides,
  }
}

/** A stored invoice_items row as SELECT * returns it (server columns included). */
function storedRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'item-old-1',
    invoice_id: 'inv-1',
    created_at: '2026-07-01T00:00:00Z',
    sort_order: 0,
    line_type: 'product',
    description: 'Gammal rad',
    quantity: 2,
    unit: 'st',
    unit_price: 500,
    line_total: 1000,
    vat_rate: 25,
    vat_amount: 250,
    article_id: null,
    revenue_account: null,
    ...overrides,
  }
}

function createHarness(opts: {
  snapshot?: unknown[] | null
  snapshotError?: unknown
  deleteError?: unknown
  /** Error returned by the n:th insert call (index 0 = the replace insert). */
  insertErrors?: (unknown | null)[]
}) {
  const inserts: Record<string, unknown>[][] = []
  const deletes: string[] = []
  let insertCall = 0
  const supabase = {
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn(() =>
          Promise.resolve({ data: opts.snapshot ?? [], error: opts.snapshotError ?? null }),
        ),
      })),
      delete: vi.fn(() => ({
        eq: vi.fn((_column: string, value: string) => {
          deletes.push(value)
          return Promise.resolve({ error: opts.deleteError ?? null })
        }),
      })),
      insert: vi.fn((rows: Record<string, unknown>[]) => {
        inserts.push(rows)
        const error = opts.insertErrors?.[insertCall] ?? null
        insertCall += 1
        return Promise.resolve({ error })
      }),
    })),
  }
  return { supabase: supabase as unknown as SupabaseClient, inserts, deletes }
}

const insertBoom = { message: 'insert boom', code: '23502' }

const ORDER_LINE_1 = 'd1000000-0000-4000-8000-000000000001'
const ORDER_LINE_2 = 'd1000000-0000-4000-8000-000000000002'

const guardResult = {
  ok: false,
  stage: 'guard',
  code: 'INVOICE_UPDATE_DROPS_ORDER_LINK',
  messageSv: expect.stringContaining('kundorder'),
}

describe('replaceInvoiceItems order-link guard', () => {
  it('refuses before deleting when the new lines drop a sales_order_item_id link', async () => {
    const { supabase, inserts, deletes } = createHarness({
      snapshot: [storedRow({ sales_order_item_id: ORDER_LINE_1 })],
    })

    const result = await replaceInvoiceItems(supabase, 'inv-1', [makeItem({ sales_order_item_id: null })])

    expect(result).toEqual(guardResult)
    expect(deletes).toHaveLength(0)
    expect(inserts).toHaveLength(0)
  })

  it('proceeds when every existing link is kept on the new lines', async () => {
    const { supabase, inserts, deletes } = createHarness({
      snapshot: [
        storedRow({ sales_order_item_id: ORDER_LINE_1 }),
        storedRow({ id: 'item-old-2', sort_order: 1, sales_order_item_id: ORDER_LINE_2 }),
      ],
    })

    const result = await replaceInvoiceItems(supabase, 'inv-1', [
      // Reordered and with an extra unlinked line: still covers both links.
      makeItem({ sort_order: 0, sales_order_item_id: ORDER_LINE_2 }),
      makeItem({ sort_order: 1, description: 'Fri rad', sales_order_item_id: null }),
      makeItem({ sort_order: 2, sales_order_item_id: ORDER_LINE_1 }),
    ])

    expect(result).toEqual({ ok: true })
    expect(deletes).toEqual(['inv-1'])
    expect(inserts).toHaveLength(1)
    expect(inserts[0].map((r) => r.sales_order_item_id)).toEqual([ORDER_LINE_2, null, ORDER_LINE_1])
  })

  it('proceeds when the draft carries no order links at all', async () => {
    const { supabase, inserts, deletes } = createHarness({
      snapshot: [storedRow({ sales_order_item_id: null }), storedRow({ id: 'item-old-2', sort_order: 1 })],
    })

    const result = await replaceInvoiceItems(supabase, 'inv-1', [makeItem({ description: 'Ny rad' })])

    expect(result).toEqual({ ok: true })
    expect(deletes).toEqual(['inv-1'])
    expect(inserts).toHaveLength(1)
  })

  it('compares links as a multiset: two rows on the same order line need two links back', async () => {
    const { supabase, inserts } = createHarness({
      snapshot: [
        storedRow({ sales_order_item_id: ORDER_LINE_1 }),
        storedRow({ id: 'item-old-2', sort_order: 1, sales_order_item_id: ORDER_LINE_1 }),
      ],
    })

    const dropped = await replaceInvoiceItems(supabase, 'inv-1', [makeItem({ sales_order_item_id: ORDER_LINE_1 })])
    expect(dropped).toEqual(guardResult)
    expect(inserts).toHaveLength(0)

    const kept = await replaceInvoiceItems(supabase, 'inv-1', [
      makeItem({ sales_order_item_id: ORDER_LINE_1 }),
      makeItem({ sort_order: 1, sales_order_item_id: ORDER_LINE_1 }),
    ])
    expect(kept).toEqual({ ok: true })
    expect(inserts).toHaveLength(1)
  })

  it('refuses when a link is swapped for a different order line', async () => {
    const { supabase, inserts } = createHarness({
      snapshot: [storedRow({ sales_order_item_id: ORDER_LINE_1 })],
    })

    const result = await replaceInvoiceItems(supabase, 'inv-1', [makeItem({ sales_order_item_id: ORDER_LINE_2 })])

    expect(result).toEqual(guardResult)
    expect(inserts).toHaveLength(0)
  })

  it('does not guard when the snapshot could not be read (nothing to compare against)', async () => {
    const { supabase, inserts, deletes } = createHarness({
      snapshot: null,
      snapshotError: { message: 'select boom' },
    })

    const result = await replaceInvoiceItems(supabase, 'inv-1', [makeItem()])

    expect(result).toEqual({ ok: true })
    expect(deletes).toEqual(['inv-1'])
    expect(inserts).toHaveLength(1)
  })
})

describe('replaceInvoiceItems', () => {
  it('replaces the rows and stamps invoice_id on the happy path', async () => {
    const { supabase, inserts } = createHarness({ snapshot: [storedRow()] })

    const result = await replaceInvoiceItems(supabase, 'inv-1', [
      makeItem({ description: 'Ny rad' }),
    ])

    expect(result).toEqual({ ok: true })
    expect(inserts).toHaveLength(1)
    expect(inserts[0][0]).toMatchObject({ description: 'Ny rad', invoice_id: 'inv-1' })
  })

  it('restores the snapshotted rows when the insert fails', async () => {
    const { supabase, inserts } = createHarness({
      snapshot: [storedRow(), storedRow({ id: 'item-old-2', sort_order: 1, description: 'Rad 2' })],
      insertErrors: [insertBoom, null],
    })

    const result = await replaceInvoiceItems(supabase, 'inv-1', [makeItem()])

    expect(result).toEqual({
      ok: false,
      stage: 'insert',
      error: insertBoom,
      restored: true,
    })
    // Two inserts: the failed replace, then the restore of the snapshot.
    expect(inserts).toHaveLength(2)
    const restore = inserts[1]
    expect(restore).toHaveLength(2)
    expect(restore.map((r) => r.description)).toEqual(['Gammal rad', 'Rad 2'])
    // Server-generated columns stripped, invoice_id re-stamped.
    for (const row of restore) {
      expect(row.id).toBeUndefined()
      expect(row.created_at).toBeUndefined()
      expect(row.invoice_id).toBe('inv-1')
    }
  })

  it('reports restored: false when the restore insert also fails', async () => {
    const { supabase, inserts } = createHarness({
      snapshot: [storedRow()],
      insertErrors: [insertBoom, { message: 'restore boom' }],
    })

    const result = await replaceInvoiceItems(supabase, 'inv-1', [makeItem()])

    expect(result).toMatchObject({ ok: false, stage: 'insert', restored: false })
    expect(inserts).toHaveLength(2)
  })

  it('reports restored: false when the snapshot itself could not be read', async () => {
    // With no snapshot there is nothing to reinsert, and claiming the draft is
    // intact would be a guess: the delete may well have removed real rows.
    const { supabase, inserts } = createHarness({
      snapshot: null,
      snapshotError: { message: 'select boom' },
      insertErrors: [insertBoom],
    })

    const result = await replaceInvoiceItems(supabase, 'inv-1', [makeItem()])

    expect(result).toMatchObject({ ok: false, stage: 'insert', restored: false })
    expect(inserts).toHaveLength(1)
  })

  it('reports restored: true when the draft had no items to begin with', async () => {
    const { supabase, inserts } = createHarness({
      snapshot: [],
      insertErrors: [insertBoom],
    })

    const result = await replaceInvoiceItems(supabase, 'inv-1', [makeItem()])

    expect(result).toMatchObject({ ok: false, stage: 'insert', restored: true })
    // No restore insert: the prior state (empty) already holds.
    expect(inserts).toHaveLength(1)
  })

  it('stops at the delete stage without touching inserts when the delete fails', async () => {
    const deleteBoom = { message: 'delete boom' }
    const { supabase, inserts } = createHarness({
      snapshot: [storedRow()],
      deleteError: deleteBoom,
    })

    const result = await replaceInvoiceItems(supabase, 'inv-1', [makeItem()])

    expect(result).toEqual({ ok: false, stage: 'delete', error: deleteBoom })
    expect(inserts).toHaveLength(0)
  })
})
