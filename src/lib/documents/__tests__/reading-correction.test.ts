import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: () => supabase,
}))

import { mirrorCorrectedReadingToDocument } from '../reading-correction'

function lastUpdate() {
  const updates = findCalls('document_attachments', 'update')
  return updates[updates.length - 1]?.[0] as Record<string, unknown>
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('mirrorCorrectedReadingToDocument', () => {
  const model = { supplier: { name: 'Telia' }, totals: { total: 500 } }
  const person = { supplier: { name: 'Telia Sverige AB' }, totals: { total: 500 } }
  const T1 = '2026-10-01T08:00:00.000Z'
  const mirror = (documentId: string | null = 'doc-1') =>
    mirrorCorrectedReadingToDocument({ documentId, companyId: 'co-1', reading: person })

  beforeEach(() => {
    reset()
  })

  it("writes the correction and keeps the model's reading the first time", async () => {
    enqueue({ data: { id: 'doc-1', extracted_data: model, extracted_at: T1, extraction_model: 'claude-sonnet', model_reading: null } })
    enqueue({ data: null })
    expect(await mirror()).toBe('mirrored')
    expect(lastUpdate()).toEqual({
      extracted_data: person,
      model_reading: { extracted_data: model, extraction_model: 'claude-sonnet', extracted_at: T1 },
    })
    // Company-scoped on the read and on the write.
    expect(findCalls('document_attachments', 'eq')).toEqual([
      ['id', 'doc-1'],
      ['company_id', 'co-1'],
      ['id', 'doc-1'],
      ['company_id', 'co-1'],
    ])
  })

  it("leaves the kept copy alone on a second correction, and extracted_at and extraction_model as the model stamped them", async () => {
    enqueue({
      data: {
        id: 'doc-1',
        extracted_data: { supplier: { name: 'first edit' } },
        extracted_at: T1,
        extraction_model: 'claude-sonnet',
        model_reading: { extracted_data: model, extraction_model: 'claude-sonnet', extracted_at: T1 },
      },
    })
    enqueue({ data: null })
    expect(await mirror()).toBe('mirrored')
    expect(lastUpdate()).toEqual({ extracted_data: person })
  })

  it('keeps no model reading when none was ever made (no AI entitlement)', async () => {
    enqueue({ data: { id: 'doc-1', extracted_data: null, extracted_at: T1, extraction_model: 'skipped:no_ai_entitlement', model_reading: null } })
    enqueue({ data: null })
    expect(await mirror()).toBe('mirrored')
    expect(lastUpdate()).toEqual({ extracted_data: person })
  })

  it('skips a document whose verifikat sits in a locked period, without throwing', async () => {
    enqueue({ data: { id: 'doc-1', extracted_data: model, extracted_at: T1, extraction_model: 'claude-sonnet', model_reading: null } })
    enqueue({ error: { code: 'P0001', message: 'Cannot attach documents to entries in a locked/closed fiscal period' } })
    expect(await mirror()).toBe('locked')
  })

  it('reports any other failure as failed, never throwing', async () => {
    enqueue({ data: { id: 'doc-1', extracted_data: model, extracted_at: T1, extraction_model: 'claude-sonnet', model_reading: null } })
    enqueue({ error: { message: 'connection reset' } })
    expect(await mirror()).toBe('failed')
    reset()
    enqueue({ error: { message: 'timeout' } })
    expect(await mirror()).toBe('failed')
    expect(findCalls('document_attachments', 'update')).toEqual([])
  })

  it('does nothing for an item without a document, or a document outside the company', async () => {
    expect(await mirror(null)).toBe('no_document')
    expect(findCalls('document_attachments', 'select')).toEqual([])
    enqueue({ data: null })
    expect(await mirror()).toBe('no_document')
    expect(findCalls('document_attachments', 'update')).toEqual([])
  })
})
