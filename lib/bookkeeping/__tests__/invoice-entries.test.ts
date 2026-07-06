import { describe, it, expect, vi, beforeEach } from 'vitest'
import { getRevenueAccount, getOutputVatAccount } from '../invoice-entries'
import { roundOre } from '@/lib/money'
import type { Invoice, InvoiceItem, CreateJournalEntryInput } from '@/types'

// Mock the engine so we can capture the input passed to createJournalEntry
vi.mock('../engine', () => ({
  findFiscalPeriod: vi.fn().mockResolvedValue('period-1'),
  createJournalEntry: vi.fn().mockImplementation(
    async (_supabase: unknown, _companyId: string, _userId: string, input: CreateJournalEntryInput) => ({
      id: 'entry-1',
      ...input,
      lines: input.lines,
    })
  ),
}))

// Mock vat-entries to avoid indirect dependency issues
vi.mock('../vat-entries', () => ({
  generateSalesVatLines: vi.fn().mockImplementation(({ vatTreatment, baseAmount }: { vatTreatment: string; baseAmount: number }) => {
    const rate = vatTreatment === 'standard_25' ? 0.25
      : vatTreatment === 'reduced_12' ? 0.12
      : vatTreatment === 'reduced_6' ? 0.06 : 0
    if (rate === 0) return []
    const account = vatTreatment === 'standard_25' ? '2611'
      : vatTreatment === 'reduced_12' ? '2621' : '2631'
    return [{
      account_number: account,
      debit_amount: 0,
      credit_amount: Math.round(baseAmount * rate * 100) / 100,
      line_description: `Utgående moms`,
    }]
  }),
  generateReverseChargeLines: vi.fn().mockReturnValue([]),
}))

const { createJournalEntry } = await import('../engine')
const mockedCreateEntry = vi.mocked(createJournalEntry)

// Import functions under test AFTER mocks are set up
const {
  createInvoiceJournalEntry,
  createInvoicePaymentJournalEntry,
  createCreditNoteJournalEntry,
  createInvoiceCashEntry,
} = await import('../invoice-entries')

// Helper to build a minimal Invoice with items
function makeInvoice(overrides: Partial<Invoice> & { items?: InvoiceItem[] }): Invoice {
  return {
    id: 'inv-1',
    user_id: 'user-1',
    customer_id: 'cust-1',
    invoice_number: '1001',
    invoice_date: '2024-06-15',
    due_date: '2024-07-15',
    currency: 'SEK',
    exchange_rate: null,
    exchange_rate_date: null,
    subtotal: 1000,
    subtotal_sek: null,
    vat_amount: 250,
    vat_amount_sek: null,
    total: 1250,
    total_sek: null,
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
    created_at: '2024-06-15T00:00:00Z',
    updated_at: '2024-06-15T00:00:00Z',
    items: [],
    ...overrides,
  } as Invoice
}

function makeItem(overrides: Partial<InvoiceItem> = {}): InvoiceItem {
  return {
    id: 'item-1',
    invoice_id: 'inv-1',
    sort_order: 0,
    description: 'Service',
    quantity: 1,
    unit: 'st',
    unit_price: 1000,
    line_total: 1000,
    vat_rate: 25,
    vat_amount: 250,
    created_at: '2024-06-15T00:00:00Z',
    ...overrides,
  }
}

describe('getRevenueAccount', () => {
  it('standard_25 returns 3001', () => {
    expect(getRevenueAccount('standard_25')).toBe('3001')
  })

  it('reduced_12 returns 3002', () => {
    expect(getRevenueAccount('reduced_12')).toBe('3002')
  })

  it('reduced_6 returns 3003', () => {
    expect(getRevenueAccount('reduced_6')).toBe('3003')
  })

  it('reverse_charge returns 3308', () => {
    expect(getRevenueAccount('reverse_charge')).toBe('3308')
  })

  it('export returns 3305', () => {
    expect(getRevenueAccount('export')).toBe('3305')
  })

  it('exempt defaults to 3100 for enskild_firma', () => {
    expect(getRevenueAccount('exempt')).toBe('3100')
    expect(getRevenueAccount('exempt', 'enskild_firma')).toBe('3100')
  })

  it('exempt returns 3004 for aktiebolag', () => {
    expect(getRevenueAccount('exempt', 'aktiebolag')).toBe('3004')
  })

  it('entityType does not affect non-exempt treatments', () => {
    expect(getRevenueAccount('standard_25', 'aktiebolag')).toBe('3001')
    expect(getRevenueAccount('reduced_12', 'aktiebolag')).toBe('3002')
    expect(getRevenueAccount('export', 'aktiebolag')).toBe('3305')
  })
})

describe('getOutputVatAccount', () => {
  it('standard_25 returns 2611', () => {
    expect(getOutputVatAccount('standard_25')).toBe('2611')
  })

  it('reduced_12 returns 2621', () => {
    expect(getOutputVatAccount('reduced_12')).toBe('2621')
  })

  it('reduced_6 returns 2631', () => {
    expect(getOutputVatAccount('reduced_6')).toBe('2631')
  })
})

