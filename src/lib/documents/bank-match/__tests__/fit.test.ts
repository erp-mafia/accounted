import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BankMatchFacts } from '../facts'

const mocks = vi.hoisted(() => ({ loadDocumentReading: vi.fn() }))
vi.mock('@/lib/documents/reading/load', () => ({ loadDocumentReading: mocks.loadDocumentReading }))

import {
  documentFitGate,
  documentRowMismatch,
  findDocumentRowMismatch,
  formatMismatchSv,
  isMismatchReason,
  type FitRow,
} from '../fit'

function facts(overrides: Partial<BankMatchFacts> = {}): BankMatchFacts {
  return {
    kind: 'supplier_invoice',
    direction: 'out',
    amount: 90,
    currency: 'EUR',
    reference: null,
    bankgiro: null,
    plusgiro: null,
    supplierBankgiro: null,
    supplierPlusgiro: null,
    issueDate: '2026-10-01',
    dueDate: '2026-10-01',
    names: ['Synthetic AI Ltd'],
    arrivedOn: '2026-10-26',
    ...overrides,
  }
}

const row = (overrides: Partial<FitRow> = {}): FitRow => ({
  amount: -202.78,
  currency: 'SEK',
  description: 'PODCASTTOOL',
  original_description: 'PODCASTTOOL',
  date: '2026-10-23',
  ...overrides,
})

describe('documentRowMismatch (crm#1479)', () => {
  it('flags a document from another seller asking for more than the row paid, converted through kronor', () => {
    // 90 EUR is about 1 030 kr: five times the 202.78 kr row, and the seller is not the one the bank names.
    expect(documentRowMismatch(facts(), row(), 1029.6)).toEqual({
      document_vendor: 'Synthetic AI Ltd',
      document_amount: 90,
      document_currency: 'EUR',
      document_amount_sek: 1029.6,
      transaction_text: 'PODCASTTOOL',
      transaction_amount: -202.78,
      transaction_currency: 'SEK',
    })
  })

  it('lets the same seller through even when the amount is larger: an invoice paid in parts', () => {
    expect(documentRowMismatch(facts(), row({ description: 'SYNTHETIC AI LTD', original_description: null }), 1029.6)).toBeNull()
  })

  it('lets a smaller document through whatever the seller: one row may carry several documents', () => {
    // Two 90 EUR invoices for one reimbursement of 2 059.64 kr.
    expect(documentRowMismatch(facts(), row({ amount: -2059.64, description: 'Utlägg', original_description: 'Utlägg' }), 1029.6)).toBeNull()
  })

  it('tolerates a card rate within the converted-amount tolerance', () => {
    expect(documentRowMismatch(facts({ amount: 108, currency: 'SEK' }), row({ amount: -100 }), 108)).toBeNull()
    expect(documentRowMismatch(facts({ amount: 110, currency: 'SEK' }), row({ amount: -100 }), 110)).not.toBeNull()
  })

  it('compares with the instructed amount when the row was paid in the document currency', () => {
    const paidInEur = row({ instructed_amount: 90, instructed_currency: 'EUR' })
    expect(documentRowMismatch(facts(), paidInEur, null)).toBeNull()
    expect(documentRowMismatch(facts({ amount: 180 }), paidInEur, null)).not.toBeNull()
  })

  it('has no verdict without a rate, a name, a row text or a reading', () => {
    expect(documentRowMismatch(facts(), row(), null)).toBeNull()
    expect(documentRowMismatch(facts({ names: [] }), row(), 1029.6)).toBeNull()
    expect(documentRowMismatch(facts(), row({ description: null, original_description: '  ', merchant_name: null }), 1029.6)).toBeNull()
    expect(documentRowMismatch(null, row(), 1029.6)).toBeNull()
  })

  it('names both sides in Swedish', () => {
    const mismatch = documentRowMismatch(facts(), row(), 1029.6)
    expect(mismatch).not.toBeNull()
    const text = formatMismatchSv(mismatch!)
    expect(text).toContain('Synthetic AI Ltd')
    expect(text).toContain('PODCASTTOOL')
    expect(text).not.toMatch(/[–—]/)
  })

  it('takes a reason of a few words, never a bare flag', () => {
    expect(isMismatchReason('Invoice paid in two parts')).toBe(true)
    expect(isMismatchReason('  ')).toBe(false)
    expect(isMismatchReason(true)).toBe(false)
  })
})

describe('findDocumentRowMismatch', () => {
  const reading = {
    fields: {
      document_type: { value: 'supplier_invoice' },
      amount_due_for_payment: { value: 90 },
      invoice_currency_code: { value: 'EUR' },
      seller_name: { value: 'Synthetic AI Ltd' },
      invoice_issue_date: { value: '2026-10-01' },
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads the document, converts at the rate for its date and decides', async () => {
    mocks.loadDocumentReading.mockResolvedValue(reading)
    const rateFor = vi.fn().mockResolvedValue(11.44)

    const mismatch = await findDocumentRowMismatch({} as never, 'company-1', 'doc-1', row(), { rateFor })

    expect(mocks.loadDocumentReading).toHaveBeenCalledWith({}, 'company-1', { documentId: 'doc-1' })
    expect(rateFor).toHaveBeenCalledWith('EUR', '2026-10-01')
    expect(mismatch).toMatchObject({ document_amount_sek: 1029.6, transaction_text: 'PODCASTTOOL' })
  })

  it('never throws: a reading that fails is no verdict', async () => {
    mocks.loadDocumentReading.mockRejectedValue(new Error('read failed'))
    await expect(findDocumentRowMismatch({} as never, 'company-1', 'doc-1', row(), { rateFor: vi.fn() })).resolves.toBeNull()
  })

  it('has no verdict for a document the bank does not pay (no invoice, receipt or credit note)', async () => {
    mocks.loadDocumentReading.mockResolvedValue({ fields: { ...reading.fields, document_type: { value: 'other' } } })
    const rateFor = vi.fn()
    await expect(findDocumentRowMismatch({} as never, 'company-1', 'doc-1', row(), { rateFor })).resolves.toBeNull()
    expect(rateFor).not.toHaveBeenCalled()
  })
})

describe('documentFitGate', () => {
  const reading = {
    fields: {
      document_type: { value: 'supplier_invoice' },
      amount_due_for_payment: { value: 90 },
      invoice_currency_code: { value: 'EUR' },
      seller_name: { value: 'Synthetic AI Ltd' },
      invoice_issue_date: { value: '2026-10-01' },
    },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.loadDocumentReading.mockResolvedValue(reading)
  })

  it('refuses a mismatch with no stated reason, naming both sides', async () => {
    const gate = documentFitGate({} as never, 'company-1', undefined, { rateFor: async () => 11.44 })
    await expect(gate('doc-1', row())).resolves.toMatchObject({
      code: 'DOC_ROW_MISMATCH',
      details: { document_vendor: 'Synthetic AI Ltd', transaction_text: 'PODCASTTOOL' },
      messageSv: expect.stringContaining('Synthetic AI Ltd'),
    })
  })

  it('lets a mismatch through with a stated reason, and a fitting document without one', async () => {
    const withReason = documentFitGate({} as never, 'company-1', 'Invoice paid in two parts', { rateFor: async () => 11.44 })
    await expect(withReason('doc-1', row())).resolves.toBeNull()
    const fitting = documentFitGate({} as never, 'company-1', undefined, { rateFor: async () => 11.44 })
    await expect(fitting('doc-1', row({ amount: -2059.64, description: 'Utlägg', original_description: null }))).resolves.toBeNull()
  })
})
