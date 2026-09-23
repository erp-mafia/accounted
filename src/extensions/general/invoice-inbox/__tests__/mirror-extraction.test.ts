import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => supabase,
}))

import { mirrorExtractionToDocument } from '../lib/mirror-extraction'

function lastUpdate() {
  const updates = findCalls('document_attachments', 'update')
  return updates[updates.length - 1]?.[0] as { extracted_data: unknown; extraction_model: string; extracted_at: string }
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  enqueue({ data: null })
})

describe('mirrorExtractionToDocument', () => {
  it('writes a successful extraction with the model that answered', async () => {
    await mirrorExtractionToDocument('doc-1', {
      data: { supplier: { name: 'x' } } as never,
      rawText: '{"supplier":{"name":"x"}}',
      model: 'google/gemma-4-31B-it',
    })
    const u = lastUpdate()
    expect(u.extracted_data).toEqual({ supplier: { name: 'x' } })
    expect(u.extraction_model).toBe('google/gemma-4-31B-it')
    expect(u.extracted_at).toBeTruthy()
    expect(findCalls('document_attachments', 'eq')[0]).toEqual(['id', 'doc-1'])
  })

  it('writes skipped:<reason> with no data for inbox and AI skip reasons alike', async () => {
    await mirrorExtractionToDocument('doc-1', { data: {} as never, rawText: null, skipped: 'no_ai_entitlement' })
    expect(lastUpdate()).toMatchObject({ extracted_data: null, extraction_model: 'skipped:no_ai_entitlement' })
    await mirrorExtractionToDocument('doc-1', { data: {} as never, rawText: null, skipped: 'ai_no_vision' })
    expect(lastUpdate()).toMatchObject({ extracted_data: null, extraction_model: 'skipped:ai_no_vision' })
  })

  it('writes failed:no_raw_text when the call yielded nothing parseable', async () => {
    await mirrorExtractionToDocument('doc-1', { data: {} as never, rawText: null })
    expect(lastUpdate()).toMatchObject({ extracted_data: null, extraction_model: 'failed:no_raw_text' })
  })

  it('never throws: a failed update is logged and swallowed', async () => {
    reset()
    enqueue({ error: { message: 'rls says no' } })
    await expect(mirrorExtractionToDocument('doc-1', { data: {} as never, rawText: null })).resolves.toBeUndefined()
  })
})
