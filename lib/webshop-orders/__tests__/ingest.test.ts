import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { upsertWebshopOrders } from '../ingest'
import type { WebshopOrderUpsert } from '../types'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/currency/riksbanken', () => ({
  fetchExchangeRate: vi.fn(async (currency: string) =>
    currency === 'SEK'
      ? { currency, rate: 1, date: '2026-08-01' }
      : currency === 'EUR'
        ? { currency, rate: 11.5, date: '2026-08-01' }
        : null,
  ),
}))

const COMPANY = 'company-1'
const USER = 'user-1'

function makeUpsert(overrides: Partial<WebshopOrderUpsert> = {}): WebshopOrderUpsert {
  return {
    platform: 'woocommerce',
    store_scope: 'butik.example.se',
    store_label: 'Butiken',
    connection_id: 'conn-1',
    row_type: 'order',
    parent_external_id: null,
    external_id: 'woo_butik.example.se_order_1001',
    platform_order_id: '1001',
    order_number: '1001',
    status: 'processing',
    is_paid: true,
    order_date: '2026-08-01',
    paid_date: '2026-08-01',
    currency: 'SEK',
    total: 500,
    total_tax: 100,
    vat_breakdown: [{ rate: 25, net: 400, tax: 100 }],
    line_items: [],
    customer_name: 'Test Person',
    customer_company: null,
    customer_email: 'test@example.se',
    customer_orgnr: null,
    customer_country: 'SE',
    payment_method: 'swish',
    payment_method_title: 'Swish',
    gateway_reference: null,
    refunded_total: 0,
    ...overrides,
  }
}

function existingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-1',
    external_id: 'woo_butik.example.se_order_1001',
    journal_entry_id: null,
    invoice_id: null,
    manually_booked_at: null,
    legacy_transaction_id: null,
    remote_changed_after_freeze: false,
    total: 500,
    total_tax: 100,
    total_sek: 500,
    exchange_rate: 1,
    currency: 'SEK',
    order_date: '2026-08-01',
    paid_date: '2026-08-01',
    is_paid: true,
    payment_method: 'swish',
    payment_method_title: 'Swish',
    gateway_reference: null,
    order_number: '1001',
    status: 'processing',
    refunded_total: 0,
    store_label: 'Butiken',
    connection_id: 'conn-1',
    customer_name: 'Test Person',
    customer_company: null,
    customer_email: 'test@example.se',
    customer_orgnr: null,
    customer_country: 'SE',
    vat_breakdown: [{ rate: 25, net: 400, tax: 100 }],
    line_items: [],
    ...overrides,
  }
}

