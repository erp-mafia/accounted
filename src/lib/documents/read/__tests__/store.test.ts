import { describe, it, expect, vi, beforeEach } from 'vitest'

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => log }))
vi.mock('@/lib/documents/preview', () => ({ keptPreview: vi.fn(async () => null) }))
vi.mock('../router', () => ({ readDocumentBytes: vi.fn() }))
vi.mock('@/lib/core/documents/document-service', () => ({ downloadDocumentObject: vi.fn() }))
vi.mock('@/lib/ai', () => ({ getAiStatus: vi.fn(() => ({ configured: true })) }))

import { readAndStoreDocument, readUnreadDocuments, storableText } from '../store'
import { readDocumentBytes } from '../router'
import { ReaderUnavailableError } from '../types'
import { AiCallTimeoutError, withAiDeadline } from '@/lib/ai/call-limit'
import { createTableMockSupabase } from '@/tests/helpers'
import { READ_GAVE_UP } from '../types'
import { downloadDocumentObject } from '@/lib/core/documents/document-service'
import { keptPreview } from '@/lib/documents/preview'

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

  it('reports a download failure once: it was stamped without a word, and nobody knew the document had no text', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: null, error: { message: 'Object not found' }, resolvedPath: null })
    const { supabase } = makeSupabase()
    await readAndStoreDocument(supabase, doc)
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('could not be downloaded'), expect.objectContaining({ doc: 'doc-1', company: 'co-1', reason: 'download_failed: Object not found' }))
    // The job's later attempts meet the same failure on a row already stamped with it: a warning, not a second report.
    await readAndStoreDocument(supabase, { ...doc, read_error: 'download_failed: Object not found' })
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('could not be downloaded'), expect.objectContaining({ doc: 'doc-1' }))
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

  it('never stamps a document because the model provider is down', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('x')]), error: null, resolvedPath: 'p' })
    // The Bedrock SDK error as it reaches the store: the message and a numeric status.
    asMock(readDocumentBytes).mockRejectedValue(Object.assign(new Error('503 Bedrock is unable to process your request.'), { status: 503 }))
    const { supabase, calls } = makeSupabase()
    const out = await readAndStoreDocument(supabase, doc)
    expect(out).toEqual({ status: 'error', reason: 'reader_unavailable: 503 Bedrock is unable to process your request.' })
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

/**
 * A reading the provider did not answer is tried again, and nothing counted
 * the tries: a scan too long for one run was read from the start every five
 * minutes for as long as it existed. The database counts them, once per wait
 * (tests/pg/document-backfill-candidates.pg.test.ts); this is what the reader
 * does with the count.
 */
