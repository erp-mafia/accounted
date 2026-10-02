import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { CreateJournalEntryInput, Invoice, InvoiceItem } from '@/types'

/**
 * Skattereduktion för grön teknik books through the same fakturamodell as
 * ROT/RUT (crm#209, #3135): the reduction is a receivable on Skatteverket
 * (BAS 1513, swedish-invoice-compliance section 8), revenue and utgående moms
 * stay on the full amount, and the customer owes the rest on 1510.
 *
 * Worked example: labour 20 000 + material 60 000 kr exkl. moms, solceller,
 * 25 % moms = 100 000 kr inkl. moms, 15 % = 15 000 kr. Travel 1 000 + 250 kr
 * moms on an unflagged row. Total 101 250: debit 1510 86 250, debit 1513
 * 15 000, credit 3001 81 000, credit 2611 20 250.
 */

vi.mock('../engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  getSwedishLocalDate: vi.fn().mockReturnValue('2026-09-30'),
  createJournalEntry: vi.fn().mockImplementation(
    async (_supabase: unknown, _companyId: string, _userId: string, input: CreateJournalEntryInput) => ({
      id: 'entry-1',
      ...input,
      lines: input.lines,
    }),
  ),
}))

vi.mock('../vat-entries', () => ({
  generateSalesVatLines: vi.fn().mockImplementation(({ baseAmount }: { baseAmount: number }) => [
    {
      account_number: '2611',
      debit_amount: 0,
      credit_amount: Math.round(baseAmount * 0.25 * 100) / 100,
      line_description: 'Utgående moms',
    },
  ]),
}))

const { createJournalEntry } = await import('../engine')
const mockedCreateEntry = vi.mocked(createJournalEntry)
const { createInvoiceJournalEntry, createCreditNoteJournalEntry, createInvoiceCashEntry } = await import('../invoice-entries')
const { proposeSendLines } = await import('../propose-send-lines')
const { proposePaymentLines } = await import('../propose-payment-lines')
const { createRotRutPayoutEntry, createRotRutReclaimEntry } = await import('../rot-rut-entries')

function item(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-labour',
    invoice_id: 'inv-1',
    sort_order: 0,
    line_type: 'product',
    description: 'Montage',
    quantity: 1,
    unit: 'st',
    unit_price: 20000,
    line_total: 20000,
    vat_rate: 25,
    vat_amount: 5000,
    deduction_type: 'gron_teknik',
    deduction_amount: 3750,
    labor_hours: 24,
    work_type: 'INSTALLATION_SOLCELLER',
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  }
}

function items(sign = 1): InvoiceItem[] {
  return [
    item({ quantity: sign, line_total: sign * 20000, vat_amount: sign * 5000 }),
    item({
      id: 'item-material',
      sort_order: 1,
      description: 'Solpaneler och växelriktare',
      quantity: sign,
      unit_price: 60000,
      line_total: sign * 60000,
      vat_amount: sign * 15000,
      deduction_amount: 11250,
      labor_hours: null,
    }),
    item({
      id: 'item-travel',
      sort_order: 2,
      description: 'Resa',
      quantity: sign,
      unit_price: 1000,
      line_total: sign * 1000,
      vat_amount: sign * 250,
      deduction_type: null,
      deduction_amount: 0,
      labor_hours: null,
      work_type: null,
    }),
  ]
}

function invoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: 'inv-1',
    user_id: 'user-1',
    customer_id: 'cust-1',
    invoice_number: '1001',
    invoice_date: '2026-09-15',
    due_date: '2026-10-15',
    currency: 'SEK',
    exchange_rate: null,
    exchange_rate_date: null,
    subtotal: 81000,
    subtotal_sek: 81000,
    vat_amount: 20250,
    vat_amount_sek: 20250,
    total: 101250,
    total_sek: 101250,
    vat_treatment: 'standard_25',
    vat_rate: 25,
    moms_ruta: '05',
    reverse_charge_text: null,
    your_reference: null,
    our_reference: null,
    notes: null,
    status: 'sent',
    sent_at: null,
    paid_at: null,
    payment_date: null,
    credited_invoice_id: null,
    journal_entry_id: null,
    payment_journal_entry_id: null,
    document_type: 'invoice',
    deduction_total: 15000,
    created_at: '2026-09-15T00:00:00Z',
    updated_at: '2026-09-15T00:00:00Z',
    items: items(),
    ...overrides,
  } as Invoice
}

