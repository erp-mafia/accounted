/**
 * Domestic reverse charge for construction services (crm#1007, ML 16 kap.
 * 13 §): the seller books the sale on 3231 with no output VAT, and 3231 is
 * what puts it in ruta 41 of the momsdeklaration. Every booking path of a
 * customer invoice (registration, credit note, kontantmetoden payment,
 * header-only fallback) must agree, and a per-line account override must
 * not move the sale out of ruta 41.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getRevenueAccount } from '../invoice-entries'
import { generatePerRateLines } from '../invoice-lines'
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
    description: 'Snickeriarbete, kök',
    quantity: 10,
    unit: 'tim',
    unit_price: 800,
    line_total: 8000,
    vat_rate: 0,
    vat_amount: 0,
    created_at: '2026-10-05T00:00:00Z',
    ...overrides,
  }
}

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    user_id: 'user-1',
    customer_id: 'cust-1',
    invoice_number: '1001',
    invoice_date: '2026-10-05',
    due_date: '2026-11-04',
    currency: 'SEK',
    exchange_rate: null,
    exchange_rate_date: null,
    subtotal: 8000,
    subtotal_sek: 8000,
    vat_amount: 0,
    vat_amount_sek: 0,
    total: 8000,
    total_sek: 8000,
    vat_treatment: 'reverse_charge_domestic',
    vat_rate: 0,
    moms_ruta: '41',
    reverse_charge_text: 'Omvänd betalningsskyldighet, byggtjänster, ML 16 kap. 13 §',
    vat_treatment_override: 'reverse_charge_domestic',
    delivery_country: null,
    your_reference: null,
    our_reference: null,
    notes: null,
    status: 'sent',
    credited_invoice_id: null,
    document_type: 'invoice',
    created_at: '2026-10-05T00:00:00Z',
    updated_at: '2026-10-05T00:00:00Z',
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

describe('getRevenueAccount for domestic reverse charge', () => {
  it('books 3231 for every legal form, and 3231 is ruta 41', () => {
    for (const entityType of ['aktiebolag', 'enskild_firma', 'ideell_forening', 'ekonomisk_forening'] as const) {
      expect(getRevenueAccount('reverse_charge_domestic', entityType)).toBe('3231')
    }
    expect(ACCOUNT_RUTA['3231'].box).toBe('ruta41')
  })
})

describe('the verifikat of a domestic reverse charge invoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('Debit 1510 / Credit 3231, no output VAT', async () => {
    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', makeInvoice(), 'aktiebolag')
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(revenueAccounts(input)).toEqual(['3231'])
    expect(input.lines.find((l) => l.account_number === '3231')?.credit_amount).toBe(8000)
    expect(input.lines.find((l) => l.account_number === '1510')?.debit_amount).toBe(8000)
    expect(input.lines.some((l) => l.account_number.startsWith('26'))).toBe(false)
    expectBalanced(input)
  })

  it('a per-line account override does not move the sale out of ruta 41', async () => {
    await createInvoiceJournalEntry(
      null as never,
      'company-1',
      'user-1',
      makeInvoice({ items: [makeItem({ revenue_account: '3011' })] }),
      'aktiebolag',
    )
    expect(revenueAccounts(mockedCreateEntry.mock.calls[0][3])).toEqual(['3231'])
  })

  it('the header-only fallback (no items) books 3231 too', async () => {
    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', makeInvoice({ items: [] }), 'aktiebolag')
    expect(revenueAccounts(mockedCreateEntry.mock.calls[0][3])).toEqual(['3231'])
  })

  it('the credit note reverses 3231', async () => {
    const creditNote = makeInvoice({
      id: 'cn-1',
      invoice_number: 'KR-1001',
      credited_invoice_id: 'inv-1',
      subtotal: -8000,
      subtotal_sek: -8000,
      total: -8000,
      total_sek: -8000,
      items: [makeItem({ unit_price: -800, line_total: -8000 })],
    })
    await createCreditNoteJournalEntry(null as never, 'company-1', 'user-1', creditNote, 'aktiebolag')
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines.find((l) => l.account_number === '3231')?.debit_amount).toBe(8000)
    expect(input.lines.find((l) => l.account_number === '1510')?.credit_amount).toBe(8000)
    expect(input.lines.some((l) => l.account_number.startsWith('26'))).toBe(false)
    expectBalanced(input)
  })

  it('kontantmetoden recognises the sale on 3231 at payment', async () => {
    await createInvoiceCashEntry(null as never, 'company-1', 'user-1', makeInvoice(), '2026-10-20', 'enskild_firma', undefined, '1930')
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(revenueAccounts(input)).toEqual(['3231'])
    expect(input.lines.some((l) => l.account_number.startsWith('26'))).toBe(false)
    expectBalanced(input)
  })
})

describe('periodisering never defers a domestic reverse charge line', () => {
  it('books 3231, not the 29xx interim account, even when the line carries a period', () => {
    const lines = generatePerRateLines(
      [makeItem({ accrual_period_start: '2026-10-01', accrual_period_end: '2027-03-31' } as Partial<InvoiceItem>)],
      'reverse_charge_domestic',
      'aktiebolag',
      '1001',
      'SEK',
      null,
      { deferAccruals: true },
    )
    expect(lines.map((l) => l.account_number)).toEqual(['3231'])
  })
})
