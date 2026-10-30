import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'
import { createMockRequest, createMockRouteParams } from '@/tests/helpers'

const requireAuthMock = vi.fn()
vi.mock('@/lib/auth/require-auth', () => ({
  requireAuth: (...args: unknown[]) => requireAuthMock(...args),
}))

vi.mock('@/lib/company/context', () => ({
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

vi.mock('@/lib/bookkeeping/currency-utils', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bookkeeping/currency-utils')>()),
  resolveSekAmount: vi.fn((amount: number) => amount),
}))

import { GET } from '../route'
import { AR_LEDGER_STATUSES } from '@/lib/reports/ar-ledger'
import { creditedInvoiceRead, reskontraRpcPorts, type ReskontraTables } from '@/tests/reskontra-rpc-port'

/**
 * The customer lookup is a table read; the invoices, their set-offs, begäran
 * items and verifikat come from get_ar_ledger_invoices, answered from `books`
 * by its JS port (tests/reskontra-rpc-port.ts). Invoices are the customer's
 * ('cust-1') and open ('sent') unless they say otherwise.
 */
function buildSupabase(
  customer: { id: string; name: string } | null,
  books: ReskontraTables,
  failures: Record<string, { message: string }> = {},
) {
  const tables: ReskontraTables = {
    ...books,
    invoices: (books.invoices ?? []).map((row) => ({ customer_id: 'cust-1', status: 'sent', ...row })),
  }
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    if (failures[name]) return { data: null, error: failures[name] }
    return { data: reskontraRpcPorts(tables)[name](args), error: null }
  })
  return {
    rpc,
    from: vi.fn().mockImplementation((table: string) => {
      // The credit notes' originals (lib/reports/credited-pairs.ts).
      if (table === 'invoices') return creditedInvoiceRead(tables.invoices ?? [], failures.invoices)
      if (table !== 'customers') throw new Error(`unexpected read of ${table}`)
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        maybeSingle: vi.fn().mockResolvedValue({ data: customer, error: null }),
      }
    }),
  }
}

/** The invoice engine's registration verifikat of an invoice. */
function engineEntry(invoiceId: string, voucherNumber: number, description: string) {
  return {
    id: `je-${invoiceId}`, source_type: 'invoice_created', source_id: invoiceId, status: 'posted',
    voucher_number: voucherNumber, voucher_series: 'A', description,
  }
}

function authWith(supabase: unknown) {
  requireAuthMock.mockResolvedValue({ user: { id: 'user-1' }, supabase, error: null })
}

