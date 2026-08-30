import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const tool = () => tools.find((candidate) => candidate.name === 'gnubok_list_supplier_invoices')!

const COMPANY = 'company-1'
const USER = 'user-1'
const SUPPLIER_UUID = '11111111-2222-4333-8444-555555555555'

const invoiceRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'si-1',
  supplier_invoice_number: 'F-1001',
  invoice_date: '2026-03-10',
  due_date: '2026-04-09',
  status: 'approved',
  total: 1250,
  total_sek: 1250,
  currency: 'SEK',
  vat_treatment: 'standard',
  remaining_amount: 1250,
  default_dimensions: null,
  supplier: { id: SUPPLIER_UUID, name: 'Office Depot AB' },
  ...overrides,
})

type ListResult = {
  invoices: Array<Record<string, unknown>>
  count: number
  total_count: number
  has_more: boolean
}

describe('gnubok_list_supplier_invoices: filters', () => {
  it('filters by supplier_id alone (eq on supplier_id, no supplier lookup)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [invoiceRow()], count: 1 })

    const result = (await tool().execute(
      { supplier_id: SUPPLIER_UUID },
      COMPANY,
      USER,
      supabase as never,
    )) as ListResult

    expect(result.count).toBe(1)
    expect(result.total_count).toBe(1)
    expect(result.has_more).toBe(false)
    expect(result.invoices[0].id).toBe('si-1')
    const eqCalls = findCalls('supplier_invoices', 'eq')
    expect(eqCalls).toContainEqual(['supplier_id', SUPPLIER_UUID])
    // Resolving supplier_name is the only reason to touch suppliers.
    expect(findCalls('suppliers', 'select')).toHaveLength(0)
    expect(findCalls('supplier_invoices', 'gte')).toHaveLength(0)
    expect(findCalls('supplier_invoices', 'lte')).toHaveLength(0)
  })

  it('rejects a non-uuid supplier_id with a pointer to supplier_name', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool().execute({ supplier_id: 'Office Depot' }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/supplier UUID.*supplier_name/)
  })

  it('rejects non-string filter values instead of silently returning the unfiltered list', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool().execute({ date_from: 20260101 }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/date_from must be a string/)
    await expect(
      tool().execute({ supplier_name: ['Office Depot'] }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/supplier_name must be a string/)
    await expect(
      tool().execute({ supplier_id: 42 }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/supplier_id must be a string/)
    await expect(
      tool().execute({ date_to: null }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/date_to must be a string/)
  })

  it('rejects a blank supplier_name instead of dropping the filter', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool().execute({ supplier_name: '   ' }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/supplier_name must not be blank/)
  })

  it('filters by supplier_name alone: literal case-insensitive substring resolved to supplier ids', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'sup-1', name: 'Office Depot AB' },
        { id: 'sup-2', name: 'Nordic OFFICE Supplies' },
        { id: 'sup-3', name: 'Byggmax AB' },
      ],
    }) // suppliers fetch
    enqueue({ data: [invoiceRow()], count: 1 }) // invoice list

    const result = (await tool().execute(
      { supplier_name: 'office' },
      COMPANY,
      USER,
      supabase as never,
    )) as ListResult

    expect(result.count).toBe(1)
    expect(findCall('suppliers', 'select')).toEqual(['id, name'])
    expect(findCalls('suppliers', 'eq')).toContainEqual(['company_id', COMPANY])
    expect(findCalls('supplier_invoices', 'in')).toContainEqual([
      'supplier_id',
      ['sup-1', 'sup-2'],
    ])
  })

  it('matches supplier_name literally: * and % are not wildcards', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'sup-1', name: 'Star*Mart' },
        { id: 'sup-2', name: 'Starke Martinsson AB' },
        { id: 'sup-3', name: '100%_AB' },
      ],
    })
    enqueue({ data: [], count: 0 })

    await tool().execute({ supplier_name: 'Star*Mart' }, COMPANY, USER, supabase as never)

    expect(findCalls('supplier_invoices', 'in')).toContainEqual(['supplier_id', ['sup-1']])
  })

  it('unknown supplier_name yields an empty result without querying invoices', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'sup-1', name: 'Byggmax AB' }] }) // no substring match

    const result = (await tool().execute(
      { supplier_name: 'no such vendor' },
      COMPANY,
      USER,
      supabase as never,
    )) as ListResult

    expect(result).toEqual({ invoices: [], count: 0, total_count: 0, has_more: false })
    expect(findCalls('supplier_invoices', 'select')).toHaveLength(0)
  })

  it('rejects a supplier_name matching more suppliers than the cap', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: Array.from({ length: 201 }, (_, i) => ({ id: `sup-${i}`, name: `Byrå AB ${i}` })),
    })

    await expect(
      tool().execute({ supplier_name: 'byrå' }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/matches more than 200 suppliers/)
  })

  it('filters by date_from alone (gte on invoice_date)', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [], count: 0 })

    await tool().execute({ date_from: '2026-01-01' }, COMPANY, USER, supabase as never)

    expect(findCall('supplier_invoices', 'gte')).toEqual(['invoice_date', '2026-01-01'])
    expect(findCalls('supplier_invoices', 'lte')).toHaveLength(0)
  })

  it('filters by date_to alone (lte on invoice_date)', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [], count: 0 })

    await tool().execute({ date_to: '2026-06-30' }, COMPANY, USER, supabase as never)

    expect(findCall('supplier_invoices', 'lte')).toEqual(['invoice_date', '2026-06-30'])
    expect(findCalls('supplier_invoices', 'gte')).toHaveLength(0)
  })

  it('combines status, supplier_id, supplier_name and date range', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: SUPPLIER_UUID, name: 'Office Depot AB' }] }) // suppliers fetch
    enqueue({ data: [invoiceRow()], count: 1 }) // invoice list

    const result = (await tool().execute(
      {
        status: 'to_pay',
        supplier_id: SUPPLIER_UUID,
        supplier_name: 'office',
        date_from: '2026-01-01',
        date_to: '2026-12-31',
      },
      COMPANY,
      USER,
      supabase as never,
    )) as ListResult

    expect(result.count).toBe(1)
    const inCalls = findCalls('supplier_invoices', 'in')
    expect(inCalls).toContainEqual(['status', ['approved', 'overdue']])
    expect(inCalls).toContainEqual(['supplier_id', [SUPPLIER_UUID]])
    expect(findCalls('supplier_invoices', 'eq')).toContainEqual(['supplier_id', SUPPLIER_UUID])
    expect(findCall('supplier_invoices', 'gte')).toEqual(['invoice_date', '2026-01-01'])
    expect(findCall('supplier_invoices', 'lte')).toEqual(['invoice_date', '2026-12-31'])
    // Deterministic order: due_date with the unique id as tiebreaker.
    const orderCalls = findCalls('supplier_invoices', 'order')
    expect(orderCalls).toContainEqual(['due_date', { ascending: true }])
    expect(orderCalls).toContainEqual(['id', { ascending: true }])
  })

  it('rejects a malformed date', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool().execute({ date_from: '01/02/2026' }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/date_from must be a valid ISO date/)
    await expect(
      tool().execute({ date_to: '2026-6-1' }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/date_to must be a valid ISO date/)
  })

  it('rejects an impossible calendar date that passes the shape regex', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool().execute({ date_from: '2026-02-30' }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/date_from must be a valid ISO date/)
    await expect(
      tool().execute({ date_to: '2026-13-01' }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/date_to must be a valid ISO date/)
  })

  it('rejects a reversed date range', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool().execute(
        { date_from: '2026-12-31', date_to: '2026-01-01' },
        COMPANY,
        USER,
        supabase as never,
      ),
    ).rejects.toThrow(/date_from must not be after date_to/)
  })

  it('signals truncation: total_count and has_more expose rows past the limit', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: Array.from({ length: 50 }, (_, i) => invoiceRow({ id: `si-${i}` })),
      count: 60,
    })

    const result = (await tool().execute(
      { date_from: '2026-01-01', date_to: '2026-03-31' },
      COMPANY,
      USER,
      supabase as never,
    )) as ListResult

    expect(result.count).toBe(50)
    expect(result.total_count).toBe(60)
    expect(result.has_more).toBe(true)
  })

  it('keeps the unfiltered path unchanged: no supplier lookup, no date filters', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [invoiceRow(), invoiceRow({ id: 'si-2' })], count: 2 })

    const result = (await tool().execute({}, COMPANY, USER, supabase as never)) as ListResult

    expect(result.count).toBe(2)
    expect(result.total_count).toBe(2)
    expect(result.has_more).toBe(false)
    expect(findCalls('suppliers', 'select')).toHaveLength(0)
    expect(findCalls('supplier_invoices', 'gte')).toHaveLength(0)
    expect(findCalls('supplier_invoices', 'lte')).toHaveLength(0)
    expect(findCalls('supplier_invoices', 'in')).toHaveLength(0)
  })
})