describe('readAndStoreDocument: readings the provider did not answer', () => {
  const noAnswer = Object.assign(new Error('Bedrock is unable to process your request.'), { status: 503 })
  /** A database whose count answers as given, and whose give-up write matches the row or not. */
  const db = (note: { data?: unknown; error?: unknown }, write: { data?: unknown; error?: unknown } = { data: [{ id: 'doc-1' }] }) =>
    createTableMockSupabase({ 'rpc:note_document_read_unavailable': note, document_attachments: write })
  const counted = (failures: number, isCounted = true) => ({ data: [{ failures, counted: isCounted }] })
  const run = (mock: ReturnType<typeof db>, row: Record<string, unknown> = doc) => readAndStoreDocument(mock.supabase as never, row as typeof doc)

  beforeEach(() => {
    vi.clearAllMocks()
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('%PDF-')]), error: null, resolvedPath: doc.storage_path })
  })

  it('counts the reading with the waits before the next tries, and leaves the document unstamped', async () => {
    asMock(readDocumentBytes).mockRejectedValue(noAnswer)
    const mock = db(counted(2))
    expect(await run(mock)).toEqual({ status: 'error', reason: 'reader_unavailable: Bedrock is unable to process your request.' })
    // The queue's outage backoff, then a day: five take at least 7.5 hours, and a document given up on is tried daily.
    expect(mock.findCall('rpc:note_document_read_unavailable', 'rpc')).toEqual([{ p_document_id: 'doc-1', p_backoff_minutes: [30, 60, 120, 240, 1440] }])
    expect(mock.payloads('document_attachments', 'update')).toEqual([])
    expect(log.error).not.toHaveBeenCalled()
  })

  it('gives the document up when the fifth reading in a row counted: it stays unread, marked, reported once', async () => {
    asMock(readDocumentBytes).mockRejectedValue(new AiCallTimeoutError('call_limit', 120_000))
    const mock = db(counted(5))
    const out = await run(mock)
    expect(out).toMatchObject({ status: 'error', reason: expect.stringMatching(/^read_failed: gave up after 5 readings without an answer: Request timed out/) })
    // read_error only: pages_read_at stays NULL, so the backfill takes it again after its day and a question reads it at once.
    expect(mock.payloads('document_attachments', 'update')).toEqual([{ read_error: READ_GAVE_UP }])
    // Only onto a row nothing has been read from: a reading that landed meanwhile wins.
    expect(mock.findCalls('document_attachments', 'is')).toEqual([['pages_read_at', null]])
    expect(mock.findCalls('document_attachments', 'eq')).toEqual([['id', 'doc-1']])
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining('given up on'), expect.objectContaining({ doc: 'doc-1', company: 'co-1', unanswered: 5 }))
  })

  it('never gives up on a retry inside a wait: a one-minute burst while someone watches the upload is one failure', async () => {
    asMock(readDocumentBytes).mockRejectedValue(noAnswer)
    // The count already stands at five (or anything): this failure did not count, so it decides nothing.
    const mock = db(counted(5, false))
    expect(await run(mock)).toMatchObject({ status: 'error', reason: expect.stringMatching(/^reader_unavailable: /) })
    expect(mock.payloads('document_attachments', 'update')).toEqual([])
    expect(log.error).not.toHaveBeenCalled()
  })

  it('never marks a document a pass already stored pages for', async () => {
    asMock(readDocumentBytes).mockRejectedValue(noAnswer)
    const mock = db(counted(5))
    const out = await run(mock, { ...doc, pages_read_at: '2026-11-01T10:00:00Z', read_error: 'partial:budget' })
    expect(out).toMatchObject({ status: 'error', reason: expect.stringMatching(/^reader_unavailable: /) })
    expect(mock.payloads('document_attachments', 'update')).toEqual([])
    expect(log.error).not.toHaveBeenCalled()
  })

  it('loses to a reading that landed meanwhile: the conditional write matched no row, nothing is reported', async () => {
    asMock(readDocumentBytes).mockRejectedValue(noAnswer)
    const mock = db(counted(5), { data: [] })
    expect(await run(mock)).toMatchObject({ status: 'error', reason: expect.stringMatching(/^reader_unavailable: /) })
    expect(log.error).not.toHaveBeenCalled()
  })

  it('reports a document given up on only the first time: its daily try that fails again warns', async () => {
    asMock(readDocumentBytes).mockRejectedValue(noAnswer)
    const mock = db(counted(6))
    const out = await run(mock, { ...doc, read_error: READ_GAVE_UP })
    expect(out).toMatchObject({ status: 'error', reason: expect.stringMatching(/^read_failed: gave up after 6 /) })
    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('still gets no answer'), expect.objectContaining({ doc: 'doc-1' }))
    // The mark is there already: writing it again would only add an audit row a day.
    expect(mock.payloads('document_attachments', 'update')).toEqual([])
    expect(mock.findCalls('document_attachments', 'is')).toEqual([['pages_read_at', null]])
  })

  it('loses a daily try to a reading that landed meanwhile on a document given up on: nothing is reported', async () => {
    asMock(readDocumentBytes).mockRejectedValue(noAnswer)
    const mock = db(counted(6), { data: [] })
    const out = await run(mock, { ...doc, read_error: READ_GAVE_UP })
    expect(out).toMatchObject({ status: 'error', reason: expect.stringMatching(/^reader_unavailable: /) })
    expect(log.warn).not.toHaveBeenCalledWith(expect.stringContaining('still gets no answer'), expect.anything())
  })

  it('counts a reading the run cut after it had its time: that is the document that does not fit', async () => {
    asMock(readDocumentBytes).mockRejectedValue(new AiCallTimeoutError('run_deadline', 275_000))
    const mock = db(counted(1))
    await withAiDeadline(Date.now() + 275_000, () => run(mock))
    expect(mock.findCall('rpc:note_document_read_unavailable', 'rpc')).toBeDefined()
  })

  it('does not count a reading the run cut before it had the time one model call gets: it started too late to say anything', async () => {
    asMock(readDocumentBytes).mockRejectedValue(new AiCallTimeoutError('run_deadline', 90_000))
    const mock = db(counted(5))
    expect(await withAiDeadline(Date.now() + 90_000, () => run(mock))).toMatchObject({ status: 'error', reason: expect.stringMatching(/^reader_unavailable: /) })
    expect(mock.findCall('rpc:note_document_read_unavailable', 'rpc')).toBeUndefined()
  })

  it('takes "the time one call gets" from the deployment\'s limit, never more than the default', async () => {
    asMock(readDocumentBytes).mockRejectedValue(new AiCallTimeoutError('run_deadline', 90_000))
    try {
      // A deployment whose calls get a minute: 90 s at the start was more than a call's time, so the cut counts.
      vi.stubEnv('AI_CALL_TIMEOUT_SECONDS', '60')
      let mock = db(counted(1))
      await withAiDeadline(Date.now() + 90_000, () => run(mock))
      expect(mock.findCall('rpc:note_document_read_unavailable', 'rpc')).toBeDefined()
      // A self-host whose calls get ten minutes, longer than any run has: a reading with 200 s still counts.
      vi.stubEnv('AI_CALL_TIMEOUT_SECONDS', '600')
      mock = db(counted(1))
      await withAiDeadline(Date.now() + 200_000, () => run(mock))
      expect(mock.findCall('rpc:note_document_read_unavailable', 'rpc')).toBeDefined()
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('does not count a reader that could not be loaded: the deployment is broken, not the document', async () => {
    asMock(readDocumentBytes).mockRejectedValue(new ReaderUnavailableError('pdf_text', new Error('Cannot find native binding')))
    const mock = db(counted(5))
    expect(await run(mock)).toMatchObject({ status: 'error', reason: expect.stringMatching(/^reader_unavailable: /) })
    expect(mock.findCall('rpc:note_document_read_unavailable', 'rpc')).toBeUndefined()
  })

  it('leaves the document as before when the count cannot be kept (the function is not deployed yet)', async () => {
    asMock(readDocumentBytes).mockRejectedValue(noAnswer)
    const mock = db({ error: { message: 'Could not find the function public.note_document_read_unavailable' } })
    expect(await run(mock)).toMatchObject({ status: 'error', reason: expect.stringMatching(/^reader_unavailable: /) })
    expect(mock.payloads('document_attachments', 'update')).toEqual([])
    expect(log.error).not.toHaveBeenCalled()
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

describe('readAndStoreDocument reads a photo from its kept preview', () => {
  it('sends the viewer\'s JPEG to the model and never downloads the original', async () => {
    asMock(downloadDocumentObject).mockClear()
    asMock(keptPreview).mockResolvedValueOnce(Buffer.from('jpeg-preview'))
    asMock(readDocumentBytes).mockResolvedValue({ ok: true, reader: 'claude_vision', pageCount: 1, pages: [{ pageNo: 1, text: 'Kvitto', reader: 'claude_vision', hasTextLayer: false }] })
    const { supabase } = makeSupabase()
    const out = await readAndStoreDocument(supabase, { ...doc, mime_type: 'image/heic' })
    expect(out).toMatchObject({ status: 'read', pages: 1 })
    expect(downloadDocumentObject).not.toHaveBeenCalled()
    expect(readDocumentBytes).toHaveBeenCalledWith(Buffer.from('jpeg-preview'), 'image/jpeg', expect.anything())
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
    expect(await readUnreadDocuments(supabase, 10, { deadlineAt: Date.now() })).toEqual({ processed: 0, read: 0, skipped: 0, errors: 0 })
  })

  it('starts no document at or after the deadline, in the retry pass or the unread one', async () => {
    let now = 1_000
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now)
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('x')]), error: null, resolvedPath: 'p' })
    // Every document takes a minute to read.
    asMock(readDocumentBytes).mockImplementation(async () => {
      now += 60_000
      return { ok: true, reader: 'pdf_text', pageCount: 1, pages: [{ pageNo: 1, text: 't', reader: 'pdf_text', hasTextLayer: true }] }
    })
    try {
      const retry = [{ ...doc, id: 'r1' }, { ...doc, id: 'r2' }]
      const unread = [{ ...doc, id: 'u1' }, { ...doc, id: 'u2' }, { ...doc, id: 'u3' }]
      // Deadline at 150 s: r1 starts at 0, r2 at 60, u1 at 120; u2 would start at 180.
      expect(await readUnreadDocuments(makeSupabase(unread, retry).supabase, 10, { deadlineAt: 151_000 })).toEqual({ processed: 3, read: 3, skipped: 0, errors: 0 })
    } finally {
      clock.mockRestore()
    }
  })

  it('walks the unread batch and counts outcomes', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('x')]), error: null, resolvedPath: 'p' })
    asMock(readDocumentBytes).mockResolvedValue({ ok: true, reader: 'office', pageCount: 1, pages: [{ pageNo: 1, text: 't', reader: 'office', hasTextLayer: true }] })
    const { supabase, calls } = makeSupabase([doc, { ...doc, id: 'doc-2', mime_type: 'application/xml' }])
    expect(await readUnreadDocuments(supabase, 10)).toEqual({ processed: 2, read: 1, skipped: 1, errors: 0 })
    // The unread batch comes from the one function that knows which rows the stamp can land on.
    expect(calls.find((c) => c.op === 'rpc')).toMatchObject({ table: 'rpc:document_backfill_candidates', filters: { p_limit: 10 } })
  })

  it('goes on to the next document when the provider fails one: the same document no longer heads every run alone', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('x')]), error: null, resolvedPath: 'p' })
    const page = { ok: true, reader: 'pdf_text', pageCount: 1, pages: [{ pageNo: 1, text: 't', reader: 'pdf_text', hasTextLayer: true }] }
    asMock(readDocumentBytes)
      .mockRejectedValueOnce(Object.assign(new Error('Bedrock is unable to process your request.'), { status: 503 }))
      .mockResolvedValue(page)
    const { supabase, calls } = makeSupabase([doc, { ...doc, id: 'doc-2' }, { ...doc, id: 'doc-3' }])
    expect(await readUnreadDocuments(supabase, 10)).toEqual({ processed: 3, read: 2, skipped: 0, errors: 1 })
    // The failed one is not stamped: it stays unread for the next run.
    expect(calls.filter((c) => c.op === 'update').map((c) => c.filters.id)).toEqual(['doc-2', 'doc-3'])
  })

  it('goes on in the retry pass too, and into the unread pass after it', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('x')]), error: null, resolvedPath: 'p' })
    const page = { ok: true, reader: 'pdf_text', pageCount: 1, pages: [{ pageNo: 1, text: 't', reader: 'pdf_text', hasTextLayer: true }] }
    asMock(readDocumentBytes)
      .mockRejectedValueOnce(Object.assign(new Error('Bedrock is unable to process your request.'), { status: 503 }))
      .mockResolvedValue(page)
    const { supabase } = makeSupabase([{ ...doc, id: 'u1' }], [{ ...doc, id: 'r1' }, { ...doc, id: 'r2' }])
    expect(await readUnreadDocuments(supabase, 10)).toEqual({ processed: 3, read: 2, skipped: 0, errors: 1 })
  })

  it('stops the batch once the missing reader has failed three documents in a row, leaving the rest unread', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('x')]), error: null, resolvedPath: 'p' })
    asMock(readDocumentBytes).mockRejectedValue(new ReaderUnavailableError('pdf_text', new Error('Cannot find native binding')))
    const { supabase, calls } = makeSupabase([doc, { ...doc, id: 'doc-2' }, { ...doc, id: 'doc-3' }, { ...doc, id: 'doc-4' }, { ...doc, id: 'doc-5' }])
    expect(await readUnreadDocuments(supabase, 10)).toEqual({ processed: 3, read: 0, skipped: 0, errors: 3 })
    expect(readDocumentBytes).toHaveBeenCalledTimes(3)
    expect(calls.filter((c) => c.op === 'update')).toEqual([])
  })

  it('stops for the run when the retry pass met the provider down: the unread pass is not started', async () => {
    asMock(downloadDocumentObject).mockResolvedValue({ blob: new Blob([Buffer.from('x')]), error: null, resolvedPath: 'p' })
    asMock(readDocumentBytes).mockRejectedValue(Object.assign(new Error('Bedrock is unable to process your request.'), { status: 503 }))
    const retry = [1, 2, 3, 4].map((n) => ({ ...doc, id: `r${n}` }))
    const { supabase, calls } = makeSupabase([{ ...doc, id: 'u1' }], retry)
    expect(await readUnreadDocuments(supabase, 10)).toEqual({ processed: 3, read: 0, skipped: 0, errors: 3 })
    expect(calls.some((c) => c.table === 'rpc:document_backfill_candidates')).toBe(false)
  })
})