const byAccount = (input: CreateJournalEntryInput, account: string) =>
  input.lines.filter((line) => line.account_number === account)
const sum = (lines: CreateJournalEntryInput['lines'], side: 'debit_amount' | 'credit_amount') =>
  Math.round(lines.reduce((total, line) => total + line[side], 0) * 100) / 100

beforeEach(() => {
  vi.clearAllMocks()
})

describe('createInvoiceJournalEntry: grön teknik', () => {
  it('books 1513 per flagged line at 15 %, 1510 for the rest, revenue and moms on the full amount', async () => {
    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice())
    const input = mockedCreateEntry.mock.calls[0][3]

    const lines1513 = byAccount(input, '1513')
    expect(lines1513.map((line) => line.debit_amount)).toEqual([3750, 11250])
    expect(lines1513.every((line) => line.line_description === 'Skattereduktion grön teknik faktura 1001')).toBe(true)
    expect(sum(byAccount(input, '1510'), 'debit_amount')).toBe(86250)
    expect(sum(byAccount(input, '3001'), 'credit_amount')).toBe(81000)
    expect(sum(byAccount(input, '2611'), 'credit_amount')).toBe(20250)
    expect(sum(input.lines, 'debit_amount')).toBe(sum(input.lines, 'credit_amount'))
    expect(sum(input.lines, 'debit_amount')).toBe(101250)
  })

  it('takes 50 % for laddpunkt and lagring from the installation type', async () => {
    await createInvoiceJournalEntry(
      null as never,
      'company-1',
      'user-1',
      invoice({
        subtotal: 16000,
        vat_amount: 4000,
        total: 20000,
        deduction_total: 10000,
        items: [item({ unit_price: 16000, line_total: 16000, vat_amount: 4000, work_type: 'INSTALLATION_LADDPUNKT' })],
      }),
    )
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(sum(byAccount(input, '1513'), 'debit_amount')).toBe(10000)
    expect(sum(byAccount(input, '1510'), 'debit_amount')).toBe(10000)
  })

  it('a credit note reverses the same 1513 amount', async () => {
    await createCreditNoteJournalEntry(
      null as never,
      'company-1',
      'user-1',
      invoice({
        invoice_number: 'KR-1002',
        credited_invoice_id: 'inv-1',
        subtotal: -81000,
        vat_amount: -20250,
        total: -101250,
        total_sek: -101250,
        subtotal_sek: -81000,
        vat_amount_sek: -20250,
        items: items(-1),
      }),
    )
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(sum(byAccount(input, '1513'), 'credit_amount')).toBe(15000)
    expect(byAccount(input, '1513')[0].line_description).toBe('Skattereduktion grön teknik kreditfaktura KR-1002')
    expect(sum(byAccount(input, '1510'), 'credit_amount')).toBe(86250)
    expect(sum(input.lines, 'debit_amount')).toBe(sum(input.lines, 'credit_amount'))
  })

  it('kontantmetoden: the bank gets the customer share, 1513 the reduction', async () => {
    await createInvoiceCashEntry(null as never, 'company-1', 'user-1', invoice(), '2026-09-20')
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(sum(byAccount(input, '1930'), 'debit_amount')).toBe(86250)
    expect(sum(byAccount(input, '1513'), 'debit_amount')).toBe(15000)
    expect(sum(byAccount(input, '3001'), 'credit_amount')).toBe(81000)
    expect(sum(input.lines, 'debit_amount')).toBe(sum(input.lines, 'credit_amount'))
  })
})

