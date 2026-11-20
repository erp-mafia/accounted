import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { generateStructured, logError } = vi.hoisted(() => ({ generateStructured: vi.fn(), logError: vi.fn() }))
vi.mock('@/lib/ai', () => ({
  getAiService: () => ({ generateStructured }),
  getAiStatus: () => ({ configured: true }),
}))
vi.mock('@/lib/legal/data-choices-store', () => ({
  isAiSwitchedOff: vi.fn(async () => false),
  isPoolingOn: vi.fn(async () => false),
}))
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  return {
    ...actual,
    createLogger: (module: string, base?: Parameters<typeof actual.createLogger>[1]) => ({
      ...actual.createLogger(module, base),
      error: logError,
    }),
  }
})

import { resolveCompanyCounterparts } from '../run'

const COMPANY = '11111111-1111-4111-8111-111111111111'

describe('resolveCompanyCounterparts when the model batch fails (accounted#115)', () => {
  let mock: ReturnType<typeof createQueuedMockSupabase>

  beforeEach(() => {
    vi.clearAllMocks()
    mock = createQueuedMockSupabase()
    mock.reset()
  })

  it('stores no alias for the strings it could not read, counts them and reports the company', async () => {
    generateStructured.mockRejectedValue(new Error('Bedrock 503'))
    mock.enqueue({
      data: [
        { id: 't1', original_description: 'FITTJA MATMA', description: null, amount: -476, currency: 'SEK', merchant_name: null },
        { id: 't2', original_description: 'Lön Anna Juni Överföring via internet', description: null, amount: -20654, currency: 'SEK', merchant_name: null },
      ],
    })
    mock.enqueue({ data: [] }) // live aliases
    mock.enqueue({ data: [] }) // document hits
    mock.enqueue({ data: [] }) // register parties
    mock.enqueue({ data: [] }) // giro numbers
    mock.enqueue({ data: [] }) // directory table: the card memo
    mock.enqueue({ data: [] }) // directory table: the salary line
    mock.enqueue({ data: null }) // insert

    const summary = await resolveCompanyCounterparts(mock.supabase as unknown as SupabaseClient, COMPANY)

    expect(generateStructured).toHaveBeenCalledTimes(1)
    expect(summary).toMatchObject({ strings: 2, modelLines: 1, modelFailed: 1, planned: 1, written: 1 })
    // Only the salary line, which needed no model, gets its (nil) alias. The
    // card memo has none, so the next run reads it again.
    const inserted = mock.findCall('counterparty_aliases', 'insert')?.[0] as Array<Record<string, unknown>>
    expect(inserted.map((row) => row.sample_text)).toEqual(['Lön Anna Juni Överföring via internet'])
    expect(logError).toHaveBeenCalledWith('counterpart model reading failed; the strings stay unresolved for the next run', {
      companyId: COMPANY,
      modelFailed: 1,
      modelLines: 1,
    })
  })
})
