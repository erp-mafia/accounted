import { describe, it, expect } from 'vitest'
import { generateImportPreview, validateIBBalance, isBalanceSheetAccount } from '../sie-import'
import type { ParsedSIEFile, AccountMapping } from '../types'

// --- Helpers ---

function makeParsedFile(overrides?: Partial<ParsedSIEFile>): ParsedSIEFile {
  return {
    header: {
      sieType: 4,
      program: 'TestProg',
      programVersion: '1.0',
      generatedDate: '2024-01-01',
      format: 'PC8',
      companyName: 'Test AB',
      orgNumber: '5566778899',
      address: null,
      fiscalYears: [{ yearIndex: 0, start: '2024-01-01', end: '2024-12-31' }],
      currency: 'SEK',
      kontoPlanType: null,
    },
    accounts: [
      { number: '1510', name: 'Kundfordringar' },
      { number: '1930', name: 'Företagskonto' },
      { number: '2440', name: 'Leverantörsskulder' },
    ],
    openingBalances: [
      { yearIndex: 0, account: '1510', amount: 50000 },
      { yearIndex: 0, account: '1930', amount: 100000 },
      { yearIndex: 0, account: '2440', amount: -150000 },
    ],
    closingBalances: [],
    resultBalances: [],
    vouchers: [
      {
        series: 'A',
        number: 1,
        date: new Date(2024, 0, 15),
        description: 'Faktura 1001',
        lines: [
          { account: '1510', amount: 12500 },
          { account: '3001', amount: -10000 },
          { account: '2611', amount: -2500 },
        ],
      },
    ],
    issues: [],
    stats: {
      totalAccounts: 3,
      totalVouchers: 1,
      totalTransactionLines: 3,
      fiscalYearStart: '2024-01-01',
      fiscalYearEnd: '2024-12-31',
    },
    ...overrides,
  }
}

function makeMapping(source: string, target: string, confidence: number = 1.0): AccountMapping {
  return {
    sourceAccount: source,
    sourceName: `Account ${source}`,
    targetAccount: target,
    targetName: `Target ${target}`,
    confidence,
    matchType: target ? 'exact' : 'manual',
    isOverride: false,
  }
}

// --- Tests ---

