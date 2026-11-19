import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { readSIESourceVouchers } from '../sie-job-preparation'
import type { SIEJob } from '../sie-job-contract'

/**
 * The learning after an import reads every source voucher group between the
 * worker's last lease renewal and complete_sie_import_job, which needs that
 * 2-minute lease alive. One request per group was about 750 requests for a
 * 150 000-voucher year; it reads twenty groups a request.
 */

const job = { id: 'import-1', company_id: 'company-1' } as SIEJob
const group = (chunk_no: number, number: number) => ({
  chunk_no,
  payload: [[{ series: 'A', number, date: '2026-02-01T00:00:00.000Z', text: 'Test', lines: [] }]],
})

describe('readSIESourceVouchers', () => {
  it('reads the groups twenty at a time, in order, and revives the dates', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: Array.from({ length: 20 }, (_, i) => group(100_001 + i, i + 1)) },
      { data: [group(100_021, 21), group(100_022, 22)] },
    ])

    const vouchers = await readSIESourceVouchers(supabase as never, job, 22)

    expect(vouchers.map((v) => v.number)).toEqual(Array.from({ length: 22 }, (_, i) => i + 1))
    expect(vouchers[0].date).toBeInstanceOf(Date)
    expect(findCalls('sie_import_chunks', 'gte')).toEqual([['chunk_no', 100_001], ['chunk_no', 100_021]])
    expect(findCalls('sie_import_chunks', 'lt')).toEqual([['chunk_no', 100_021], ['chunk_no', 100_023]])
    expect(findCalls('sie_import_chunks', 'eq')).toContainEqual(['import_id', 'import-1'])
  })

  it('refuses when a group is missing, as the one-by-one read did', async () => {
    const { supabase, enqueueMany } = createQueuedMockSupabase()
    enqueueMany([{ data: [group(100_001, 1)] }])

    await expect(readSIESourceVouchers(supabase as never, job, 2)).rejects.toThrow('SIE source group missing')
  })
})
