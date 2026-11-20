import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockRequest, parseJsonResponse } from '@/tests/helpers'
import {
  createSupplierInvoiceRowsDb,
  invoiceRow,
  voucherRow,
} from '@/lib/supplier-invoices/__tests__/supplier-invoice-rows-db'

// The route's reads are answered from these rows with its own filters applied
// (company, supplier, live status), so each test states what is in the
// database and reads what the editor would be told.
const rows: { supplier_invoices: Record<string, unknown>[]; journal_entries: Record<string, unknown>[] } = {
  supplier_invoices: [],
  journal_entries: [],
}
const db = createSupplierInvoiceRowsDb(rows)
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => Promise.resolve(db.supabase),
}))

vi.mock('@/lib/company/context', () => ({
  requireCompanyId: vi.fn().mockResolvedValue('company-1'),
  getActiveCompanyId: vi.fn().mockResolvedValue('company-1'),
}))

import { GET } from '../route'

const SUPPLIER = '550e8400-e29b-41d4-a716-446655440000'
const OTHER_SUPPLIER = '550e8400-e29b-41d4-a716-446655440001'

interface ExistsBody {
  data: {
    exists: boolean
    existing?: { id: string; supplier_invoice_number: string | null; status: string; voucher: { label: string } | null }
    reference?: { count: number; needs_acknowledgement: boolean; invoice: { id: string; voucher: { label: string } | null } }
  }
}

async function ask(searchParams: Record<string, string>) {
  const request = createMockRequest('/api/supplier-invoices/exists', { searchParams })
  const response = await GET(request, { params: Promise.resolve({}) })
  return parseJsonResponse<ExistsBody>(response)
}

