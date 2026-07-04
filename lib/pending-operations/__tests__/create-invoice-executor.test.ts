/**
 * Unit tests for the create_invoice executor, run through the public
 * `commitPendingOperation` dispatcher (executors are not exported).
 *
 * Covers the two server-authoritative VAT behaviors flagged in review:
 *  1. A non-VAT-registered company gets every line rate coerced to 0 and the
 *     invoice stored as momsfri ('exempt'), regardless of what was staged.
 *  2. Free-text rows (line_type 'text') are excluded from subtotal, VAT, and
 *     mixed-rate detection: a text row's 0% must not flip vat_rate to null.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { eventBus } from '@/lib/events/bus'
import { makeCustomer } from '@/tests/helpers'
import type { PendingOperation } from '@/types'

import { commitPendingOperation } from '../commit'

function makePendingOp(overrides: Partial<PendingOperation>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: 'company-1',
    operation_type: 'create_invoice',
    status: 'pending',
    title: 'test',
    params: {},
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'medium',
    created_at: '2026-05-03T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-05-03T00:00:00Z',
    ...overrides,
  } as PendingOperation
}

/**
 * Queue-based supabase mock that also records `.insert()` payloads per table,
 * so assertions can inspect what was actually written.
 */
function createCapturingSupabase(results: Array<{ data?: unknown; error?: unknown }>) {
  const queue = [...results]
  const inserts: Record<string, unknown[]> = {}

  const from = vi.fn((table: string) => {
    const raw = queue.shift() ?? { data: null, error: null }
    const result = { data: raw.data ?? null, error: raw.error ?? null }
    const chain: object = new Proxy(
      {},
      {
        get(_target, prop) {
          if (prop === 'then') {
            return (resolve: (v: unknown) => void) => resolve(result)
          }
          if (prop === 'insert') {
            return (payload: unknown) => {
              ;(inserts[table] ??= []).push(payload)
              return chain
            }
          }
          return () => chain
        },
      },
    )
    return chain
  })

  return { supabase: { from }, inserts }
}

const customer = makeCustomer({ id: 'cust-1', customer_type: 'swedish_business' })

/** Queue for the dispatcher + executor call sequence (SEK, no overrides):
 *  CAS claim → customers → company_settings → invoices insert →
 *  invoice_items insert → complete-invoice select → dispatcher update. */
