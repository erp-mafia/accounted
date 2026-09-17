import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../router', () => ({ readDocumentBytes: vi.fn() }))
vi.mock('@/lib/core/documents/document-service', () => ({ downloadDocumentObject: vi.fn() }))
vi.mock('@/lib/ai', () => ({ getAiStatus: vi.fn(() => ({ configured: true })) }))

import { readAndStoreDocument, readUnreadDocuments } from '../store'
import { readDocumentBytes } from '../router'
import { downloadDocumentObject } from '@/lib/core/documents/document-service'

type Call = { table: string; op: string; payload?: unknown; filters: Record<string, unknown> }

// A minimal chainable Supabase double that records every write and answers
// the unread-batch select with the rows given.
function makeSupabase(unread: Array<Record<string, unknown>> = [], retry: Array<Record<string, unknown>> = []) {
  const calls: Call[] = []
  const chain = (table: string) => {
    const state: Call = { table, op: '', filters: {} }
    const api: Record<string, unknown> = {}
    api.select = () => { state.op = 'select'; return api }
    api.insert = (payload: unknown) => { state.op = 'insert'; state.payload = payload; calls.push(state); return Promise.resolve({ error: null }) }
    api.update = (payload: unknown) => { state.op = 'update'; state.payload = payload; return api }
    api.delete = () => { state.op = 'delete'; return api }
    api.eq = (k: string, v: unknown) => {
      state.filters[k] = v
      if (state.op === 'update' || state.op === 'delete') { calls.push(state); return Promise.resolve({ error: null }) }
      return api
    }
    api.is = () => api
    api.in = () => { state.op = 'select-retry'; return api }
    api.order = () => api
    api.limit = () => { calls.push(state); return Promise.resolve({ data: state.op === 'select-retry' ? retry : unread, error: null }) }
    return api
  }
  return { supabase: { from: (t: string) => chain(t) } as never, calls }
}

const doc = { id: 'doc-1', company_id: 'co-1', storage_path: 'documents/co-1/u/1_a.pdf', mime_type: 'application/pdf' }
const asMock = (fn: unknown) => fn as ReturnType<typeof vi.fn>

