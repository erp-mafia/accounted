import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../router', () => ({ readDocumentBytes: vi.fn() }))
vi.mock('@/lib/core/documents/document-service', () => ({ downloadDocumentObject: vi.fn() }))
vi.mock('@/lib/ai', () => ({ getAiStatus: vi.fn(() => ({ configured: true })) }))

import { readAndStoreDocument, readUnreadDocuments, storableText } from '../store'
import { readDocumentBytes } from '../router'
import { ReaderUnavailableError } from '../types'
import { downloadDocumentObject } from '@/lib/core/documents/document-service'

type Call = { table: string; op: string; payload?: unknown; filters: Record<string, unknown> }

// A minimal chainable Supabase double that records every write and answers
// the backfill selects (retry, everyone's unread; the rollout select is gone) with the rows given.
function makeSupabase(unread: Array<Record<string, unknown>> = [], retry: Array<Record<string, unknown>> = [], rollout: Array<Record<string, unknown>> = []) {
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
    api.in = (k: string, v: unknown) => {
      state.filters[k] = v
      if (k === 'read_error') state.op = 'select-retry'
      else if (state.op !== 'select-retry') state.op = 'select-rollout'
      return api
    }
    api.order = () => api
    api.limit = (n: number) => {
      state.filters.limit = n
      calls.push(state)
      const rows = state.op === 'select-retry' ? retry : state.op === 'select-rollout' ? rollout : unread
      return Promise.resolve({ data: rows.slice(0, n), error: null })
    }
    return api
  }
  // The unread batch; other rpcs (the usage meter) answer empty and are not recorded.
  const rpc = (fn: string, args: { p_limit?: number }) => {
    if (fn === 'document_retry_candidates') {
      calls.push({ table: `rpc:${fn}`, op: 'select-retry', filters: { ...args } })
      return Promise.resolve({ data: retry.slice(0, args.p_limit), error: null })
    }
    if (fn !== 'document_backfill_candidates') return Promise.resolve({ data: null, error: null })
    calls.push({ table: `rpc:${fn}`, op: 'rpc', filters: { ...args } })
    return Promise.resolve({ data: unread.slice(0, args.p_limit), error: null })
  }
  return { supabase: { from: (t: string) => chain(t), rpc } as never, calls }
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

  it('lets the model at a document of any company: the shelf is on for everyone', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('%PDF-')]), error: null, resolvedPath: 'p' })
    asMock(readDocumentBytes).mockResolvedValue({ ok: true, reader: 'pdf_text', pageCount: 2, partial: 'ai_gated', pages: [{ pageNo: 1, text: 'a', reader: 'pdf_text', hasTextLayer: true }] })
    const { supabase, calls } = makeSupabase()
    const out = await readAndStoreDocument(supabase, doc)
    expect(readDocumentBytes).toHaveBeenCalledWith(expect.any(Buffer), 'application/pdf', { allowModel: true, maxModelPages: null })
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

  it('never stamps a document because the reader itself could not be loaded', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('x')]), error: null, resolvedPath: 'p' })
    asMock(readDocumentBytes).mockRejectedValue(new ReaderUnavailableError('pdf_text', new Error('Cannot find native binding')))
    const { supabase, calls } = makeSupabase()
    const out = await readAndStoreDocument(supabase, doc)
    expect(out).toEqual({ status: 'error', reason: 'reader_unavailable: pdf_text: Cannot find native binding' })
    // No write at all: pages_read_at stays null, so the backfill reads it once the reader is there.
    expect(calls).toEqual([])
  })

  it('still stamps a failure that is about the document', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('x')]), error: null, resolvedPath: 'p' })
    asMock(readDocumentBytes).mockRejectedValue(new Error('invalid PDF structure'))
    const { supabase, calls } = makeSupabase()
    expect(await readAndStoreDocument(supabase, doc)).toEqual({ status: 'error', reason: 'read_failed: invalid PDF structure' })
    expect(calls[0].payload).toMatchObject({ read_error: 'read_failed: invalid PDF structure' })
  })
})

describe('storableText', () => {
  it('drops what Postgres cannot hold and keeps the text, tabs and newlines', () => {
    expect(storableText('Hyra\u0000 19\u00a0300 kr\n\tper månad\u0007')).toBe('Hyra 19\u00a0300 kr\n\tper månad')
    // An unpaired surrogate becomes the replacement character; a real pair (an emoji) is left alone.
    expect(storableText('a\uD83Db')).toBe('a\uFFFDb')
    expect(storableText('ok \uD83D\uDE00')).toBe('ok \uD83D\uDE00')
  })

  it('is applied to the page text and to every position box before the insert', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('x')]), error: null, resolvedPath: 'p' })
    asMock(readDocumentBytes).mockResolvedValue({ ok: true, reader: 'pdf_text', pageCount: 1, pages: [{ pageNo: 1, text: 'Sum\u0000ma', reader: 'pdf_text', hasTextLayer: true, words: [{ t: 'Sum\u0000ma', x0: 1, y0: 1, x1: 2, y1: 2 }] }] })
    const { supabase, calls } = makeSupabase()
    await readAndStoreDocument(supabase, doc)
    const inserted = calls.find((c) => c.op === 'insert')!.payload as Array<{ text: string; words: Array<{ t: string }> }>
    expect(inserted[0].text).toBe('Summa')
    expect(inserted[0].words[0].t).toBe('Summa')
  })
})

