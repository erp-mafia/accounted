import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const matchSupplierMock = vi.fn()
vi.mock('@/lib/suppliers/match-supplier', async () => {
  const actual = await vi.importActual<typeof import('@/lib/suppliers/match-supplier')>('@/lib/suppliers/match-supplier')
  return { ...actual, matchSupplierByIdentity: (...args: unknown[]) => matchSupplierMock(...args) }
})

import {
  compareCreditToInvoice,
  creditNoteFromReading,
  normalizeInvoiceNumber,
  pickCreditTarget,
  resolveInboxCreditTarget,
  type CreditTargetCandidate,
} from '../credit-target'

function invoice(overrides: Partial<CreditTargetCandidate> = {}): CreditTargetCandidate {
  return {
    supplier_invoice_id: 'si-1',
    supplier_invoice_number: '10234',
    arrival_number: 12,
    supplier_id: 'sup-1',
    supplier_name: 'Programvara AB',
    invoice_date: '2026-09-01',
    status: 'approved',
    currency: 'SEK',
    total: 10000,
    ...overrides,
  }
}

const reading = (overrides: Partial<Parameters<typeof pickCreditTarget>[1]> = {}) => ({
  supplierId: 'sup-1',
  referencedNumber: '10234',
  total: -10000,
  currency: 'SEK',
  ...overrides,
})

describe('pickCreditTarget: the referenced invoice number', () => {
  it('matches the one invoice it references for its whole amount', () => {
    const result = pickCreditTarget([invoice(), invoice({ supplier_invoice_id: 'si-2', supplier_invoice_number: '10235' })], reading())
    expect(result).toMatchObject({ status: 'matched', matched_on: 'invoice_number', credit_total: 10000 })
    expect(result.invoice?.supplier_invoice_id).toBe('si-1')
  })

  it('reads the number the way people write it', () => {
    expect(normalizeInvoiceNumber(' #0010234 ')).toBe('10234')
    expect(normalizeInvoiceNumber('f-2026 118')).toBe('F-2026118')
    expect(pickCreditTarget([invoice()], reading({ referencedNumber: '#010234' })).status).toBe('matched')
  })

  it('flags a credit note for less than the invoice as partial, never matched', () => {
    const result = pickCreditTarget([invoice()], reading({ total: -2500 }))
    expect(result).toMatchObject({ status: 'partial', credit_total: 2500 })
    expect(result.invoice?.supplier_invoice_id).toBe('si-1')
  })

  it('flags a missing, larger or foreign-currency amount as amount_differs', () => {
    expect(pickCreditTarget([invoice()], reading({ total: null })).status).toBe('amount_differs')
    expect(pickCreditTarget([invoice()], reading({ total: -12000 })).status).toBe('amount_differs')
    expect(pickCreditTarget([invoice()], reading({ currency: 'EUR' })).status).toBe('amount_differs')
  })

  it('says the referenced invoice is already credited', () => {
    const result = pickCreditTarget([invoice({ status: 'credited' })], reading())
    expect(result).toMatchObject({ status: 'already_credited', matched_on: 'invoice_number' })
  })

  it('hands back several open invoices with the number as ambiguous', () => {
    const result = pickCreditTarget(
      [invoice(), invoice({ supplier_invoice_id: 'si-2', supplier_id: 'sup-2' })],
      reading({ supplierId: null }),
    )
    expect(result.status).toBe('ambiguous')
    expect(result.candidates.map((c) => c.supplier_invoice_id)).toEqual(['si-1', 'si-2'])
  })
})

describe('pickCreditTarget: the supplier and amount fallback', () => {
  it('matches the supplier\'s one open invoice of the same amount', () => {
    const result = pickCreditTarget(
      [invoice({ supplier_invoice_number: '9001', total: 4000 }), invoice({ supplier_invoice_id: 'si-2', supplier_invoice_number: '9002' })],
      reading({ referencedNumber: null }),
    )
    expect(result).toMatchObject({ status: 'matched', matched_on: 'supplier_amount' })
    expect(result.invoice?.supplier_invoice_id).toBe('si-2')
  })

  it('does not guess between two invoices of the same amount', () => {
    const result = pickCreditTarget(
      [invoice({ supplier_invoice_number: '9001' }), invoice({ supplier_invoice_id: 'si-2', supplier_invoice_number: '9002' })],
      reading({ referencedNumber: 'unknown-ref' }),
    )
    expect(result.status).toBe('ambiguous')
    expect(result.candidates).toHaveLength(2)
  })

  it('offers the supplier\'s creditable invoices to pick from when nothing fits', () => {
    const result = pickCreditTarget(
      [invoice({ total: 3000 }), invoice({ supplier_invoice_id: 'si-2', status: 'credited', total: 3000 })],
      reading({ referencedNumber: null }),
    )
    expect(result.status).toBe('none')
    expect(result.candidates.map((c) => c.supplier_invoice_id)).toEqual(['si-1'])
  })

  it('answers none with nothing to pick when the supplier is unknown', () => {
    expect(pickCreditTarget([invoice()], reading({ supplierId: null, referencedNumber: null }))).toMatchObject({
      status: 'none',
      candidates: [],
    })
  })
})

