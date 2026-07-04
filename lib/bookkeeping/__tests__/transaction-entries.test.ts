import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeTransaction } from '@/tests/helpers'
import type { CreateJournalEntryInput, MappingResult, VatJournalLine } from '@/types'

// Mock engine
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

// Mock currency-utils with real logic
vi.mock('../currency-utils', () => ({
  resolveSekAmount: vi.fn().mockImplementation(
    (amount: number, amountSek: number | null, currency: string | null, exchangeRate: number | null) => {
      if (!currency || currency === 'SEK') return amount
      if (amountSek != null) return Math.round(amountSek * 100) / 100
      if (exchangeRate != null && exchangeRate > 0) return Math.round(amount * exchangeRate * 100) / 100
      return amount
    }
  ),
  buildCurrencyMetadata: vi.fn().mockImplementation(
    (currency: string | null, amountInCurrency: number | null | undefined, exchangeRate: number | null) => {
      if (!currency || currency === 'SEK') return {}
      return {
        ...(currency ? { currency } : {}),
        ...(amountInCurrency != null ? { amount_in_currency: amountInCurrency } : {}),
        ...(exchangeRate != null && exchangeRate > 0 ? { exchange_rate: exchangeRate } : {}),
      }
    }
  ),
}))

// Mock vat-entries with real logic
vi.mock('../vat-entries', () => ({
  generateInputVatLine: vi.fn().mockImplementation(
    (totalAmount: number, vatRate: number = 0.25) => {
      if (vatRate === 0) return null
      const vatAmount = Math.round((totalAmount * vatRate) / (1 + vatRate) * 100) / 100
      return {
        account_number: '2641',
        debit_amount: vatAmount,
        credit_amount: 0,
        line_description: `Ingående moms ${vatRate * 100}%`,
      }
    }
  ),
  generateReverseChargeLines: vi.fn().mockImplementation(
    (baseAmount: number, vatRate: number = 0.25) => {
      const vatAmount = Math.round(baseAmount * vatRate * 100) / 100
      let outputAccount: string
      switch (vatRate) {
        case 0.12: outputAccount = '2624'; break
        case 0.06: outputAccount = '2634'; break
        default: outputAccount = '2614'; break
      }
      return [
        { account_number: '2645', debit_amount: vatAmount, credit_amount: 0, line_description: `Fiktiv ingående moms` },
        { account_number: outputAccount, debit_amount: 0, credit_amount: vatAmount, line_description: `Fiktiv utgående moms` },
      ]
    }
  ),
  extractNetAmount: vi.fn().mockImplementation(
    (totalAmount: number, vatRate: number) => {
      if (vatRate === 0) return totalAmount
      return Math.round((totalAmount / (1 + vatRate)) * 100) / 100
    }
  ),
  extractVatAmount: vi.fn().mockImplementation(
    (totalAmount: number, vatRate: number) => {
      if (vatRate === 0) return 0
      return Math.round((totalAmount - totalAmount / (1 + vatRate)) * 100) / 100
    }
  ),
}))

const { createJournalEntry, findFiscalPeriod } = await import('../engine')
const mockedCreateEntry = vi.mocked(createJournalEntry)
const mockedFindFiscalPeriod = vi.mocked(findFiscalPeriod)

const { createTransactionJournalEntry, buildDomesticExpenseLines } = await import('../transaction-entries')

function makeMappingResult(overrides: Partial<MappingResult> = {}): MappingResult {
  return {
    rule: null,
    debit_account: '5410',
    credit_account: '1930',
    risk_level: 'LOW',
    confidence: 0.95,
    requires_review: false,
    default_private: false,
    vat_lines: [],
    description: 'Test mapping',
    ...overrides,
  }
}

