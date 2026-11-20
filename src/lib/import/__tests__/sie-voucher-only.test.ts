import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { parseSIEFile } from '../sie-parser'
import { isVoucherOnlySIE } from '../sie-voucher-only'
import { SIEJobValidationError, submitSIEJob } from '../sie-jobs'
import type { AccountMapping } from '../types'

// crm#1049: a card provider's SIE file (verifikat, no balances) for a year
// that is already imported is appended (issue #108, sie-append.test.ts),
// never offered as the year's replacement.

const HEADER = ['#FLAGGA 0', '#SIETYP 4', '#RAR 0 20260101 20261231']
const VOUCHER = ['#VER "" "" 20260315 "Kortköp"', '{', '#TRANS 6110 {} 250.00', '#TRANS 2890 {} -250.00', '}']

const CARD_FILE = [...HEADER, ...VOUCHER].join('\n')
const FULL_YEAR = [...HEADER, '#IB 0 1930 1000.00', '#UB 0 1930 1000.00', '#RES 0 6110 250.00', ...VOUCHER].join('\n')

describe('isVoucherOnlySIE', () => {
  it('is true for verifikat without any balance (the SIE 4I shape)', () => {
    expect(isVoucherOnlySIE(parseSIEFile(CARD_FILE))).toBe(true)
  })

  it('is false for a whole-year export with balances', () => {
    expect(isVoucherOnlySIE(parseSIEFile(FULL_YEAR))).toBe(false)
  })

  it('is false for a file without verifikat', () => {
    expect(isVoucherOnlySIE(parseSIEFile([...HEADER, '#UB 0 1930 1000.00'].join('\n')))).toBe(false)
  })
})

describe('submitSIEJob: a verifikat-only file never replaces a year', () => {
  beforeEach(() => {
    vi.stubEnv('SIE_IMPORT_JOBS', 'true')
  })
  afterEach(() => vi.unstubAllEnvs())

  const mappings: AccountMapping[] = ['6110', '2890'].map((number) => ({
    sourceAccount: number, targetAccount: number, sourceName: 'Konto', targetName: 'Konto',
    confidence: 1, matchType: 'exact', isOverride: false,
  }))
  const replace = {
    filename: 'kort.si', createFiscalPeriod: false, importOpeningBalances: false, importTransactions: true,
    onExistingPeriod: 'replace' as const, supersedesImportId: '00000000-0000-4000-8000-000000000001',
  }

  it('refuses the replacement before any database read, at every door', async () => {
    const database = { from: vi.fn(), rpc: vi.fn(), storage: { from: vi.fn() } }
    const error = await submitSIEJob(database as unknown as SupabaseClient, 'company-1', 'user-1', CARD_FILE, mappings, replace)
      .catch((thrown: unknown) => thrown)

    expect(error).toBeInstanceOf(SIEJobValidationError)
    expect((error as SIEJobValidationError).code).toBe('SIE_IMPORT_VOUCHERS_ONLY_FILE')
    expect((error as SIEJobValidationError).details).toMatchObject({
      existing_import_id: replace.supersedesImportId,
      vouchers: 1,
    })
    expect(database.from).not.toHaveBeenCalled()
    expect(database.rpc).not.toHaveBeenCalled()
    expect(database.storage.from).not.toHaveBeenCalled()
  })
})
