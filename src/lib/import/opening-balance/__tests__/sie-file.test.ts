import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { previousYearHasBookkeeping, readSIEFileOpeningBalance, toSIEFileOpeningBalance } from '../sie-file'

const mapping = (sourceAccount: string, targetAccount: string) => ({
  sourceAccount, sourceName: sourceAccount, targetAccount, targetName: targetAccount,
  confidence: 1, matchType: 'exact', isOverride: false,
})

// The shape a continuation import seals: the file's #IB in source accounts
// plus the approved mappings (crm#1099).
const manifest = {
  prior_activity: true,
  effectiveOpeningBalances: [
    { account: '1930', amount: 12500.5, yearIndex: 0 },
    { account: '1330', amount: 100000, yearIndex: 0 },
    { account: '2099', amount: -112500.5, yearIndex: 0 },
  ],
  input: { mappings: [mapping('1930', '1930'), mapping('1330', '1330'), mapping('2099', '2099')] },
}

describe('toSIEFileOpeningBalance', () => {
  it('turns the stored #IB into debit and credit lines sorted by account', () => {
    const file = toSIEFileOpeningBalance({ id: 'import-1', filename: '2019.SE', manifest })
    expect(file).toEqual({
      importId: 'import-1',
      filename: '2019.SE',
      lines: [
        { account_number: '1330', debit_amount: 100000, credit_amount: 0 },
        { account_number: '1930', debit_amount: 12500.5, credit_amount: 0 },
        { account_number: '2099', debit_amount: 0, credit_amount: 112500.5 },
      ],
      totalDebit: 112500.5,
      totalCredit: 112500.5,
    })
  })

  it('maps through the approved mappings, sums accounts that share a target and skips unmapped ones', () => {
    const file = toSIEFileOpeningBalance({ id: 'import-1', filename: 'f.se', manifest: {
      effectiveOpeningBalances: [
        { account: '1911', amount: 100.1, yearIndex: 0 },
        { account: '1912', amount: 0.2, yearIndex: 0 },
        { account: '0099', amount: 50, yearIndex: 0 },
        { account: '2081', amount: -100.3, yearIndex: 0 },
      ],
      input: { mappings: [mapping('1911', '1930'), mapping('1912', '1930'), mapping('2081', '2081'), { ...mapping('0099', ''), targetAccount: '' }] },
    } })
    expect(file?.lines).toEqual([
      { account_number: '1930', debit_amount: 100.3, credit_amount: 0 },
      { account_number: '2081', debit_amount: 0, credit_amount: 100.3 },
    ])
    expect(file?.totalDebit).toBe(file?.totalCredit)
  })

  it('reports an unbalanced statement as it is, for the caller to refuse', () => {
    const file = toSIEFileOpeningBalance({ id: 'import-1', filename: 'f.se', manifest: {
      effectiveOpeningBalances: [{ account: '2641', amount: 75, yearIndex: 0 }, { account: '1930', amount: 100, yearIndex: 0 }],
      input: { mappings: [mapping('2641', '2641'), mapping('1930', '1930')] },
    } })
    expect(file?.totalDebit).toBe(175)
    expect(file?.totalCredit).toBe(0)
  })

  it('ignores other years, zero sums and malformed rows', () => {
    const file = toSIEFileOpeningBalance({ id: 'import-1', filename: null, manifest: {
      effectiveOpeningBalances: [
        { account: '1930', amount: 10, yearIndex: -1 },
        { account: '1930', amount: 5, yearIndex: 0 },
        { account: '1930', amount: -5, yearIndex: 0 },
        { account: 1510, amount: 7, yearIndex: 0 },
        { account: '1510', amount: 'x', yearIndex: 0 },
      ],
      input: { mappings: [mapping('1930', '1930'), mapping('1510', '1510')] },
    } })
    expect(file).toBeNull()
  })

  it('returns null for a manifest without a stored IB', () => {
    expect(toSIEFileOpeningBalance({ id: 'import-1', filename: 'f.se', manifest: { input: { mappings: [] } } })).toBeNull()
    expect(toSIEFileOpeningBalance({ id: 'import-1', filename: 'f.se', manifest: null })).toBeNull()
  })
})

describe('readSIEFileOpeningBalance', () => {
  const queued = createQueuedMockSupabase()
  beforeEach(() => queued.reset())

  it('reads the latest completed import of the year within the company', async () => {
    queued.enqueue({ data: [{ id: 'import-1', filename: '2019.SE', manifest }] })
    const file = await readSIEFileOpeningBalance(queued.supabase as never, 'company-1', 'period-1')
    expect(file?.lines).toHaveLength(3)
    expect(queued.findCalls('sie_imports', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['fiscal_period_id', 'period-1'],
      ['job_kind', 'import'],
      ['job_state', 'completed'],
    ])
    expect(queued.findCall('sie_imports', 'order')).toEqual(['created_at', { ascending: false }])
  })

  it('returns null when the year has no completed import', async () => {
    queued.enqueue({ data: [] })
    expect(await readSIEFileOpeningBalance(queued.supabase as never, 'company-1', 'period-1')).toBeNull()
  })

  it('throws a read error instead of hiding it', async () => {
    queued.enqueue({ error: { message: 'boom' } })
    await expect(readSIEFileOpeningBalance(queued.supabase as never, 'company-1', 'period-1')).rejects.toEqual({ message: 'boom' })
  })
})

describe('previousYearHasBookkeeping (PH 193)', () => {
  const queued = createQueuedMockSupabase()
  beforeEach(() => queued.reset())

  it('is true when the year before holds a posted verifikat that is not a storno (imported again)', async () => {
    queued.enqueue({ data: { id: 'previous-year', period_end: '2025-12-31' } })
    queued.enqueue({ data: [{ id: 'entry-1' }] })
    expect(await previousYearHasBookkeeping(queued.supabase as never, 'company-1', '2026-01-01')).toBe(true)
    expect(queued.findCalls('fiscal_periods', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['period_end', '2025-12-31'],
    ])
    expect(queued.findCalls('journal_entries', 'eq')).toEqual([
      ['company_id', 'company-1'],
      ['fiscal_period_id', 'previous-year'],
      ['status', 'posted'],
    ])
    expect(queued.findCall('journal_entries', 'neq')).toEqual(['source_type', 'storno'])
  })

  it('is false when the undone year has only reversed originals and stornos left (crm#1099)', async () => {
    queued.enqueue({ data: { id: 'previous-year', period_end: '2025-12-31' } })
    queued.enqueue({ data: [] })
    expect(await previousYearHasBookkeeping(queued.supabase as never, 'company-1', '2026-01-01')).toBe(false)
  })

  it('is false for the first year of the company without reading entries', async () => {
    queued.enqueue({ data: null })
    expect(await previousYearHasBookkeeping(queued.supabase as never, 'company-1', '2026-01-01')).toBe(false)
    expect(queued.findCalls('journal_entries', 'eq')).toEqual([])
  })

  it('throws a read error instead of answering false', async () => {
    queued.enqueue({ data: [{ id: 'previous-year' }] })
    queued.enqueue({ error: { message: 'boom' } })
    await expect(previousYearHasBookkeeping(queued.supabase as never, 'company-1', '2026-01-01')).rejects.toEqual({ message: 'boom' })
  })
})
