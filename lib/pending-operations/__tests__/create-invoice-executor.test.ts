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
function queueFor(
  settings: { vat_registered: boolean } | null,
  forCustomer: typeof customer = customer,
) {
  return [
    { data: { id: 'op-1' } },
    { data: forCustomer },
    { data: settings },
    { data: { id: 'inv-1', invoice_number: null } },
    { data: null },
    { data: { id: 'inv-1' } },
    { data: null },
  ]
}

// A validated EU business: the picker default is a single locked 0%
// (huvudregeln, ML 6 kap. 34 §), but the gate reads the wider permitted set.
const euCustomer = makeCustomer({
  id: 'cust-1',
  customer_type: 'eu_business',
  vat_number_validated: true,
})

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

describe('commitPendingOperation: create_invoice: VAT rates for a foreign business', () => {
  it('accepts an explicit 12% line to a validated EU business (taxed where performed)', async () => {
    // A Stockholm hotel night sold to a German company carries 12% Swedish VAT
    // (ML 6 kap., taxed where the supply is performed). The picker default for
    // that customer is 0%, so refusing 12% made the invoice impossible to issue.
    const { supabase, inserts } = createCapturingSupabase(
      queueFor({ vat_registered: true }, euCustomer),
    )

    const op = makePendingOp({
      params: {
        customer_id: 'cust-1',
        items: [{ description: 'Hotellnatt Stockholm', quantity: 2, unit: 'st', unit_price: 1000, vat_rate: 12 }],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(inserts['invoices'][0]).toMatchObject({
      subtotal: 2000,
      vat_amount: 240,
      total: 2240,
      vat_rate: 12,
    })
  })

  it('still defaults to 0% when a line omits vat_rate', async () => {
    // Widening the accepted set must not move the default: an omitted rate
    // falls back to getVatRules().rate, which is 0% (reverse charge).
    const { supabase, inserts } = createCapturingSupabase(
      queueFor({ vat_registered: true }, euCustomer),
    )

    const op = makePendingOp({
      params: {
        customer_id: 'cust-1',
        items: [{ description: 'Konsulttimmar', quantity: 1, unit: 'tim', unit_price: 1000 }],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(inserts['invoices'][0]).toMatchObject({
      subtotal: 1000,
      vat_amount: 0,
      total: 1000,
      vat_rate: 0,
      vat_treatment: 'reverse_charge',
    })
  })

  it('still rejects a rate that is not a Swedish VAT rate', async () => {
    // The permitted set widened to 0/25/12/6, not to anything: 10% stays out.
    const { supabase } = createCapturingSupabase(queueFor({ vat_registered: true }, euCustomer))

    const op = makePendingOp({
      params: {
        customer_id: 'cust-1',
        items: [{ description: 'X', quantity: 1, unit: 'st', unit_price: 1000, vat_rate: 10 }],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/10%/)
  })
})

describe('commitPendingOperation: create_invoice: staged article references', () => {
  it('writes a company-scoped article_id through to the invoice_items row', async () => {
    // Queue: CAS claim → customers → company_settings → articles scope check →
    // invoices insert → invoice_items insert → complete select → update.
    const { supabase, inserts } = createCapturingSupabase([
      { data: { id: 'op-1' } },
      { data: customer },
      { data: { vat_registered: true } },
      { data: [{ id: 'art-1' }] },
      { data: { id: 'inv-1', invoice_number: null } },
      { data: null },
      { data: { id: 'inv-1' } },
      { data: null },
    ])

    const op = makePendingOp({
      params: {
        customer_id: 'cust-1',
        items: [
          {
            description: 'Konsulttimme',
            quantity: 2,
            unit: 'tim',
            unit_price: 1200,
            vat_rate: 25,
            article_id: 'art-1',
          },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    const itemRows = inserts['invoice_items'][0] as Array<Record<string, unknown>>
    expect(itemRows[0]).toMatchObject({ article_id: 'art-1', line_total: 2400 })
  })

  it('fails when a staged article_id belongs to another company (drift/tamper gate)', async () => {
    // The FK on invoice_items.article_id only proves existence, not tenancy:
    // the executor must refuse an id the scoped select cannot see.
    const { supabase, inserts } = createCapturingSupabase([
      { data: { id: 'op-1' } },
      { data: customer },
      { data: { vat_registered: true } },
      { data: [] },
      { data: null },
    ])

    const op = makePendingOp({
      params: {
        customer_id: 'cust-1',
        items: [
          {
            description: 'Konsulttimme',
            quantity: 1,
            unit: 'tim',
            unit_price: 1200,
            vat_rate: 25,
            article_id: 'art-foreign',
          },
        ],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('failed')
    expect(result.error).toMatch(/Artikel art-foreign finns inte i företaget/)
    expect(inserts['invoices']).toBeUndefined()
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

describe('commitPendingOperation: create_invoice as a quote (offert)', () => {
  /** Quote queue: CAS claim → customers → company_settings → invoices insert →
   *  invoice_items insert → dispatcher update. No complete-invoice select:
   *  quotes never emit invoice.created. */
  const quoteQueue = [
    { data: { id: 'op-1' } },
    { data: customer },
    { data: { vat_registered: true } },
    { data: { id: 'inv-q', invoice_number: 'OF-001' } },
    { data: null },
    { data: null },
  ]

  it('allocates OF-nnn via generate_quote_number and never touches the F-series', async () => {
    const base = createCapturingSupabase(quoteQueue)
    const rpc = vi.fn().mockResolvedValue({ data: 'OF-001', error: null })
    const supabase = { ...base.supabase, rpc }
    const emitted: string[] = []
    eventBus.on('invoice.created', async () => {
      emitted.push('invoice.created')
    })

    const op = makePendingOp({
      params: {
        customer_id: 'cust-1',
        document_type: 'quote',
        valid_until: '2026-12-31',
        items: [{ description: 'Konsulttimmar', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
        invoice_date: '2026-09-02',
        due_date: '2026-12-31',
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).toBe('committed')
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('generate_quote_number', { p_company_id: 'company-1' })
    expect(rpc).not.toHaveBeenCalledWith('generate_invoice_number', expect.anything())
    expect(base.inserts['invoices'][0]).toMatchObject({
      invoice_number: 'OF-001',
      document_type: 'quote',
      quote_status: 'open',
      valid_until: '2026-12-31',
      due_date: '2026-12-31',
      total: 1250,
    })
    expect(emitted).toEqual([])
  })

  it('refuses a quote without valid_until', async () => {
    const base = createCapturingSupabase([{ data: { id: 'op-1' } }])
    const rpc = vi.fn()
    const supabase = { ...base.supabase, rpc }

    const op = makePendingOp({
      params: {
        customer_id: 'cust-1',
        document_type: 'quote',
        items: [{ description: 'Konsulttimmar', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).not.toBe('committed')
    expect(rpc).not.toHaveBeenCalled()
    expect(base.inserts['invoices']).toBeUndefined()
  })

  it('fails closed when the OF-series allocation errors, inserting nothing', async () => {
    const base = createCapturingSupabase([{ data: { id: 'op-1' } }, { data: customer }, { data: { vat_registered: true } }])
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } })
    const supabase = { ...base.supabase, rpc }

    const op = makePendingOp({
      params: {
        customer_id: 'cust-1',
        document_type: 'quote',
        valid_until: '2026-12-31',
        items: [{ description: 'Konsulttimmar', quantity: 1, unit: 'tim', unit_price: 1000, vat_rate: 25 }],
      },
    })

    const result = await commitPendingOperation(supabase as never, 'user-1', 'company-1', op)

    expect(result.status).not.toBe('committed')
    expect(base.inserts['invoices']).toBeUndefined()
  })
})