describe('generateImportPreview', () => {
  describe('trial balance from IB', () => {
    it('calculates debit totals from positive IB amounts', () => {
      const parsed = makeParsedFile()
      const mappings = [
        makeMapping('1510', '1510'),
        makeMapping('1930', '1930'),
        makeMapping('2440', '2440'),
      ]
      const preview = generateImportPreview(parsed, mappings)

      // Positive amounts: 50000 + 100000 = 150000
      expect(preview.trialBalance.totalDebit).toBe(150000)
    })

    it('calculates credit totals from negative IB amounts', () => {
      const parsed = makeParsedFile()
      const mappings = [
        makeMapping('1510', '1510'),
        makeMapping('1930', '1930'),
        makeMapping('2440', '2440'),
      ]
      const preview = generateImportPreview(parsed, mappings)

      // Negative amounts: |-150000| = 150000
      expect(preview.trialBalance.totalCredit).toBe(150000)
    })

    it('detects balanced trial balance', () => {
      const parsed = makeParsedFile()
      const mappings = [makeMapping('1510', '1510')]
      const preview = generateImportPreview(parsed, mappings)

      // 150000 debit = 150000 credit
      expect(preview.trialBalance.isBalanced).toBe(true)
    })

    it('detects unbalanced trial balance', () => {
      const parsed = makeParsedFile({
        openingBalances: [
          { yearIndex: 0, account: '1510', amount: 50000 },
          { yearIndex: 0, account: '1930', amount: 100000 },
          // Missing credit side — only 150000 debit, 0 credit
        ],
      })
      const mappings = [makeMapping('1510', '1510')]
      const preview = generateImportPreview(parsed, mappings)

      expect(preview.trialBalance.isBalanced).toBe(false)
    })

    it('handles zero opening balances', () => {
      const parsed = makeParsedFile({ openingBalances: [] })
      const mappings: AccountMapping[] = []
      const preview = generateImportPreview(parsed, mappings)

      expect(preview.trialBalance.totalDebit).toBe(0)
      expect(preview.trialBalance.totalCredit).toBe(0)
      expect(preview.trialBalance.isBalanced).toBe(true)
    })
  })

  describe('company info passthrough', () => {
    it('passes company name', () => {
      const parsed = makeParsedFile()
      const preview = generateImportPreview(parsed, [])
      expect(preview.companyName).toBe('Test AB')
    })

    it('passes org number', () => {
      const parsed = makeParsedFile()
      const preview = generateImportPreview(parsed, [])
      expect(preview.orgNumber).toBe('5566778899')
    })

    it('handles null company info', () => {
      const parsed = makeParsedFile({
        header: {
          ...makeParsedFile().header,
          companyName: null,
          orgNumber: null,
        },
      })
      const preview = generateImportPreview(parsed, [])
      expect(preview.companyName).toBeNull()
      expect(preview.orgNumber).toBeNull()
    })
  })

  describe('mapping status', () => {
    it('reflects mapper output counts', () => {
      const parsed = makeParsedFile()
      const mappings = [
        makeMapping('1510', '1510'),     // mapped
        makeMapping('1930', '1930'),     // mapped
        makeMapping('2440', '', 0),       // unmapped
      ]
      const preview = generateImportPreview(parsed, mappings)

      expect(preview.mappingStatus.total).toBe(3)
      expect(preview.mappingStatus.mapped).toBe(2)
      expect(preview.mappingStatus.unmapped).toBe(1)
    })

    it('reports low confidence mappings', () => {
      const mappings = [
        makeMapping('1510', '1510', 1.0),
        makeMapping('3400', '3001', 0.3), // low confidence
      ]
      const parsed = makeParsedFile()
      const preview = generateImportPreview(parsed, mappings)

      expect(preview.mappingStatus.lowConfidence).toBe(1)
    })
  })

  describe('statistics', () => {
    it('passes account count', () => {
      const parsed = makeParsedFile()
      const preview = generateImportPreview(parsed, [])
      expect(preview.accountCount).toBe(3)
    })

    it('passes voucher count', () => {
      const parsed = makeParsedFile()
      const preview = generateImportPreview(parsed, [])
      expect(preview.voucherCount).toBe(1)
    })

    it('passes transaction line count', () => {
      const parsed = makeParsedFile()
      const preview = generateImportPreview(parsed, [])
      expect(preview.transactionLineCount).toBe(3)
    })
  })

  describe('issues passthrough', () => {
    it('passes parse issues to preview', () => {
      const parsed = makeParsedFile({
        issues: [
          { severity: 'warning', line: 5, message: 'Unknown tag: #FOO', tag: 'FOO' },
          { severity: 'error', line: 10, message: 'Invalid voucher', tag: 'VER' },
        ],
      })
      const preview = generateImportPreview(parsed, [])

      expect(preview.issues).toHaveLength(2)
      expect(preview.issues[0].severity).toBe('warning')
      expect(preview.issues[1].severity).toBe('error')
    })
  })
})