describe('GET /api/supplier-invoices/exists', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    db.reset()
    rows.supplier_invoices.length = 0
    rows.journal_entries.length = 0
    db.supabase.auth.getUser.mockResolvedValue({ data: { user: { id: 'user-1', email: 'test@test.se' } }, error: null })
  })

  it('returns 401 when not authenticated', async () => {
    db.supabase.auth.getUser.mockResolvedValue({ data: { user: null }, error: null })

    const { status, body } = await ask({ supplier_id: SUPPLIER, number: 'F-2026-881' })

    expect(status).toBe(401)
    expect(body).toEqual({ error: 'Unauthorized' })
  })

  it('returns 400 when supplier_id is not a uuid', async () => {
    const { status, body } = await ask({ supplier_id: 'not-a-uuid', number: 'F-2026-881' })

    expect(status).toBe(400)
    expect(body).toMatchObject({ type: 'validation_error' })
  })

  it('returns 400 with neither a number nor a reference', async () => {
    const { status, body } = await ask({ supplier_id: SUPPLIER })

    expect(status).toBe(400)
    expect(body).toMatchObject({ type: 'validation_error' })
    expect(db.tables()).toEqual([])
  })

  it('returns 400 for an empty number or reference', async () => {
    expect((await ask({ supplier_id: SUPPLIER, number: '' })).status).toBe(400)
    expect((await ask({ supplier_id: SUPPLIER, number: 'F-1', reference: '' })).status).toBe(400)
  })

  it('returns exists: false when no invoice has the number or the reference', async () => {
    rows.supplier_invoices.push(invoiceRow({ supplier_id: SUPPLIER, supplier_invoice_number: 'F-1', payment_reference: '111222' }))

    const { status, body } = await ask({ supplier_id: SUPPLIER, number: 'F-2026-881', reference: '5550001' })

    expect(status).toBe(200)
    expect(body.data).toEqual({ exists: false })
  })

  it('number hit: the existing invoice with the verifikat it is booked on', async () => {
    const holder = invoiceRow({
      supplier_id: SUPPLIER,
      supplier_invoice_number: 'F-2026-881',
      status: 'approved',
      registration_journal_entry_id: 'je-1',
    })
    rows.supplier_invoices.push(holder)
    rows.journal_entries.push(voucherRow())

    const { status, body } = await ask({ supplier_id: SUPPLIER, number: 'F-2026-881' })

    expect(status).toBe(200)
    expect(body.data).toEqual({
      exists: true,
      existing: {
        id: holder.id,
        supplier_invoice_number: 'F-2026-881',
        arrival_number: holder.arrival_number,
        invoice_date: '2026-10-01',
        total: 1250,
        currency: 'SEK',
        ore_rounding: null,
        status: 'approved',
        voucher: { journal_entry_id: 'je-1', label: 'A71' },
      },
    })
  })

  it('reference hit: the other invoice, its verifikat, and an acknowledgement asked for', async () => {
    const other = invoiceRow({
      supplier_id: SUPPLIER,
      supplier_invoice_number: 'F-700',
      payment_reference: '7300 5512 348',
      registration_journal_entry_id: 'je-1',
    })
    rows.supplier_invoices.push(other)
    rows.journal_entries.push(voucherRow())

    const { status, body } = await ask({ supplier_id: SUPPLIER, number: 'F-701', reference: '73005512348' })

    expect(status).toBe(200)
    expect(body.data.exists).toBe(false)
    expect(body.data.existing).toBeUndefined()
    expect(body.data.reference).toMatchObject({
      count: 1,
      needs_acknowledgement: true,
      invoice: { id: other.id, supplier_invoice_number: 'F-700', voucher: { label: 'A71' } },
    })
  })

  it('reference alone, before a number is typed', async () => {
    const other = invoiceRow({ supplier_id: SUPPLIER, payment_reference: '5550001' })
    rows.supplier_invoices.push(other)

    const { body } = await ask({ supplier_id: SUPPLIER, reference: '5550001' })

    expect(body.data).toMatchObject({ exists: false, reference: { count: 1, invoice: { id: other.id, voucher: null } } })
  })

  it('both: the number on one invoice and the reference on another', async () => {
    const holder = invoiceRow({ supplier_id: SUPPLIER, supplier_invoice_number: 'F-2026-881' })
    const sharing = invoiceRow({ supplier_id: SUPPLIER, supplier_invoice_number: 'F-500', payment_reference: '5550001' })
    rows.supplier_invoices.push(holder, sharing)

    const { body } = await ask({ supplier_id: SUPPLIER, number: 'F-2026-881', reference: '5550001' })

    expect(body.data).toMatchObject({
      exists: true,
      existing: { id: holder.id },
      reference: { count: 1, needs_acknowledgement: true, invoice: { id: sharing.id } },
    })
  })

  it('a reference shared by two or more invoices asks for no acknowledgement', async () => {
    rows.supplier_invoices.push(
      invoiceRow({ supplier_id: SUPPLIER, payment_reference: '5550001', invoice_date: '2026-08-01' }),
      invoiceRow({ supplier_id: SUPPLIER, payment_reference: '5550001', invoice_date: '2026-09-01' }),
    )

    const { body } = await ask({ supplier_id: SUPPLIER, number: 'F-NEW', reference: '5550001' })

    expect(body.data.reference).toMatchObject({ count: 2, needs_acknowledgement: false })
  })

  it('mirrors the partial unique index predicate: credited and reversed invoices are left out', async () => {
    rows.supplier_invoices.push(
      invoiceRow({ supplier_id: SUPPLIER, supplier_invoice_number: 'F-2026-881', payment_reference: '5550001', status: 'credited' }),
      invoiceRow({ supplier_id: SUPPLIER, supplier_invoice_number: 'F-2026-881', payment_reference: '5550001', status: 'reversed' }),
    )

    const { body } = await ask({ supplier_id: SUPPLIER, number: 'F-2026-881', reference: '5550001' })

    expect(body.data).toEqual({ exists: false })
    expect(db.findCalls('supplier_invoices', 'not')).toEqual([
      ['status', 'in', '(credited,reversed)'],
      ['status', 'in', '(credited,reversed)'],
    ])
  })

  it('never leaks another company or another supplier', async () => {
    rows.supplier_invoices.push(
      invoiceRow({ supplier_id: SUPPLIER, company_id: 'company-2', supplier_invoice_number: 'F-2026-881', payment_reference: '5550001', registration_journal_entry_id: 'je-1' }),
      invoiceRow({ supplier_id: OTHER_SUPPLIER, supplier_invoice_number: 'F-2026-881', payment_reference: '5550001' }),
    )
    rows.journal_entries.push(voucherRow({ company_id: 'company-2' }))

    const { status, body } = await ask({ supplier_id: SUPPLIER, number: 'F-2026-881', reference: '5550001' })

    expect(status).toBe(200)
    expect(body.data).toEqual({ exists: false })
    expect(db.findCalls('supplier_invoices', 'eq').filter(([column]) => column === 'company_id')).toEqual([
      ['company_id', 'company-1'],
      ['company_id', 'company-1'],
    ])
  })

  it('names no verifikat of another company, even when an invoice points at one', async () => {
    rows.supplier_invoices.push(
      invoiceRow({ supplier_id: SUPPLIER, supplier_invoice_number: 'F-2026-881', registration_journal_entry_id: 'je-1' }),
    )
    rows.journal_entries.push(voucherRow({ company_id: 'company-2' }))

    const { body } = await ask({ supplier_id: SUPPLIER, number: 'F-2026-881' })

    expect(body.data.existing?.voucher).toBeNull()
  })

  it('returns 500 on database error', async () => {
    db.setTable('supplier_invoices', { error: { message: 'DB error' } })

    const { status } = await ask({ supplier_id: SUPPLIER, number: 'F-2026-881' })

    expect(status).toBe(500)
  })
})
