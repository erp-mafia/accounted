/**
 * A räntefaktura (vat_treatment outside_scope): dröjsmålsränta is no supply,
 * so it books on its own interest-income account (8313) with no output VAT,
 * and 8313 is no ruta of the momsdeklaration. Every booking path of a
 * customer invoice (registration, credit note, kontantmetoden payment,
 * header-only fallback) must agree.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ACCOUNT_RUTA } from '@/lib/reports/vat-declaration'
import type { Invoice, InvoiceItem, CreateJournalEntryInput } from '@/types'

vi.mock('../engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: vi.fn().mockImplementation(
    async (_supabase: unknown, _companyId: string, _userId: string, input: CreateJournalEntryInput) => ({
      id: 'entry-1',
      ...input,
      lines: input.lines,
    }),
  ),
}))

const { createJournalEntry } = await import('../engine')
const mockedCreateEntry = vi.mocked(createJournalEntry)
const { createInvoiceJournalEntry, createCreditNoteJournalEntry, createInvoiceCashEntry } = await import(
  '../invoice-entries'
)

function makeItem(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'inv-1',
    sort_order: 0,
    description: 'Dröjsmålsränta faktura 1042',
    quantity: 1,
    unit: 'st',
    unit_price: 68.49,
    line_total: 68.49,
    vat_rate: 0,
    vat_amount: 0,
    revenue_account: '8313',
    created_at: '2026-11-27T00:00:00Z',
    ...overrides,
  }
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    user_id: 'user-1',
    customer_id: 'cust-1',
    invoice_number: '1060',
    invoice_date: '2026-11-27',
    due_date: '2026-12-27',
    currency: 'SEK',
    exchange_rate: null,
    exchange_rate_date: null,
    subtotal: 68.49,
    subtotal_sek: 68.49,
    vat_amount: 0,
    vat_amount_sek: 0,
    total: 68.49,
    total_sek: 68.49,
    vat_treatment: 'outside_scope',
    vat_rate: 0,
    moms_ruta: null,
    reverse_charge_text: 'Utanför svensk mervärdesskatt: ingen omsättning i Sverige',
    vat_treatment_override: 'outside_scope',
    delivery_country: null,
    is_late_interest_invoice: true,
    your_reference: null,
    our_reference: null,
    notes: null,
    status: 'sent',
    credited_invoice_id: null,
    document_type: 'invoice',
    created_at: '2026-11-27T00:00:00Z',
    updated_at: '2026-11-27T00:00:00Z',
    items: [makeItem()],
    ...overrides,
  } as Invoice
}

function expectInterestOnly(input: CreateJournalEntryInput, side: 'credit' | 'debit') {
  const interest = input.lines.filter((l) => l.account_number === '8313')
  expect(interest).toHaveLength(1)
  expect(side === 'credit' ? interest[0].credit_amount : interest[0].debit_amount).toBe(68.49)
  expect(input.lines.some((l) => l.account_number.startsWith('26'))).toBe(false)
  expect(input.lines.some((l) => /^3\d{3}$/.test(l.account_number))).toBe(false)
  const debit = input.lines.reduce((s, l) => s + l.debit_amount, 0)
  const credit = input.lines.reduce((s, l) => s + l.credit_amount, 0)
  expect(Math.round(debit * 100)).toBe(Math.round(credit * 100))
}

describe('the verifikat of a räntefaktura', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('8313 is no ruta of the momsdeklaration', () => {
    expect(ACCOUNT_RUTA['8313']).toBeUndefined()
  })

  it('Debit 1510 / Credit 8313, no output VAT, described as dröjsmålsränta', async () => {
    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', makeInvoice(), 'aktiebolag')
    const input = mockedCreateEntry.mock.calls[0][3]
    expectInterestOnly(input, 'credit')
    expect(input.lines.find((l) => l.account_number === '1510')?.debit_amount).toBe(68.49)
    expect(input.lines.find((l) => l.account_number === '8313')?.line_description).toBe('Dröjsmålsränta faktura 1060')
  })

  it('the header-only fallback (no items) books 8313 too', async () => {
    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', makeInvoice({ items: [] }), 'aktiebolag')
    expectInterestOnly(mockedCreateEntry.mock.calls[0][3], 'credit')
  })

  it('the credit note reverses 8313', async () => {
    const creditNote = makeInvoice({
      id: 'cn-1',
      invoice_number: 'KR-1060',
      credited_invoice_id: 'inv-1',
      subtotal: -68.49,
      subtotal_sek: -68.49,
      total: -68.49,
      total_sek: -68.49,
      items: [makeItem({ unit_price: -68.49, line_total: -68.49 })],
    })
    await createCreditNoteJournalEntry(null as never, 'company-1', 'user-1', creditNote, 'aktiebolag')
    const input = mockedCreateEntry.mock.calls[0][3]
    expectInterestOnly(input, 'debit')
    expect(input.lines.find((l) => l.account_number === '1510')?.credit_amount).toBe(68.49)
  })

  it('kontantmetoden recognises the interest on 8313 at payment', async () => {
    await createInvoiceCashEntry(null as never, 'company-1', 'user-1', makeInvoice(), '2026-12-20', 'enskild_firma', undefined, '1930')
    const input = mockedCreateEntry.mock.calls[0][3]
    expectInterestOnly(input, 'credit')
    expect(input.lines.find((l) => l.account_number === '1930')?.debit_amount).toBe(68.49)
  })
})
