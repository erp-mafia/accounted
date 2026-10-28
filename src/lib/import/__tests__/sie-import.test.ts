import { describe, it, expect } from 'vitest'
import {
  generateImportPreview,
  validateIBBalance,
  isBalanceSheetAccount,
  ensureFiscalPeriod,
  precheckFiscalPeriod,
  prepareSIEVouchers,
  buildSIEOpeningBalanceEntry,
  computeVoucherNumberRanges,
} from '../sie-import'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { ORE_ROUNDING_ACCOUNT } from '@/lib/money'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import type { ParsedSIEFile, AccountMapping } from '../types'

// --- Helpers ---

function makeParsedFile(overrides?: Partial<ParsedSIEFile>): ParsedSIEFile {
  return {
    header: {
      sieType: 4,
      flagga: 0,
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
    dimensions: [],
    dimensionValues: [],
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
          // Missing credit side: only 150000 debit, 0 credit
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
          { severity: 'warning', line: 5, message: 'Okänd tagg: #FOO, ignoreras', tag: 'FOO' },
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

  it('books a difference of exactly one öre instead of dropping it', () => {
    // Production: debit 1092065.44 vs credit 1092065.43 passed preparation
    // with no balancing line and import_sie_chunk rejected the IB voucher.
    const parsed = makeParsedFile({
      openingBalances: [
        { yearIndex: 0, account: '1930', amount: 1092065.44 },
        { yearIndex: 0, account: '2081', amount: -1092065.43 },
      ],
    })
    const accountMap = new Map([['1930', '1930'], ['2081', '2081']])
    const result = validateIBBalance(parsed, accountMap)

    expect(result.roundingAdjustment).toBe(0.01)
    expect(result.fileImbalance).toBe(0.01)
  })

  it('books a one öre difference on the credit side too', () => {
    const parsed = makeParsedFile({
      openingBalances: [
        { yearIndex: 0, account: '1930', amount: 2318713.0 },
        { yearIndex: 0, account: '2081', amount: -2318713.01 },
      ],
    })
    const accountMap = new Map([['1930', '1930'], ['2081', '2081']])
    const result = validateIBBalance(parsed, accountMap)

    expect(result.roundingAdjustment).toBe(-0.01)
  })

  it('returns large adjustment for file-level imbalance (unallocated årets resultat)', () => {
    // Simulates a Fortnox export where previous year result hasn't been allocated
    // to equity: BS accounts don't balance because årets resultat is implicit
    const parsed = makeParsedFile({
      openingBalances: [
        { yearIndex: 0, account: '1510', amount: 50100 },
        { yearIndex: 0, account: '2440', amount: -50000 },
      ],
    })
    const accountMap = new Map([['1510', '1510'], ['2440', '2440']])
    const result = validateIBBalance(parsed, accountMap)

    // The adjustment is 100 SEK: caller should book to 2099, never reject
    expect(result.roundingAdjustment).toBe(100)
    expect(result.fileImbalance).toBe(100)
    expect(result.excludedAccountsTotal).toBe(0)
  })

  it('tracks excluded accounts separately from file imbalance (Fortnox system accounts)', () => {
    // Simulates Fortnox 0099 carrying IB balance: file is balanced,
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
        { yearIndex: -1, account: '1510', amount: 99999 }, // Previous year, ignored
      ],
    })
    const accountMap = new Map([['1510', '1510'], ['2440', '2440']])
    const result = validateIBBalance(parsed, accountMap)

    expect(result.roundingAdjustment).toBe(0)
    expect(result.lines).toHaveLength(2)
  })
})

describe('buildSIEOpeningBalanceEntry with a one öre difference', () => {
  it('adds the balancing line so the IB voucher balances', () => {
    const parsed = makeParsedFile({
      openingBalances: [
        { yearIndex: 0, account: '1930', amount: 1092065.44 },
        { yearIndex: 0, account: '2081', amount: -1092065.43 },
      ],
    })
    const accountMap = new Map([['1930', '1930'], ['2081', '2081']])
    const { roundingAdjustment } = validateIBBalance(parsed, accountMap)
    const entry = buildSIEOpeningBalanceEntry('fp-1', parsed, accountMap, roundingAdjustment, 'IB', '2099')

    expect(entry).not.toBeNull()
    expect(entry!.lines).toHaveLength(3)
    const adjustment = entry!.lines[2]
    expect(adjustment.account_number).toBe('2099')
    expect(adjustment.credit_amount).toBe(0.01)
    const debit = Math.round(entry!.lines.reduce((s, l) => s + l.debit_amount, 0) * 100) / 100
    const credit = Math.round(entry!.lines.reduce((s, l) => s + l.credit_amount, 0) * 100) / 100
    expect(debit).toBe(credit)
  })
})