function unauthed() {
  requireAuthMock.mockResolvedValue({
    user: null,
    supabase: {},
    error: NextResponse.json({ error: 'Unauthorized' }, { status: 401 }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('GET /api/reports/ar-ledger/customer/[customerId]/invoices', () => {
  it('returns 401 when not authenticated', async () => {
    unauthed()
    const req = createMockRequest(
      '/api/reports/ar-ledger/customer/cust-1/invoices'
    )
    const res = await GET(req, createMockRouteParams({ customerId: 'cust-1' }))
    expect(res.status).toBe(401)
  })

  it('returns 404 when customer is unknown', async () => {
    authWith(buildSupabase(null, { invoices: [] }))
    const req = createMockRequest(
      '/api/reports/ar-ledger/customer/cust-1/invoices'
    )
    const res = await GET(req, createMockRouteParams({ customerId: 'cust-1' }))
    expect(res.status).toBe(404)
  })

  it('happy path: returns invoices with linked journal entries', async () => {
    const invoices = [
      {
        id: 'inv-1',
        invoice_number: '2026-001',
        invoice_date: '2026-05-01',
        due_date: '2026-06-01',
        total: 1250,
        paid_amount: 0,
        currency: 'SEK',
        exchange_rate: null,
        remaining_amount: 1250,
        notes: null,
      },
    ]
    const supabase = buildSupabase(
      { id: 'cust-1', name: 'Acme AB' },
      { invoices, journal_entries: [{ ...engineEntry('inv-1', 22, 'Faktura 2026-001'), id: 'je-1' }] },
    )
    authWith(supabase)
    const req = createMockRequest(
      '/api/reports/ar-ledger/customer/cust-1/invoices'
    )
    const res = await GET(req, createMockRouteParams({ customerId: 'cust-1' }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: {
        customer_id: string
        customer_name: string
        lines: Array<{
          invoice_id: string
          voucher_number: number
          journal_entry_id: string
          outstanding: number
        }>
      }
    }

    // One read of the customer's population, verifikat included.
    expect(supabase.rpc).toHaveBeenCalledWith('get_ar_ledger_invoices', {
      p_company_id: 'company-1',
      p_as_of_date: null,
      p_customer_id: 'cust-1',
    })
    expect(body.data.customer_id).toBe('cust-1')
    expect(body.data.customer_name).toBe('Acme AB')
    expect(body.data.lines).toHaveLength(1)
    expect(body.data.lines[0].invoice_id).toBe('inv-1')
    expect(body.data.lines[0].journal_entry_id).toBe('je-1')
    expect(body.data.lines[0].voucher_number).toBe(22)
    expect(body.data.lines[0].outstanding).toBe(1250)
  })

  it('includes a partially paid invoice with its remainder outstanding (feedback seq 817399)', async () => {
    const invoices = [
      {
        id: 'inv-pp',
        invoice_number: '2026024',
        invoice_date: '2026-06-01',
        due_date: '2026-07-01',
        total: 15625,
        paid_amount: 15000,
        currency: 'SEK',
        exchange_rate: null,
        remaining_amount: 625,
        notes: null,
      },
    ]
    // Same population as the aggregate it drills into: every live status
    // (AR_LEDGER_STATUSES), so a partially paid invoice is read.
    expect(AR_LEDGER_STATUSES).toContain('partially_paid')
    const supabase = buildSupabase(
      { id: 'cust-1', name: 'Kunden AB' },
      { invoices: invoices.map((inv) => ({ ...inv, status: 'partially_paid' })) },
    )
    authWith(supabase)
    const req = createMockRequest(
      '/api/reports/ar-ledger/customer/cust-1/invoices'
    )
    const res = await GET(req, createMockRouteParams({ customerId: 'cust-1' }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: { lines: Array<Record<string, unknown>> }
    }
    expect(body.data.lines).toHaveLength(1)
    expect(body.data.lines[0]).toMatchObject({
      invoice_id: 'inv-pp',
      paid_amount: 15000,
      outstanding: 625,
      outstanding_sek: 625,
      debit: 625,
    })
  })

  it('shows the imported verifikat an invoice registered from the books is linked to (crm#1094)', async () => {
    const invoices = [
      {
        id: 'inv-registered',
        invoice_number: '1023',
        invoice_date: '2026-03-02',
        due_date: '2026-04-01',
        total: 12500,
        paid_amount: 0,
        currency: 'SEK',
        exchange_rate: null,
        remaining_amount: 12500,
        notes: null,
        status: 'sent',
        journal_entry_id: 'je-sie',
      },
    ]
    const supabase = buildSupabase(
      { id: 'cust-1', name: 'Kunden AB' },
      {
        invoices,
        // No invoice_created entry: the invoice was booked by the SIE import.
        journal_entries: [
          { id: 'je-sie', source_type: 'import', status: 'posted', voucher_number: 45, voucher_series: 'B', description: 'Kundfaktura 1023' },
        ],
      },
    )
    authWith(supabase)
    const req = createMockRequest('/api/reports/ar-ledger/customer/cust-1/invoices')
    const res = await GET(req, createMockRouteParams({ customerId: 'cust-1' }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as { data: { lines: Array<Record<string, unknown>> } }
    expect(body.data.lines[0]).toMatchObject({
      invoice_id: 'inv-registered',
      journal_entry_id: 'je-sie',
      voucher_series: 'B',
      voucher_number: 45,
      description: 'Kundfaktura 1023',
      outstanding: 12500,
    })
  })

  it('leaves out a migrated credit note whose original was imported as paid, like the aggregate', async () => {
    const row = {
      invoice_date: '2026-02-13',
      due_date: '2026-03-15',
      currency: 'SEK',
      exchange_rate: null,
      remaining_amount: 0,
      notes: null,
    }
    authWith(
      buildSupabase(
        { id: 'cust-1', name: 'Callidus Tech AB' },
        {
          invoices: [
            { ...row, id: 'inv-open', invoice_number: '10', total: 1000, paid_amount: 0, remaining_amount: 1000, status: 'sent' },
            { ...row, id: 'inv-cn', invoice_number: '6', total: -11615, paid_amount: 0, status: 'credited' },
          ],
        },
      )
    )
    const req = createMockRequest('/api/reports/ar-ledger/customer/cust-1/invoices')
    const res = await GET(req, createMockRouteParams({ customerId: 'cust-1' }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as { data: { lines: Array<{ invoice_id: string }> } }
    expect(body.data.lines.map((line) => line.invoice_id)).toEqual(['inv-open'])
  })
})

describe('GET /api/reports/ar-ledger/customer/[customerId]/invoices: credit note set-off (crm#1059)', () => {
  const row = { currency: 'SEK', exchange_rate: null, notes: null }
  const invoices = [
    { ...row, id: 'cn', invoice_number: 'KR-F-1', invoice_date: '2026-09-10', due_date: '2026-09-10', total: -40000, paid_amount: null, remaining_amount: 0, status: 'sent', journal_entry_id: 'je-cn' },
    { ...row, id: 'new', invoice_number: 'F-2', invoice_date: '2026-09-20', due_date: '2026-10-20', total: 50000, paid_amount: 40000, remaining_amount: 10000, status: 'partially_paid', journal_entry_id: 'je-new' },
  ]
  const setOff = {
    id: 'pay-setoff', invoice_id: 'new', journal_entry_id: 'je-cn', amount: 40000, currency: 'SEK',
    payment_exchange_rate: null, payment_date: '2026-09-10', invoice: { invoice_date: '2026-09-20' },
  }

  it('shows a credit note whose credit paid the new invoice as used, like the aggregate', async () => {
    const supabase = buildSupabase({ id: 'cust-1', name: 'Kunden AB' }, { invoices, invoice_payments: [setOff] })
    authWith(supabase)
    const req = createMockRequest('/api/reports/ar-ledger/customer/cust-1/invoices')
    const res = await GET(req, createMockRouteParams({ customerId: 'cust-1' }))
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      data: { lines: Array<{ invoice_id: string; outstanding: number; debit: number; paid_amount: number }> }
    }
    const lines = Object.fromEntries(body.data.lines.map((line) => [line.invoice_id, line]))
    // paid_amount is total - outstanding, as generateARLedger reports it.
    expect(lines.cn).toMatchObject({ outstanding: 0, debit: 0, paid_amount: -40000 })
    expect(lines.new).toMatchObject({ outstanding: 10000, debit: 10000, paid_amount: 40000 })
  })

  it('answers with an error when the population, set-offs included, cannot be read', async () => {
    authWith(
      buildSupabase(
        { id: 'cust-1', name: 'Kunden AB' },
        { invoices, invoice_payments: [setOff] },
        { get_ar_ledger_invoices: { message: 'boom' } },
      )
    )
    const req = createMockRequest('/api/reports/ar-ledger/customer/cust-1/invoices')
    const res = await GET(req, createMockRouteParams({ customerId: 'cust-1' }))
    expect(res.status).toBe(500)
  })
})

describe('GET /api/reports/ar-ledger/customer/[customerId]/invoices: ROT/RUT awaiting Skatteverket', () => {
  // RUT invoice: 10 000 invoiced, deduction 3 000 on 1513, the buyer's 7 000
  // paid, Skatteverket's share not yet paid out.
  const row = { currency: 'SEK', exchange_rate: null, notes: null, invoice_date: '2026-05-01', due_date: '2026-06-01' }
  const rut = {
    ...row, id: 'inv-rut', invoice_number: 'F-RUT', total: 10000, paid_amount: 7000, remaining_amount: 0,
    deduction_total: 3000, deduction_reclaimed_total: 0, status: 'paid',
  }
  const plain = {
    ...row, id: 'inv-plain', invoice_number: 'F-PLAIN', total: 1250, paid_amount: 0, remaining_amount: 1250,
    deduction_total: 0, deduction_reclaimed_total: 0, status: 'sent',
  }
  // One begäran item for the invoice, on a begäran settled by the payout
  // voucher of 2026-07-01.
  const item = (status: string, decided: number): ReskontraTables => ({
    rot_rut_payout_request_items: [{ id: `item-${status}`, invoice_id: 'inv-rut', request_id: `req-${status}`, decided_amount: decided }],
    rot_rut_payout_requests: [{ id: `req-${status}`, status, settlement_journal_entry_id: 'je-payout' }],
    journal_entries: [{ id: 'je-payout', entry_date: '2026-07-01', status: 'posted' }],
  })

  async function linesFor(payout: ReskontraTables = {}) {
    authWith(buildSupabase({ id: 'cust-1', name: 'Hushållet' }, { invoices: [rut, plain], ...payout }))
    const req = createMockRequest('/api/reports/ar-ledger/customer/cust-1/invoices')
    const res = await GET(req, createMockRouteParams({ customerId: 'cust-1' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { lines: Array<{ invoice_id: string; outstanding: number; debit: number; paid_amount: number }> }
    }
    return Object.fromEntries(body.data.lines.map((line) => [line.invoice_id, line]))
  }

  it('lists a paid invoice whose begäran is not settled with the deduction outstanding, like the aggregate', async () => {
    const lines = await linesFor()
    expect(lines['inv-rut']).toMatchObject({ outstanding: 3000, debit: 3000, paid_amount: 7000 })
    expect(lines['inv-plain']).toMatchObject({ outstanding: 1250, debit: 1250, paid_amount: 0 })
  })

  it('keeps the refused remainder of a partly paid begäran', async () => {
    const lines = await linesFor(item('partially_paid', 2000))
    expect(lines['inv-rut']).toMatchObject({ outstanding: 1000, debit: 1000 })
  })

  it('leaves out a paid invoice whose begäran is settled in full', async () => {
    const lines = await linesFor(item('paid', 3000))
    expect(Object.keys(lines)).toEqual(['inv-plain'])
  })
})

describe('GET /api/reports/ar-ledger/customer/[customerId]/invoices: a credited invoice and its credit note (crm#1537)', () => {
  const row = { currency: 'SEK', exchange_rate: null, notes: null, paid_amount: 0 }
  const original = (total: number) => ({ ...row, id: 'orig', invoice_number: 'F-1', invoice_date: '2026-06-01', due_date: '2026-07-01', total, status: 'credited' })
  const note = (total: number) => ({ ...row, id: 'kr', invoice_number: 'KR-1', invoice_date: '2026-10-20', due_date: '2026-10-20', total, status: 'sent', credited_invoice_id: 'orig' })
  const open = { ...row, id: 'open', invoice_number: 'F-2', invoice_date: '2026-09-01', due_date: '2026-10-01', total: 500, status: 'sent' }

  async function linesFor(invoices: Record<string, unknown>[]) {
    authWith(buildSupabase({ id: 'cust-1', name: 'Kunden AB' }, { invoices }))
    const res = await GET(createMockRequest('/api/reports/ar-ledger/customer/cust-1/invoices'), createMockRouteParams({ customerId: 'cust-1' }))
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { lines: Array<{ invoice_id: string; outstanding: number }> } }
    return body.data.lines.map((line) => [line.invoice_id, line.outstanding])
  }

  it('lists neither row of a full credit, like the aggregate', async () => {
    expect(await linesFor([original(1000), note(-1000), open])).toEqual([['open', 500]])
  })

  it('keeps the rest of a partial credit on the original', async () => {
    expect(await linesFor([original(1000), note(-400)])).toEqual([['orig', 600]])
  })
})