/** Balance check helper */
function assertBalanced(input: CreateJournalEntryInput) {
  const totalDebit = input.lines.reduce((sum, l) => sum + l.debit_amount, 0)
  const totalCredit = input.lines.reduce((sum, l) => sum + l.credit_amount, 0)
  expect(totalDebit).toBeCloseTo(totalCredit, 2)
  expect(totalDebit).toBeGreaterThan(0)
}

describe('createTransactionJournalEntry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  // --- Validation ---

  it('throws when debit_account is missing', async () => {
    const tx = makeTransaction()
    const mapping = makeMappingResult({ debit_account: '' })

    await expect(
      createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)
    ).rejects.toThrow('Invalid mapping result')
  })

  it('throws when credit_account is missing', async () => {
    const tx = makeTransaction()
    const mapping = makeMappingResult({ credit_account: '' })

    await expect(
      createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)
    ).rejects.toThrow('Invalid mapping result')
  })

  // --- Fiscal period ---

  it('returns null when no fiscal period found', async () => {
    mockedFindFiscalPeriod.mockResolvedValue(null)
    const tx = makeTransaction()
    const mapping = makeMappingResult()

    const result = await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    expect(result).toBeNull()
    expect(mockedCreateEntry).not.toHaveBeenCalled()
  })

  // --- Private expense ---

  it('creates private expense entry for EF (2013)', async () => {
    const tx = makeTransaction({ amount: -500, description: 'Lunch privat' })
    const mapping = makeMappingResult({
      debit_account: '2013',
      credit_account: '1930',
      default_private: true,
    })

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    expect(mockedCreateEntry).toHaveBeenCalledOnce()
    const input = mockedCreateEntry.mock.calls[0][3]

    expect(input.lines).toHaveLength(2)

    const debit2013 = input.lines.find(l => l.account_number === '2013')
    expect(debit2013?.debit_amount).toBe(500)
    expect(debit2013?.credit_amount).toBe(0)
    expect(debit2013?.line_description).toMatch(/^Privat:/)

    const credit1930 = input.lines.find(l => l.account_number === '1930')
    expect(credit1930?.credit_amount).toBe(500)
    expect(credit1930?.debit_amount).toBe(0)

    assertBalanced(input)
  })

  it('creates private expense entry for AB (2893)', async () => {
    const tx = makeTransaction({ amount: -1200, description: 'Privat uttag' })
    const mapping = makeMappingResult({
      debit_account: '2893',
      credit_account: '1930',
      default_private: true,
    })

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines).toHaveLength(2)

    const debit2893 = input.lines.find(l => l.account_number === '2893')
    expect(debit2893?.debit_amount).toBe(1200)

    const credit1930 = input.lines.find(l => l.account_number === '1930')
    expect(credit1930?.credit_amount).toBe(1200)

    assertBalanced(input)
  })

  // --- Business expense ---

  it('creates business expense without VAT (2 lines)', async () => {
    const tx = makeTransaction({ amount: -299, description: 'Office supplies' })
    const mapping = makeMappingResult({
      debit_account: '5410',
      credit_account: '1930',
      vat_lines: [],
    })

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines).toHaveLength(2)

    const debit5410 = input.lines.find(l => l.account_number === '5410')
    expect(debit5410?.debit_amount).toBe(299)

    const credit1930 = input.lines.find(l => l.account_number === '1930')
    expect(credit1930?.credit_amount).toBe(299)

    assertBalanced(input)
  })

  it('creates business expense with 25% input VAT (3 lines)', async () => {
    const tx = makeTransaction({ amount: -1250, description: 'Software license' })
    const vatLines: VatJournalLine[] = [
      { account_number: '2641', debit_amount: 250, credit_amount: 0, description: 'Ingående moms 25%' },
    ]
    const mapping = makeMappingResult({
      debit_account: '5410',
      credit_account: '1930',
      vat_lines: vatLines,
    })

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines).toHaveLength(3)

    const debit2641 = input.lines.find(l => l.account_number === '2641')
    expect(debit2641?.debit_amount).toBe(250)

    const debit5410 = input.lines.find(l => l.account_number === '5410')
    expect(debit5410?.debit_amount).toBe(1000) // 1250 - 250 VAT

    const credit1930 = input.lines.find(l => l.account_number === '1930')
    expect(credit1930?.credit_amount).toBe(1250)

    assertBalanced(input)
  })

  it('nets the expense line against an underlag VAT override below the rate amount', async () => {
    // Restaurant receipt 415.80 kr incl. dricks: the document's 12% VAT is
    // 42.43 kr (not rate-extraction 44.55) because dricks carries no moms.
    // The expense line must absorb the difference so the entry balances.
    const tx = makeTransaction({ amount: -415.80, description: 'LEONH Repr' })
    const vatLines: VatJournalLine[] = [
      { account_number: '2641', debit_amount: 42.43, credit_amount: 0, description: 'Ingående moms (enligt underlag)' },
    ]
    const mapping = makeMappingResult({
      debit_account: '6071',
      credit_account: '1930',
      vat_lines: vatLines,
    })

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines).toHaveLength(3)

    const debit2641 = input.lines.find(l => l.account_number === '2641')
    expect(debit2641?.debit_amount).toBe(42.43)

    const debit6071 = input.lines.find(l => l.account_number === '6071')
    expect(debit6071?.debit_amount).toBe(373.37) // 415.80 - 42.43

    const credit1930 = input.lines.find(l => l.account_number === '1930')
    expect(credit1930?.credit_amount).toBe(415.80)

    assertBalanced(input)
  })

  it('handles VAT rounding precision on expense', async () => {
    const tx = makeTransaction({ amount: -997.50, description: 'Expense with rounding' })
    const vatLines: VatJournalLine[] = [
      { account_number: '2641', debit_amount: 199.50, credit_amount: 0, description: 'Ingående moms 25%' },
    ]
    const mapping = makeMappingResult({
      debit_account: '5410',
      credit_account: '1930',
      vat_lines: vatLines,
    })

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]
    const debit5410 = input.lines.find(l => l.account_number === '5410')
    // net = Math.round((997.50 - 199.50) * 100) / 100 = 798
    expect(debit5410?.debit_amount).toBe(Math.round((997.50 - 199.50) * 100) / 100)

    assertBalanced(input)
  })

  it('creates expense with EU reverse charge (2645/2614)', async () => {
    const tx = makeTransaction({ amount: -5000, description: 'EU SaaS service' })
    const vatLines: VatJournalLine[] = [
      { account_number: '2645', debit_amount: 1250, credit_amount: 0, description: 'Fiktiv ingående moms' },
      { account_number: '2614', debit_amount: 0, credit_amount: 1250, description: 'Fiktiv utgående moms' },
    ]
    const mapping = makeMappingResult({
      debit_account: '5410',
      credit_account: '1930',
      vat_lines: vatLines,
    })

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]

    const debit2645 = input.lines.find(l => l.account_number === '2645')
    expect(debit2645?.debit_amount).toBe(1250)

    const credit2614 = input.lines.find(l => l.account_number === '2614')
    expect(credit2614?.credit_amount).toBe(1250)

    // Expense: For reverse charge, no 2641 line means netAmount = absAmount - 0 = 5000
    const debit5410 = input.lines.find(l => l.account_number === '5410')
    expect(debit5410?.debit_amount).toBe(5000)

    const credit1930 = input.lines.find(l => l.account_number === '1930')
    expect(credit1930?.credit_amount).toBe(5000)

    assertBalanced(input)
  })

  // --- Income ---

  it('creates income entry without VAT (2 lines)', async () => {
    const tx = makeTransaction({ amount: 8000, description: 'Export revenue' })
    const mapping = makeMappingResult({
      debit_account: '1930',
      credit_account: '3001',
      vat_lines: [],
    })

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines).toHaveLength(2)

    const debit1930 = input.lines.find(l => l.account_number === '1930')
    expect(debit1930?.debit_amount).toBe(8000)

    const credit3001 = input.lines.find(l => l.account_number === '3001')
    expect(credit3001?.credit_amount).toBe(8000)

    assertBalanced(input)
  })

  it('creates income entry with output VAT', async () => {
    const tx = makeTransaction({ amount: 12500, description: 'Sales income' })
    const vatLines: VatJournalLine[] = [
      { account_number: '2611', debit_amount: 0, credit_amount: 2500, description: 'Utgående moms 25%' },
    ]
    const mapping = makeMappingResult({
      debit_account: '1930',
      credit_account: '3001',
      vat_lines: vatLines,
    })

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]

    const debit1930 = input.lines.find(l => l.account_number === '1930')
    expect(debit1930?.debit_amount).toBe(12500)

    const credit3001 = input.lines.find(l => l.account_number === '3001')
    expect(credit3001?.credit_amount).toBe(10000) // 12500 - 2500 VAT

    const credit2611 = input.lines.find(l => l.account_number === '2611')
    expect(credit2611?.credit_amount).toBe(2500)

    assertBalanced(input)
  })

  it('handles VAT rounding precision on income', async () => {
    const tx = makeTransaction({ amount: 333.33, description: 'Small sale' })
    const vatLines: VatJournalLine[] = [
      { account_number: '2611', debit_amount: 0, credit_amount: 66.67, description: 'Utgående moms 25%' },
    ]
    const mapping = makeMappingResult({
      debit_account: '1930',
      credit_account: '3001',
      vat_lines: vatLines,
    })

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]
    const credit3001 = input.lines.find(l => l.account_number === '3001')
    // net = Math.round((333.33 - 66.67) * 100) / 100 = 266.66
    expect(credit3001?.credit_amount).toBe(Math.round((333.33 - 66.67) * 100) / 100)

    assertBalanced(input)
  })

  // --- Foreign currency ---

  it('adds currency metadata to 1930 line for EUR expense', async () => {
    const tx = makeTransaction({
      amount: -100,
      currency: 'EUR',
      amount_sek: null,
      exchange_rate: 11.50,
      description: 'EUR purchase',
    })
    const mapping = makeMappingResult({
      debit_account: '5410',
      credit_account: '1930',
      vat_lines: [],
    })

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]
    const credit1930 = input.lines.find(l => l.account_number === '1930')

    expect(credit1930?.currency).toBe('EUR')
    expect(credit1930?.amount_in_currency).toBe(100)
    expect(credit1930?.exchange_rate).toBe(11.50)

    // All amounts in SEK
    expect(credit1930?.credit_amount).toBe(1150) // 100 * 11.50
    const debit5410 = input.lines.find(l => l.account_number === '5410')
    expect(debit5410?.debit_amount).toBe(1150)

    assertBalanced(input)
  })

  it('SEK transaction has no currency metadata', async () => {
    const tx = makeTransaction({ amount: -500, currency: 'SEK' })
    const mapping = makeMappingResult()

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]
    for (const line of input.lines) {
      expect(line.currency).toBeUndefined()
      expect(line.amount_in_currency).toBeUndefined()
      expect(line.exchange_rate).toBeUndefined()
    }
  })

  // --- Metadata ---

  it('sets source_type and source_id correctly', async () => {
    const tx = makeTransaction({ id: 'tx-abc-123', amount: -100 })
    const mapping = makeMappingResult()

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.source_type).toBe('bank_transaction')
    expect(input.source_id).toBe('tx-abc-123')
  })

  it('uses transaction.date as entry_date', async () => {
    const tx = makeTransaction({ date: '2024-09-15', amount: -100 })
    const mapping = makeMappingResult()

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.entry_date).toBe('2024-09-15')
  })
})