describe('proposals: grön teknik', () => {
  it('the send preview splits the receivable the same way and names grön teknik', () => {
    const lines = proposeSendLines({
      invoice: {
        id: 'invoice-1',
        invoice_number: '1001',
        total: 101250,
        total_sek: null,
        subtotal: 81000,
        subtotal_sek: null,
        vat_amount: 20250,
        vat_amount_sek: null,
        currency: 'SEK',
        exchange_rate: null,
        vat_treatment: 'standard_25',
        items: items(),
      },
      entityType: 'aktiebolag',
    })
    const lines1513 = lines.filter((line) => line.account_number === '1513')
    expect(lines1513.map((line) => line.debit_amount)).toEqual(['3750', '11250'])
    expect(lines1513[0].line_description).toBe('Skattereduktion grön teknik faktura 1001')
    expect(lines.find((line) => line.account_number === '1510')?.debit_amount).toBe('86250')
  })

  it('the cash-method payment preview names grön teknik on its 1513 legs', () => {
    const lines = proposePaymentLines({
      invoice: {
        id: 'invoice-1',
        invoice_number: '1001',
        total: 101250,
        total_sek: null,
        subtotal: 81000,
        subtotal_sek: null,
        vat_amount: 20250,
        vat_amount_sek: null,
        currency: 'SEK',
        exchange_rate: null,
        vat_treatment: 'standard_25',
        items: items(),
        deduction_total: 15000,
      },
      accountingMethod: 'cash',
      entityType: 'aktiebolag',
    })
    expect(lines.find((line) => line.account_number === '1930')?.debit_amount).toBe('86250')
    // One 1513 leg per item, as createInvoiceCashEntry books it.
    const legs1513 = lines.filter((line) => line.account_number === '1513')
    expect(legs1513.map((line) => line.debit_amount)).toEqual(['3750', '11250'])
    for (const leg of legs1513) {
      expect(leg.line_description).toBe('Skattereduktion grön teknik faktura 1001')
    }
  })

  it('a ROT invoice names ROT on its cash-method 1513 leg, as createInvoiceCashEntry books it', () => {
    const lines = proposePaymentLines({
      invoice: {
        id: 'invoice-1',
        invoice_number: '1001',
        total: 12500,
        total_sek: null,
        subtotal: 10000,
        subtotal_sek: null,
        vat_amount: 2500,
        vat_amount_sek: null,
        currency: 'SEK',
        exchange_rate: null,
        vat_treatment: 'standard_25',
        items: [item({ unit_price: 10000, line_total: 10000, vat_amount: 2500, deduction_type: 'rot', work_type: 'EL' })],
        deduction_total: 3750,
      },
      accountingMethod: 'cash',
      entityType: 'aktiebolag',
    })
    expect(lines.find((line) => line.account_number === '1513')?.line_description).toBe('ROT-avdrag faktura 1001')
  })
})

describe('payout and reclaim vouchers name grön teknik', () => {
  it('the payout voucher text', async () => {
    await createRotRutPayoutEntry(null as never, 'company-1', 'user-1', {
      requestId: 'req-1',
      requestName: 'GT 2026-10',
      deductionType: 'gron_teknik',
      paymentDate: '2026-10-10',
      amount: 15000,
      oreRounding: 0.4,
    })
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Utbetalning skattereduktion grön teknik från Skatteverket (GT 2026-10)')
    expect(byAccount(input, '3740')[0].line_description).toBe('Öresavrundning skattereduktion grön teknik (GT 2026-10)')
    expect(sum(byAccount(input, '1513'), 'credit_amount')).toBe(15000.4)
  })

  it('the ROT payout voucher text is unchanged', async () => {
    await createRotRutPayoutEntry(null as never, 'company-1', 'user-1', {
      requestId: 'req-1',
      requestName: 'ROT 2026-07',
      deductionType: 'rot',
      paymentDate: '2026-07-10',
      amount: 3000,
    })
    expect(mockedCreateEntry.mock.calls[0][3].description).toBe('Utbetalning ROT-avdrag från Skatteverket (ROT 2026-07)')
  })

  it('the reclaim voucher text', async () => {
    await createRotRutReclaimEntry(null as never, 'company-1', 'user-1', {
      requestId: 'req-1',
      requestName: 'GT 2026-10',
      deductionType: 'gron_teknik',
      bookingDate: '2026-10-20',
      legs: [{ invoiceId: 'inv-1', invoiceNumber: '1001', amount: 2500 }],
    })
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Nekad skattereduktion grön teknik från Skatteverket (GT 2026-10)')
    expect(input.lines.map((line) => [line.account_number, line.debit_amount, line.credit_amount, line.line_description])).toEqual([
      ['1510', 2500, 0, 'Nekad skattereduktion grön teknik faktura 1001'],
      ['1513', 0, 2500, 'Nekad skattereduktion grön teknik faktura 1001'],
    ])
  })

  it('the RUT reclaim voucher text is unchanged', async () => {
    await createRotRutReclaimEntry(null as never, 'company-1', 'user-1', {
      requestId: 'req-1',
      requestName: 'RUT 2026-07',
      deductionType: 'rut',
      bookingDate: '2026-07-20',
      legs: [{ invoiceId: 'inv-1', invoiceNumber: '7', amount: 100 }],
    })
    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Nekat RUT-avdrag från Skatteverket (RUT 2026-07)')
    expect(input.lines[0].line_description).toBe('Nekat RUT-avdrag faktura 7')
  })
})