describe('readUnreadDocuments', () => {
  beforeEach(() => { vi.clearAllMocks(); process.env.ARKIV_COMPANY_IDS = 'co-1' })

  it('retries the gated rows of every company, asking for no company in particular', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('x')]), error: null, resolvedPath: 'p' })
    asMock(readDocumentBytes).mockResolvedValue({ ok: true, reader: 'claude_vision', pageCount: 1, pages: [{ pageNo: 1, text: 't', reader: 'claude_vision', hasTextLayer: false }] })
    const { supabase, calls } = makeSupabase([], [{ ...doc, id: 'r1', mime_type: 'image/jpeg' }])
    expect(await readUnreadDocuments(supabase, 10)).toEqual({ processed: 1, read: 1, skipped: 0, errors: 0 })
    expect(readDocumentBytes).toHaveBeenCalledTimes(1)
    expect(readDocumentBytes).toHaveBeenCalledWith(expect.any(Buffer), 'image/jpeg', { allowModel: true, maxModelPages: null })
    expect(calls.find((c) => c.op === 'select-retry')?.filters.company_id).toBeUndefined()
    // Through the function that leaves out rows the stamp cannot land on (a locked period).
    expect(calls.find((c) => c.op === 'select-retry')).toMatchObject({ table: 'rpc:document_retry_candidates', filters: { p_reasons: expect.arrayContaining(['ai_gated']), p_limit: 40 } })
  })


  it('never asks for rollout rows: nobody goes first now that the shelf is on for everyone', async () => {
    const { supabase, calls } = makeSupabase([{ ...doc, mime_type: 'application/xml' }])
    expect(await readUnreadDocuments(supabase, 10)).toEqual({ processed: 1, read: 0, skipped: 1, errors: 0 })
    const ops = calls.filter((c) => c.op.startsWith('select') || c.op === 'rpc').map((c) => c.op)
    expect(ops).not.toContain('select-rollout')
    expect(ops.at(-1)).toBe('rpc')
  })

  it('stops between documents once the time budget is spent', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('x')]), error: null, resolvedPath: 'p' })
    asMock(readDocumentBytes).mockResolvedValue({ ok: true, reader: 'pdf_text', pageCount: 1, pages: [{ pageNo: 1, text: 't', reader: 'pdf_text', hasTextLayer: true }] })
    const { supabase } = makeSupabase([], [], [{ ...doc, id: 'mine-1' }, { ...doc, id: 'mine-2' }])
    expect(await readUnreadDocuments(supabase, 10, { budgetMs: 0 })).toEqual({ processed: 0, read: 0, skipped: 0, errors: 0 })
  })

  it('walks the unread batch and counts outcomes', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('x')]), error: null, resolvedPath: 'p' })
    asMock(readDocumentBytes).mockResolvedValue({ ok: true, reader: 'office', pageCount: 1, pages: [{ pageNo: 1, text: 't', reader: 'office', hasTextLayer: true }] })
    const { supabase, calls } = makeSupabase([doc, { ...doc, id: 'doc-2', mime_type: 'application/xml' }])
    expect(await readUnreadDocuments(supabase, 10)).toEqual({ processed: 2, read: 1, skipped: 1, errors: 0 })
    // The unread batch comes from the one function that knows which rows the stamp can land on.
    expect(calls.find((c) => c.op === 'rpc')).toMatchObject({ table: 'rpc:document_backfill_candidates', filters: { p_limit: 10 } })
  })

  it('stops the batch at the first document the missing reader fails, leaving the rest unread', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('x')]), error: null, resolvedPath: 'p' })
    asMock(readDocumentBytes).mockRejectedValue(new ReaderUnavailableError('pdf_text', new Error('Cannot find native binding')))
    const { supabase, calls } = makeSupabase([doc, { ...doc, id: 'doc-2' }, { ...doc, id: 'doc-3' }])
    expect(await readUnreadDocuments(supabase, 10)).toEqual({ processed: 1, read: 0, skipped: 0, errors: 1 })
    expect(readDocumentBytes).toHaveBeenCalledTimes(1)
    expect(calls.filter((c) => c.op === 'update')).toEqual([])
  })
})