describe('buildDomesticExpenseLines', () => {
  it('25% VAT: 3 lines (expense net + 2641 + 1930)', () => {
    const lines = buildDomesticExpenseLines(1250, '5410', 'Office supplies', 0.25)

    expect(lines).toHaveLength(3)

    const expense = lines.find(l => l.account_number === '5410')
    expect(expense?.debit_amount).toBe(1000) // 1250 / 1.25

    const vat = lines.find(l => l.account_number === '2641')
    expect(vat?.debit_amount).toBe(250) // 1250 - 1000

    const bank = lines.find(l => l.account_number === '1930')
    expect(bank?.credit_amount).toBe(1250)

    const totalDebit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const totalCredit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(totalDebit).toBeCloseTo(totalCredit, 2)
  })

  it('12% VAT: correct amounts', () => {
    const lines = buildDomesticExpenseLines(1120, '5400', 'Food supplies', 0.12)

    expect(lines).toHaveLength(3)

    const expense = lines.find(l => l.account_number === '5400')
    expect(expense?.debit_amount).toBe(1000) // 1120 / 1.12

    const vat = lines.find(l => l.account_number === '2641')
    expect(vat?.debit_amount).toBe(120) // 1120 - 1000

    const bank = lines.find(l => l.account_number === '1930')
    expect(bank?.credit_amount).toBe(1120)

    const totalDebit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const totalCredit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(totalDebit).toBeCloseTo(totalCredit, 2)
  })

  it('vatRate=0: 2 lines, no 2641', () => {
    const lines = buildDomesticExpenseLines(500, '5410', 'No VAT expense', 0)

    expect(lines).toHaveLength(2)

    const expense = lines.find(l => l.account_number === '5410')
    expect(expense?.debit_amount).toBe(500)

    const bank = lines.find(l => l.account_number === '1930')
    expect(bank?.credit_amount).toBe(500)

    const vatLine = lines.find(l => l.account_number === '2641')
    expect(vatLine).toBeUndefined()

    const totalDebit = lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const totalCredit = lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(totalDebit).toBe(totalCredit)
  })

  it('negative amount uses Math.abs', () => {
    const lines = buildDomesticExpenseLines(-750, '5410', 'Negative test', 0)

    expect(lines).toHaveLength(2)

    const expense = lines.find(l => l.account_number === '5410')
    expect(expense?.debit_amount).toBe(750)

    const bank = lines.find(l => l.account_number === '1930')
    expect(bank?.credit_amount).toBe(750)

    // All amounts positive
    for (const line of lines) {
      expect(line.debit_amount).toBeGreaterThanOrEqual(0)
      expect(line.credit_amount).toBeGreaterThanOrEqual(0)
    }
  })
})

