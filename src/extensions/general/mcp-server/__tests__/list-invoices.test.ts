/**
 * gnubok_list_invoices: open balance per row and the partially_paid filter
 * (MCP feedback seqs 817418 / 817440). A partially paid invoice used to list
 * with status and total only, so its residual took a second call to see, and
 * the status enum had no partially_paid for a strict client to send.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const listInvoices = tools.find((t) => t.name === 'gnubok_list_invoices')!

const invoiceRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'inv-pp',
  invoice_number: '2026024',
  status: 'partially_paid',
  customer_id: 'cust-1',
  total: 15625,
  paid_amount: 15000,
  remaining_amount: 625,
  currency: 'SEK',
  invoice_date: '2026-06-01',
  due_date: '2026-07-01',
  document_type: 'invoice',
  valid_until: null,
  quote_status: null,
  default_dimensions: {},
  customers: { name: 'Kunden AB' },
  ...overrides,
})

type ListResult = { invoices: Array<Record<string, unknown>> }

describe('gnubok_list_invoices: paid and remaining amounts', () => {
  it('accepts partially_paid as a status filter', async () => {
    const props = (listInvoices.inputSchema as { properties: Record<string, { enum?: string[] }> })
      .properties
    expect(props.status.enum).toContain('partially_paid')

    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [invoiceRow()], count: 1 })

    const result = (await listInvoices.execute(
      { status: 'partially_paid' },
      'company-1',
      'user-1',
      supabase as never,
    )) as ListResult

    expect(findCalls('invoices', 'eq')).toContainEqual(['status', 'partially_paid'])
    expect(result.invoices).toHaveLength(1)
  })

  it('returns paid_amount and remaining_amount on every row', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: [
        invoiceRow(),
        // Nothing paid yet: paid_amount is NULL in the table.
        invoiceRow({
          id: 'inv-sent',
          invoice_number: '2026025',
          status: 'sent',
          total: 1000,
          paid_amount: null,
          remaining_amount: 1000,
          // Not yet due: a sent invoice past its due date reports overdue.
          due_date: '2099-12-31',
        }),
      ],
      count: 2,
    })

    const result = (await listInvoices.execute({}, 'company-1', 'user-1', supabase as never)) as ListResult

    const columns = String(findCall('invoices', 'select')?.[0])
    expect(columns).toContain('paid_amount')
    expect(columns).toContain('remaining_amount')
    expect(result.invoices[0]).toMatchObject({
      invoice_number: '2026024',
      status: 'partially_paid',
      total: 15625,
      paid_amount: 15000,
      remaining_amount: 625,
    })
    expect(result.invoices[1]).toMatchObject({
      invoice_number: '2026025',
      status: 'sent',
      paid_amount: 0,
      remaining_amount: 1000,
    })
  })
})

describe('gnubok_list_invoices: overdue follows the due date (crm#1084)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  // crm#1367: a received self-billed sale has invoice_number null by design,
  // so without these two fields it listed like an unsent draft.
  it('returns the customer\'s number and the self-billed flag on a received self-bill', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: [
        invoiceRow({ id: 'inv-sb', invoice_number: null, external_invoice_number: 'S2441', is_self_billed: true, status: 'paid', remaining_amount: 0 }),
        invoiceRow({ id: 'inv-own' }),
      ],
      count: 2,
    })

    const result = (await listInvoices.execute({}, 'company-1', 'user-1', supabase as never)) as ListResult

    const columns = String(findCall('invoices', 'select')?.[0])
    expect(columns).toContain('external_invoice_number')
    expect(columns).toContain('is_self_billed')
    expect(result.invoices[0]).toMatchObject({ id: 'inv-sb', invoice_number: null, external_invoice_number: 'S2441', is_self_billed: true })
    expect(result.invoices[1]).toMatchObject({ id: 'inv-own', invoice_number: '2026024', external_invoice_number: null, is_self_billed: false })
  })

  it('status=overdue filters on the due date and the open remainder, never the stored status', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-13T08:00:00Z'))
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [invoiceRow({ id: 'inv-late', status: 'sent', due_date: '2026-09-30', remaining_amount: 1000 })], count: 1 })

    const result = (await listInvoices.execute({ status: 'overdue' }, 'company-1', 'user-1', supabase as never)) as ListResult

    expect(findCalls('invoices', 'eq')).not.toContainEqual(['status', 'overdue'])
    expect(findCalls('invoices', 'in')).toContainEqual(['status', ['sent', 'overdue', 'partially_paid']])
    expect(findCalls('invoices', 'lt')).toContainEqual(['due_date', '2026-10-13'])
    expect(findCalls('invoices', 'gt')).toContainEqual(['remaining_amount', 0])
    // The stored 'sent' reports as what it is: overdue.
    expect(result.invoices[0]).toMatchObject({ id: 'inv-late', status: 'overdue' })
  })

  it('reports a sent invoice past due as overdue and keeps partially_paid as stored', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-13T08:00:00Z'))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        invoiceRow({ id: 'a', status: 'sent', due_date: '2026-10-12', remaining_amount: 10 }),
        invoiceRow({ id: 'b', status: 'sent', due_date: '2026-10-13', remaining_amount: 10 }),
        invoiceRow({ id: 'c', status: 'overdue', due_date: '2026-11-01', remaining_amount: 10 }),
        invoiceRow({ id: 'd', status: 'partially_paid', due_date: '2026-09-01', remaining_amount: 10 }),
      ],
      count: 4,
    })

    const result = (await listInvoices.execute({}, 'company-1', 'user-1', supabase as never)) as ListResult

    expect(result.invoices.map((inv) => [inv.id, inv.status])).toEqual([
      ['a', 'overdue'],
      ['b', 'sent'],
      ['c', 'sent'],
      ['d', 'partially_paid'],
    ])
  })
})

// crm#1568: an invoice with öresavrundning listed only its exact total and
// remaining_amount, so an agent reported 3116,25 kr for an invoice whose
// "Att betala" is 3116 kr. The list now carries the figures the v1 API has
// carried since crm#1487, from the same helper (withAmountToPay).
describe('gnubok_list_invoices: what the invoice asks for (crm#1568)', () => {
  it('returns amount_to_pay and ore_rounding_amount next to the exact total', async () => {
    const { supabase, enqueue, findCall, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        // Rounded up from a half krona, and the report's own 3116,25 rounded down.
        invoiceRow({ id: 'inv-up', invoice_number: 'F-1001', status: 'sent', due_date: '2099-12-31', total: 4312.5, paid_amount: null, remaining_amount: 4312.5, ore_rounding: true, deduction_total: 0 }),
        invoiceRow({ id: 'inv-down', invoice_number: 'F-1002', status: 'sent', due_date: '2099-12-31', total: 3116.25, paid_amount: null, remaining_amount: 3116.25, ore_rounding: true, deduction_total: 0 }),
      ],
      count: 2,
    })

    const result = (await listInvoices.execute({}, 'company-1', 'user-1', supabase as never)) as ListResult

    const columns = String(findCall('invoices', 'select')?.[0])
    expect(columns).toContain('ore_rounding')
    expect(columns).toContain('deduction_total')
    // total and remaining_amount stay what the books carry; amount_to_pay is the document's figure.
    expect(result.invoices[0]).toMatchObject({ total: 4312.5, amount_to_pay: 4313, ore_rounding_amount: 0.5, remaining_amount: 4312.5 })
    expect(result.invoices[1]).toMatchObject({ total: 3116.25, amount_to_pay: 3116, ore_rounding_amount: -0.25, remaining_amount: 3116.25 })
    // Both rows carry their own choice (frozen at issue): the company's
    // rounding is not read. The one settings read is the payment reference's.
    expect(findCalls('company_settings', 'select')).toEqual([['*']])
  })

  it('computes a draft without a choice of its own with the company setting, and nets a ROT/RUT deduction', async () => {
    const { supabase, enqueue, findCall } = createQueuedMockSupabase()
    enqueue({
      data: [
        invoiceRow({ id: 'draft', status: 'draft', total: 3116.25, paid_amount: null, remaining_amount: 3116.25, ore_rounding: null, deduction_total: 0 }),
        invoiceRow({ id: 'issued-off', status: 'sent', due_date: '2099-12-31', total: 3116.25, paid_amount: null, remaining_amount: 3116.25, ore_rounding: false, deduction_total: 0 }),
        invoiceRow({ id: 'rot', status: 'sent', due_date: '2099-12-31', total: 10000.4, paid_amount: null, remaining_amount: 7000.4, ore_rounding: true, deduction_total: 3000 }),
        invoiceRow({ id: 'eur', status: 'sent', due_date: '2099-12-31', currency: 'EUR', total: 100.5, paid_amount: null, remaining_amount: 100.5, ore_rounding: true, deduction_total: 0 }),
        invoiceRow({ id: 'credit', status: 'sent', due_date: '2099-12-31', total: -3116.25, paid_amount: null, remaining_amount: 0, ore_rounding: true, deduction_total: 0, credited_invoice_id: 'inv-orig' }),
      ],
      count: 5,
    })
    enqueue({ data: { ore_rounding: false } }) // company_settings: rounding off today

    const result = (await listInvoices.execute({}, 'company-1', 'user-1', supabase as never)) as ListResult
    const byId = Object.fromEntries(result.invoices.map((inv) => [inv.id, inv]))

    expect(findCall('company_settings', 'eq')).toEqual(['company_id', 'company-1'])
    // The draft follows today's company setting (off): it asks for the exact total.
    expect(byId.draft).toMatchObject({ amount_to_pay: 3116.25, ore_rounding_amount: 0 })
    // An issued row keeps its own choice whatever the company says today.
    expect(byId['issued-off']).toMatchObject({ amount_to_pay: 3116.25, ore_rounding_amount: 0 })
    expect(byId.rot).toMatchObject({ total: 10000.4, amount_to_pay: 7000, ore_rounding_amount: -0.4 })
    // Öresavrundning is a Swedish-krona rule: a foreign invoice asks for its total.
    expect(byId.eur).toMatchObject({ amount_to_pay: 100.5, ore_rounding_amount: 0 })
    // A credit note mirrors the invoice it credits.
    expect(byId.credit).toMatchObject({ amount_to_pay: -3116, ore_rounding_amount: 0.25 })
  })

  it('fails the call when the company setting cannot be read, never guessing it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [invoiceRow({ status: 'draft', total: 3116.25, ore_rounding: null, deduction_total: 0 })], count: 1 })
    enqueue({ error: { message: 'permission denied' } }) // company_settings

    await expect(listInvoices.execute({}, 'company-1', 'user-1', supabase as never)).rejects.toThrow(/ore_rounding/)
  })
})

// crm#1759: after an SIE migration the register was empty, the customer
// invoices lived as imported verifikat, and the list carried no
// coverage_note, so the agent read an empty answer as "no invoices".
describe('gnubok_list_invoices: the register-coverage note (crm#1759)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  type CoverageResult = ListResult & {
    invoice_register_coverage?: { covers_from: string | null; has_pre_register_invoices: boolean }
    coverage_note?: string
  }

  async function listWith(rows: Array<Record<string, unknown>>, coverage: Record<string, unknown>) {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-10T08:00:00Z'))
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: rows, count: rows.length })
    if (rows.length > 0) {
      // The payment reference of the listed invoices: the company's settings, then the rows' own facts.
      enqueue({ data: null })
      enqueue({ data: [] })
    }
    enqueue({ data: { pre_register_in_period: false, ...coverage } }) // rpc:get_invoice_register_coverage
    const result = (await listInvoices.execute({}, 'company-1', 'user-1', supabase as never)) as CoverageResult
    expect(supabase.rpc).toHaveBeenCalledWith('get_invoice_register_coverage', expect.objectContaining({ p_today: '2026-11-10' }))
    return result
  }

  it('says an empty register holds none of the history the books carry', async () => {
    const result = await listWith([], { covers_from: '2026-11-10', has_pre_register_invoices: true })

    expect(result.invoices).toEqual([])
    expect(result.invoice_register_coverage).toEqual({ covers_from: '2026-11-10', has_pre_register_invoices: true })
    expect(result.coverage_note).toMatch(/^Fakturaregistret har inga kundfakturor före 2026-11-10/)
    expect(result.coverage_note).toContain('1510/1513')
    expect(result.coverage_note).toContain('inte heller när listan är tom')
    expect(result.coverage_note).toContain('gnubok_query_journal')
  })

  it('keeps the boundary wording for a register that is complete from an earlier date', async () => {
    const result = await listWith(
      [invoiceRow({ status: 'sent', due_date: '2099-12-31', ore_rounding: true, deduction_total: 0 })],
      { covers_from: '2026-07-19', has_pre_register_invoices: true },
    )

    expect(result.coverage_note).toMatch(/^Fakturaregistret är fullständigt först från 2026-07-19\./)
  })

  it('carries no note when the books show nothing outside the register, or the boundary is unknown', async () => {
    const complete = await listWith([], { covers_from: '2026-11-10', has_pre_register_invoices: false })
    expect(complete).not.toHaveProperty('coverage_note')

    // The function before 20261110100000 answered an empty register this way.
    const unknown = await listWith([], { covers_from: null, has_pre_register_invoices: false })
    expect(unknown.invoice_register_coverage).toEqual({ covers_from: null, has_pre_register_invoices: false })
    expect(unknown).not.toHaveProperty('coverage_note')
  })
})

// crm#1886: the reference the invoice PDF prints, on every row, from the
// projection the v1 responses use (withPaymentReference).
describe('gnubok_list_invoices: payment_reference (crm#1886)', () => {
  it('returns what the payer quotes for each invoice, and null where none is asked for', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const issued = { status: 'sent', due_date: '2099-12-31', ore_rounding: true, deduction_total: 0 }
    enqueue({
      data: [
        invoiceRow({ ...issued, id: 'inv-sv', invoice_number: '0073' }),
        invoiceRow({ ...issued, id: 'inv-en', invoice_number: '0074' }),
        invoiceRow({ id: 'draft', status: 'draft', invoice_number: null, ore_rounding: true, deduction_total: 0 }),
        invoiceRow({ ...issued, id: 'quote', invoice_number: 'OF-0073', document_type: 'quote', quote_status: 'open' }),
        invoiceRow({ ...issued, id: 'credit', invoice_number: 'KR-0073', total: -15625, credited_invoice_id: 'inv-sv' }),
      ],
      count: 5,
    })
    enqueue({ data: { bankgiro: '5050-1055' } }) // company_settings
    enqueue({
      // The facts of the rows that can carry a reference.
      data: [
        { id: 'inv-sv', payment_details: null, autogiro_payer_number: null, customer: { language: 'sv' } },
        { id: 'inv-en', payment_details: null, autogiro_payer_number: null, customer: { language: 'en' } },
      ],
    })

    const result = (await listInvoices.execute({}, 'company-1', 'user-1', supabase as never)) as ListResult
    const byId = Object.fromEntries(result.invoices.map((inv) => [inv.id, inv]))

    // 0073 plus its Luhn check digit, as the PDF prints "OCR/Referens".
    expect(byId['inv-sv']).toMatchObject({ payment_reference: '00737', payment_reference_type: 'ocr' })
    // An English invoice prints "Reference" with the number.
    expect(byId['inv-en']).toMatchObject({ payment_reference: '0074', payment_reference_type: 'invoice_number' })
    for (const id of ['draft', 'quote', 'credit']) {
      expect(byId[id], id).toMatchObject({ payment_reference: null, payment_reference_type: null })
    }
    expect(findCalls('invoices', 'in')).toContainEqual(['id', ['inv-sv', 'inv-en']])
  })
})