describe('readAndStoreDocument', () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.ARKIV_COMPANY_IDS = 'co-1' })

  it('replaces the pages and stamps the document with the page count', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('%PDF-')]), error: null, resolvedPath: doc.storage_path })
    asMock(readDocumentBytes).mockResolvedValue({
      ok: true,
      reader: 'pdf_text',
      pageCount: 2,
      pages: [
        { pageNo: 1, text: 'a', reader: 'pdf_text', hasTextLayer: true, words: [{ t: 'a', x0: 1, y0: 2, x1: 3, y1: 4 }] },
        { pageNo: 2, text: 'b', reader: 'claude_vision', hasTextLayer: false },
      ],
    })
    const { supabase, calls } = makeSupabase()
    const out = await readAndStoreDocument(supabase, doc)
    expect(out).toEqual({ status: 'read', pages: 2, reader: 'pdf_text' })
    expect(calls.map((c) => `${c.table}:${c.op}`)).toEqual(['document_pages:delete', 'document_pages:insert', 'document_attachments:update'])
    const inserted = calls[1].payload as Array<Record<string, unknown>>
    expect(inserted[0]).toMatchObject({ company_id: 'co-1', document_id: 'doc-1', page_no: 1, reader: 'pdf_text', has_text_layer: true })
    expect(inserted[1]).toMatchObject({ page_no: 2, reader: 'claude_vision', words: null })
    expect(calls[2].payload).toMatchObject({ page_count: 2, read_error: null })
    expect(calls[2].filters).toEqual({ id: 'doc-1' })
  })

  it('stamps structured and unsupported files without downloading', async () => {
    const { supabase, calls } = makeSupabase()
    expect(await readAndStoreDocument(supabase, { ...doc, mime_type: 'application/json' })).toEqual({ status: 'skipped', reason: 'structured' })
    expect(await readAndStoreDocument(supabase, { ...doc, mime_type: 'application/octet-stream' })).toEqual({ status: 'skipped', reason: 'unsupported_mime' })
    expect(downloadDocumentObject).not.toHaveBeenCalled()
    expect(calls.every((c) => c.table === 'document_attachments' && c.op === 'update')).toBe(true)
    expect(calls[0].payload).toMatchObject({ read_error: 'structured', page_count: null })
  })

  it('stamps ai_unconfigured so the backfill retry pass can find the row later', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('jpg')]), error: null, resolvedPath: 'p' })
    asMock(readDocumentBytes).mockResolvedValue({ ok: false, skipped: 'ai_unconfigured' })
    const { supabase, calls } = makeSupabase()
    expect(await readAndStoreDocument(supabase, { ...doc, mime_type: 'image/jpeg' })).toEqual({ status: 'skipped', reason: 'ai_unconfigured' })
    expect(calls[0].payload).toMatchObject({ read_error: 'ai_unconfigured', page_count: 0 })
  })

  it('reads text layers for a company outside the rollout but never calls the model', async () => {
    process.env.ARKIV_COMPANY_IDS = 'someone-else'
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('%PDF-')]), error: null, resolvedPath: 'p' })
    asMock(readDocumentBytes).mockResolvedValue({ ok: true, reader: 'pdf_text', pageCount: 2, partial: 'ai_gated', pages: [{ pageNo: 1, text: 'a', reader: 'pdf_text', hasTextLayer: true }] })
    const { supabase, calls } = makeSupabase()
    const out = await readAndStoreDocument(supabase, doc)
    expect(readDocumentBytes).toHaveBeenCalledWith(expect.any(Buffer), 'application/pdf', { allowModel: false, maxModelPages: null })
    expect(out).toEqual({ status: 'read', pages: 1, reader: 'pdf_text', partial: 'partial:ai_gated' })
    expect(calls.at(-1)!.payload).toMatchObject({ read_error: 'partial:ai_gated', page_count: 2 })
  })

  it('records a download failure as a read error and stamps the row', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: null, error: { message: 'Object not found' }, resolvedPath: null })
    const { supabase, calls } = makeSupabase()
    const out = await readAndStoreDocument(supabase, doc)
    expect(out).toEqual({ status: 'error', reason: 'download_failed: Object not found' })
    expect(calls[0].payload).toMatchObject({ read_error: 'download_failed: Object not found' })
  })
})

describe('readUnreadDocuments', () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.ARKIV_COMPANY_IDS = 'co-1' })

  it('retries gated rows only for companies now in the rollout, after the unread batch', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('x')]), error: null, resolvedPath: 'p' })
    asMock(readDocumentBytes).mockResolvedValue({ ok: true, reader: 'claude_vision', pageCount: 1, pages: [{ pageNo: 1, text: 't', reader: 'claude_vision', hasTextLayer: false }] })
    const { supabase } = makeSupabase([], [{ ...doc, id: 'r1', mime_type: 'image/jpeg' }, { ...doc, id: 'r2', company_id: 'other', mime_type: 'image/jpeg' }])
    expect(await readUnreadDocuments(supabase, 10)).toEqual({ processed: 1, read: 1, skipped: 0, errors: 0 })
    expect(readDocumentBytes).toHaveBeenCalledTimes(1)
    expect(readDocumentBytes).toHaveBeenCalledWith(expect.any(Buffer), 'image/jpeg', { allowModel: true, maxModelPages: null })
  })

  it('walks the unread batch and counts outcomes', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('x')]), error: null, resolvedPath: 'p' })
    asMock(readDocumentBytes).mockResolvedValue({ ok: true, reader: 'office', pageCount: 1, pages: [{ pageNo: 1, text: 't', reader: 'office', hasTextLayer: true }] })
    const { supabase } = makeSupabase([doc, { ...doc, id: 'doc-2', mime_type: 'application/xml' }])
    expect(await readUnreadDocuments(supabase, 10)).toEqual({ processed: 2, read: 1, skipped: 1, errors: 0 })
  })
})
