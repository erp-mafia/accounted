import { describe, it, expect, vi } from 'vitest'
import {
  generateImportPreview,
  validateIBBalance,
  isBalanceSheetAccount,
  ensureFiscalPeriod,
  importVouchers,
  computeVoucherNumberRanges,
  linkOpeningBalanceEntryToPeriod,
  companyHasPriorActivity,
} from '../sie-import'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { ParsedSIEFile, AccountMapping } from '../types'
import type { SupabaseClient } from '@supabase/supabase-js'

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
          { severity: 'warning', line: 5, message: 'Okänd tagg: #FOO — ignoreras', tag: 'FOO' },
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

describe('ensureFiscalPeriod validation', () => {
  // Mirrors the `enforce_period_start_day` DB trigger so users get an
  // actionable Swedish error instead of a raw Postgres message.
  type Supabase = Parameters<typeof ensureFiscalPeriod>[0]

  it('rejects mid-month start when an earlier period already exists', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null }, // containing check — no match
      { data: [], error: null },   // overlapping check — none
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
      { data: { id: 'new-period-id' }, error: null }, // insert result
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
    // an SIE for their förlängt första räkenskapsår 2017-07-28 – 2018-12-31.
    // The 2017 period is chronologically earliest, so mid-month start is
    // legal under BFL 3 kap.
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null }, // containing check — no match
      { data: [], error: null },   // overlapping check — none (2017 vs 2026)
      { data: [], error: null },   // no earlier period than 2017-07-28
      { data: { id: 'retro-first-year-id' }, error: null }, // insert
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
    // window did not cover the voucher's own entry_date — breaking the SIE
    // invariant and BFL 5 kap. (verifikationsnummer per räkenskapsår).
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null }, // containing check — no match
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
      { data: [{ id: 'entry-1' }], error: null }, // journal_entries — has at least one
    ])

    await expect(
      ensureFiscalPeriod(
        supabase as unknown as Supabase,
        'company-id',
        '2025-03-01', // Capelix-style broken FY March–Feb
        '2026-02-28',
      ),
    ).rejects.toThrow(/Inställningar → Företag/)
  })

  it('replaces an overlapping period when it is empty (onboarding-seeded)', async () => {
    // Real-world Zerify AB case: onboarding seeded Räkenskapsår 2026 =
    // 2026-01-01 – 2026-12-31; the user has a förlängt första räkenskapsår
    // 2025-10-20 – 2026-12-31 (BFL 3 kap.) and imports an SIE for it.
    // The seeded period carries no data, so we replace it.
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([
      { data: null, error: null }, // containing check — no match
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
      { data: [], error: null }, // journal_entries — none
      { data: [], error: null }, // earlier-period check — none (mid-month start)
      { data: null, error: null }, // delete result
      { data: { id: 'replaced-id' }, error: null }, // insert result
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
    // we even look at journal_entries — the period clearly carries user data.
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
})

describe('linkOpeningBalanceEntryToPeriod', () => {
  // Regression: SIE import created the opening-balance entry but never wrote
  // its ID back to fiscal_periods. Without the link, getOpeningBalances falls
  // through to summing all prior journal lines, which inflates balance-sheet
  // accounts across multi-year imports (each year's IB double-counted against
  // the prior year's UB).
  type Supabase = Parameters<typeof linkOpeningBalanceEntryToPeriod>[0]

  it('writes opening_balance_entry_id and opening_balances_set to the fiscal period', async () => {
    const updates: Array<{ payload: Record<string, unknown>; filters: Record<string, unknown> }> = []

    const supabase = {
      from: (table: string) => {
        if (table !== 'fiscal_periods') {
          throw new Error(`Unexpected table: ${table}`)
        }
        let pendingPayload: Record<string, unknown> = {}
        const filters: Record<string, unknown> = {}
        const chain = {
          update: (payload: Record<string, unknown>) => {
            pendingPayload = payload
            return chain
          },
          eq: (col: string, val: unknown) => {
            filters[col] = val
            return chain
          },
          then: (resolve: (v: unknown) => void) => {
            updates.push({ payload: pendingPayload, filters: { ...filters } })
            resolve({ data: null, error: null })
          },
        }
        return chain
      },
    }

    await linkOpeningBalanceEntryToPeriod(
      supabase as unknown as Supabase,
      'company-1',
      'period-1',
      'ob-entry-1',
    )

    expect(updates).toHaveLength(1)
    expect(updates[0].payload).toEqual({
      opening_balance_entry_id: 'ob-entry-1',
      opening_balances_set: true,
    })
    expect(updates[0].filters).toEqual({
      id: 'period-1',
      company_id: 'company-1',
    })
  })

  it('throws a descriptive error when the update fails', async () => {
    const supabase = {
      from: () => {
        const chain = {
          update: () => chain,
          eq: () => chain,
          then: (resolve: (v: unknown) => void) =>
            resolve({ data: null, error: { message: 'permission denied' } }),
        }
        return chain
      },
    }

    await expect(
      linkOpeningBalanceEntryToPeriod(
        supabase as unknown as Supabase,
        'company-1',
        'period-1',
        'ob-entry-1',
      ),
    ).rejects.toThrow(/Failed to link opening balance entry.*permission denied/)
  })
})

describe('companyHasPriorActivity', () => {
  // Guards multi-year SIE imports: when the company already has posted
  // non-IB journal entries, creating another IB entry would double-count
  // one year's movements against every balance-sheet account.
  type Supabase = Parameters<typeof companyHasPriorActivity>[0]

  function buildCountingSupabase(count: number) {
    const capturedFilters: Record<string, unknown> = {}

    const supabase = {
      from: (table: string) => {
        if (table !== 'journal_entries') {
          throw new Error(`Unexpected table: ${table}`)
        }
        const chain = {
          select: (_cols: string, opts?: { count?: string; head?: boolean }) => {
            capturedFilters['_opts'] = opts
            return chain
          },
          eq: (col: string, val: unknown) => {
            capturedFilters[`eq:${col}`] = val
            return chain
          },
          neq: (col: string, val: unknown) => {
            const key = `neq:${col}`
            const existing = capturedFilters[key]
            if (Array.isArray(existing)) {
              existing.push(val)
            } else if (existing !== undefined) {
              capturedFilters[key] = [existing, val]
            } else {
              capturedFilters[key] = val
            }
            return chain
          },
          in: (col: string, val: unknown) => {
            capturedFilters[`in:${col}`] = val
            return chain
          },
          then: (resolve: (v: { count: number; error: null }) => void) =>
            resolve({ count, error: null }),
        }
        return chain
      },
    }
    return { supabase, capturedFilters }
  }

  it('returns false when the company has no prior posted entries', async () => {
    const { supabase } = buildCountingSupabase(0)

    const result = await companyHasPriorActivity(supabase as unknown as Supabase, 'company-1')

    expect(result).toBe(false)
  })

  it('returns true when the company has prior posted non-IB entries', async () => {
    const { supabase } = buildCountingSupabase(42)

    const result = await companyHasPriorActivity(supabase as unknown as Supabase, 'company-1')

    expect(result).toBe(true)
  })

  it('excludes opening_balance and storno entries, and only counts posted', async () => {
    const { supabase, capturedFilters } = buildCountingSupabase(0)

    await companyHasPriorActivity(supabase as unknown as Supabase, 'company-1')

    expect(capturedFilters['neq:source_type']).toEqual(['opening_balance', 'storno'])
    expect(capturedFilters['eq:status']).toBe('posted')
    expect(capturedFilters['eq:company_id']).toBe('company-1')
  })

  it('treats null/undefined count as zero', async () => {
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            neq: () => ({
              neq: () => ({
                eq: () => ({
                  then: (resolve: (v: { count: null; error: null }) => void) =>
                    resolve({ count: null, error: null }),
                }),
              }),
            }),
          }),
        }),
      }),
    }

    const result = await companyHasPriorActivity(supabase as unknown as Supabase, 'company-1')

    expect(result).toBe(false)
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

