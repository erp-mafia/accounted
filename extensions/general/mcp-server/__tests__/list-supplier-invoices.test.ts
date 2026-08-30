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

type ListResult = { invoices: Array<Record<string, unknown>>; count: number }

describe('gnubok_list_supplier_invoices: filters', () => {
  it('filters by supplier_id alone (eq on supplier_id, no supplier lookup)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [invoiceRow()] })

    const result = (await tool().execute(
      { supplier_id: SUPPLIER_UUID },
      COMPANY,
      USER,
      supabase as never,
    )) as ListResult

    expect(result.count).toBe(1)
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

  it('filters by supplier_name alone: case-insensitive substring resolved to supplier ids', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'sup-1' }, { id: 'sup-2' }] }) // suppliers lookup
    enqueue({ data: [invoiceRow()] }) // invoice list

    const result = (await tool().execute(
      { supplier_name: 'office' },
      COMPANY,
      USER,
      supabase as never,
    )) as ListResult

    expect(result.count).toBe(1)
    expect(findCall('suppliers', 'ilike')).toEqual(['name', '%office%'])
    expect(findCalls('supplier_invoices', 'in')).toContainEqual([
      'supplier_id',
      ['sup-1', 'sup-2'],
    ])
  })

  it('escapes LIKE wildcards in supplier_name so % and _ match literally', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'sup-1' }] })
    enqueue({ data: [] })

    await tool().execute({ supplier_name: '100%_ab' }, COMPANY, USER, supabase as never)

    expect(findCall('suppliers', 'ilike')).toEqual(['name', '%100\\%\\_ab%'])
  })

  it('unknown supplier_name yields an empty result without querying invoices', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] }) // suppliers lookup: no match

    const result = (await tool().execute(
      { supplier_name: 'no such vendor' },
      COMPANY,
      USER,
      supabase as never,
    )) as ListResult

    expect(result).toEqual({ invoices: [], count: 0 })
    expect(findCalls('supplier_invoices', 'select')).toHaveLength(0)
  })

  it('filters by date_from alone (gte on invoice_date)', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })

    await tool().execute({ date_from: '2026-01-01' }, COMPANY, USER, supabase as never)

    expect(findCall('supplier_invoices', 'gte')).toEqual(['invoice_date', '2026-01-01'])
    expect(findCalls('supplier_invoices', 'lte')).toHaveLength(0)
  })

  it('filters by date_to alone (lte on invoice_date)', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })

    await tool().execute({ date_to: '2026-06-30' }, COMPANY, USER, supabase as never)

    expect(findCall('supplier_invoices', 'lte')).toEqual(['invoice_date', '2026-06-30'])
    expect(findCalls('supplier_invoices', 'gte')).toHaveLength(0)
  })

  it('combines status, supplier_id, supplier_name and date range', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: SUPPLIER_UUID }] }) // suppliers lookup
    enqueue({ data: [invoiceRow()] }) // invoice list

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
  })

  it('rejects a malformed date', async () => {
    const { supabase } = createQueuedMockSupabase()
    await expect(
      tool().execute({ date_from: '01/02/2026' }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/date_from must be an ISO date/)
    await expect(
      tool().execute({ date_to: '2026-6-1' }, COMPANY, USER, supabase as never),
    ).rejects.toThrow(/date_to must be an ISO date/)
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

  it('keeps the unfiltered path unchanged: no supplier lookup, no date filters', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [invoiceRow(), invoiceRow({ id: 'si-2' })] })

    const result = (await tool().execute({}, COMPANY, USER, supabase as never)) as ListResult

    expect(result.count).toBe(2)
    expect(findCalls('suppliers', 'select')).toHaveLength(0)
    expect(findCalls('supplier_invoices', 'gte')).toHaveLength(0)
    expect(findCalls('supplier_invoices', 'lte')).toHaveLength(0)
    expect(findCalls('supplier_invoices', 'in')).toHaveLength(0)
  })
})