describe('upsertWebshopOrders', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>
  const supabase = () => mock.supabase as unknown as SupabaseClient

  beforeEach(() => {
    vi.clearAllMocks()
    mock = createQueuedMockSupabase()
  })

  it('inserts a new SEK order with resolved FX and no legacy link', async () => {
    mock.enqueueMany([
      { data: [] }, // existing webshop_orders
      { data: [] }, // legacy transactions
      { data: [{ id: 'new-1', external_id: 'woo_butik.example.se_order_1001' }] }, // insert
    ])

    const result = await upsertWebshopOrders(supabase(), COMPANY, USER, [makeUpsert()])

    expect(result).toMatchObject({ inserted: 1, updated: 0, errors: 0, crossMarked: 0 })
    const insertArgs = mock.findCall('webshop_orders', 'insert')
    expect(insertArgs).toBeDefined()
    const payload = (insertArgs![0] as Record<string, unknown>[])[0]
    expect(payload).toMatchObject({
      company_id: COMPANY,
      user_id: USER,
      external_id: 'woo_butik.example.se_order_1001',
      total_sek: 500,
      exchange_rate: 1,
      legacy_transaction_id: null,
    })
  })

  it('parents a refund to an order inserted in the same call', async () => {
    mock.enqueueMany([
      { data: [] }, // existing (order phase)
      { data: [] }, // legacy (order phase)
      { data: [{ id: 'order-id-1', external_id: 'woo_butik.example.se_order_1001' }] },
      { data: [] }, // existing (refund phase; parent already known via knownIds)
      { data: [] }, // legacy (refund phase)
      { data: [{ id: 'refund-id-1', external_id: 'woo_butik.example.se_refund_77' }] },
    ])

    const refund = makeUpsert({
      row_type: 'refund',
      parent_external_id: 'woo_butik.example.se_order_1001',
      external_id: 'woo_butik.example.se_refund_77',
      platform_order_id: '77',
      total: -500,
      total_tax: -100,
      refunded_total: 0,
    })
    const result = await upsertWebshopOrders(supabase(), COMPANY, USER, [
      refund,
      makeUpsert(),
    ])

    expect(result.inserted).toBe(2)
    const inserts = mock.findCalls('webshop_orders', 'insert')
    expect(inserts).toHaveLength(2)
    const refundPayload = (inserts[1][0] as Record<string, unknown>[])[0]
    expect(refundPayload).toMatchObject({
      row_type: 'refund',
      parent_order_id: 'order-id-1',
    })
  })

  it('cross-marks rows whose external_id already exists in the transactions feed', async () => {
    mock.enqueueMany([
      { data: [] },
      { data: [{ id: 'txn-9', external_id: 'woo_butik.example.se_order_1001' }] },
      { data: [{ id: 'new-1', external_id: 'woo_butik.example.se_order_1001' }] },
    ])

    const result = await upsertWebshopOrders(supabase(), COMPANY, USER, [makeUpsert()])

    expect(result.crossMarked).toBe(1)
    const payload = (mock.findCall('webshop_orders', 'insert')![0] as Record<string, unknown>[])[0]
    expect(payload.legacy_transaction_id).toBe('txn-9')
  })

  it('updates an unfrozen existing row when status moves', async () => {
    mock.enqueueMany([
      { data: [existingRow()] },
      { data: [] },
      { data: null }, // update
    ])

    const result = await upsertWebshopOrders(supabase(), COMPANY, USER, [
      makeUpsert({ status: 'completed' }),
    ])

    expect(result).toMatchObject({ inserted: 0, updated: 1, unchanged: 0 })
    const updateArgs = mock.findCall('webshop_orders', 'update')
    expect(updateArgs).toBeDefined()
    expect((updateArgs![0] as Record<string, unknown>).status).toBe('completed')
  })

  it('counts an identical re-poll as unchanged without writing', async () => {
    mock.enqueueMany([{ data: [existingRow()] }, { data: [] }])

    const result = await upsertWebshopOrders(supabase(), COMPANY, USER, [makeUpsert()])

    expect(result).toMatchObject({ inserted: 0, updated: 0, unchanged: 1 })
    expect(mock.findCall('webshop_orders', 'update')).toBeUndefined()
    expect(mock.findCall('webshop_orders', 'insert')).toBeUndefined()
  })

  it('treats jsonb-reordered keys as unchanged (Postgres does not preserve key order)', async () => {
    // What PostgREST returns: same VALUES, different object key order than
    // what the sync inserts. JSON.stringify comparison falsely flagged every
    // such row as changed (and every booked row as remote-drifted).
    mock.enqueueMany([
      {
        data: [
          existingRow({
            vat_breakdown: [{ net: 400, tax: 100, rate: 25 }],
            line_items: [],
          }),
        ],
      },
      { data: [] },
    ])

    const result = await upsertWebshopOrders(supabase(), COMPANY, USER, [makeUpsert()])

    expect(result).toMatchObject({ unchanged: 1, updated: 0, frozenFlagged: 0 })
    expect(mock.findCall('webshop_orders', 'update')).toBeUndefined()
  })

  it('does not flag a booked row when only key order differs', async () => {
    mock.enqueueMany([
      {
        data: [
          existingRow({
            journal_entry_id: 'je-1',
            vat_breakdown: [{ tax: 100, rate: 25, net: 400 }],
          }),
        ],
      },
      { data: [] },
    ])

    const result = await upsertWebshopOrders(supabase(), COMPANY, USER, [makeUpsert()])

    expect(result.frozenFlagged).toBe(0)
    expect(mock.findCall('webshop_orders', 'update')).toBeUndefined()
  })

  it('flags a booked row whose financials drifted instead of updating them', async () => {
    mock.enqueueMany([
      { data: [existingRow({ journal_entry_id: 'je-1' })] },
      { data: [] },
      { data: null }, // safe-field update
    ])

    const result = await upsertWebshopOrders(supabase(), COMPANY, USER, [
      makeUpsert({ total: 600, status: 'completed' }),
    ])

    expect(result.frozenFlagged).toBe(1)
    const update = mock.findCall('webshop_orders', 'update')![0] as Record<string, unknown>
    expect(update.remote_changed_after_freeze).toBe(true)
    expect(update.status).toBe('completed')
    expect(update).not.toHaveProperty('total')
    expect(update).not.toHaveProperty('total_sek')
    expect(update).not.toHaveProperty('paid_date')
  })

  it('flags a manually marked row whose financials drifted instead of updating them (#1879)', async () => {
    mock.enqueueMany([
      { data: [existingRow({ manually_booked_at: '2026-08-10T00:00:00Z' })] },
      { data: [] },
      { data: null }, // safe-field update
    ])

    const result = await upsertWebshopOrders(supabase(), COMPANY, USER, [
      makeUpsert({ total: 600, status: 'completed' }),
    ])

    expect(result.frozenFlagged).toBe(1)
    const update = mock.findCall('webshop_orders', 'update')![0] as Record<string, unknown>
    expect(update.remote_changed_after_freeze).toBe(true)
    expect(update).not.toHaveProperty('total')
    expect(update).not.toHaveProperty('line_items')
  })

  it('leaves total_sek null when the exchange rate cannot resolve', async () => {
    mock.enqueueMany([
      { data: [] },
      { data: [] },
      { data: [{ id: 'new-1', external_id: 'woo_butik.example.se_order_1001' }] },
    ])

    await upsertWebshopOrders(supabase(), COMPANY, USER, [
      makeUpsert({ currency: 'ISK', total: 900 }),
    ])

    const payload = (mock.findCall('webshop_orders', 'insert')![0] as Record<string, unknown>[])[0]
    expect(payload.total_sek).toBeNull()
    expect(payload.exchange_rate).toBeNull()
  })

  it('converts non-SEK totals with the fetched rate', async () => {
    mock.enqueueMany([
      { data: [] },
      { data: [] },
      { data: [{ id: 'new-1', external_id: 'woo_butik.example.se_order_1001' }] },
    ])

    await upsertWebshopOrders(supabase(), COMPANY, USER, [
      makeUpsert({ currency: 'EUR', total: 100, total_tax: 20 }),
    ])

    const payload = (mock.findCall('webshop_orders', 'insert')![0] as Record<string, unknown>[])[0]
    expect(payload.total_sek).toBe(1150)
    expect(payload.exchange_rate).toBe(11.5)
  })

  it('surfaces select errors without throwing', async () => {
    mock.enqueueMany([{ data: null, error: { message: 'boom', code: '500' } }])

    const result = await upsertWebshopOrders(supabase(), COMPANY, USER, [makeUpsert()])

    expect(result.errors).toBe(1)
    expect(result.firstError?.message).toBe('boom')
  })
})
