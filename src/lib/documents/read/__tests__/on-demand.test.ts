import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

const readAndStoreDocument = vi.fn()
const enqueueDocumentJob = vi.fn()
vi.mock('@/lib/documents/read/store', () => ({ readAndStoreDocument: (...args: unknown[]) => readAndStoreDocument(...args) }))
vi.mock('@/lib/documents/jobs/queue', () => ({ enqueueDocumentJob: (...args: unknown[]) => enqueueDocumentJob(...args) }))

import { ensureDocumentRead } from '../on-demand'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const doc = {
  id: 'doc-1',
  company_id: 'company-1',
  storage_path: 'documents/company-1/doc-1.pdf',
  mime_type: 'application/pdf',
  created_at: '2024-03-01T10:00:00Z',
  journal_entry_id: 'je-1',
  journal_entry_line_id: null,
  doc_type: null,
  pages_read_at: null,
  read_error: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  reset()
  process.env.ARKIV_COMPANY_IDS = 'company-1'
})

describe('ensureDocumentRead', () => {
  it('does not read again a document whose pages are stored but whose stamp the period lock refused', async () => {
    enqueue({ data: doc })
    enqueue({ data: null, count: 2 })
    const out = await ensureDocumentRead(supabase as never, 'company-1', 'doc-1')
    expect(out).toEqual({ status: 'skipped', reason: 'already_read' })
    expect(readAndStoreDocument).not.toHaveBeenCalled()
    expect(findCalls('document_pages', 'eq')).toEqual([['document_id', 'doc-1']])
  })

  it('reads a document with no pages stored, and queues its typing', async () => {
    enqueue({ data: doc })
    enqueue({ data: null, count: 0 })
    readAndStoreDocument.mockResolvedValue({ status: 'read', pages: 1 })
    const out = await ensureDocumentRead(supabase as never, 'company-1', 'doc-1')
    expect(out).toEqual({ status: 'read', pages: 1 })
    expect(readAndStoreDocument).toHaveBeenCalledTimes(1)
    expect(enqueueDocumentJob).toHaveBeenCalledWith(expect.anything(), 'company-1', 'doc-1', 'classify')
  })

  it('never looks for pages of a document already stamped as read', async () => {
    enqueue({ data: { ...doc, pages_read_at: '2026-09-01T10:00:00Z' } })
    const out = await ensureDocumentRead(supabase as never, 'company-1', 'doc-1')
    expect(out).toEqual({ status: 'skipped', reason: 'already_read' })
    expect(findCalls('document_pages', 'select')).toEqual([])
  })
})
