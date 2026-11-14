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
    enqueue({ data: { accounting_method: 'accrual' } }) // company_settings: to_pay
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
    expect(inCalls).toContainEqual(['status', ['approved', 'overdue', 'partially_paid']])
    expect(inCalls).toContainEqual(['supplier_id', [SUPPLIER_UUID]])
    expect(findCalls('supplier_invoices', 'eq')).toContainEqual(['supplier_id', SUPPLIER_UUID])
    expect(findCall('supplier_invoices', 'gte')).toEqual(['invoice_date', '2026-01-01'])
    expect(findCall('supplier_invoices', 'lte')).toEqual(['invoice_date', '2026-12-31'])
    // Deterministic order: due_date with the unique id as tiebreaker.
    const orderCalls = findCalls('supplier_invoices', 'order')
    expect(orderCalls).toContainEqual(['due_date', { ascending: true }])
    expect(orderCalls).toContainEqual(['id', { ascending: true }])
  })

  // crm#1141: kontantmetoden has no attest step, so a registered invoice is
  // already to pay; the app offers Markera som betald on the same rows.
  it('to_pay includes registered invoices under kontantmetoden only', async () => {
    const cash = createQueuedMockSupabase()
    cash.enqueue({ data: { accounting_method: 'cash' } })
    cash.enqueue({ data: [invoiceRow({ status: 'registered' })], count: 1 })
    const result = (await tool().execute({ status: 'to_pay' }, COMPANY, USER, cash.supabase as never)) as ListResult
    expect(result.invoices[0]).toMatchObject({ status: 'registered' })
    expect(cash.findCalls('company_settings', 'eq')).toContainEqual(['company_id', COMPANY])
    expect(cash.findCalls('supplier_invoices', 'in')).toContainEqual([
      'status',
      ['registered', 'approved', 'overdue', 'partially_paid'],
    ])

    const accrual = createQueuedMockSupabase()
    accrual.enqueue({ data: { accounting_method: 'accrual' } })
    accrual.enqueue({ data: [], count: 0 })
    await tool().execute({ status: 'to_pay' }, COMPANY, USER, accrual.supabase as never)
    expect(accrual.findCalls('supplier_invoices', 'in')).toContainEqual([
      'status',
      ['approved', 'overdue', 'partially_paid'],
    ])
    // One the supplier debits itself has nothing to pay (crm#1463).
    expect(accrual.findCalls('supplier_invoices', 'eq')).toContainEqual(['auto_debit', false])
  })

  // For #207: an attested invoice the nightly flip stored as overdue is
  // still attested, and a part-paid invoice past its due date is overdue.
  it('status=approved reads the attest mark and returns an attested invoice stored as overdue', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [invoiceRow({ status: 'overdue', approved_at: '2026-03-20T09:00:00Z' })], count: 1 })
    const result = (await tool().execute({ status: 'approved' }, COMPANY, USER, supabase as never)) as ListResult
    expect(result.invoices[0]).toMatchObject({ status: 'overdue', approved_at: '2026-03-20T09:00:00Z' })
    expect(findCalls('supplier_invoices', 'in')).toContainEqual(['status', ['registered', 'approved', 'overdue']])
    expect(findCall('supplier_invoices', 'or')).toEqual(['status.eq.approved,approved_at.not.is.null'])
    expect(findCalls('supplier_invoices', 'eq')).not.toContainEqual(['status', 'approved'])
    expect(findCalls('company_settings', 'select')).toHaveLength(0)
  })

  it('status=overdue is computed, so a part-paid invoice past its due date is returned', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [invoiceRow({ status: 'partially_paid', remaining_amount: 850 })], count: 1 })
    const result = (await tool().execute({ status: 'overdue' }, COMPANY, USER, supabase as never)) as ListResult
    expect(result.invoices[0]).toMatchObject({ status: 'partially_paid', remaining_amount: 850 })
    expect(findCalls('supplier_invoices', 'in')).toContainEqual(['status', ['registered', 'approved', 'partially_paid', 'overdue']])
    expect(findCalls('supplier_invoices', 'eq')).toContainEqual(['is_credit_note', false])
    expect(findCall('supplier_invoices', 'gt')).toEqual(['remaining_amount', 0.005])
    expect(findCall('supplier_invoices', 'lt')).toEqual(['due_date', expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/)])
    expect(findCalls('supplier_invoices', 'eq')).not.toContainEqual(['status', 'overdue'])
  })

  it('reads the accounting method only for to_pay', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [invoiceRow({ status: 'registered' })], count: 1 })
    await tool().execute({ status: 'registered' }, COMPANY, USER, supabase as never)
    expect(findCalls('company_settings', 'select')).toHaveLength(0)
    expect(findCalls('supplier_invoices', 'eq')).toContainEqual(['status', 'registered'])
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

