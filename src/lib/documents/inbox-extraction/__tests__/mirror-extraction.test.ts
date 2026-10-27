import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => supabase,
}))

import {
  extractionStamp,
  mirrorExtractionToDocument,
  providerUnavailableAttempt,
  providerUnavailableStamp,
} from '../mirror-extraction'
import { isModelExtraction } from '@/lib/documents/model-reading'
import { deriveExtractionStatus } from '@/app/api/documents/[id]/extraction-status/route'

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

  it('stamps a provider outage distinctly, never as failed:no_raw_text', async () => {
    await mirrorExtractionToDocument('doc-1', { data: {} as never, rawText: null, failure: 'provider_unavailable' })
    expect(lastUpdate()).toMatchObject({ extracted_data: null, extraction_model: 'failed:provider_unavailable' })
  })

  it('records the attempt of a retried provider outage in the stamp', async () => {
    await mirrorExtractionToDocument('doc-1', { data: {} as never, rawText: null, failure: 'provider_unavailable', attempt: 3 })
    expect(lastUpdate()).toMatchObject({ extraction_model: 'failed:provider_unavailable:3' })
  })

  it('keeps failed:no_raw_text for every failure that is not the provider', async () => {
    await mirrorExtractionToDocument('doc-1', { data: {} as never, rawText: null, failure: 'error' })
    expect(lastUpdate()).toMatchObject({ extracted_data: null, extraction_model: 'failed:no_raw_text' })
  })

  it('never throws: a failed update is logged and swallowed', async () => {
    reset()
    enqueue({ error: { message: 'rls says no' } })
    await expect(mirrorExtractionToDocument('doc-1', { data: {} as never, rawText: null })).resolves.toBeUndefined()
  })
})

describe('extraction stamps', () => {
  it('a skip wins over a failure, and a reading over both', () => {
    expect(extractionStamp({ data: {} as never, rawText: null, skipped: 'sandbox', failure: 'provider_unavailable' })).toBe('skipped:sandbox')
    expect(extractionStamp({ data: {} as never, rawText: '{}', model: 'm', failure: 'error' })).toBe('m')
  })

  it('round-trips the attempt through the stamp', () => {
    expect(providerUnavailableStamp(1)).toBe('failed:provider_unavailable')
    expect(providerUnavailableStamp(2)).toBe('failed:provider_unavailable:2')
    expect(providerUnavailableAttempt('failed:provider_unavailable')).toBe(1)
    expect(providerUnavailableAttempt('failed:provider_unavailable:3')).toBe(3)
    expect(providerUnavailableAttempt('failed:no_raw_text')).toBeNull()
    expect(providerUnavailableAttempt('failed:provider_unavailable:x')).toBeNull()
    expect(providerUnavailableAttempt(null)).toBeNull()
  })

  it('reads as a reading that never happened everywhere failed:* does', () => {
    for (const stamp of ['failed:provider_unavailable', 'failed:provider_unavailable:3']) {
      expect(isModelExtraction(stamp)).toBe(false)
      expect(deriveExtractionStatus({ extracted_at: '2026-10-26T09:00:00Z', extracted_data: null, extraction_model: stamp }, true)).toBe('failed')
    }
  })
})
