import { describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { readSIEClosingBalances } from '../sie-job-preparation'
import type { SIEJob } from '../sie-job-contract'

/**
 * The finishing step reads the parsed file from the root snapshot checkpoint,
 * which is sealed with its arrays emptied, #UB included. The notice that says
 * which side of an opening-balance difference is off needs the file's #UB -1,
 * so it is read back from the metadata groups: read from the root alone it
 * was always empty, and the notice never fired on a real import.
 */

const job = { id: 'import-1', company_id: 'company-1' } as SIEJob

describe('readSIEClosingBalances', () => {
  it('reads the file\'s #UB rows back from the metadata groups, not the emptied root', async () => {
    const { supabase, enqueueMany, findCalls } = createQueuedMockSupabase()
    enqueueMany([
      { data: { payload: [{ parsed: { closingBalances: [], openingBalances: [] }, metadataGroups: 1 }] } },
      {
        data: [{
          payload: [[
            { sourceId: 'openingBalances:1', key: 'openingBalances', value: { yearIndex: 0, account: '1930', amount: 5100 } },
            { sourceId: 'closingBalances:1', key: 'closingBalances', value: { yearIndex: -1, account: '1930', amount: 5000 } },
            { sourceId: 'closingBalances:2', key: 'closingBalances', value: { yearIndex: 0, account: '1930', amount: 5200 } },
          ]],
        }],
      },
    ])

    expect(await readSIEClosingBalances(supabase as never, job)).toEqual([
      { yearIndex: -1, account: '1930', amount: 5000 },
      { yearIndex: 0, account: '1930', amount: 5200 },
    ])
    // Both reads stay inside this import's own checkpoints.
    expect(findCalls('sie_import_chunks', 'eq')).toContainEqual(['import_id', 'import-1'])
    expect(findCalls('sie_import_chunks', 'eq')).toContainEqual(['company_id', 'company-1'])
  })
})