// crm#1229: "attested, paid by hand at the bank, money not landed" and
// "attested, nothing paid" looked identical in this listing, and so did an
// attested overdue invoice and an unattested one.
describe('gnubok_list_supplier_invoices: attest and "I banken" marks', () => {
  it('projects approved_at and bank_entered_at and returns them on each invoice', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({ data: { accounting_method: 'accrual' } }) // company_settings: to_pay
    enqueue({
      data: [
        invoiceRow({ status: 'overdue', approved_at: '2026-04-01T08:00:00Z', bank_entered_at: '2026-04-08T09:00:00Z' }),
        invoiceRow({ id: 'si-2', status: 'overdue', approved_at: null, bank_entered_at: null }),
      ],
      count: 2,
    })

    const result = (await tool().execute({ status: 'to_pay' }, COMPANY, USER, supabase as never)) as ListResult

    const [columns] = findCall('supplier_invoices', 'select') as [string]
    expect(columns).toMatch(/\bapproved_at\b/)
    expect(columns).toMatch(/\bbank_entered_at\b/)
    expect(result.invoices[0]).toMatchObject({ approved_at: '2026-04-01T08:00:00Z', bank_entered_at: '2026-04-08T09:00:00Z' })
    expect(result.invoices[1]).toMatchObject({ approved_at: null, bank_entered_at: null })
  })
})

// crm#1282: the app showed two invoices as "I betalning" (an open bank
// payment order, unsigned at the bank) while this listing said approved with
// the full remaining_amount, so the agent could not tell what had happened.
describe('gnubok_list_supplier_invoices: open_payment, read as the app reads it', () => {
  it('carries the open bank payment order of an unsettled invoice, with the bank status and failure code', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        invoiceRow({ id: 'si-in-bank', status: 'approved' }),
        invoiceRow({ id: 'si-free', status: 'approved' }),
        invoiceRow({ id: 'si-paid', status: 'paid', remaining_amount: 0 }),
      ],
      count: 3,
    })
    enqueue({ data: [] }) // supplier_payment_batch_items: no payment file
    enqueue({
      data: [
        {
          id: 'order-1',
          supplier_invoice_id: 'si-in-bank',
          status: 'submitted',
          created_at: '2026-10-01T08:52:46Z',
          supplier_invoice_payment_id: null,
          provider_status: 'RCVD',
          provider_error_code: null,
        },
      ],
    })

    const result = (await tool().execute({}, COMPANY, USER, supabase as never)) as ListResult

    const byId = new Map(result.invoices.map((invoice) => [invoice.id, invoice]))
    expect(byId.get('si-in-bank')).toMatchObject({
      status: 'approved',
      open_payment: {
        batch: null,
        payment_order: { id: 'order-1', status: 'submitted', created_at: '2026-10-01T08:52:46Z', provider_status: 'RCVD', provider_error_code: null },
      },
    })
    expect(byId.get('si-free')).toMatchObject({ open_payment: null })
    expect(byId.get('si-paid')).toMatchObject({ open_payment: null })
    // Only the unsettled invoices are asked about, inside the company, among the open statuses.
    expect(findCall('payment_orders', 'in')).toEqual(['supplier_invoice_id', ['si-in-bank', 'si-free']])
    expect(findCalls('payment_orders', 'eq')).toContainEqual(['company_id', COMPANY])
    expect(findCalls('payment_orders', 'in')).toContainEqual(['status', expect.arrayContaining(['submitted', 'awaiting_signature', 'executed'])])
  })

  it('carries the payment file an invoice sits in, and leaves a failed order out', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [invoiceRow({ id: 'si-file' }), invoiceRow({ id: 'si-failed' })], count: 2 })
    enqueue({ data: [{ supplier_invoice_id: 'si-file', batch: { id: 'file-1', status: 'created', created_at: '2026-10-02T08:00:00Z' } }] })
    // The read asks for open statuses only; a row the database still returned in a final status counts for nothing.
    enqueue({ data: [{ id: 'order-2', supplier_invoice_id: 'si-failed', status: 'failed', created_at: '2026-10-02T09:00:00Z', supplier_invoice_payment_id: null, provider_status: null, provider_error_code: 'EXECUTION_DATE_INVALID' }] })

    const result = (await tool().execute({}, COMPANY, USER, supabase as never)) as ListResult

    expect(result.invoices[0]).toMatchObject({ id: 'si-file', open_payment: { batch: { id: 'file-1', created_at: '2026-10-02T08:00:00Z' }, payment_order: null } })
    expect(result.invoices[1]).toMatchObject({ id: 'si-failed', open_payment: null })
  })

  it('fails the call when the payment instructions cannot be read: a null would say nothing pays the invoice', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [invoiceRow()], count: 1 })
    enqueue({ data: [] })
    enqueue({ data: null, error: { message: 'DB error', code: '57014' } })

    await expect(tool().execute({}, COMPANY, USER, supabase as never)).rejects.toThrow(/DB error/)
  })
})
