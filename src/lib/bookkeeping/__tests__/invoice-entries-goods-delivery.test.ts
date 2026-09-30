/**
 * Goods delivered abroad (#2906): an invoice that stated a delivery_country
 * under an export / reverse_charge header books the goods revenue accounts,
 * which is what puts the sale in the right momsdeklaration box: 3105 (ruta 36)
 * instead of 3305 (ruta 40), 3108 (ruta 35, periodisk sammanställning goods)
 * instead of 3308 (ruta 39). Every invoice without it books as before.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getRevenueAccount } from '../invoice-entries'
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
    description: 'Pallställ',
    quantity: 2,
    unit: 'st',
    unit_price: 5000,
    line_total: 10000,
    vat_rate: 0,
    vat_amount: 0,
    created_at: '2026-09-27T00:00:00Z',
    ...overrides,
  }
}

function makeInvoice(overrides: Partial<Invoice>): Invoice {
  return {
    id: 'inv-1',
    user_id: 'user-1',
    customer_id: 'cust-1',
    invoice_number: '1001',
    invoice_date: '2026-09-27',
    due_date: '2026-10-27',
    currency: 'SEK',
    exchange_rate: null,
    exchange_rate_date: null,
    subtotal: 10000,
    subtotal_sek: 10000,
    vat_amount: 0,
    vat_amount_sek: 0,
    total: 10000,
    total_sek: 10000,
    vat_treatment: 'export',
    vat_rate: 0,
    moms_ruta: '36',
    reverse_charge_text: null,
    your_reference: null,
    our_reference: null,
    notes: null,
    status: 'sent',
    credited_invoice_id: null,
    document_type: 'invoice',
    created_at: '2026-09-27T00:00:00Z',
    updated_at: '2026-09-27T00:00:00Z',
    items: [makeItem()],
    ...overrides,
  } as Invoice
}

function revenueAccounts(input: CreateJournalEntryInput): string[] {
  return input.lines.filter((l) => l.account_number.startsWith('3')).map((l) => l.account_number)
}

function expectBalanced(input: CreateJournalEntryInput) {
  const debit = input.lines.reduce((s, l) => s + l.debit_amount, 0)
  const credit = input.lines.reduce((s, l) => s + l.credit_amount, 0)
  expect(Math.round(debit * 100) / 100).toBe(Math.round(credit * 100) / 100)
  expect(debit).toBeGreaterThan(0)
}

describe('getRevenueAccount with a goods delivery abroad', () => {
  it('books goods on 3105 / 3108 and services on 3305 / 3308', () => {
    expect(getRevenueAccount('export', 'aktiebolag', 'NO')).toBe('3105')
    expect(getRevenueAccount('reverse_charge', 'aktiebolag', 'DE')).toBe('3108')
    expect(getRevenueAccount('export', 'aktiebolag', null)).toBe('3305')
    expect(getRevenueAccount('reverse_charge', 'aktiebolag')).toBe('3308')
  })

  it('does not touch the domestic treatments', () => {
    expect(getRevenueAccount('standard_25', 'aktiebolag', 'NO')).toBe('3001')
    expect(getRevenueAccount('exempt', 'aktiebolag', 'NO')).toBe('3004')
  })

  it('lands each account in the box the invoice header names', () => {
    expect(ACCOUNT_RUTA[getRevenueAccount('export', 'aktiebolag', 'NO')].box).toBe('ruta36')
    expect(ACCOUNT_RUTA[getRevenueAccount('reverse_charge', 'aktiebolag', 'DE')].box).toBe('ruta35')
  })
})

describe('the verifikat of an invoice with a goods delivery abroad', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('export of goods: Debit 1510 / Credit 3105, no output VAT', async () => {
    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', makeInvoice({ delivery_country: 'NO' }), 'aktiebolag')
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(revenueAccounts(input)).toEqual(['3105'])
    expect(input.lines.find((l) => l.account_number === '3105')?.credit_amount).toBe(10000)
    expect(input.lines.find((l) => l.account_number === '1510')?.debit_amount).toBe(10000)
    expect(input.lines.some((l) => l.account_number.startsWith('26'))).toBe(false)
    expectBalanced(input)
  })

  it('intra-EU supply of goods: Credit 3108', async () => {
    await createInvoiceJournalEntry(
      null as never,
      'company-1',
      'user-1',
      makeInvoice({ vat_treatment: 'reverse_charge', moms_ruta: '35', delivery_country: 'DE' }),
      'aktiebolag',
    )
    expect(revenueAccounts(mockedCreateEntry.mock.calls[0][3])).toEqual(['3108'])
  })

  it('without a delivery country books the services accounts exactly as before', async () => {
    // Includes the legacy rows that carry moms_ruta 36 but were always booked on 3305.
    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', makeInvoice({ delivery_country: null }), 'aktiebolag')
    await createInvoiceJournalEntry(
      null as never,
      'company-1',
      'user-1',
      makeInvoice({ vat_treatment: 'reverse_charge', moms_ruta: '39' }),
      'aktiebolag',
    )
    expect(revenueAccounts(mockedCreateEntry.mock.calls[0][3])).toEqual(['3305'])
    expect(revenueAccounts(mockedCreateEntry.mock.calls[1][3])).toEqual(['3308'])
  })

  it('a Swedish header ignores a stored delivery country (standard stated for goods shipped abroad)', async () => {
    await createInvoiceJournalEntry(
      null as never,
      'company-1',
      'user-1',
      makeInvoice({
        vat_treatment: 'standard_25',
        moms_ruta: '05',
        delivery_country: 'NO',
        vat_amount: 2500,
        vat_amount_sek: 2500,
        total: 12500,
        total_sek: 12500,
        items: [makeItem({ vat_rate: 25, vat_amount: 2500 })],
      }),
      'aktiebolag',
    )
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(revenueAccounts(input)).toEqual(['3001'])
    expect(input.lines.find((l) => l.account_number === '2611')?.credit_amount).toBe(2500)
    expectBalanced(input)
  })

  it('the header-only fallback (no items) takes the goods account too', async () => {
    await createInvoiceJournalEntry(
      null as never,
      'company-1',
      'user-1',
      makeInvoice({ delivery_country: 'NO', items: [] }),
      'aktiebolag',
    )
    expect(revenueAccounts(mockedCreateEntry.mock.calls[0][3])).toEqual(['3105'])
  })

  it('the credit note reverses the goods account (delivery_country is copied from the original)', async () => {
    const creditNote = makeInvoice({
      id: 'cn-1',
      invoice_number: 'KR-1001',
      credited_invoice_id: 'inv-1',
      subtotal: -10000,
      subtotal_sek: -10000,
      total: -10000,
      total_sek: -10000,
      delivery_country: 'NO',
      items: [makeItem({ unit_price: -5000, line_total: -10000 })],
    })
    await createCreditNoteJournalEntry(null as never, 'company-1', 'user-1', creditNote, 'aktiebolag')
    const input = mockedCreateEntry.mock.calls[0][3]
    const revenue = input.lines.find((l) => l.account_number === '3105')
    expect(revenue?.debit_amount).toBe(10000)
    expect(input.lines.find((l) => l.account_number === '1510')?.credit_amount).toBe(10000)
    expectBalanced(input)
  })

  it('kontantmetoden recognises the goods export on 3105 at payment', async () => {
    await createInvoiceCashEntry(
      null as never,
      'company-1',
      'user-1',
      makeInvoice({ delivery_country: 'NO' }),
      '2026-10-15',
      'aktiebolag',
    )
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(revenueAccounts(input)).toEqual(['3105'])
    expectBalanced(input)
  })
})
