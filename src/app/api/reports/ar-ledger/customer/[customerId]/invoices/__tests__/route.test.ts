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

vi.mock('@/lib/bookkeeping/currency-utils', () => ({
  resolveSekAmount: vi.fn((amount: number) => amount),
}))

import { GET } from '../route'
import { AR_LEDGER_STATUSES } from '@/lib/reports/ar-ledger'

interface QueryResult {
  data: unknown
  error: unknown
}

function buildSupabase(
  customer: { id: string; name: string } | null,
  invoicesResult: QueryResult,
  entriesResult: QueryResult,
  /** The second journal_entries read: the verifikat invoices are linked to. */
  linkedEntriesResult?: QueryResult,
  /** Payment rows naming a credit note's verifikat (crm#1059). */
  paymentsResult: QueryResult = { data: [], error: null }
) {
  const invoicesIn = vi.fn().mockReturnThis()
  const entriesIn = vi.fn().mockReturnThis()
  const paymentsIn = vi.fn().mockReturnThis()
  let entryReads = 0
  return {
    invoicesIn,
    entriesIn,
    paymentsIn,
    from: vi.fn().mockImplementation((table: string) => {
      if (table === 'invoice_payments') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: paymentsIn,
          order: vi.fn().mockReturnThis(),
          range: vi.fn().mockReturnThis(),
          then: (resolve: (v: QueryResult) => void) => resolve(paymentsResult),
        }
      }
      if (table === 'customers') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          maybeSingle: vi.fn().mockResolvedValue({ data: customer, error: null }),
        }
      }
      if (table === 'invoices') {
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          in: invoicesIn,
          order: vi.fn().mockReturnThis(),
          limit: vi.fn().mockReturnThis(),
          then: (resolve: (v: QueryResult) => void) => resolve(invoicesResult),
        }
      }
      // journal_entries
      entryReads += 1
      const result = entryReads > 1 && linkedEntriesResult ? linkedEntriesResult : entriesResult
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        in: entriesIn,
        then: (resolve: (v: QueryResult) => void) => resolve(result),
      }
    }),
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
    authWith(
      buildSupabase(null, { data: [], error: null }, { data: [], error: null })
    )
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
    const entries = [
      {
        id: 'je-1',
        voucher_number: 22,
        voucher_series: 'A',
        description: 'Faktura 2026-001',
        source_id: 'inv-1',
      },
    ]
    authWith(
      buildSupabase(
        { id: 'cust-1', name: 'Acme AB' },
        { data: invoices, error: null },
        { data: entries, error: null }
      )
    )
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
    const supabase = buildSupabase(
      { id: 'cust-1', name: 'Kunden AB' },
      { data: invoices, error: null },
      { data: [], error: null }
    )
    authWith(supabase)
    const req = createMockRequest(
      '/api/reports/ar-ledger/customer/cust-1/invoices'
    )
    const res = await GET(req, createMockRouteParams({ customerId: 'cust-1' }))
    expect(res.status).toBe(200)

    // Same population as the aggregate it drills into.
    expect(supabase.invoicesIn).toHaveBeenCalledWith('status', [...AR_LEDGER_STATUSES])
    expect(supabase.invoicesIn).toHaveBeenCalledWith(
      'status',
      expect.arrayContaining(['partially_paid'])
    )

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
      { data: invoices, error: null },
      // No invoice_created entry: the invoice was booked by the SIE import.
      { data: [], error: null },
      { data: [{ id: 'je-sie', voucher_number: 45, voucher_series: 'B', description: 'Kundfaktura 1023' }], error: null }
    )
    authWith(supabase)
    const req = createMockRequest('/api/reports/ar-ledger/customer/cust-1/invoices')
    const res = await GET(req, createMockRouteParams({ customerId: 'cust-1' }))
    expect(res.status).toBe(200)

    expect(supabase.entriesIn).toHaveBeenCalledWith('id', ['je-sie'])
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
          data: [
            { ...row, id: 'inv-open', invoice_number: '10', total: 1000, paid_amount: 0, remaining_amount: 1000, status: 'sent' },
            { ...row, id: 'inv-cn', invoice_number: '6', total: -11615, paid_amount: 0, status: 'credited' },
          ],
          error: null,
        },
        { data: [], error: null }
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
    const supabase = buildSupabase(
      { id: 'cust-1', name: 'Kunden AB' },
      { data: invoices, error: null },
      { data: [], error: null },
      { data: [], error: null },
      { data: [setOff], error: null }
    )
    authWith(supabase)
    const req = createMockRequest('/api/reports/ar-ledger/customer/cust-1/invoices')
    const res = await GET(req, createMockRouteParams({ customerId: 'cust-1' }))
    expect(res.status).toBe(200)

    expect(supabase.paymentsIn).toHaveBeenCalledWith('journal_entry_id', ['je-cn'])
    const body = (await res.json()) as {
      data: { lines: Array<{ invoice_id: string; outstanding: number; debit: number; paid_amount: number }> }
    }
    const lines = Object.fromEntries(body.data.lines.map((line) => [line.invoice_id, line]))
    // paid_amount is total - outstanding, as generateARLedger reports it.
    expect(lines.cn).toMatchObject({ outstanding: 0, debit: 0, paid_amount: -40000 })
    expect(lines.new).toMatchObject({ outstanding: 10000, debit: 10000, paid_amount: 40000 })
  })

  it('answers with an error when the set-off rows cannot be read', async () => {
    authWith(
      buildSupabase(
        { id: 'cust-1', name: 'Kunden AB' },
        { data: invoices, error: null },
        { data: [], error: null },
        { data: [], error: null },
        { data: null, error: { message: 'boom' } }
      )
    )
    const req = createMockRequest('/api/reports/ar-ledger/customer/cust-1/invoices')
    const res = await GET(req, createMockRouteParams({ customerId: 'cust-1' }))
    expect(res.status).toBe(500)
  })
})
