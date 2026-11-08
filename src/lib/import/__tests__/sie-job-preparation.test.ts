import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SIEJob } from '../sie-job-contract'

vi.mock('../sie-jobs', async load => ({
  ...await load<typeof import('../sie-jobs')>(),
  readSIEJobSource: vi.fn(),
}))
vi.mock('../sie-resync', () => ({ planSIEResync: vi.fn().mockResolvedValue(null) }))

import { readSIEJobSource } from '../sie-jobs'
import { planSIEResync } from '../sie-resync'
import { parseSIEFile } from '../sie-parser'
import { prepareSIEJob } from '../sie-job-preparation'

const { supabase, enqueue, reset } = createQueuedMockSupabase()
beforeEach(() => { vi.clearAllMocks(); reset() })

describe('incremental SIE preparation', () => {
  it('applies the admitted fiscal year to a reparsed SIE4I source without RAR', async () => {
    const source = '#FLAGGA 0\n#SIETYP 4\n#KONTO 1930 "Bank"\n#KONTO 3001 "Sales"\n#VER A 1 20260115 "Sale"\n{\n#TRANS 1930 {} 100\n#TRANS 3001 {} -100\n}'
    const hash = createHash('sha256').update(source).digest('hex')
    const fiscalYear = { start: '2026-01-01', end: '2026-12-31' }
    const mappings = ['1930', '3001'].map(number => ({ sourceAccount: number, sourceName: number,
      targetAccount: number, targetName: number, confidence: 1, matchType: 'exact', isOverride: false }))
    const job = {
      id: 'job', company_id: 'company', user_id: 'user', worker_id: 'worker', job_attempt: 2,
      file_hash: hash, prepared_through: 0, fiscal_year_start: fiscalYear.start, fiscal_year_end: fiscalYear.end,
      manifest: { snapshotComplete: true, input: { version: 1, sourceHash: hash, fiscalYear, mappings,
        options: { filename: 'delta.se', onExistingPeriod: 'incremental', importOpeningBalances: false, importTransactions: true } } },
    } as unknown as SIEJob
    enqueue({ data: { payload: [{ parsed: parseSIEFile(`#RAR 0 20260101 20261231\n${source}`),
      voucherGroups: 1, metadataGroups: 0, sourceSeries: ['A'], hasCurrentYearIb: false }] } })
    enqueue({ data: [] })
    vi.mocked(readSIEJobSource).mockResolvedValue(source)

    // Stop after the plan is read, before any preparation writes.
    await expect(prepareSIEJob(supabase as unknown as SupabaseClient, job, Date.now() + 30_000))
      .rejects.toThrow('Tidigare import kunde inte verifieras för omsynkningen.')

    expect(planSIEResync).toHaveBeenCalledOnce()
    expect(vi.mocked(planSIEResync).mock.calls[0][3].stats).toMatchObject({
      fiscalYearStart: fiscalYear.start, fiscalYearEnd: fiscalYear.end,
    })
    expect(vi.mocked(planSIEResync).mock.calls[0][3].header.fiscalYears).toContainEqual({ yearIndex: 0, ...fiscalYear })
    expect(supabase.rpc).not.toHaveBeenCalled()
  })
})