describe('compareCreditToInvoice', () => {
  it('compares magnitudes to the öre', () => {
    expect(compareCreditToInvoice({ total: -1249.995, currency: 'SEK' }, { total: 1250, currency: 'SEK' })).toBe('full')
    expect(compareCreditToInvoice({ total: 1249.5, currency: null }, { total: 1250, currency: 'SEK' })).toBe('partial')
  })
})

describe('creditNoteFromReading', () => {
  it('trusts magnitudes, not signs, and sums net and VAT when no total was read', () => {
    expect(creditNoteFromReading({ totals: { subtotal: -8000, vatAmount: -2000, total: null } }).total).toBe(10000)
    // The reported case: a positive total over a negative net and VAT.
    expect(creditNoteFromReading({ totals: { subtotal: -8000, vatAmount: -2000, total: 10000 } }).total).toBe(10000)
  })

  it('reads the credit note\'s own number and date and the invoice it references', () => {
    expect(
      creditNoteFromReading({
        invoice: { invoiceNumber: 'K-778', invoiceDate: '2026-09-18', currency: 'SEK', creditedInvoiceNumber: '10234' },
      }),
    ).toMatchObject({ creditNoteNumber: 'K-778', creditNoteDate: '2026-09-18', referencedNumber: '10234', currency: 'SEK' })
    expect(creditNoteFromReading({ invoice: { invoiceDate: '18/9' } }).creditNoteDate).toBeNull()
  })
})

describe('resolveInboxCreditTarget', () => {
  const { supabase, setTable, reset, findCall } = createTableMockSupabase()

  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('resolves the supplier from the reading when none is picked, and reads that supplier\'s invoices', async () => {
    matchSupplierMock.mockResolvedValue({ supplierId: 'sup-1', matchedOn: 'org_number' })
    setTable('supplier_invoices', {
      data: [
        {
          id: 'si-1',
          supplier_id: 'sup-1',
          supplier_invoice_number: '10234',
          arrival_number: 12,
          invoice_date: '2026-09-01',
          status: 'approved',
          currency: 'SEK',
          total: '10000.00',
          supplier: { name: 'Programvara AB' },
        },
      ],
    })

    const result = await resolveInboxCreditTarget(supabase as unknown as SupabaseClient, 'company-1', {
      matched_supplier_id: null,
      extracted_data: {
        supplier: { name: 'Programvara AB', orgNumber: '5561234567' },
        invoice: { creditedInvoiceNumber: '10234', currency: 'SEK' },
        totals: { total: -10000 },
      },
    })

    expect(result).toMatchObject({ status: 'matched', matched_on: 'invoice_number' })
    expect(result.invoice).toMatchObject({ supplier_name: 'Programvara AB', total: 10000 })
    expect(findCall('supplier_invoices', 'eq')).toEqual(['company_id', 'company-1'])
    expect(findCall('supplier_invoices', 'gt')).toEqual(['total', 0])
  })

  it('searches the company by the referenced number when the supplier is unknown', async () => {
    matchSupplierMock.mockResolvedValue(null)
    setTable('supplier_invoices', { data: [] })
    const result = await resolveInboxCreditTarget(supabase as unknown as SupabaseClient, 'company-1', {
      extracted_data: { invoice: { creditedInvoiceNumber: '10_234' }, totals: { total: -1 } },
    })
    expect(result.status).toBe('none')
    // LIKE wildcards in the number are escaped, never matched as patterns.
    expect(findCall('supplier_invoices', 'ilike')).toEqual(['supplier_invoice_number', '10\\_234'])
  })
})