describe('ensureFiscalPeriod validation', () => {
  // Mirrors the `enforce_period_start_day` DB trigger so users get an
  // actionable Swedish error instead of a raw Postgres message.
  type Supabase = Parameters<typeof ensureFiscalPeriod>[0]

  it('rejects mid-month start when an earlier period already exists', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null }, // containing check, no match
      { data: [], error: null },   // overlapping check, none
      { data: [{ id: 'earlier' }], error: null }, // earlier period exists
    ])

    await expect(
      ensureFiscalPeriod(
        supabase as unknown as Supabase,
        'company-id',
        '2026-04-16',
        '2026-12-31',
      ),
    ).rejects.toThrow(/kronologiskt första räkenskapsår får börja mitt i månaden/)
  })

  it('rejects end date that is not the last day of the month', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      { data: [], error: null },
      { data: [], error: null }, // no earlier period
    ])

    await expect(
      ensureFiscalPeriod(
        supabase as unknown as Supabase,
        'company-id',
        '2026-01-01',
        '2026-12-30', // not the last day of December
      ),
    ).rejects.toThrow(/måste sluta på månadens sista dag/)
  })

  it('allows mid-month start for the company first fiscal period', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      { data: [], error: null },
      { data: [], error: null }, // no earlier period
      { data: [], error: null }, // no predecessor in the continuity chain
      { data: { id: 'new-period-id' }, error: null }, // insert result
      { data: [], error: null }, // no successor to relink
    ])

    const id = await ensureFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2026-04-16',
      '2026-12-31',
    )

    expect(id).toBe('new-period-id')
  })

  it('allows mid-month start when importing a retroactive earliest period', async () => {
    // Scenario: onboarding created a 2026 fiscal period, user now imports
    // an SIE for their förlängt första räkenskapsår 2017-07-28 to 2018-12-31.
    // The 2017 period is chronologically earliest, so mid-month start is
    // legal under BFL 3 kap.
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null }, // containing check, no match
      { data: [], error: null },   // overlapping check, none (2017 vs 2026)
      { data: [], error: null },   // no earlier period than 2017-07-28
      { data: [], error: null },   // no predecessor in the continuity chain
      { data: { id: 'retro-first-year-id' }, error: null }, // insert
      { data: [], error: null },   // no successor to relink
    ])

    const id = await ensureFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2017-07-28',
      '2018-12-31',
    )

    expect(id).toBe('retro-first-year-id')
  })

  it('reuses an existing period that contains the range (no validation needed)', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: { id: 'existing-period-id' }, error: null }, // containing match
    ])

    const id = await ensureFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2026-04-16',
      '2026-12-31',
    )

    expect(id).toBe('existing-period-id')
  })

  it('rejects when an existing period overlaps the range but already has posted entries', async () => {
    // Regression: previously fell through to the overlapping period silently,
    // which stamped every imported voucher with a fiscal_period_id whose
    // window did not cover the voucher's own entry_date, breaking the SIE
    // invariant and BFL 5 kap. (verifikationsnummer per räkenskapsår).
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null }, // containing check, no match
      {
        data: [
          {
            id: 'calendar-2026',
            period_start: '2026-01-01',
            period_end: '2026-12-31',
            name: 'Räkenskapsår 2026',
            is_closed: false,
            locked_at: null,
            opening_balances_set: false,
          },
        ],
        error: null,
      },
      { data: [{ id: 'entry-1' }], error: null }, // journal_entries: has at least one
    ])

    await expect(
      ensureFiscalPeriod(
        supabase as unknown as Supabase,
        'company-id',
        '2025-03-01', // a broken FY March-Feb
        '2026-02-28',
      ),
    ).rejects.toThrow(/Inställningar → Företag/)
  })

  it('replaces an overlapping period when it is empty (onboarding-seeded)', async () => {
    // Real-world case: onboarding seeded Räkenskapsår 2026 =
    // 2026-01-01 to 2026-12-31; the user has a förlängt första räkenskapsår
    // 2025-10-20 to 2026-12-31 (BFL 3 kap.) and imports an SIE for it.
    // The seeded period carries no data, so we replace it.
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null }, // containing check, no match
      {
        data: [
          {
            id: 'seeded-2026',
            period_start: '2026-01-01',
            period_end: '2026-12-31',
            name: 'Räkenskapsår 2026',
            is_closed: false,
            locked_at: null,
            opening_balances_set: false,
          },
        ],
        error: null,
      },
      { data: [], error: null }, // journal_entries: none
      { data: [], error: null }, // earlier-period check, none (mid-month start)
      { data: null, error: null }, // delete result
      { data: [], error: null }, // no predecessor in the continuity chain
      { data: { id: 'replaced-id' }, error: null }, // insert result
      { data: [], error: null }, // no successor to relink
    ])

    const id = await ensureFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2025-10-20',
      '2026-12-31',
    )

    expect(id).toBe('replaced-id')
  })

  it('refuses to replace an overlapping period whose opening balances are already set', async () => {
    // opening_balances_set: true short-circuits the replaceability gate before
    // we even look at journal_entries: the period clearly carries user data.
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      {
        data: [
          {
            id: 'with-ib-2026',
            period_start: '2026-01-01',
            period_end: '2026-12-31',
            name: 'Räkenskapsår 2026',
            is_closed: false,
            locked_at: null,
            opening_balances_set: true,
          },
        ],
        error: null,
      },
    ])

    await expect(
      ensureFiscalPeriod(
        supabase as unknown as Supabase,
        'company-id',
        '2025-10-20',
        '2026-12-31',
      ),
    ).rejects.toThrow(/Inställningar → Företag/)
  })

  it('refuses to replace an overlapping period that is locked', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      {
        data: [
          {
            id: 'locked-2026',
            period_start: '2026-01-01',
            period_end: '2026-12-31',
            name: 'Räkenskapsår 2026',
            is_closed: false,
            locked_at: '2026-03-15T10:00:00Z',
            opening_balances_set: false,
          },
        ],
        error: null,
      },
    ])

    await expect(
      ensureFiscalPeriod(
        supabase as unknown as Supabase,
        'company-id',
        '2025-10-20',
        '2026-12-31',
      ),
    ).rejects.toThrow(/överlappar men matchar inte/)
  })

  it('relinks the immediate successor when an earlier period is imported later', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      { data: [], error: null },
      { data: [], error: null },
      { data: { id: 'fp-2025' }, error: null },
      { data: [{ id: 'fp-2026', period_start: '2026-01-01' }], error: null },
      { data: null, error: null },
    ])

    const id = await ensureFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2025-01-01',
      '2025-12-31',
    )

    expect(id).toBe('fp-2025')
    expect(findCalls('fiscal_periods', 'update')).toContainEqual([
      { previous_period_id: 'fp-2025' },
    ])
  })

  // previous_period_id means "the räkenskapsår immediately before". Linking
  // the NEAREST period across a gap of missing years made year-end seed a
  // company's opening balances two years forward (feedback seq 249297): the
  // chain must only ever be wired between date-adjacent periods.
  it('does not relink a successor that is not date-adjacent (gap of missing years)', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      { data: [], error: null },
      { data: [], error: null },
      { data: { id: 'fp-2024-25' }, error: null },
      // Onboarding-seeded 2026/2027 exists; 2025/2026 is missing.
      { data: [{ id: 'fp-2026-27', period_start: '2026-05-01' }], error: null },
    ])

    const id = await ensureFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2024-05-01',
      '2025-04-30',
    )

    expect(id).toBe('fp-2024-25')
    expect(findCalls('fiscal_periods', 'update')).toEqual([])
  })

  it('links the predecessor only when it ends the day before the new period starts', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      { data: [], error: null },
      { data: [{ id: 'fp-2022', period_end: '2022-12-31' }], error: null }, // nearest, but 2023-2024 missing
      { data: { id: 'fp-2025' }, error: null },
      { data: [], error: null },
    ])

    await ensureFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2025-01-01',
      '2025-12-31',
    )

    const [insertPayload] = findCalls('fiscal_periods', 'insert')[0] as [{ previous_period_id: string | null }]
    expect(insertPayload.previous_period_id).toBeNull()

    const adjacent = createQueuedMockSupabase()
    adjacent.enqueueMany([
      { data: null, error: null },
      { data: [], error: null },
      { data: [{ id: 'fp-2024', period_end: '2024-12-31' }], error: null },
      { data: { id: 'fp-2025' }, error: null },
      { data: [], error: null },
    ])

    await ensureFiscalPeriod(
      adjacent.supabase as unknown as Supabase,
      'company-id',
      '2025-01-01',
      '2025-12-31',
    )

    const [adjacentPayload] = adjacent.findCalls('fiscal_periods', 'insert')[0] as [{ previous_period_id: string | null }]
    expect(adjacentPayload.previous_period_id).toBe('fp-2024')
  })

  // BFL 3 kap. caps any räkenskapsår at 18 months (12 is the norm; 18 is the
  // ceiling for a förlängt/omlagt year). #RAR used to be validated for start
  // and end DAY only, so a 24-month räkenskapsår from a foreign system
  // imported cleanly and stamped every voucher with an illegal period. The cap
  // now mirrors validatePeriodDuration(), which the fiscal-periods routes,
  // period-service and onboarding already enforce.
  describe('18-month cap (BFL 3 kap.)', () => {
    /** Queue for the happy path: day-1 start, so the earlier-period lookup is skipped. */
    const createQueue = (newId: string) => [
      { data: null, error: null }, // containing check, no match
      { data: [], error: null },   // overlapping check, none
      { data: [], error: null },   // no predecessor in the continuity chain
      { data: { id: newId }, error: null }, // insert result
      { data: [], error: null },   // no successor to relink
    ]

    it('allows a normal 12-month räkenskapsår (unaffected by the cap)', async () => {
      const { supabase, enqueueMany } = createQueuedMockSupabase()
      enqueueMany(createQueue('calendar-2026'))

      const id = await ensureFiscalPeriod(
        supabase as unknown as Supabase,
        'company-id',
        '2026-01-01',
        '2026-12-31',
      )

      expect(id).toBe('calendar-2026')
    })

    it('allows exactly 18 months (förlängt räkenskapsår, the legal maximum)', async () => {
      const { supabase, enqueueMany } = createQueuedMockSupabase()
      enqueueMany(createQueue('extended-first-year'))

      const id = await ensureFiscalPeriod(
        supabase as unknown as Supabase,
        'company-id',
        '2025-07-01',
        '2026-12-31',
      )

      expect(id).toBe('extended-first-year')
    })

    it('refuses 19 months, one month past the cap', async () => {
      const { supabase, enqueueMany } = createQueuedMockSupabase()
      enqueueMany([
        { data: null, error: null }, // containing check, no match
        { data: [], error: null },   // overlapping check, none
      ])

      await expect(
        ensureFiscalPeriod(
          supabase as unknown as Supabase,
          'company-id',
          '2025-06-01',
          '2026-12-31',
        ),
      ).rejects.toThrow(/omfattar 19 månader.*högst 18 månader \(BFL 3 kap\.\)/s)
    })

    it('refuses a 24-month räkenskapsår and names the recovery path', async () => {
      const { supabase, enqueueMany } = createQueuedMockSupabase()
      enqueueMany([
        { data: null, error: null },
        { data: [], error: null },
      ])

      await expect(
        ensureFiscalPeriod(
          supabase as unknown as Supabase,
          'company-id',
          '2025-01-01',
          '2026-12-31',
        ),
      ).rejects.toThrow(/omfattar 24 månader/)

      // The message has to tell an accountant who cannot edit the SIE file what
      // to do instead: re-export one räkenskapsår per file from the source system.
      await expect(
        ensureFiscalPeriod(
          supabase as unknown as Supabase,
          'company-id',
          '2025-01-01',
          '2026-12-31',
        ),
      ).rejects.toThrow(/exportera om från källsystemet med ett räkenskapsår per fil/)
    })

    it('refuses before deleting an empty seeded period, leaving the company untouched', async () => {
      // The over-long range overlaps an onboarding-seeded period that the
      // importer would otherwise replace. The cap runs before that destructive
      // delete, so a refused import costs the user nothing.
      const { supabase, enqueueMany } = createQueuedMockSupabase()
      enqueueMany([
        { data: null, error: null }, // containing check, no match
        {
          data: [
            {
              id: 'seeded-2026',
              period_start: '2026-01-01',
              period_end: '2026-12-31',
              name: 'Räkenskapsår 2026',
              is_closed: false,
              locked_at: null,
              opening_balances_set: false,
            },
          ],
          error: null,
        },
        { data: [], error: null }, // journal_entries: none, so the period is replaceable
      ])

      await expect(
        ensureFiscalPeriod(
          supabase as unknown as Supabase,
          'company-id',
          '2025-01-01',
          '2026-12-31',
        ),
      ).rejects.toThrow(/högst 18 månader/)

      // containing + overlapping + journal_entries only: no delete, no insert.
      expect(supabase.from).toHaveBeenCalledTimes(3)
    })

    it('checks every #RAR range it is handed, not just the first', async () => {
      // A SIE migration walks one räkenskapsår per file (#RAR 0 each time), so
      // the realistic failure is a valid current year followed by a broken
      // prior year. Each range is validated on its own; a good year importing
      // does not buy the next one a pass.
      const { supabase, enqueueMany } = createQueuedMockSupabase()
      enqueueMany(createQueue('year-2026'))

      const currentYear = await ensureFiscalPeriod(
        supabase as unknown as Supabase,
        'company-id',
        '2026-01-01',
        '2026-12-31',
      )
      expect(currentYear).toBe('year-2026')

      enqueueMany([
        { data: null, error: null },
        { data: [], error: null },
      ])

      await expect(
        ensureFiscalPeriod(
          supabase as unknown as Supabase,
          'company-id',
          '2024-01-01',
          '2025-12-31', // 24 months masquerading as the prior year
        ),
      ).rejects.toThrow(/omfattar 24 månader/)
    })
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

describe('computeVoucherNumberRanges', () => {
  it('returns empty array for no mapping', () => {
    expect(computeVoucherNumberRanges([])).toEqual([])
  })

  it('produces one range per series with correct from/to', () => {
    const ranges = computeVoucherNumberRanges([
      { sourceId: 'B1', series: 'B', targetNumber: 1 },
      { sourceId: 'B2', series: 'B', targetNumber: 2 },
      { sourceId: 'B3', series: 'B', targetNumber: 3 },
      { sourceId: 'C1', series: 'C', targetNumber: 1 },
      { sourceId: 'C2', series: 'C', targetNumber: 2 },
      { sourceId: 'V1', series: 'V', targetNumber: 1 },
    ])

    expect(ranges).toEqual([
      { series: 'B', from: 1, to: 3 },
      { series: 'C', from: 1, to: 2 },
      { series: 'V', from: 1, to: 1 },
    ])
  })

  it('handles non-contiguous target numbers per series', () => {
    const ranges = computeVoucherNumberRanges([
      { sourceId: 'B1', series: 'B', targetNumber: 5 },
      { sourceId: 'B2', series: 'B', targetNumber: 9 },
    ])
    expect(ranges).toEqual([{ series: 'B', from: 5, to: 9 }])
  })
})

describe('prepareSIEVouchers: per-voucher series preservation', () => {
  function makeVoucher(
    series: string,
    number: number,
    lines: Array<{ account: string; amount: number }> = [
      { account: '1510', amount: 1000 },
      { account: '3001', amount: -1000 },
    ],
  ) {
    return {
      series,
      number,
      date: new Date(2024, 0, 15),
      description: `Voucher ${series}${number}`,
      lines,
    }
  }

  const baseMap = new Map([
    ['1510', '1510'],
    ['3001', '3001'],
  ])

  function prepare(
    parsed: ParsedSIEFile,
    accountMap: Map<string, string>,
    defaultSeries: string,
    options: { startOrdinal?: number; sieImportId?: string; accountIds?: Map<string, string> } = {},
  ) {
    return prepareSIEVouchers(parsed, accountMap, defaultSeries, options.sieImportId ?? 'import-1', {
      startOrdinal: options.startOrdinal ?? 0,
      accountIds: options.accountIds ?? new Map(),
    })
  }

  it('routes each voucher to its source series (B, C, V → B, C, V)', () => {
    const parsed = makeParsedFile({
      vouchers: [
        makeVoucher('B', 1),
        makeVoucher('B', 2),
        makeVoucher('C', 1),
        makeVoucher('V', 1),
      ],
    })

    const result = prepare(
      parsed,
      baseMap,
      'B', // fallback (should not be used here: all vouchers have series)
      { accountIds: new Map([['1510', 'acc-1510'], ['3001', 'acc-3001']]) },
    )

    expect(result.preparedEntries.map((e) => e.series)).toEqual(['B', 'B', 'C', 'V'])
    expect(result.preparedEntries[0].lines.map((l) => l.account_id)).toEqual(['acc-1510', 'acc-3001'])
  })

  it('sends #BTRANS/#RTRANS history as corrections on the payload, never as lines (#2427)', () => {
    const corrected = {
      ...makeVoucher('A', 7, [
        { account: '3001', amount: 1200 },
        { account: '1510', amount: -1200 },
      ]),
      corrections: {
        struck: [{ account: '1510', amount: 1200, description: 'Fel konto', signature: 'EL' }],
        added: [{ account: '3001', amount: 1200, signature: 'EL' }],
      },
    }
    const parsed = makeParsedFile({ vouchers: [makeVoucher('A', 6), corrected] })

    const entries = prepare(parsed, baseMap, 'A', { sieImportId: 'import-42' })
      .preparedEntries as unknown as Array<Record<string, unknown>>

    expect(entries).toHaveLength(2)
    // Every voucher has batch provenance, even when it carries no history.
    expect(entries[0]).not.toHaveProperty('corrections')
    expect(entries[0]).toHaveProperty('sieImportId', 'import-42')
    expect(entries[0]).toHaveProperty('sourceOrdinal', 0)

    // The corrected voucher: lines are the #TRANS rows only ...
    expect(entries[1].lines).toHaveLength(2)
    // ... and the history rides alongside, debit/credit split like lines,
    // stamped with the import id and the source-system signature.
    expect(entries[1].sieImportId).toBe('import-42')
    expect(entries[1].corrections).toEqual({
      struck: [{ account_number: '1510', debit_amount: 1200, credit_amount: 0, line_description: 'Fel konto', sort_order: 0, signature: 'EL' }],
      added: [{ account_number: '3001', debit_amount: 1200, credit_amount: 0, line_description: null, sort_order: 0, signature: 'EL' }],
      signature: 'EL',
    })
  })

  it('keeps the source account on history rows whose account is unmapped', () => {
    const corrected = {
      ...makeVoucher('A', 1),
      corrections: {
        struck: [{ account: '9999', amount: -1000 }],
        added: [],
      },
    }
    const parsed = makeParsedFile({ vouchers: [corrected] })

    const entries = prepare(parsed, baseMap, 'A').preparedEntries as unknown as Array<Record<string, unknown>>

    // The voucher itself (mapped #TRANS rows) is still prepared; only history
    // references the unmapped account, verbatim, as the source showed it.
    expect(entries).toHaveLength(1)
    expect(entries[0].corrections).toEqual({
      struck: [{ account_number: '9999', debit_amount: 0, credit_amount: 1000, line_description: null, sort_order: 0, signature: null }],
      added: [],
      signature: null,
    })
  })

  it('falls back to defaultSeries when source voucher has empty series (SIE4I)', () => {
    const parsed = makeParsedFile({
      vouchers: [
        { ...makeVoucher('', 1) },
        { ...makeVoucher('', 2) },
      ],
    })

    const result = prepare(parsed, baseMap, 'V') // fallback used because source series is empty

    expect(result.preparedEntries.map((e) => e.series)).toEqual(['V', 'V'])
  })

  it('keeps SIE4I vouchers without series AND without number apart (#2546)', () => {
    // `#VER "" ""`: per SIE 4B the receiving system assigns both, so the parser
    // marks the number omitted and leaves a placeholder 0. Both vouchers used
    // to collapse onto the single sourceId "0", so all but the last one
    // vanished from the payload and from the per-account movements the
    // migration adjustment entry is computed from.
    const parsed = makeParsedFile({
      vouchers: [
        {
          series: '',
          number: 0,
          numberOmitted: true,
          date: new Date(2024, 0, 15),
          description: 'Dagsrapport 1',
          lines: [
            { account: '1510', amount: 1000 },
            { account: '3001', amount: -1000 },
          ],
        },
        {
          series: '',
          number: 0,
          numberOmitted: true,
          date: new Date(2024, 0, 16),
          description: 'Dagsrapport 2',
          lines: [
            { account: '1510', amount: 2500 },
            { account: '3001', amount: -2500 },
          ],
        },
      ],
    })

    const entries = prepare(parsed, baseMap, 'V').preparedEntries

    // Ordinal-based ids: distinct, and they point back at the file's order.
    expect(entries.map((e) => [e.sourceId, e.series])).toEqual([['#1', 'V'], ['#2', 'V']])
    // The file named neither, so nothing is invented for the source columns.
    expect(entries.map((e) => e.sourceSeries)).toEqual([null, null])
    expect(entries.map((e) => e.sourceNumber)).toEqual([null, null])
  })

  it('numbers SIE4I sourceIds by position in the FILE, not in the chunk (#2546)', () => {
    // A chunked import (#2532) prepares one voucher group per call with only
    // that group's vouchers, so the loop index restarts at 0 every group.
    // The ordinal has to come from startOrdinal + index, or group 2 would reuse
    // "#1" and the writer would see a duplicate of group 1's first voucher.
    const secondGroup = makeParsedFile({
      vouchers: [
        {
          series: '',
          number: 0,
          numberOmitted: true,
          date: new Date(2024, 0, 17),
          description: 'Dagsrapport 3',
          lines: [
            { account: '1510', amount: 700 },
            { account: '3001', amount: -700 },
          ],
        },
      ],
    })

    const prepared = prepare(secondGroup, baseMap, 'V', { startOrdinal: 2, sieImportId: 'import-99' }).preparedEntries

    expect(prepared.map((e) => e.sourceId)).toEqual(['#3'])
    expect(prepared.map((e) => e.sourceOrdinal)).toEqual([2])
  })

  it('keys each entry by its source voucher reference for the audit trail', () => {
    const parsed = makeParsedFile({
      vouchers: [
        makeVoucher('B', 1),
        makeVoucher('C', 7),
      ],
    })

    const entries = prepare(parsed, baseMap, 'B').preparedEntries

    expect(entries.map((e) => [e.sourceId, e.series])).toEqual([['B1', 'B'], ['C7', 'C']])
  })

  it('preserves original source series/number on each prepared entry, even across skipped vouchers', () => {
    // A2 is an empty voucher (no lines), will be skipped. A1 and A3 survive,
    // and source_voucher_number must keep the SIE originals (1 and 3) so
    // traceability is not lost when the target series is numbered contiguously.
    const parsed = makeParsedFile({
      vouchers: [
        { ...makeVoucher('A', 1), description: 'Receipt 2025-001, Acme AB' },
        { ...makeVoucher('A', 2), lines: [] },
        { ...makeVoucher('A', 3), description: 'Invoice 2025-003, Jane Doe' },
      ],
    })

    const result = prepare(parsed, baseMap, 'A')

    expect(result.skippedDetails.map((d) => [d.voucherId, d.reason])).toEqual([['A2', 'zero_lines']])
    expect(result.preparedEntries.map((e) => e.sourceSeries)).toEqual(['A', 'A'])
    expect(result.preparedEntries.map((e) => e.sourceNumber)).toEqual([1, 3])
    expect(result.preparedEntries.map((e) => e.description)).toEqual(['Receipt 2025-001, Acme AB', 'Invoice 2025-003, Jane Doe'])
  })

  it('stores NULL source series when the source voucher has no series (SIE4I subsystem import)', () => {
    const parsed = makeParsedFile({
      vouchers: [
        { ...makeVoucher('', 1) },
      ],
    })

    const [entry] = prepare(parsed, baseMap, 'V').preparedEntries

    expect(entry.sourceSeries).toBeNull()
    expect(entry.sourceNumber).toBe(1)
  })

  describe('opening-balance voucher tagging vs derived IB (issue #675)', () => {
    const obMap = new Map([
      ['1930', '1930'],
      ['2010', '2010'],
    ])

    it('tags a qualifying OB voucher opening_balance even when #UB -1 records exist', () => {
      // Precedence 2 beats 3: the OB-voucher candidate makes
      // getEffectiveOpeningBalances yield no balances, so hasCurrentYearIb is
      // false and the voucher keeps serving as the IB. Without that yield, a
      // derived IB entry AND this voucher would both book the same amounts.
      const parsed = makeParsedFile({
        openingBalances: [],
        closingBalances: [
          { yearIndex: -1, account: '1930', amount: 37400.78 },
          { yearIndex: -1, account: '2010', amount: -37400.78 },
        ],
        vouchers: [
          {
            series: 'A',
            number: 1,
            date: new Date(2024, 0, 1),
            description: 'Ingående balans',
            lines: [
              { account: '1930', amount: 37400.78 },
              { account: '2010', amount: -37400.78 },
            ],
          },
        ],
      })

      const entries = prepare(parsed, obMap, 'A').preparedEntries

      expect(entries).toHaveLength(1)
      expect(entries[0].sourceType).toBe('opening_balance')
    })

    it('keeps an FY-start voucher without IB wording as import when IB is derived from #UB -1', () => {
      const parsed = makeParsedFile({
        openingBalances: [],
        closingBalances: [
          { yearIndex: -1, account: '1930', amount: 37400.78 },
          { yearIndex: -1, account: '2010', amount: -37400.78 },
        ],
        vouchers: [
          {
            series: 'A',
            number: 1,
            date: new Date(2024, 0, 1),
            description: 'Omföring',
            lines: [
              { account: '1930', amount: 1000 },
              { account: '2010', amount: -1000 },
            ],
          },
        ],
      })

      const entries = prepare(parsed, obMap, 'A').preparedEntries

      expect(entries[0].sourceType).toBe('import')
    })
  })

  it('closes a sub-krona gap on BAS 3740 Öres- och kronutjämning, never on a non-BAS number (#2687)', () => {
    // 100.00 debit against 99.63 credit: the importer adds an explicit 0.37
    // credit on the rounding account instead of editing a source line.
    const parsed = makeParsedFile({
      vouchers: [
        makeVoucher('A', 1, [
          { account: '1510', amount: 100 },
          { account: '3001', amount: -99.63 },
        ]),
      ],
    })

    const result = prepare(parsed, baseMap, 'A')

    expect(result.skippedDetails).toEqual([])
    const rounding = result.preparedEntries[0].lines.filter((line) => line.line_description === 'Öresutjämning')
    expect(rounding).toEqual([
      expect.objectContaining({ account_number: ORE_ROUNDING_ACCOUNT, debit_amount: 0, credit_amount: 0.37 }),
    ])
    // The number the importer books on must be a real BAS 2026 account.
    expect(getBASReference(rounding[0].account_number as string)?.account_name).toBe('Öres- och kronutjämning')
  })
})

describe('IB derivation from #UB -1 (issue #675)', () => {
  const derivedOverrides: Partial<ParsedSIEFile> = {
    openingBalances: [],
    closingBalances: [
      { yearIndex: -1, account: '1930', amount: 37400.78 },
      { yearIndex: -1, account: '2440', amount: -37400.78 },
      { yearIndex: 0, account: '1930', amount: 160406.0 },
      { yearIndex: 0, account: '2440', amount: -160406.0 },
    ],
  }

  describe('generateImportPreview', () => {
    it('computes opening balance totals from the derived set', () => {
      const parsed = makeParsedFile(derivedOverrides)
      const preview = generateImportPreview(parsed, [
        makeMapping('1930', '1930'),
        makeMapping('2440', '2440'),
      ])

      // Derived from #UB -1: 37400.78 debit / 37400.78 credit. This is also
      // what enables the IB toggle in ImportReviewStep (openingBalanceTotal > 0).
      expect(preview.openingBalanceTotal).toBe(37400.78)
      expect(preview.trialBalance.totalDebit).toBe(37400.78)
      expect(preview.trialBalance.totalCredit).toBe(37400.78)
      expect(preview.trialBalance.isBalanced).toBe(true)
    })

    it('appends an info issue explaining the derivation without mutating parsed.issues', () => {
      const parsed = makeParsedFile(derivedOverrides)
      const preview = generateImportPreview(parsed, [makeMapping('1930', '1930')])

      const infoMessages = preview.issues.filter((i) => i.severity === 'info')
      expect(infoMessages.map((i) => i.message).join(' ')).toMatch(/härleds från föregående års utgående balans/i)
      expect(parsed.issues).toHaveLength(0)
    })

    it('does not append the derivation issue when explicit #IB 0 exists', () => {
      const parsed = makeParsedFile()
      const preview = generateImportPreview(parsed, [makeMapping('1930', '1930')])

      expect(preview.issues).toHaveLength(0)
    })
  })

  describe('validateIBBalance', () => {
    it('builds journal lines from the derived #UB -1 set', () => {
      const parsed = makeParsedFile(derivedOverrides)
      const accountMap = new Map([
        ['1930', '1930'],
        ['2440', '2440'],
      ])

      const result = validateIBBalance(parsed, accountMap)

      expect(result.lines).toEqual([
        { account_number: '1930', debit_amount: 37400.78, credit_amount: 0, line_description: 'IB 1930' },
        { account_number: '2440', debit_amount: 0, credit_amount: 37400.78, line_description: 'IB 2440' },
      ])
      expect(result.roundingAdjustment).toBe(0)
      expect(result.fileImbalance).toBe(0)
    })

    it('reports the imbalance when the derived set carries an unallocated prior-year result', () => {
      const parsed = makeParsedFile({
        openingBalances: [],
        closingBalances: [
          { yearIndex: -1, account: '1930', amount: 37400.78 },
          { yearIndex: -1, account: '2440', amount: -30000.0 },
        ],
      })
      const accountMap = new Map([
        ['1930', '1930'],
        ['2440', '2440'],
      ])

      const result = validateIBBalance(parsed, accountMap)

      // 37400.78 − 30000.00 → diff booked to 2099 by createOpeningBalanceEntry
      expect(result.roundingAdjustment).toBe(7400.78)
      expect(result.fileImbalance).toBe(7400.78)
    })
  })
})

describe('precheckFiscalPeriod', () => {
  // The read-only verdict the parse preview shows. Mirrors the
  // ensureFiscalPeriod cases above one-to-one: whatever this says at preview
  // is what the import does.
  type Supabase = Parameters<typeof precheckFiscalPeriod>[0]

  const seededPeriod = {
    id: 'seeded-2026',
    period_start: '2026-01-01',
    period_end: '2026-12-31',
    name: 'Räkenskapsår 2026',
    is_closed: false,
    locked_at: null,
    opening_balances_set: false,
  }

  it('reports match when an existing period contains the range', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: { id: 'existing-period-id' }, error: null }])

    const verdict = await precheckFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2026-01-01',
      '2026-12-31',
    )

    expect(verdict).toEqual({ verdict: 'match', periodId: 'existing-period-id' })
  })

  // A containing period that is closed or locked used to answer 'match', so
  // the import ran into the DB trigger ("Cannot write to locked/closed fiscal
  // period") with no way forward. Each state names its own remedy.
  const closedPeriod = {
    id: 'fy-2024-2025',
    name: 'Räkenskapsår 2024/2025',
    period_start: '2024-06-03',
    period_end: '2025-08-31',
  }

  it('refuses a klarmarkerad containing period and points at Öppna igen', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          ...closedPeriod,
          is_closed: true,
          locked_at: '2026-09-04T10:55:54Z',
          closed_externally: true,
          closing_entry_id: null,
        },
        error: null,
      },
    ])

    const verdict = await precheckFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2024-06-03',
      '2025-08-31',
    )

    expect(verdict.verdict).toBe('conflict')
    if (verdict.verdict !== 'conflict') return
    expect(verdict.existingPeriod).toEqual({
      id: 'fy-2024-2025',
      name: 'Räkenskapsår 2024/2025',
      periodStart: '2024-06-03',
      periodEnd: '2025-08-31',
    })
    expect(verdict.message).toMatch(/avslutat i ett tidigare program/)
    expect(verdict.message).toMatch(/Öppna igen/)
    expect(verdict.message).toMatch(/Inställningar > Bokföring > Räkenskapsår/)
  })

  it('refuses a period closed by a year-end run without offering Öppna igen', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          ...closedPeriod,
          is_closed: true,
          locked_at: '2026-09-04T12:14:16Z',
          closed_externally: false,
          closing_entry_id: 'closing-entry',
        },
        error: null,
      },
    ])

    const verdict = await precheckFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2024-06-03',
      '2025-08-31',
    )

    expect(verdict.verdict).toBe('conflict')
    if (verdict.verdict !== 'conflict') return
    expect(verdict.message).toMatch(/stängt med ett årsbokslut/)
    expect(verdict.message).not.toMatch(/Öppna igen/)
  })

  it('refuses a locked (not closed) containing period and points at Lås upp', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      {
        data: {
          ...closedPeriod,
          is_closed: false,
          locked_at: '2026-09-04T10:55:54Z',
          closed_externally: false,
          closing_entry_id: null,
        },
        error: null,
      },
    ])

    const verdict = await precheckFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2024-06-03',
      '2025-08-31',
    )

    expect(verdict.verdict).toBe('conflict')
    if (verdict.verdict !== 'conflict') return
    expect(verdict.message).toMatch(/är låst\. Lås upp det/)
  })

  it('reports create with nothing to replace when no period overlaps', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null }, // containing check, no match
      { data: [], error: null }, // overlapping check, none
    ])

    const verdict = await precheckFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2025-01-01',
      '2025-12-31',
    )

    expect(verdict).toEqual({ verdict: 'create', replacesEmptyPeriodId: null })
  })

  it('reports invalid with the import refusal text for a 19-month #RAR', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      { data: [], error: null },
    ])

    const verdict = await precheckFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2024-01-01',
      '2025-07-31',
    )

    expect(verdict.verdict).toBe('invalid')
    if (verdict.verdict !== 'invalid') return
    expect(verdict.message).toMatch(/omfattar 19 månader/)
  })

  it('reports invalid for an end date that is not the last day of its month', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      { data: [], error: null },
    ])

    const verdict = await precheckFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2024-01-01',
      '2024-12-30',
    )

    expect(verdict.verdict).toBe('invalid')
    if (verdict.verdict !== 'invalid') return
    expect(verdict.message).toMatch(/måste sluta på månadens sista dag/)
  })

  it('reports invalid for a mid-month start when an earlier period exists', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      { data: [], error: null },
      { data: [{ id: 'earlier' }], error: null }, // earlier period exists
    ])

    const verdict = await precheckFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2026-04-16',
      '2026-12-31',
    )

    expect(verdict.verdict).toBe('invalid')
    if (verdict.verdict !== 'invalid') return
    expect(verdict.message).toMatch(/kronologiskt första räkenskapsår får börja mitt i månaden/)
  })

  it('reports create naming the empty seeded period it will replace', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      { data: [seededPeriod], error: null },
      { data: [], error: null }, // journal_entries: none
      { data: [], error: null }, // earlier-period check, none (mid-month start)
    ])

    const verdict = await precheckFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2025-10-20',
      '2026-12-31',
    )

    expect(verdict).toEqual({ verdict: 'create', replacesEmptyPeriodId: 'seeded-2026' })
  })

  it('reports conflict with the import refusal text when the overlapping period has entries', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      { data: [seededPeriod], error: null },
      { data: [{ id: 'entry-1' }], error: null },
    ])

    const verdict = await precheckFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2025-03-01',
      '2026-02-28',
    )

    expect(verdict.verdict).toBe('conflict')
    if (verdict.verdict !== 'conflict') return
    expect(verdict.existingPeriod).toEqual({
      id: 'seeded-2026',
      name: 'Räkenskapsår 2026',
      periodStart: '2026-01-01',
      periodEnd: '2026-12-31',
    })
    expect(verdict.message).toMatch(/2025-03-01 till 2026-02-28/)
    expect(verdict.message).toMatch(/Inställningar → Företag/)
  })

  it('reports conflict without reading entries when opening balances are set', async () => {
    const { supabase, enqueueMany, calls } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      { data: [{ ...seededPeriod, opening_balances_set: true }], error: null },
    ])

    const verdict = await precheckFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2025-10-20',
      '2026-12-31',
    )

    expect(verdict.verdict).toBe('conflict')
    expect(calls.some((c) => c.table === 'journal_entries')).toBe(false)
  })

  it('is the verdict ensureFiscalPeriod acts on: conflict throws the same text', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null },
      { data: [seededPeriod], error: null },
      { data: [{ id: 'entry-1' }], error: null },
    ])
    const precheck = await precheckFiscalPeriod(
      supabase as unknown as Supabase,
      'company-id',
      '2025-03-01',
      '2026-02-28',
    )

    const again = createQueuedMockSupabase()
    again.enqueueMany([
      { data: null, error: null },
      { data: [seededPeriod], error: null },
      { data: [{ id: 'entry-1' }], error: null },
    ])

    await expect(
      ensureFiscalPeriod(again.supabase as unknown as Supabase, 'company-id', '2025-03-01', '2026-02-28'),
    ).rejects.toThrow(precheck.verdict === 'conflict' ? precheck.message : 'unreachable')
  })
})