function queueFor(settings: { vat_registered: boolean } | null) {
  return [
    { data: { id: 'op-1' } },
    { data: customer },
    { data: settings },
    { data: { id: 'inv-1', invoice_number: null } },
    { data: null },
    { data: { id: 'inv-1' } },
    { data: null },
  ]
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('commitPendingOperation: create_invoice', () => {
  it('coerces a staged non-zero VAT rate to 0 for a non-VAT-registered company', async () => {
    const { supabase, inserts } = createCapturingSupabase(queueFor({ vat_registered: false }))

    const op = makePendingOp({
      params: {
        customer_id: 'cust-1',
        items: [{ description: 'Konsulttimmar', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
        invoice_date: '2026-06-01',
        due_date: '2026-07-01',
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(inserts['invoices']).toHaveLength(1)
    expect(inserts['invoices'][0]).toMatchObject({
      subtotal: 1000,
      vat_amount: 0,
      total: 1000,
      vat_rate: 0,
      vat_treatment: 'exempt',
      moms_ruta: null,
    })
    const itemRows = inserts['invoice_items'][0] as Array<Record<string, unknown>>
    expect(itemRows).toHaveLength(1)
    expect(itemRows[0]).toMatchObject({ vat_rate: 0, vat_amount: 0 })
  })

  it('keeps the staged rate for a VAT-registered company', async () => {
    const { supabase, inserts } = createCapturingSupabase(queueFor({ vat_registered: true }))

    const op = makePendingOp({
      params: {
        customer_id: 'cust-1',
        items: [{ description: 'Konsulttimmar', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(inserts['invoices'][0]).toMatchObject({
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      vat_rate: 25,
      moms_ruta: '05',
    })
  })

  it('excludes text rows from totals and mixed-rate detection', async () => {
    const { supabase, inserts } = createCapturingSupabase(queueFor({ vat_registered: true }))

    const op = makePendingOp({
      params: {
        customer_id: 'cust-1',
        items: [
          { description: 'Konsulttimmar', quantity: 2, unit: 'tim', unit_price: 500, vat_rate: 25 },
          { line_type: 'text', description: 'Avser vecka 23', quantity: 0, unit: '', unit_price: 0, vat_rate: 0 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    // The text row's 0% must not trigger mixed-rate (vat_rate: null).
    expect(inserts['invoices'][0]).toMatchObject({
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      vat_rate: 25,
    })
    const itemRows = inserts['invoice_items'][0] as Array<Record<string, unknown>>
    expect(itemRows).toHaveLength(2)
    expect(itemRows[0]).toMatchObject({ line_type: 'product', vat_rate: 25, vat_amount: 250, line_total: 1000 })
    expect(itemRows[1]).toMatchObject({
      line_type: 'text',
      description: 'Avser vecka 23',
      quantity: 0,
      unit_price: 0,
      line_total: 0,
      vat_rate: 0,
      vat_amount: 0,
    })
  })
})

describe('commitPendingOperation: create_invoice: dimensions propagation (PR7)', () => {
  it('staged default_dimensions lands on the invoices row and item bags on invoice_items rows', async () => {
    const { supabase, inserts } = createCapturingSupabase(queueFor({ vat_registered: true }))

    const op = makePendingOp({
      params: {
        customer_id: 'cust-1',
        default_dimensions: { '1': 'KS01' },
        items: [
          {
            description: 'Konsulttimmar',
            quantity: 1,
            unit: 'tim',
            unit_price: 1000,
            vat_rate: 25,
            dimensions: { '6': 'P001' },
          },
          { line_type: 'text', description: 'Avser vecka 23', quantity: 0, unit: '', unit_price: 0, vat_rate: 0 },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(inserts['invoices'][0]).toMatchObject({ default_dimensions: { '1': 'KS01' } })

    const itemRows = inserts['invoice_items'][0] as Array<Record<string, unknown>>
    expect(itemRows).toHaveLength(2)
    expect(itemRows[0]).toMatchObject({ line_type: 'product', dimensions: { '6': 'P001' } })
    // Text rows never carry a bag.
    expect(itemRows[1]).toMatchObject({ line_type: 'text', dimensions: {} })
  })

  it('defaults to {} when no bags are staged', async () => {
    const { supabase, inserts } = createCapturingSupabase(queueFor({ vat_registered: true }))

    const op = makePendingOp({
      params: {
        customer_id: 'cust-1',
        items: [{ description: 'Konsulttimmar', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(inserts['invoices'][0]).toMatchObject({ default_dimensions: {} })
    const itemRows = inserts['invoice_items'][0] as Array<Record<string, unknown>>
    expect(itemRows[0]).toMatchObject({ dimensions: {} })
  })

  it('coerces an INVALID staged bag away: the insert gets {} (drift/tamper gate)', async () => {
    const { supabase, inserts } = createCapturingSupabase(queueFor({ vat_registered: true }))

    const op = makePendingOp({
      params: {
        customer_id: 'cust-1',
        // '0' is not a valid SIE dimension number: the whole bag is rejected.
        default_dimensions: { '0': 'X' },
        items: [
          {
            description: 'Konsulttimmar',
            quantity: 1,
            unit: 'tim',
            unit_price: 1000,
            vat_rate: 25,
            // Empty code fails the schema: the whole bag is rejected.
            dimensions: { '1': '' },
          },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(inserts['invoices'][0]).toMatchObject({ default_dimensions: {} })
    const itemRows = inserts['invoice_items'][0] as Array<Record<string, unknown>>
    expect(itemRows[0]).toMatchObject({ dimensions: {} })
  })
})