describe('createInvoiceJournalEntry: per-line VAT', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('single-rate invoice creates one revenue + one VAT line', async () => {
    const invoice = makeInvoice({
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      vat_treatment: 'standard_25',
      items: [
        makeItem({ description: 'A', quantity: 2, unit_price: 300, line_total: 600, vat_rate: 25, vat_amount: 150 }),
        makeItem({ id: 'item-2', description: 'B', quantity: 1, unit_price: 400, line_total: 400, vat_rate: 25, vat_amount: 100 }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)

    expect(mockedCreateEntry).toHaveBeenCalledOnce()
    const input = mockedCreateEntry.mock.calls[0][3]

    // Should have 3 lines: 1510 debit, 3001 credit, 2611 credit
    expect(input.lines).toHaveLength(3)

    // Debit 1510 = total
    const debit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(debit1510?.debit_amount).toBe(1250)
    expect(debit1510?.credit_amount).toBe(0)

    // Credit 3001 = subtotal
    const credit3001 = input.lines.find((l) => l.account_number === '3001')
    expect(credit3001?.debit_amount).toBe(0)
    expect(credit3001?.credit_amount).toBe(1000)

    // Credit 2611 = VAT
    const credit2611 = input.lines.find((l) => l.account_number === '2611')
    expect(credit2611?.debit_amount).toBe(0)
    expect(credit2611?.credit_amount).toBe(250)
  })

  it('mixed 25%/12% creates two revenue + two VAT lines', async () => {
    const invoice = makeInvoice({
      subtotal: 1000,
      vat_amount: 184, // 600*0.25 + 400*0.12 = 150 + 48 = 198... let's recalc
      total: 1198,
      vat_treatment: 'standard_25',
      vat_rate: null as unknown as number,
      items: [
        makeItem({ description: 'Consulting', quantity: 1, unit_price: 600, line_total: 600, vat_rate: 25, vat_amount: 150 }),
        makeItem({ id: 'item-2', description: 'Food service', quantity: 1, unit_price: 400, line_total: 400, vat_rate: 12, vat_amount: 48 }),
      ],
    })
    invoice.vat_amount = 198
    invoice.total = 1198

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)

    expect(mockedCreateEntry).toHaveBeenCalledOnce()
    const input = mockedCreateEntry.mock.calls[0][3]

    // Should have 5 lines: 1510, 3001(25%), 2611(25%), 3002(12%), 2621(12%)
    expect(input.lines).toHaveLength(5)

    // Debit 1510 = total
    const debit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(debit1510?.debit_amount).toBe(1198)

    // Revenue 3001 (25% group)
    const credit3001 = input.lines.find((l) => l.account_number === '3001')
    expect(credit3001?.credit_amount).toBe(600)

    // VAT 2611 (25% group)
    const credit2611 = input.lines.find((l) => l.account_number === '2611')
    expect(credit2611?.credit_amount).toBe(150)

    // Revenue 3002 (12% group)
    const credit3002 = input.lines.find((l) => l.account_number === '3002')
    expect(credit3002?.credit_amount).toBe(400)

    // VAT 2621 (12% group)
    const credit2621 = input.lines.find((l) => l.account_number === '2621')
    expect(credit2621?.credit_amount).toBe(48)
  })

  it('reverse charge creates single 3308, no VAT lines', async () => {
    const invoice = makeInvoice({
      subtotal: 5000,
      vat_amount: 0,
      total: 5000,
      vat_treatment: 'reverse_charge',
      vat_rate: 0,
      items: [
        makeItem({ quantity: 1, unit_price: 5000, line_total: 5000, vat_rate: 0, vat_amount: 0 }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)

    expect(mockedCreateEntry).toHaveBeenCalledOnce()
    const input = mockedCreateEntry.mock.calls[0][3]

    // Should have 2 lines: 1510 debit, 3308 credit (no VAT)
    expect(input.lines).toHaveLength(2)

    const debit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(debit1510?.debit_amount).toBe(5000)

    const credit3308 = input.lines.find((l) => l.account_number === '3308')
    expect(credit3308?.credit_amount).toBe(5000)

    // No VAT lines
    const vatLines = input.lines.filter((l) =>
      l.account_number.startsWith('26')
    )
    expect(vatLines).toHaveLength(0)
  })

  it('balance: debit(1510) = sum(revenue + VAT credits)', async () => {
    const invoice = makeInvoice({
      subtotal: 2000,
      vat_amount: 380, // 1200*0.25 + 500*0.12 + 300*0.06 = 300 + 60 + 18 = 378
      total: 2378,
      vat_treatment: 'standard_25',
      vat_rate: null as unknown as number,
      items: [
        makeItem({ description: 'A', quantity: 1, unit_price: 1200, line_total: 1200, vat_rate: 25, vat_amount: 300 }),
        makeItem({ id: 'item-2', description: 'B', quantity: 1, unit_price: 500, line_total: 500, vat_rate: 12, vat_amount: 60 }),
        makeItem({ id: 'item-3', description: 'C', quantity: 1, unit_price: 300, line_total: 300, vat_rate: 6, vat_amount: 18 }),
      ],
    })
    invoice.vat_amount = 378
    invoice.total = 2378

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)

    const input = mockedCreateEntry.mock.calls[0][3]

    const totalDebit = input.lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const totalCredit = input.lines.reduce((sum, l) => sum + l.credit_amount, 0)

    expect(totalDebit).toBe(totalCredit)
    expect(totalDebit).toBe(2378)
  })
})

describe('createInvoiceJournalEntry: per-article revenue account override', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('without an override, two 25% lines collapse into one 3001 revenue line (unchanged behaviour)', async () => {
    const invoice = makeInvoice({
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      vat_treatment: 'standard_25',
      vat_rate: null as unknown as number,
      items: [
        makeItem({ description: 'A', unit_price: 600, line_total: 600, vat_rate: 25, vat_amount: 150 }),
        makeItem({ id: 'item-2', description: 'B', unit_price: 400, line_total: 400, vat_rate: 25, vat_amount: 100 }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)
    const input = mockedCreateEntry.mock.calls[0][3]

    const rev3001 = input.lines.filter((l) => l.account_number === '3001')
    expect(rev3001).toHaveLength(1)
    expect(rev3001[0].credit_amount).toBe(1000)
    const vat2611 = input.lines.filter((l) => l.account_number === '2611')
    expect(vat2611).toHaveLength(1)
    expect(vat2611[0].credit_amount).toBe(250)
  })

  it('splits one rate into two revenue accounts but keeps a single VAT line, balanced', async () => {
    const invoice = makeInvoice({
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      vat_treatment: 'standard_25',
      vat_rate: null as unknown as number,
      items: [
        makeItem({ description: 'Goods', unit_price: 600, line_total: 600, vat_rate: 25, vat_amount: 150 }), // no override → 3001
        makeItem({ id: 'item-2', description: 'Consulting', unit_price: 400, line_total: 400, vat_rate: 25, vat_amount: 100, revenue_account: '3041' }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)
    const input = mockedCreateEntry.mock.calls[0][3]

    expect(input.lines.find((l) => l.account_number === '3001')?.credit_amount).toBe(600)
    expect(input.lines.find((l) => l.account_number === '3041')?.credit_amount).toBe(400)
    const vat = input.lines.filter((l) => l.account_number === '2611')
    expect(vat).toHaveLength(1)
    expect(vat[0].credit_amount).toBe(250)

    const debit = input.lines.reduce((s, l) => s + l.debit_amount, 0)
    const credit = input.lines.reduce((s, l) => s + l.credit_amount, 0)
    expect(debit).toBe(credit)
    expect(debit).toBe(1250)
  })

  it('ignores a per-line override on reverse charge: revenue stays on 3308', async () => {
    const invoice = makeInvoice({
      subtotal: 5000,
      vat_amount: 0,
      total: 5000,
      vat_treatment: 'reverse_charge',
      vat_rate: 0,
      items: [
        makeItem({ unit_price: 5000, line_total: 5000, vat_rate: 0, vat_amount: 0, revenue_account: '3041' }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)
    const input = mockedCreateEntry.mock.calls[0][3]

    expect(input.lines.find((l) => l.account_number === '3308')?.credit_amount).toBe(5000)
    expect(input.lines.find((l) => l.account_number === '3041')).toBeUndefined()
  })

  it('absorbs rounding on the last account so a split rate still balances against 1510', async () => {
    // Two 25% lines to different accounts whose individual SEK rounding would
    // otherwise drift from the rate-level total (10.005 → 10.01 each = 20.02,
    // but the rate total is round(20.01) = 20.01).
    const invoice = makeInvoice({
      subtotal: 20.01,
      vat_amount: 5.0,
      total: 25.01,
      vat_treatment: 'standard_25',
      vat_rate: null as unknown as number,
      items: [
        makeItem({ description: 'A', unit_price: 10.005, line_total: 10.005, vat_rate: 25, vat_amount: 2.5 }),
        makeItem({ id: 'item-2', description: 'B', unit_price: 10.005, line_total: 10.005, vat_rate: 25, vat_amount: 2.5, revenue_account: '3041' }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)
    const input = mockedCreateEntry.mock.calls[0][3]

    const revSum = input.lines
      .filter((l) => l.account_number === '3001' || l.account_number === '3041')
      .reduce((s, l) => s + l.credit_amount, 0)
    expect(Math.round(revSum * 100) / 100).toBe(20.01)

    const debit = Math.round(input.lines.reduce((s, l) => s + l.debit_amount, 0) * 100) / 100
    const credit = Math.round(input.lines.reduce((s, l) => s + l.credit_amount, 0) * 100) / 100
    expect(debit).toBe(credit)
    expect(debit).toBe(25.01)
  })
})

describe('createCreditNoteJournalEntry: per-line VAT', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reverses per-rate lines correctly for mixed rates', async () => {
    const creditNote = makeInvoice({
      invoice_number: 'KR-1001',
      subtotal: -1000,
      vat_amount: -198,
      total: -1198,
      vat_treatment: 'standard_25',
      items: [
        makeItem({ quantity: -1, unit_price: 600, line_total: -600, vat_rate: 25, vat_amount: -150 }),
        makeItem({ id: 'item-2', quantity: -1, unit_price: 400, line_total: -400, vat_rate: 12, vat_amount: -48 }),
      ],
    })

    await createCreditNoteJournalEntry(null as never, 'company-1', 'user-1', creditNote)

    expect(mockedCreateEntry).toHaveBeenCalledOnce()
    const input = mockedCreateEntry.mock.calls[0][3]

    // Revenue and VAT lines should be debits (reversed)
    const debit3001 = input.lines.find((l) => l.account_number === '3001')
    expect(debit3001?.debit_amount).toBe(600)
    expect(debit3001?.credit_amount).toBe(0)

    const debit2611 = input.lines.find((l) => l.account_number === '2611')
    expect(debit2611?.debit_amount).toBe(150)

    const debit3002 = input.lines.find((l) => l.account_number === '3002')
    expect(debit3002?.debit_amount).toBe(400)

    const debit2621 = input.lines.find((l) => l.account_number === '2621')
    expect(debit2621?.debit_amount).toBe(48)

    // 1510 should be credit
    const credit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(credit1510?.credit_amount).toBe(1198)
    expect(credit1510?.debit_amount).toBe(0)

    // Balance check
    const totalDebit = input.lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const totalCredit = input.lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(totalDebit).toBe(totalCredit)
  })
})

describe('createInvoiceCashEntry: per-line VAT', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('cash method with mixed rates creates per-rate revenue + VAT', async () => {
    const invoice = makeInvoice({
      subtotal: 1000,
      vat_amount: 198,
      total: 1198,
      vat_treatment: 'standard_25',
      items: [
        makeItem({ quantity: 1, unit_price: 600, line_total: 600, vat_rate: 25, vat_amount: 150 }),
        makeItem({ id: 'item-2', quantity: 1, unit_price: 400, line_total: 400, vat_rate: 12, vat_amount: 48 }),
      ],
    })

    await createInvoiceCashEntry(null as never, 'company-1', 'user-1', invoice, '2024-07-01')

    expect(mockedCreateEntry).toHaveBeenCalledOnce()
    const input = mockedCreateEntry.mock.calls[0][3]

    // Debit 1930 (bank account) instead of 1510
    const debit1930 = input.lines.find((l) => l.account_number === '1930')
    expect(debit1930?.debit_amount).toBe(1198)

    // Same per-rate credits as accrual
    const credit3001 = input.lines.find((l) => l.account_number === '3001')
    expect(credit3001?.credit_amount).toBe(600)

    const credit2611 = input.lines.find((l) => l.account_number === '2611')
    expect(credit2611?.credit_amount).toBe(150)

    const credit3002 = input.lines.find((l) => l.account_number === '3002')
    expect(credit3002?.credit_amount).toBe(400)

    // Balance
    const totalDebit = input.lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const totalCredit = input.lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(totalDebit).toBe(totalCredit)
  })
})

describe('createInvoiceJournalEntry: EUR foreign currency', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('EUR invoice converts amounts to SEK using exchange rate', async () => {
    // EUR 1,000 + EUR 250 VAT = EUR 1,250 total, rate 11.5
    const invoice = makeInvoice({
      currency: 'EUR',
      exchange_rate: 11.5,
      subtotal: 1000,
      subtotal_sek: 11500,
      vat_amount: 250,
      vat_amount_sek: 2875,
      total: 1250,
      total_sek: 14375,
      vat_treatment: 'standard_25',
      items: [
        makeItem({ line_total: 1000, vat_rate: 25, vat_amount: 250 }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)

    expect(mockedCreateEntry).toHaveBeenCalledOnce()
    const input = mockedCreateEntry.mock.calls[0][3]

    // All amounts should be in SEK
    const debit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(debit1510?.debit_amount).toBe(14375) // 1000*11.5 + 250*11.5 = 14375

    const credit3001 = input.lines.find((l) => l.account_number === '3001')
    expect(credit3001?.credit_amount).toBe(11500) // 1000 * 11.5

    const credit2611 = input.lines.find((l) => l.account_number === '2611')
    expect(credit2611?.credit_amount).toBe(2875) // 250 * 11.5

    // 1510 line should have currency metadata
    expect(debit1510?.currency).toBe('EUR')
    expect(debit1510?.amount_in_currency).toBe(1250)
    expect(debit1510?.exchange_rate).toBe(11.5)

    // Balance check
    const totalDebit = input.lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const totalCredit = input.lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(totalDebit).toBe(totalCredit)
  })

  it('EUR invoice uses total_sek when available', async () => {
    // Edge case: total_sek differs slightly from computed (e.g. pre-computed at different rate)
    const invoice = makeInvoice({
      currency: 'EUR',
      exchange_rate: 11.5,
      subtotal: 1000,
      subtotal_sek: null,
      vat_amount: 0,
      vat_amount_sek: null,
      total: 1000,
      total_sek: null,
      vat_treatment: 'export',
      items: [
        makeItem({ line_total: 1000, vat_rate: 0, vat_amount: 0 }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)

    const input = mockedCreateEntry.mock.calls[0][3]

    // Revenue should be computed via exchange rate
    const credit3305 = input.lines.find((l) => l.account_number === '3305')
    expect(credit3305?.credit_amount).toBe(11500)

    const debit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(debit1510?.debit_amount).toBe(11500)
  })

  it('SEK invoice still works unchanged (backward compatibility)', async () => {
    const invoice = makeInvoice({
      subtotal: 800,
      vat_amount: 200,
      total: 1000,
      vat_treatment: 'standard_25',
      items: [
        makeItem({ line_total: 800, vat_rate: 25, vat_amount: 200 }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)

    const input = mockedCreateEntry.mock.calls[0][3]
    const debit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(debit1510?.debit_amount).toBe(1000)

    // No currency metadata for SEK
    expect(debit1510?.currency).toBeUndefined()
    expect(debit1510?.amount_in_currency).toBeUndefined()
  })
})

describe('BFL-compliant descriptions with counterparty names', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('createInvoiceJournalEntry includes customer name in description', async () => {
    const invoice = makeInvoice({
      items: [makeItem()],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice, 'enskild_firma', 'Foretag AB')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Kundfaktura 1001, Foretag AB')
  })

  it('createInvoiceJournalEntry falls back without customer name', async () => {
    const invoice = makeInvoice({
      items: [makeItem()],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice, 'enskild_firma')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Kundfaktura 1001')
  })

  it('createInvoicePaymentJournalEntry includes customer name', async () => {
    const invoice = makeInvoice({ total: 1250 })

    await createInvoicePaymentJournalEntry(null as never, 'company-1', 'user-1', invoice, '2024-07-15', undefined, 'Foretag AB')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Inbetalning kundfaktura 1001, Foretag AB')
  })

  it('createInvoicePaymentJournalEntry falls back without customer name', async () => {
    const invoice = makeInvoice({ total: 1250 })

    await createInvoicePaymentJournalEntry(null as never, 'company-1', 'user-1', invoice, '2024-07-15')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Inbetalning kundfaktura 1001')
  })

  it('createCreditNoteJournalEntry includes customer name', async () => {
    const creditNote = makeInvoice({
      invoice_number: 'KR-1001',
      subtotal: -1000,
      vat_amount: -250,
      total: -1250,
      items: [makeItem({ quantity: -1, line_total: -1000, vat_amount: -250 })],
    })

    await createCreditNoteJournalEntry(null as never, 'company-1', 'user-1', creditNote, 'enskild_firma', 'Foretag AB')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Kreditfaktura KR-1001, Foretag AB')
  })

  it('createInvoiceCashEntry includes customer name', async () => {
    const invoice = makeInvoice({
      items: [makeItem()],
    })

    await createInvoiceCashEntry(null as never, 'company-1', 'user-1', invoice, '2024-07-01', 'enskild_firma', 'Foretag AB')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Kontantbetalning kundfaktura 1001, Foretag AB')
  })

  it('createInvoiceCashEntry falls back without customer name', async () => {
    const invoice = makeInvoice({
      items: [makeItem()],
    })

    await createInvoiceCashEntry(null as never, 'company-1', 'user-1', invoice, '2024-07-01', 'enskild_firma')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.description).toBe('Kontantbetalning kundfaktura 1001')
  })
})

describe('createInvoicePaymentJournalEntry: exchange rate difference', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('SEK payment creates simple 2-line entry', async () => {
    const invoice = makeInvoice({ total: 1250 })

    await createInvoicePaymentJournalEntry(null as never, 'company-1', 'user-1', invoice, '2024-07-15')

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines).toHaveLength(2)

    const debit1930 = input.lines.find((l) => l.account_number === '1930')
    expect(debit1930?.debit_amount).toBe(1250)

    const credit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(credit1510?.credit_amount).toBe(1250)
  })

  it('EUR payment with positive exchange rate difference (gain) creates 3 lines', async () => {
    const invoice = makeInvoice({
      currency: 'EUR',
      exchange_rate: 11.5,
      total: 1000,
      total_sek: 11500,
    })

    // Gain of 200 SEK (received more than booked)
    await createInvoicePaymentJournalEntry(null as never, 'company-1', 'user-1', invoice, '2024-07-15', 200)

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines).toHaveLength(3)

    // Debit 1930: actual SEK received = 11500 + 200 = 11700
    const debit1930 = input.lines.find((l) => l.account_number === '1930')
    expect(debit1930?.debit_amount).toBe(11700)

    // Credit 1510: original booked amount
    const credit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(credit1510?.credit_amount).toBe(11500)

    // Credit 3960: exchange rate gain
    const credit3960 = input.lines.find((l) => l.account_number === '3960')
    expect(credit3960?.credit_amount).toBe(200)

    // Balance check
    const totalDebit = input.lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const totalCredit = input.lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(totalDebit).toBe(totalCredit)
  })

  it('EUR payment with negative exchange rate difference (loss) creates 3 lines', async () => {
    const invoice = makeInvoice({
      currency: 'EUR',
      exchange_rate: 11.5,
      total: 1000,
      total_sek: 11500,
    })

    // Loss of 300 SEK (received less than booked)
    await createInvoicePaymentJournalEntry(null as never, 'company-1', 'user-1', invoice, '2024-07-15', -300)

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines).toHaveLength(3)

    // Debit 1930: actual SEK received = 11500 + (-300) = 11200
    const debit1930 = input.lines.find((l) => l.account_number === '1930')
    expect(debit1930?.debit_amount).toBe(11200)

    // Credit 1510: original booked amount
    const credit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(credit1510?.credit_amount).toBe(11500)

    // Debit 7960: exchange rate loss
    const debit7960 = input.lines.find((l) => l.account_number === '7960')
    expect(debit7960?.debit_amount).toBe(300)

    // Balance check
    const totalDebit = input.lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const totalCredit = input.lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(totalDebit).toBe(totalCredit)
  })
})

describe('createInvoiceJournalEntry: ROT/RUT-avdrag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('single ROT line: 10 000 kr labor → 1513 debit 3 000, 1510 debit 7 000 + 2 500 VAT', async () => {
    // 10 000 kr labor with 25% VAT = 12 500 total. ROT = 30% of 10 000 = 3 000.
    // Customer owes (12 500 - 3 000) = 9 500. Skatteverket pays 3 000.
    const invoice = makeInvoice({
      subtotal: 10000,
      vat_amount: 2500,
      total: 12500,
      vat_treatment: 'standard_25',
      items: [
        makeItem({
          quantity: 1,
          unit_price: 10000,
          line_total: 10000,
          vat_rate: 25,
          vat_amount: 2500,
          deduction_type: 'rot',
          deduction_amount: 3000,
        }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)

    expect(mockedCreateEntry).toHaveBeenCalledOnce()
    const input = mockedCreateEntry.mock.calls[0][3]

    // Lines: 1510 (debit 9500) + 1513 (debit 3000) + 3001 (credit 10000) + 2611 (credit 2500)
    expect(input.lines).toHaveLength(4)

    const debit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(debit1510?.debit_amount).toBe(9500)

    const debit1513 = input.lines.find((l) => l.account_number === '1513')
    expect(debit1513?.debit_amount).toBe(3000)
    expect(debit1513?.credit_amount).toBe(0)

    const credit3001 = input.lines.find((l) => l.account_number === '3001')
    expect(credit3001?.credit_amount).toBe(10000)

    const credit2611 = input.lines.find((l) => l.account_number === '2611')
    expect(credit2611?.credit_amount).toBe(2500)

    // Balance: 9500 + 3000 = 12500 = 10000 + 2500
    const totalDebit = input.lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const totalCredit = input.lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(totalDebit).toBe(totalCredit)
    expect(totalDebit).toBe(12500)
  })

  it('mixed invoice: ROT line + non-deduction line, per-item handling', async () => {
    // ROT line 10 000 (deduction 3 000) + non-deduction materials line 4 000.
    // Total 14 000 + 25% VAT = 17 500. Customer owes 14 500. Skatteverket 3 000.
    const invoice = makeInvoice({
      subtotal: 14000,
      vat_amount: 3500,
      total: 17500,
      vat_treatment: 'standard_25',
      items: [
        makeItem({
          quantity: 1,
          unit_price: 10000,
          line_total: 10000,
          vat_rate: 25,
          vat_amount: 2500,
          deduction_type: 'rot',
          deduction_amount: 3000,
        }),
        makeItem({
          id: 'item-2',
          quantity: 1,
          unit_price: 4000,
          line_total: 4000,
          vat_rate: 25,
          vat_amount: 1000,
          // No deduction
        }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)

    const input = mockedCreateEntry.mock.calls[0][3]

    // Lines: 1510 (debit 14500) + 1513 (debit 3000) + 3001 (credit 14000) + 2611 (credit 3500)
    expect(input.lines).toHaveLength(4)

    const debit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(debit1510?.debit_amount).toBe(14500)

    const debit1513 = input.lines.find((l) => l.account_number === '1513')
    expect(debit1513?.debit_amount).toBe(3000)

    // Balance: 14500 + 3000 = 17500
    const totalDebit = input.lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const totalCredit = input.lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(totalDebit).toBe(totalCredit)
    expect(totalDebit).toBe(17500)
  })

  it('RUT line with 50% rate: 5 000 kr → 1513 debit 2 500', async () => {
    // 5 000 labor with 25% VAT = 6 250 total. RUT = 50% of 5 000 = 2 500.
    const invoice = makeInvoice({
      subtotal: 5000,
      vat_amount: 1250,
      total: 6250,
      vat_treatment: 'standard_25',
      items: [
        makeItem({
          quantity: 1,
          unit_price: 5000,
          line_total: 5000,
          vat_rate: 25,
          vat_amount: 1250,
          deduction_type: 'rut',
          deduction_amount: 2500,
        }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)

    const input = mockedCreateEntry.mock.calls[0][3]

    const debit1513 = input.lines.find((l) => l.account_number === '1513')
    expect(debit1513?.debit_amount).toBe(2500)
    expect(debit1513?.line_description).toMatch(/RUT/)

    const debit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(debit1510?.debit_amount).toBe(3750) // 6250 - 2500

    // Balance
    const totalDebit = input.lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const totalCredit = input.lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(totalDebit).toBe(totalCredit)
  })

  it('no deduction_type → no 1513 line, normal AR debit', async () => {
    const invoice = makeInvoice({
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      items: [
        makeItem({ quantity: 1, unit_price: 1000, line_total: 1000, vat_rate: 25, vat_amount: 250 }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)

    const input = mockedCreateEntry.mock.calls[0][3]

    expect(input.lines.find((l) => l.account_number === '1513')).toBeUndefined()
    const debit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(debit1510?.debit_amount).toBe(1250)
  })

  it('two ROT lines: per-line 1513 debits sum to invoice deduction total', async () => {
    // 6 000 + 4 000 labor, both ROT 30% → 1 800 + 1 200 = 3 000 total.
    const invoice = makeInvoice({
      subtotal: 10000,
      vat_amount: 2500,
      total: 12500,
      vat_treatment: 'standard_25',
      items: [
        makeItem({
          quantity: 1,
          unit_price: 6000,
          line_total: 6000,
          vat_rate: 25,
          vat_amount: 1500,
          deduction_type: 'rot',
          deduction_amount: 1800,
        }),
        makeItem({
          id: 'item-2',
          quantity: 1,
          unit_price: 4000,
          line_total: 4000,
          vat_rate: 25,
          vat_amount: 1000,
          deduction_type: 'rot',
          deduction_amount: 1200,
        }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)

    const input = mockedCreateEntry.mock.calls[0][3]

    const debit1513Lines = input.lines.filter((l) => l.account_number === '1513')
    expect(debit1513Lines).toHaveLength(2)
    const total1513 = debit1513Lines.reduce((sum, l) => sum + l.debit_amount, 0)
    expect(total1513).toBe(3000)

    const debit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(debit1510?.debit_amount).toBe(9500) // 12500 - 3000

    // Balance
    const totalDebit = input.lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const totalCredit = input.lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(totalDebit).toBe(totalCredit)
  })
})

describe('dimensions propagation (PR7): createInvoiceJournalEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('1510 + VAT lines carry the invoice default; revenue lines carry the merged item-over-default bag', async () => {
    const invoice = makeInvoice({
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      vat_treatment: 'standard_25',
      default_dimensions: { '1': 'KS01' },
      items: [
        makeItem({ description: 'A', unit_price: 600, line_total: 600, vat_rate: 25, vat_amount: 150, dimensions: { '6': 'P001' } }),
        makeItem({ id: 'item-2', description: 'B', unit_price: 400, line_total: 400, vat_rate: 25, vat_amount: 100, dimensions: { '1': 'KS02' } }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)
    const input = mockedCreateEntry.mock.calls[0][3]

    const debit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(debit1510?.dimensions).toEqual({ '1': 'KS01' })

    const vat2611 = input.lines.filter((l) => l.account_number === '2611')
    expect(vat2611).toHaveLength(1)
    expect(vat2611[0].dimensions).toEqual({ '1': 'KS01' })

    // Same vat_rate + account, DIFFERENT bags → separate revenue lines
    // (aggregation identity = account + bag).
    const rev3001 = input.lines.filter((l) => l.account_number === '3001')
    expect(rev3001).toHaveLength(2)
    expect(rev3001[0].credit_amount).toBe(600)
    expect(rev3001[0].dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    expect(rev3001[1].credit_amount).toBe(400)
    // The item bag wins per key over the invoice default.
    expect(rev3001[1].dimensions).toEqual({ '1': 'KS02' })
  })

  it('items with the identical merged bag still aggregate into one revenue line', async () => {
    const invoice = makeInvoice({
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      vat_treatment: 'standard_25',
      default_dimensions: { '1': 'KS01' },
      items: [
        makeItem({ description: 'A', unit_price: 600, line_total: 600, vat_rate: 25, vat_amount: 150, dimensions: { '6': 'P001' } }),
        makeItem({ id: 'item-2', description: 'B', unit_price: 400, line_total: 400, vat_rate: 25, vat_amount: 100, dimensions: { '6': 'P001' } }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)
    const input = mockedCreateEntry.mock.calls[0][3]

    const rev3001 = input.lines.filter((l) => l.account_number === '3001')
    expect(rev3001).toHaveLength(1)
    expect(rev3001[0].credit_amount).toBe(1000)
    expect(rev3001[0].dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
  })

  it('per-rate rounding remainder is absorbed by the last dimension bucket (balanced against 1510)', async () => {
    // Same account, same 25% rate: split only by the dimensions bag. The
    // rate-level total (20.01) is the balance anchor; independent per-bucket
    // rounding would give 2 × 10.01 = 20.02, so the last bucket must absorb.
    const invoice = makeInvoice({
      subtotal: 20.01,
      vat_amount: 5.0,
      total: 25.01,
      vat_treatment: 'standard_25',
      vat_rate: null as unknown as number,
      items: [
        makeItem({ description: 'A', unit_price: 10.005, line_total: 10.005, vat_rate: 25, vat_amount: 2.5 }),
        makeItem({ id: 'item-2', description: 'B', unit_price: 10.005, line_total: 10.005, vat_rate: 25, vat_amount: 2.5, dimensions: { '6': 'P001' } }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)
    const input = mockedCreateEntry.mock.calls[0][3]

    const rev3001 = input.lines.filter((l) => l.account_number === '3001')
    expect(rev3001).toHaveLength(2)
    expect(rev3001[0].dimensions).toBeUndefined()
    expect(rev3001[1].dimensions).toEqual({ '6': 'P001' })

    const revSum = rev3001.reduce((s, l) => s + l.credit_amount, 0)
    expect(roundOre(revSum)).toBe(20.01)

    const debit = roundOre(input.lines.reduce((s, l) => s + l.debit_amount, 0))
    const credit = roundOre(input.lines.reduce((s, l) => s + l.credit_amount, 0))
    expect(debit).toBe(credit)
    expect(debit).toBe(25.01)
  })

  it('ROT 1513 line carries the item merged bag', async () => {
    const invoice = makeInvoice({
      subtotal: 10000,
      vat_amount: 2500,
      total: 12500,
      vat_treatment: 'standard_25',
      default_dimensions: { '1': 'KS01' },
      items: [
        makeItem({
          quantity: 1,
          unit_price: 10000,
          line_total: 10000,
          vat_rate: 25,
          vat_amount: 2500,
          deduction_type: 'rot',
          deduction_amount: 3000,
          dimensions: { '6': 'P001' },
        }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)
    const input = mockedCreateEntry.mock.calls[0][3]

    const debit1513 = input.lines.find((l) => l.account_number === '1513')
    expect(debit1513?.debit_amount).toBe(3000)
    expect(debit1513?.dimensions).toEqual({ '1': 'KS01', '6': 'P001' })

    // 1510 still carries the default only.
    const debit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(debit1510?.dimensions).toEqual({ '1': 'KS01' })
  })

  it('fallback path (no items) carries the invoice default on revenue + VAT lines', async () => {
    const invoice = makeInvoice({
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      vat_treatment: 'standard_25',
      default_dimensions: { '1': 'KS01', '6': 'P001' },
      items: [],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)
    const input = mockedCreateEntry.mock.calls[0][3]

    const rev3001 = input.lines.find((l) => l.account_number === '3001')
    expect(rev3001?.dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    const vat2611 = input.lines.find((l) => l.account_number === '2611')
    expect(vat2611?.dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    const debit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(debit1510?.dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
  })

  it('no default and no item bags → line.dimensions stays undefined', async () => {
    const invoice = makeInvoice({
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      vat_treatment: 'standard_25',
      items: [
        makeItem({ unit_price: 1000, line_total: 1000, vat_rate: 25, vat_amount: 250 }),
      ],
    })

    await createInvoiceJournalEntry(null as never, 'company-1', 'user-1', invoice)
    const input = mockedCreateEntry.mock.calls[0][3]

    const debit1510 = input.lines.find((l) => l.account_number === '1510')
    // toEqual ignores undefined-valued keys: the line shape is unchanged.
    expect(debit1510).toEqual({
      account_number: '1510',
      debit_amount: 1250,
      credit_amount: 0,
      line_description: 'Faktura 1001',
    })
    expect(debit1510?.dimensions).toBeUndefined()
    expect(input.lines.find((l) => l.account_number === '3001')?.dimensions).toBeUndefined()
    expect(input.lines.find((l) => l.account_number === '2611')?.dimensions).toBeUndefined()
  })
})

describe('dimensions propagation (PR7): createInvoicePaymentJournalEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('SEK payment: both 1930 and 1510 carry the invoice default', async () => {
    const invoice = makeInvoice({ total: 1250, default_dimensions: { '1': 'KS01', '6': 'P001' } })

    await createInvoicePaymentJournalEntry(null as never, 'company-1', 'user-1', invoice, '2024-07-15')
    const input = mockedCreateEntry.mock.calls[0][3]

    expect(input.lines).toHaveLength(2)
    for (const line of input.lines) {
      expect(line.dimensions).toEqual({ '1': 'KS01', '6': 'P001' })
    }
  })

  it('FX payment: the 3960 kursvinst line carries the default too', async () => {
    const invoice = makeInvoice({
      currency: 'EUR',
      exchange_rate: 11.5,
      total: 1000,
      total_sek: 11500,
      default_dimensions: { '6': 'P001' },
    })

    await createInvoicePaymentJournalEntry(null as never, 'company-1', 'user-1', invoice, '2024-07-15', 200)
    const input = mockedCreateEntry.mock.calls[0][3]

    expect(input.lines).toHaveLength(3)
    for (const account of ['1930', '1510', '3960']) {
      const line = input.lines.find((l) => l.account_number === account)
      expect(line?.dimensions).toEqual({ '6': 'P001' })
    }
  })

  it('FX loss payment: the 7960 kursförlust line carries the default too', async () => {
    const invoice = makeInvoice({
      currency: 'EUR',
      exchange_rate: 11.5,
      total: 1000,
      total_sek: 11500,
      default_dimensions: { '6': 'P001' },
    })

    await createInvoicePaymentJournalEntry(null as never, 'company-1', 'user-1', invoice, '2024-07-15', -300)
    const input = mockedCreateEntry.mock.calls[0][3]

    const loss7960 = input.lines.find((l) => l.account_number === '7960')
    expect(loss7960?.dimensions).toEqual({ '6': 'P001' })
  })

  it('no default bag → payment lines carry no dimensions', async () => {
    const invoice = makeInvoice({ total: 1250 })

    await createInvoicePaymentJournalEntry(null as never, 'company-1', 'user-1', invoice, '2024-07-15')
    const input = mockedCreateEntry.mock.calls[0][3]

    for (const line of input.lines) {
      expect(line.dimensions).toBeUndefined()
    }
  })
})

describe('dimensions propagation (PR7): createInvoiceCashEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('1930 carries the default; revenue carries the merged item bag; VAT carries the default', async () => {
    const invoice = makeInvoice({
      subtotal: 1000,
      vat_amount: 250,
      total: 1250,
      vat_treatment: 'standard_25',
      default_dimensions: { '1': 'KS01' },
      items: [
        makeItem({ unit_price: 1000, line_total: 1000, vat_rate: 25, vat_amount: 250, dimensions: { '6': 'P001' } }),
      ],
    })

    await createInvoiceCashEntry(null as never, 'company-1', 'user-1', invoice, '2024-07-01')
    const input = mockedCreateEntry.mock.calls[0][3]

    const debit1930 = input.lines.find((l) => l.account_number === '1930')
    expect(debit1930?.dimensions).toEqual({ '1': 'KS01' })

    const rev3001 = input.lines.find((l) => l.account_number === '3001')
    expect(rev3001?.dimensions).toEqual({ '1': 'KS01', '6': 'P001' })

    const vat2611 = input.lines.find((l) => l.account_number === '2611')
    expect(vat2611?.dimensions).toEqual({ '1': 'KS01' })
  })
})

describe('dimensions propagation (PR7): createCreditNoteJournalEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('swapped lines keep the item bags; 1510 carries the credit note default', async () => {
    const creditNote = makeInvoice({
      invoice_number: 'KR-1001',
      subtotal: -1000,
      vat_amount: -198,
      total: -1198,
      vat_treatment: 'standard_25',
      default_dimensions: { '1': 'KS01' },
      items: [
        makeItem({ quantity: -1, unit_price: 600, line_total: -600, vat_rate: 25, vat_amount: -150, dimensions: { '6': 'P001' } }),
        makeItem({ id: 'item-2', quantity: -1, unit_price: 400, line_total: -400, vat_rate: 12, vat_amount: -48 }),
      ],
    })

    await createCreditNoteJournalEntry(null as never, 'company-1', 'user-1', creditNote)
    const input = mockedCreateEntry.mock.calls[0][3]

    // The reversed (debit) revenue lines keep the merged item bags.
    const debit3001 = input.lines.find((l) => l.account_number === '3001')
    expect(debit3001?.debit_amount).toBe(600)
    expect(debit3001?.dimensions).toEqual({ '1': 'KS01', '6': 'P001' })

    const debit3002 = input.lines.find((l) => l.account_number === '3002')
    expect(debit3002?.dimensions).toEqual({ '1': 'KS01' })

    // VAT lines carry the default only.
    expect(input.lines.find((l) => l.account_number === '2611')?.dimensions).toEqual({ '1': 'KS01' })
    expect(input.lines.find((l) => l.account_number === '2621')?.dimensions).toEqual({ '1': 'KS01' })

    // 1510 carries the credit note's own default bag.
    const credit1510 = input.lines.find((l) => l.account_number === '1510')
    expect(credit1510?.credit_amount).toBe(1198)
    expect(credit1510?.dimensions).toEqual({ '1': 'KS01' })
  })
})

describe('createInvoiceCashEntry: ROT/RUT-avdrag', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('cash method ROT: 1930 debit reduced by deduction, 1513 carries the rest', async () => {
    const invoice = makeInvoice({
      subtotal: 10000,
      vat_amount: 2500,
      total: 12500,
      vat_treatment: 'standard_25',
      items: [
        makeItem({
          quantity: 1,
          unit_price: 10000,
          line_total: 10000,
          vat_rate: 25,
          vat_amount: 2500,
          deduction_type: 'rot',
          deduction_amount: 3000,
        }),
      ],
    })

    await createInvoiceCashEntry(null as never, 'company-1', 'user-1', invoice, '2024-07-01')

    const input = mockedCreateEntry.mock.calls[0][3]

    const debit1930 = input.lines.find((l) => l.account_number === '1930')
    expect(debit1930?.debit_amount).toBe(9500)

    const debit1513 = input.lines.find((l) => l.account_number === '1513')
    expect(debit1513?.debit_amount).toBe(3000)

    // Balance
    const totalDebit = input.lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const totalCredit = input.lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(totalDebit).toBe(totalCredit)
  })
})
