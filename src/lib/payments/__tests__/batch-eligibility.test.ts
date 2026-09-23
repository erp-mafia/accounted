import { describe, expect, it } from 'vitest'
import { luhnCheckDigit } from '@/lib/bankgiro/luhn'
import {
  evaluateInvoiceForBatch,
  PAYABLE_SUPPLIER_INVOICE_STATUSES,
  type BatchInvoiceFacts,
} from '@/lib/payments/batch-eligibility'

const VALID_OCR = `1234567${luhnCheckDigit('1234567')}`
const TODAY = '2026-08-10'

const supplier = {
  bankgiro: '5050-1055',
  plusgiro: null,
  bank_account: null,
  clearing_number: null,
  account_number: null,
  city: 'Stockholm',
}

function invoice(overrides: Partial<BatchInvoiceFacts> = {}): BatchInvoiceFacts {
  return {
    id: 'inv-1',
    status: 'approved',
    approved_at: '2026-08-01T10:00:00Z',
    due_date: '2026-08-20',
    remaining_amount: 737.5,
    currency: 'SEK',
    is_credit_note: false,
    payment_reference: VALID_OCR,
    supplier_invoice_number: 'CD3014794407',
    ...overrides,
  }
}

describe('evaluateInvoiceForBatch', () => {
  it('accepts every payable status and rejects the rest', () => {
    for (const status of PAYABLE_SUPPLIER_INVOICE_STATUSES) {
      const result = evaluateInvoiceForBatch(invoice({ status }), supplier, { today: TODAY })
      expect(result.eligible, status).toBe(true)
    }
    for (const status of ['paid', 'disputed', 'credited', 'reversed']) {
      const result = evaluateInvoiceForBatch(invoice({ status }), supplier, { today: TODAY })
      expect(result).toEqual({ eligible: false, reason: 'not_payable' })
    }
  })

  it('rejects credit notes before anything else', () => {
    const result = evaluateInvoiceForBatch(
      invoice({ is_credit_note: true, status: 'paid' }),
      supplier,
      { today: TODAY },
    )
    expect(result).toEqual({ eligible: false, reason: 'credit_note' })
  })

  it('rejects a settled remainder at the epsilon boundary', () => {
    const atEpsilon = evaluateInvoiceForBatch(invoice({ remaining_amount: 0.005 }), supplier, {
      today: TODAY,
    })
    expect(atEpsilon).toEqual({ eligible: false, reason: 'nothing_remaining' })

    const justAbove = evaluateInvoiceForBatch(invoice({ remaining_amount: 0.01 }), supplier, {
      today: TODAY,
    })
    expect(justAbove.eligible).toBe(true)
  })

  it('rejects foreign currency', () => {
    const result = evaluateInvoiceForBatch(invoice({ currency: 'EUR' }), supplier, { today: TODAY })
    expect(result).toEqual({ eligible: false, reason: 'foreign_currency' })
  })

  it('rejects a supplier without payment details', () => {
    const result = evaluateInvoiceForBatch(
      invoice(),
      { bankgiro: null, plusgiro: null, bank_account: null },
      { today: TODAY },
    )
    expect(result).toEqual({ eligible: false, reason: 'payee_missing' })
  })

  it('rejects a supplier with an invalid bankgiro', () => {
    const result = evaluateInvoiceForBatch(
      invoice(),
      { ...supplier, bankgiro: '1234-5678' },
      { today: TODAY },
    )
    expect(result).toEqual({ eligible: false, reason: 'payee_invalid' })
  })

  it('defaults the payment date to the due date when it is in the future', () => {
    const result = evaluateInvoiceForBatch(invoice({ due_date: '2026-08-20' }), supplier, {
      today: TODAY,
    })
    expect(result.eligible && result.defaults.payment_date).toBe('2026-08-20')
  })

  it('defaults the payment date to today when the due date has passed', () => {
    const result = evaluateInvoiceForBatch(
      invoice({ due_date: '2026-07-07', status: 'overdue' }),
      supplier,
      { today: TODAY },
    )
    expect(result.eligible && result.defaults.payment_date).toBe(TODAY)
  })

  it('defaults the amount to the rounded remaining amount', () => {
    const result = evaluateInvoiceForBatch(invoice({ remaining_amount: 199.291 }), supplier, {
      today: TODAY,
    })
    expect(result.eligible && result.defaults.amount).toBe(199.29)
  })

  it('warns on an un-attested invoice instead of blocking it', () => {
    const result = evaluateInvoiceForBatch(
      invoice({ status: 'registered', approved_at: null }),
      supplier,
      { today: TODAY },
    )
    expect(result.eligible && result.warnings).toContain('unattested')
  })

  it('warns when the invoice already sits in an active batch', () => {
    const result = evaluateInvoiceForBatch(invoice(), supplier, {
      today: TODAY,
      activeBatchIdByInvoice: new Map([['inv-1', 'batch-9']]),
    })
    expect(result.eligible && result.warnings).toContain('already_batched')
    expect(result.eligible && result.activeBatchId).toBe('batch-9')
  })

  it('warns on an invalid OCR and falls back to the invoice number', () => {
    const result = evaluateInvoiceForBatch(invoice({ payment_reference: '1234568' }), supplier, {
      today: TODAY,
    })
    expect(result.eligible && result.warnings).toContain('ocr_invalid')
    expect(result.eligible && result.reference).toEqual({
      type: 'invoice_number',
      value: 'CD3014794407',
    })
  })

  it('warns when the supplier has no town (Swedbank address rules)', () => {
    const result = evaluateInvoiceForBatch(invoice(), { ...supplier, city: null }, {
      today: TODAY,
    })
    expect(result.eligible && result.warnings).toContain('payee_city_missing')
  })

  it('carries a clean OCR through as the structured reference', () => {
    const result = evaluateInvoiceForBatch(invoice(), supplier, { today: TODAY })
    expect(result.eligible && result.reference).toEqual({ type: 'ocr', value: VALID_OCR })
    expect(result.eligible && result.warnings).toEqual([])
  })
})