describe('validateIBBalance', () => {
  it('returns 0 roundingAdjustment when IB is balanced', () => {
    const parsed = makeParsedFile({
      openingBalances: [
        { yearIndex: 0, account: '1510', amount: 50000 },
        { yearIndex: 0, account: '2440', amount: -50000 },
      ],
    })
    const accountMap = new Map([['1510', '1510'], ['2440', '2440']])
    const result = validateIBBalance(parsed, accountMap)

    expect(result.roundingAdjustment).toBe(0)
    expect(result.fileImbalance).toBe(0)
    expect(result.excludedAccountsTotal).toBe(0)
    expect(result.lines).toHaveLength(2)
  })

  it('returns rounding adjustment for imbalance <= 1 SEK', () => {
    const parsed = makeParsedFile({
      openingBalances: [
        { yearIndex: 0, account: '1510', amount: 50000.50 },
        { yearIndex: 0, account: '2440', amount: -50000 },
      ],
    })
    const accountMap = new Map([['1510', '1510'], ['2440', '2440']])
    const result = validateIBBalance(parsed, accountMap)

    expect(result.roundingAdjustment).toBe(0.5)
    expect(result.fileImbalance).toBe(0.5)
  })

  it('returns large adjustment for file-level imbalance (unallocated årets resultat)', () => {
    // Simulates a Fortnox export where previous year result hasn't been allocated
    // to equity — BS accounts don't balance because årets resultat is implicit
    const parsed = makeParsedFile({
      openingBalances: [
        { yearIndex: 0, account: '1510', amount: 50100 },
        { yearIndex: 0, account: '2440', amount: -50000 },
      ],
    })
    const accountMap = new Map([['1510', '1510'], ['2440', '2440']])
    const result = validateIBBalance(parsed, accountMap)

    // The adjustment is 100 SEK — caller should book to 2099, never reject
    expect(result.roundingAdjustment).toBe(100)
    expect(result.fileImbalance).toBe(100)
    expect(result.excludedAccountsTotal).toBe(0)
  })

  it('tracks excluded accounts separately from file imbalance (Fortnox system accounts)', () => {
    // Simulates Fortnox 0099 carrying IB balance — file is balanced,
    // but mapped accounts are not because 0099 is excluded from mapping
    const parsed = makeParsedFile({
      openingBalances: [
        { yearIndex: 0, account: '1510', amount: 50000 },
        { yearIndex: 0, account: '2440', amount: -150000 },
        { yearIndex: 0, account: '0099', amount: 100000 },  // System account, not mapped
      ],
    })
    const accountMap = new Map([['1510', '1510'], ['2440', '2440']])
    const result = validateIBBalance(parsed, accountMap)

    // File-level: 50000 + (-150000) + 100000 = 0, balanced
    expect(result.fileImbalance).toBe(0)
    // Mapped-level: 50000 debit, 150000 credit = -100000 diff
    expect(result.roundingAdjustment).toBe(-100000)
    // The excluded 0099 accounts for the entire difference
    expect(result.excludedAccountsTotal).toBe(100000)
    // Only 2 lines (0099 excluded)
    expect(result.lines).toHaveLength(2)
  })

  it('ignores non-current-year balances', () => {
    const parsed = makeParsedFile({
      openingBalances: [
        { yearIndex: 0, account: '1510', amount: 50000 },
        { yearIndex: 0, account: '2440', amount: -50000 },
        { yearIndex: -1, account: '1510', amount: 99999 }, // Previous year — ignored
      ],
    })
    const accountMap = new Map([['1510', '1510'], ['2440', '2440']])
    const result = validateIBBalance(parsed, accountMap)

    expect(result.roundingAdjustment).toBe(0)
    expect(result.lines).toHaveLength(2)
  })
})

describe('isBalanceSheetAccount', () => {
  it('returns true for class 1 (assets)', () => {
    expect(isBalanceSheetAccount('1510')).toBe(true)
    expect(isBalanceSheetAccount('1930')).toBe(true)
  })

  it('returns true for class 2 (liabilities/equity)', () => {
    expect(isBalanceSheetAccount('2099')).toBe(true)
    expect(isBalanceSheetAccount('2440')).toBe(true)
  })

  it('returns false for class 3 (revenue)', () => {
    expect(isBalanceSheetAccount('3001')).toBe(false)
    expect(isBalanceSheetAccount('3740')).toBe(false)
  })

  it('returns false for class 4-8 (expenses)', () => {
    expect(isBalanceSheetAccount('4010')).toBe(false)
    expect(isBalanceSheetAccount('5010')).toBe(false)
    expect(isBalanceSheetAccount('6211')).toBe(false)
    expect(isBalanceSheetAccount('7210')).toBe(false)
    expect(isBalanceSheetAccount('8999')).toBe(false)
  })
})