describe('createTransactionJournalEntry: dimensions propagation (PR7)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockedFindFiscalPeriod.mockResolvedValue('period-1')
  })

  it('expense: tags ONLY the business debit line: bank and VAT lines stay untagged', async () => {
    const tx = makeTransaction({ amount: -1250, description: 'Software license' })
    const vatLines: VatJournalLine[] = [
      { account_number: '2641', debit_amount: 250, credit_amount: 0, description: 'Ingående moms 25%' },
    ]
    const mapping = makeMappingResult({
      debit_account: '5410',
      credit_account: '1930',
      vat_lines: vatLines,
      dimensions: { '1': 'KS01', '6': 'P001' },
    })

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]

    const debit5410 = input.lines.find(l => l.account_number === '5410')
    expect(debit5410?.dimensions).toEqual({ '1': 'KS01', '6': 'P001' })

    expect(input.lines.find(l => l.account_number === '2641')?.dimensions).toBeUndefined()
    expect(input.lines.find(l => l.account_number === '1930')?.dimensions).toBeUndefined()
  })

  it('income: tags ONLY the revenue credit line: bank and output-VAT lines stay untagged', async () => {
    const tx = makeTransaction({ amount: 12500, description: 'Sales income' })
    const vatLines: VatJournalLine[] = [
      { account_number: '2611', debit_amount: 0, credit_amount: 2500, description: 'Utgående moms 25%' },
    ]
    const mapping = makeMappingResult({
      debit_account: '1930',
      credit_account: '3001',
      vat_lines: vatLines,
      dimensions: { '6': 'P001' },
    })

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]

    expect(input.lines.find(l => l.account_number === '3001')?.dimensions).toEqual({ '6': 'P001' })
    expect(input.lines.find(l => l.account_number === '2611')?.dimensions).toBeUndefined()
    expect(input.lines.find(l => l.account_number === '1930')?.dimensions).toBeUndefined()
  })

  it('all_lines_complete: each vat_lines[i].dimensions is used per line, with NO fallback to mappingResult.dimensions', async () => {
    const tx = makeTransaction({ amount: -1250, description: 'Multi-line pattern' })
    const vatLines: VatJournalLine[] = [
      { account_number: '5410', debit_amount: 1000, credit_amount: 0, description: 'Kostnad', dimensions: { '6': 'P001' } },
      // No dimensions on the VAT line: must NOT inherit the categorize-level bag.
      { account_number: '2641', debit_amount: 250, credit_amount: 0, description: 'Ingående moms' },
    ]
    const mapping = makeMappingResult({
      debit_account: '5410',
      credit_account: '1930',
      all_lines_complete: true,
      vat_lines: vatLines,
      // Would mis-tag the VAT line if any fallback existed.
      dimensions: { '1': 'LEAK' },
    })

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines).toHaveLength(3)

    expect(input.lines.find(l => l.account_number === '5410')?.dimensions).toEqual({ '6': 'P001' })
    expect(input.lines.find(l => l.account_number === '2641')?.dimensions).toBeUndefined()
    // Settlement line stays untagged.
    expect(input.lines.find(l => l.account_number === '1930')?.dimensions).toBeUndefined()

    assertBalanced(input)
  })

  it('all_lines_complete income: per-line bags authoritative on the credit side too', async () => {
    const tx = makeTransaction({ amount: 12500, description: 'Multi-line income' })
    const vatLines: VatJournalLine[] = [
      { account_number: '3001', debit_amount: 0, credit_amount: 10000, description: 'Försäljning', dimensions: { '1': 'KS01' } },
      { account_number: '2611', debit_amount: 0, credit_amount: 2500, description: 'Utgående moms' },
    ]
    const mapping = makeMappingResult({
      debit_account: '1930',
      credit_account: '3001',
      all_lines_complete: true,
      vat_lines: vatLines,
      dimensions: { '1': 'LEAK' },
    })

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]
    expect(input.lines.find(l => l.account_number === '3001')?.dimensions).toEqual({ '1': 'KS01' })
    expect(input.lines.find(l => l.account_number === '2611')?.dimensions).toBeUndefined()
    expect(input.lines.find(l => l.account_number === '1930')?.dimensions).toBeUndefined()
  })

  it('default_private path never tags: even when a bag is set on the mapping', async () => {
    const tx = makeTransaction({ amount: -500, description: 'Lunch privat' })
    const mapping = makeMappingResult({
      debit_account: '2013',
      credit_account: '1930',
      default_private: true,
      dimensions: { '1': 'KS01' },
    })

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]
    for (const line of input.lines) {
      expect(line.dimensions).toBeUndefined()
    }
  })

  it('no bag on the mapping → business line stays untagged', async () => {
    const tx = makeTransaction({ amount: -299 })
    const mapping = makeMappingResult({ debit_account: '5410', credit_account: '1930' })

    await createTransactionJournalEntry(null as never, 'company-1', 'user-1', tx, mapping)

    const input = mockedCreateEntry.mock.calls[0][3]
    for (const line of input.lines) {
      expect(line.dimensions).toBeUndefined()
    }
  })
})