describe('importVouchers — per-voucher series preservation', () => {
  // Captures the rows passed to `.insert()` so the test can assert on
  // voucher_series per inserted record. Uses a hand-rolled mock rather than
  // createQueuedMockSupabase because we need to inspect arguments, not just
  // return queued data.
  function buildCapturingSupabase() {
    const journalEntryInserts: Array<Record<string, unknown>> = []
    const journalEntryLineInserts: Array<Record<string, unknown>> = []
    const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = []

    // Each `next_voucher_number` RPC call auto-increments per series, matching
    // the DB function's ON CONFLICT behavior.
    const nextNumberBySeries = new Map<string, number>()

    let syntheticEntryId = 1

    const supabase = {
      from: vi.fn((table: string) => {
        if (table === 'chart_of_accounts') {
          // Return all accounts used in test vouchers as if already active
          return {
            select: () => ({
              eq: () => ({
                in: (_col: string, accountNumbers: string[]) => ({
                  then: (resolve: (v: { data: { id: string; account_number: string }[]; error: null }) => void) =>
                    resolve({
                      data: accountNumbers.map((num, i) => ({ id: `acc-${i}`, account_number: num })),
                      error: null,
                    }),
                }),
              }),
            }),
          }
        }

        if (table === 'journal_entries') {
          return {
            insert: (rows: Array<Record<string, unknown>>) => {
              journalEntryInserts.push(...rows)
              return {
                select: () => ({
                  then: (resolve: (v: { data: { id: string }[]; error: null }) => void) =>
                    resolve({
                      data: rows.map(() => ({ id: `entry-${syntheticEntryId++}` })),
                      error: null,
                    }),
                }),
              }
            },
          }
        }

        if (table === 'journal_entry_lines') {
          return {
            insert: (rows: Array<Record<string, unknown>>) => {
              journalEntryLineInserts.push(...rows)
              return Promise.resolve({ error: null })
            },
          }
        }

        throw new Error(`Unexpected table: ${table}`)
      }),

      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        rpcCalls.push({ name, args })
        if (name === 'next_voucher_number') {
          const series = args.p_series as string
          const current = nextNumberBySeries.get(series) ?? 0
          const next = current + 1
          nextNumberBySeries.set(series, next)
          return { data: next, error: null }
        }
        if (name === 'reserve_voucher_range') {
          const series = args.p_series as string
          const highest = args.p_highest_used as number
          nextNumberBySeries.set(series, highest)
          return { data: null, error: null }
        }
        if (name === 'release_voucher_range') {
          return { data: null, error: null }
        }
        throw new Error(`Unexpected RPC: ${name}`)
      }),
    }

    return {
      supabase: supabase as unknown as SupabaseClient,
      journalEntryInserts,
      journalEntryLineInserts,
      rpcCalls,
    }
  }

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

  it('routes each voucher to its source series (B, C, V → B, C, V)', async () => {
    const { supabase, journalEntryInserts, rpcCalls } = buildCapturingSupabase()
    const parsed = makeParsedFile({
      vouchers: [
        makeVoucher('B', 1),
        makeVoucher('B', 2),
        makeVoucher('C', 1),
        makeVoucher('V', 1),
      ],
    })

    const result = await importVouchers(
      supabase,
      'company-1',
      'user-1',
      'period-1',
      parsed,
      baseMap,
      'B', // fallback (should not be used here — all vouchers have series)
    )

    expect(result.created).toBe(4)
    expect(new Set(result.seriesUsed)).toEqual(new Set(['B', 'C', 'V']))

    const seriesInInserts = journalEntryInserts.map((r) => r.voucher_series)
    expect(seriesInInserts).toEqual(['B', 'B', 'C', 'V'])

    // Each series reserves its own voucher-number range independently
    const reserveCalls = rpcCalls.filter((c) => c.name === 'reserve_voucher_range')
    expect(reserveCalls.map((c) => c.args.p_series)).toEqual(['B', 'C', 'V'])
  })

  it('falls back to defaultSeries when source voucher has empty series (SIE4I)', async () => {
    const { supabase, journalEntryInserts } = buildCapturingSupabase()
    const parsed = makeParsedFile({
      vouchers: [
        { ...makeVoucher('', 1) },
        { ...makeVoucher('', 2) },
      ],
    })

    const result = await importVouchers(
      supabase,
      'company-1',
      'user-1',
      'period-1',
      parsed,
      baseMap,
      'V', // fallback used because source series is empty
    )

    expect(result.created).toBe(2)
    expect(result.seriesUsed).toEqual(['V'])
    expect(journalEntryInserts.every((r) => r.voucher_series === 'V')).toBe(true)
  })

  it('records source series in voucherNumberMapping for audit trail', async () => {
    const { supabase } = buildCapturingSupabase()
    const parsed = makeParsedFile({
      vouchers: [
        makeVoucher('B', 1),
        makeVoucher('C', 7),
      ],
    })

    const result = await importVouchers(
      supabase,
      'company-1',
      'user-1',
      'period-1',
      parsed,
      baseMap,
      'B',
    )

    expect(result.voucherNumberMapping).toEqual([
      { sourceId: 'B1', series: 'B', targetNumber: 1 },
      { sourceId: 'C7', series: 'C', targetNumber: 1 },
    ])
  })

  it('assigns independent sequential target numbers per series', async () => {
    const { supabase, journalEntryInserts } = buildCapturingSupabase()
    const parsed = makeParsedFile({
      vouchers: [
        makeVoucher('B', 1),
        makeVoucher('B', 2),
        makeVoucher('B', 3),
        makeVoucher('C', 1),
        makeVoucher('C', 2),
      ],
    })

    await importVouchers(
      supabase,
      'company-1',
      'user-1',
      'period-1',
      parsed,
      baseMap,
      'B',
    )

    const bNumbers = journalEntryInserts
      .filter((r) => r.voucher_series === 'B')
      .map((r) => r.voucher_number)
    const cNumbers = journalEntryInserts
      .filter((r) => r.voucher_series === 'C')
      .map((r) => r.voucher_number)

    // Each series starts at 1 and increments independently — not globally continuous
    expect(bNumbers).toEqual([1, 2, 3])
    expect(cNumbers).toEqual([1, 2])
  })

  it('preserves original source series/number on each imported entry, even across skipped vouchers', async () => {
    const { supabase, journalEntryInserts } = buildCapturingSupabase()
    // A2 is an empty voucher (no lines) — will be skipped. A1 and A3 survive.
    // Accounted assigns target numbers 1 and 2 (contiguous), but source_voucher_number
    // must preserve the SIE originals (1 and 3) so traceability is not lost.
    const parsed = makeParsedFile({
      vouchers: [
        makeVoucher('A', 1),
        { ...makeVoucher('A', 2), lines: [] },
        makeVoucher('A', 3),
      ],
    })

    const result = await importVouchers(
      supabase,
      'company-1',
      'user-1',
      'period-1',
      parsed,
      baseMap,
      'A',
    )

    expect(result.created).toBe(2)
    expect(result.skippedEmpty).toBe(1)
    expect(journalEntryInserts.map((r) => r.voucher_number)).toEqual([1, 2])
    expect(journalEntryInserts.map((r) => r.source_voucher_series)).toEqual(['A', 'A'])
    expect(journalEntryInserts.map((r) => r.source_voucher_number)).toEqual([1, 3])
  })

  it('stores NULL source series/number when the source voucher has no series (SIE4I subsystem import)', async () => {
    const { supabase, journalEntryInserts } = buildCapturingSupabase()
    const parsed = makeParsedFile({
      vouchers: [
        { ...makeVoucher('', 1) },
      ],
    })

    await importVouchers(
      supabase,
      'company-1',
      'user-1',
      'period-1',
      parsed,
      baseMap,
      'V',
    )

    expect(journalEntryInserts[0].source_voucher_series).toBeNull()
    expect(journalEntryInserts[0].source_voucher_number).toBe(1)
  })

  describe('opening-balance voucher tagging vs derived IB (issue #675)', () => {
    const obMap = new Map([
      ['1930', '1930'],
      ['2010', '2010'],
    ])

    it('tags a qualifying OB voucher opening_balance even when #UB -1 records exist', async () => {
      // Precedence 2 beats 3: the OB-voucher candidate makes
      // getEffectiveOpeningBalances yield no balances, so hasCurrentYearIb is
      // false and the voucher keeps serving as the IB. Without that yield, a
      // derived IB entry AND this voucher would both book the same amounts.
      const { supabase, journalEntryInserts } = buildCapturingSupabase()
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

      const result = await importVouchers(
        supabase,
        'company-1',
        'user-1',
        'period-1',
        parsed,
        obMap,
        'A',
      )

      expect(result.created).toBe(1)
      expect(journalEntryInserts[0].source_type).toBe('opening_balance')
    })

    it('keeps an FY-start voucher without IB wording as import when IB is derived from #UB -1', async () => {
      const { supabase, journalEntryInserts } = buildCapturingSupabase()
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

      await importVouchers(
        supabase,
        'company-1',
        'user-1',
        'period-1',
        parsed,
        obMap,
        'A',
      )

      expect(journalEntryInserts[0].source_type).toBe('import')
    })
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
