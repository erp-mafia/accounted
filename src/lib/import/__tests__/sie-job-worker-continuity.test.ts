import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AccountMapping } from '../types'

const reads = vi.hoisted(() => ({ differences: vi.fn(), closing: vi.fn() }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn() }))
vi.mock('../sie-continuity', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sie-continuity')>()),
  diagnoseCarriedForwardDifferences: reads.differences,
}))
vi.mock('../sie-job-preparation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sie-job-preparation')>()),
  readSIEClosingBalances: reads.closing,
}))

import { carriedForwardContinuity } from '../sie-job-worker'
import type { SIEJob } from '../sie-job-contract'

/**
 * The finishing step of a continuation import. Its first version read the
 * file's #UB -1 from the root snapshot, which is sealed with its arrays
 * emptied, so the notice naming the file's #IB as the side that is off never
 * fired on a real import. It reads them back from the metadata groups.
 */

const supabase = {} as SupabaseClient
const job = (prior_activity: boolean) => ({
  id: 'import-1',
  company_id: 'company-1',
  fiscal_period_id: 'period-2019',
  fiscal_year_start: '2019-01-01',
  manifest: {
    prior_activity,
    effectiveOpeningBalances: [
      { account: '1730', amount: 700, yearIndex: 0 },
      { account: '1930', amount: 5000, yearIndex: 0 },
      { account: '2990', amount: -1500, yearIndex: 0 },
    ],
  },
}) as unknown as SIEJob

const mappings = ['1730', '1930', '2990'].map((account) => ({
  sourceAccount: account, sourceName: account, targetAccount: account, targetName: account,
  confidence: 1, matchType: 'exact', isOverride: false,
})) as AccountMapping[]

// The books carry the previous year forward; the file's #IB moved 500 onto 1730 and 2990.
const differences = [
  { account: '1730', file: 700, books: 200, difference: -500 },
  { account: '2990', file: -1500, books: -1000, difference: 500 },
]
const previousYear = [
  { yearIndex: -1, account: '1730', amount: 200 },
  { yearIndex: -1, account: '1930', amount: 5000 },
  { yearIndex: -1, account: '2990', amount: -1000 },
  { yearIndex: 0, account: '1930', amount: 5100 },
]

beforeEach(() => {
  vi.clearAllMocks()
  reads.differences.mockResolvedValue(differences)
  reads.closing.mockResolvedValue(previousYear)
})

describe('carriedForwardContinuity', () => {
  it('reads the file\'s #UB -1 back from the metadata groups and names the file\'s #IB as the side that is off', async () => {
    const result = await carriedForwardContinuity(supabase, job(true), mappings)

    expect(reads.closing).toHaveBeenCalledWith(supabase, expect.objectContaining({ id: 'import-1' }))
    expect(result).toEqual({ differences, fileOpeningOff: true })
  })

  it('still reports the differences when the #UB rows cannot be read: only the sentence is lost', async () => {
    reads.closing.mockRejectedValue(new Error('SIE metadata checkpoint missing'))

    expect(await carriedForwardContinuity(supabase, job(true), mappings)).toEqual({ differences, fileOpeningOff: false })
  })

  it('reads nothing when the books agree with the file\'s #IB', async () => {
    reads.differences.mockResolvedValue([])

    expect(await carriedForwardContinuity(supabase, job(true), mappings)).toEqual({ differences: [], fileOpeningOff: false })
    expect(reads.closing).not.toHaveBeenCalled()
  })

  it('compares nothing for an import that booked the file\'s own #IB', async () => {
    expect(await carriedForwardContinuity(supabase, job(false), mappings)).toEqual({ differences: [], fileOpeningOff: false })
    expect(reads.differences).not.toHaveBeenCalled()
  })
})
