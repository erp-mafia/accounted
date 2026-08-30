import { describe, it, expect, vi } from 'vitest'
import {
  INBOX_UPLOAD_COMPLETE_URL,
  INBOX_UPLOAD_CREATE_URL,
  uploadViaSignedUrl,
} from '../direct-upload'

const UPLOAD_ID = '33333333-3333-4333-8333-333333333333'
const SIGNED_URL =
  'https://proj.supabase.co/storage/v1/object/upload/sign/documents/documents/c/u/pending/x.pdf?token=signed'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function reservationResponse(): Response {
  return jsonResponse({
    data: { upload_id: UPLOAD_ID, upload_url: SIGNED_URL, expires_at: '2026-08-28T12:00:00.000Z' },
  })
}

function fakeFile(): File {
  return new File([new Uint8Array(16)], 'faktura.pdf', { type: 'application/pdf' })
}

type Call = { url: string; init: RequestInit | undefined }

function fetchSequence(responses: Array<Response | (() => Response)>) {
  const calls: Call[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init })
    const next = responses.shift()
    if (!next) throw new Error('unexpected fetch')
    return typeof next === 'function' ? next() : next
  }) as unknown as typeof fetch
  return { fetchImpl, calls }
}

describe('uploadViaSignedUrl', () => {
  it('runs create, PUT to the raw signed URL, then complete, and resolves to the complete response', async () => {
    const completeRes = jsonResponse({ data: { inbox_item_id: 'inbox-1' } })
    const { fetchImpl, calls } = fetchSequence([
      reservationResponse(),
      new Response(null, { status: 200 }),
      completeRes,
    ])
    const file = fakeFile()

    const res = await uploadViaSignedUrl(file, {
      fetchImpl,
      matchedTransactionId: 'tx-1',
      skipExtraction: true,
    })

    expect(res).toBe(completeRes)
    expect(calls.map((c) => c.url)).toEqual([INBOX_UPLOAD_CREATE_URL, SIGNED_URL, INBOX_UPLOAD_COMPLETE_URL])

    // 1. create: JSON metadata only, never the bytes
    expect(calls[0].init?.method).toBe('POST')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({
      file_name: 'faktura.pdf',
      mime_type: 'application/pdf',
      size_bytes: 16,
    })

    // 2. PUT: the file itself, typed, no upsert onto an existing key
    expect(calls[1].init?.method).toBe('PUT')
    expect(calls[1].init?.headers).toEqual({ 'content-type': 'application/pdf', 'x-upsert': 'false' })
    expect(calls[1].init?.body).toBe(file)

    // 3. complete: the reservation plus the same options /upload takes
    expect(calls[2].init?.method).toBe('POST')
    expect(JSON.parse(String(calls[2].init?.body))).toEqual({
      upload_id: UPLOAD_ID,
      file_name: 'faktura.pdf',
      mime_type: 'application/pdf',
      matched_transaction_id: 'tx-1',
      skip_extraction: true,
    })
  })

  it('defaults to no matched transaction and extraction on', async () => {
    const { fetchImpl, calls } = fetchSequence([
      reservationResponse(),
      new Response(null, { status: 200 }),
      jsonResponse({ data: {} }),
    ])

    await uploadViaSignedUrl(fakeFile(), { fetchImpl })

    expect(JSON.parse(String(calls[2].init?.body))).toMatchObject({
      matched_transaction_id: null,
      skip_extraction: false,
    })
  })

  it('returns the create response unchanged when the reservation is refused, and sends nothing else', async () => {
    const limited = jsonResponse({ error: { code: 'RATE_LIMITED', message: 'För många' } }, 429)
    const { fetchImpl, calls } = fetchSequence([limited])

    const res = await uploadViaSignedUrl(fakeFile(), { fetchImpl })

    expect(res).toBe(limited)
    expect(calls).toHaveLength(1)
  })

  it('aborts before complete when Storage rejects the PUT, surfacing the status in an envelope', async () => {
    const { fetchImpl, calls } = fetchSequence([
      reservationResponse(),
      new Response('token expired', { status: 403 }),
    ])

    const res = await uploadViaSignedUrl(fakeFile(), { fetchImpl })

    expect(calls).toHaveLength(2)
    expect(res.ok).toBe(false)
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('INBOX_UPLOAD_STORAGE_REJECTED')
    expect(body.error.message).toContain('403')
    expect(body.error.message).toContain('Försök igen')
  })

  it('throws when the reservation is malformed rather than PUTting to nowhere', async () => {
    const { fetchImpl, calls } = fetchSequence([jsonResponse({ data: { upload_id: UPLOAD_ID } })])

    await expect(uploadViaSignedUrl(fakeFile(), { fetchImpl })).rejects.toThrow(/upload_url/)
    expect(calls).toHaveLength(1)
  })
})
