import { afterEach, describe, expect, it, vi } from 'vitest'
import { archiveUploadForm, isRetryableArchiveUploadFailure, uploadToArchive } from '../archive-upload'
import { DOCUMENT_UPLOAD_CREATE_URL } from '../direct-upload'
import { HOSTED_MAX_UPLOAD_BYTES } from '../upload-size'
import { PLAIN_DOCUMENT_UPLOAD_URL } from '../underlag-upload-route'

const DOCUMENT_ID = '11111111-1111-4111-8111-111111111111'
const UPLOAD_ID = '33333333-3333-4333-8333-333333333333'
const SIGNED_URL = 'https://proj.supabase.co/storage/v1/object/upload/sign/documents/documents/c/u/pending/x.pdf?token=signed'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function pdf(bytes = 16): File {
  return new File([new Uint8Array(bytes)], 'avtal.pdf', { type: 'application/pdf' })
}

type Call = { url: string; init: RequestInit | undefined }

function fetchSequence(responses: Array<Response | Error>) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    const next = responses.shift()
    if (!next) throw new Error('unexpected fetch')
    if (next instanceof Error) throw next
    return next
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('archiveUploadForm', () => {
  it('is the plain picked-file upload with content dedupe, and names no verifikat', () => {
    const form = archiveUploadForm()
    expect(form.get('upload_source')).toBe('file_upload')
    expect(form.get('dedupe_by_content')).toBe('true')
    expect(form.get('journal_entry_id')).toBeNull()
    expect(form.get('journal_entry_line_id')).toBeNull()
    expect(form.get('file')).toBeNull()
  })
})

describe('uploadToArchive', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('posts the file to the plain documents route, never the inbox, and answers the stored document', async () => {
    const { fetchImpl, calls } = fetchSequence([jsonResponse({ data: { id: DOCUMENT_ID } })])

    const result = await uploadToArchive(pdf(), { fetchImpl })

    expect(result).toEqual({ ok: true, documentId: DOCUMENT_ID, deduplicated: false })
    expect(calls.map((c) => c.url)).toEqual([PLAIN_DOCUMENT_UPLOAD_URL])
    expect(calls[0].url).not.toContain('invoice-inbox')
    expect(calls[0].init?.method).toBe('POST')
    const sent = calls[0].init?.body as FormData
    expect(sent.get('upload_source')).toBe('file_upload')
    expect(sent.get('dedupe_by_content')).toBe('true')
    expect((sent.get('file') as File).name).toBe('avtal.pdf')
  })

  it('says when the bytes were already archived', async () => {
    const { fetchImpl } = fetchSequence([jsonResponse({ data: { id: DOCUMENT_ID, deduplicated: true, duplicate_of: DOCUMENT_ID } })])

    expect(await uploadToArchive(pdf(), { fetchImpl })).toEqual({ ok: true, documentId: DOCUMENT_ID, deduplicated: true })
  })

  it('stages a file over the hosted body limit in Storage first and still posts to the documents route', async () => {
    vi.stubEnv('NEXT_PUBLIC_SELF_HOSTED', '')
    const { fetchImpl, calls } = fetchSequence([
      jsonResponse({ data: { upload_id: UPLOAD_ID, upload_url: SIGNED_URL, expires_at: '2026-11-17T12:00:00.000Z' } }),
      new Response(null, { status: 200 }),
      jsonResponse({ data: { id: DOCUMENT_ID } }),
    ])

    const result = await uploadToArchive(pdf(HOSTED_MAX_UPLOAD_BYTES + 1), { fetchImpl })

    expect(result).toEqual({ ok: true, documentId: DOCUMENT_ID, deduplicated: false })
    expect(calls.map((c) => c.url)).toEqual([DOCUMENT_UPLOAD_CREATE_URL, SIGNED_URL, PLAIN_DOCUMENT_UPLOAD_URL])
    const sent = calls[2].init?.body as FormData
    expect(sent.get('upload_id')).toBe(UPLOAD_ID)
    expect(sent.get('dedupe_by_content')).toBe('true')
    expect(sent.get('file')).toBeNull()
  })

  it('hands back the status and the error envelope of a refusal', async () => {
    const envelope = { error: { code: 'DOC_UPLOAD_INVALID_CONTENT', message: 'Filen kunde inte läsas som en giltig PDF eller bild.' } }
    const { fetchImpl } = fetchSequence([jsonResponse(envelope, 400)])

    expect(await uploadToArchive(pdf(), { fetchImpl })).toEqual({ ok: false, status: 400, body: envelope })
  })

  it('is a failure when the answer carries no document id', async () => {
    const { fetchImpl } = fetchSequence([jsonResponse({ data: {} })])

    expect(await uploadToArchive(pdf(), { fetchImpl })).toEqual({ ok: false, status: 200, body: { data: {} } })
  })

  it('is a failure with no body when the answer is not JSON', async () => {
    const { fetchImpl } = fetchSequence([new Response('<html>Bad gateway</html>', { status: 502 })])

    expect(await uploadToArchive(pdf(), { fetchImpl })).toEqual({ ok: false, status: 502, body: null })
  })

  it('is a failure with status 0 when nothing answered', async () => {
    const { fetchImpl } = fetchSequence([new TypeError('Failed to fetch')])

    expect(await uploadToArchive(pdf(), { fetchImpl })).toEqual({ ok: false, status: 0, body: null })
  })

  it('sends nothing for a file the browser cannot read', async () => {
    const { fetchImpl, calls } = fetchSequence([])
    const unreadable = pdf()
    Object.defineProperty(unreadable, 'arrayBuffer', { value: () => Promise.reject(new Error('NotReadableError')) })

    const result = await uploadToArchive(unreadable, { fetchImpl })

    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ status: 400, body: { error: { code: 'DOC_UPLOAD_FILE_UNREADABLE' } } })
    expect(calls).toEqual([])
  })
})

describe('isRetryableArchiveUploadFailure', () => {
  it('offers the same file again when nothing answered, the server failed or the limit asked for a pause', () => {
    for (const status of [0, 429, 500, 502, 503]) expect(isRetryableArchiveUploadFailure(status)).toBe(true)
  })

  it('does not when the refusal is about the file or the person', () => {
    for (const status of [200, 400, 401, 403, 413, 415]) expect(isRetryableArchiveUploadFailure(status)).toBe(false)
  })
})
