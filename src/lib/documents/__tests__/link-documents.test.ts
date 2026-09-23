import { describe, it, expect, vi } from 'vitest'
import {
  linkDocuments,
  formatFailedDocumentNames,
  type DocumentLinkTarget,
} from '../link-documents'

function okResponse(): Response {
  return new Response(JSON.stringify({ data: { id: 'doc' } }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function errorResponse(status: number, code?: string, message?: string): Response {
  return new Response(
    JSON.stringify(code ? { error: { code, message } } : {}),
    { status, headers: { 'Content-Type': 'application/json' } },
  )
}

const targets: DocumentLinkTarget[] = [
  { documentId: 'doc-1', fileName: 'kvitto-1.pdf' },
  { documentId: 'doc-2', fileName: 'kvitto-2.pdf' },
  { documentId: 'doc-3', fileName: 'kvitto-3.pdf' },
]

describe('linkDocuments', () => {
  it('links every document when all calls succeed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse())

    const result = await linkDocuments(targets, 'entry-1', { fetchImpl })

    expect(result.linked).toEqual(['doc-1', 'doc-2', 'doc-3'])
    expect(result.failed).toEqual([])
    expect(result.allLinked).toBe(true)
    expect(result.firstLinkedId).toBe('doc-1')
    expect(fetchImpl).toHaveBeenCalledTimes(3)
  })

  it('POSTs to the link endpoint with the journal entry id', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse())

    await linkDocuments([{ documentId: 'doc-1', fileName: 'a.pdf' }], 'entry-9', { fetchImpl })

    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('/api/documents/doc-1/link')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({ journal_entry_id: 'entry-9' })
  })

  it('passes inbox_item_id and transaction_id through only when set', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse())

    await linkDocuments(
      [{ documentId: 'doc-1', inboxItemId: 'inbox-1', transactionId: 'tx-1' }],
      'entry-1',
      { fetchImpl },
    )

    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      journal_entry_id: 'entry-1',
      inbox_item_id: 'inbox-1',
      transaction_id: 'tx-1',
    })
  })

  it('reports the specific documents that failed when some succeed', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse())
      .mockResolvedValueOnce(errorResponse(500, 'DOC_LINK_FAILED', 'Kunde inte bifoga underlag'))
      .mockResolvedValueOnce(okResponse())

    const result = await linkDocuments(targets, 'entry-1', { fetchImpl })

    expect(result.linked).toEqual(['doc-1', 'doc-3'])
    expect(result.allLinked).toBe(false)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]).toEqual({
      documentId: 'doc-2',
      fileName: 'kvitto-2.pdf',
      status: 500,
      code: 'DOC_LINK_FAILED',
      reason: 'Kunde inte bifoga underlag',
    })
    // The caller must be able to name the missing underlag to the user.
    expect(formatFailedDocumentNames(result.failed)).toBe('kvitto-2.pdf')
  })

  it('reports a non-ok response as a failure (the old empty-catch hid these)', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(errorResponse(403, 'PERIOD_LOCKED', 'Bokföringen är låst'))

    const result = await linkDocuments([targets[0]], 'entry-1', { fetchImpl })

    expect(result.linked).toEqual([])
    expect(result.allLinked).toBe(false)
    expect(result.failed[0].status).toBe(403)
    expect(result.failed[0].code).toBe('PERIOD_LOCKED')
  })

  it('handles a non-ok response with a non-JSON body', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response('<html>502</html>', { status: 502 }))

    const result = await linkDocuments([targets[0]], 'entry-1', { fetchImpl })

    expect(result.allLinked).toBe(false)
    expect(result.failed[0]).toEqual({
      documentId: 'doc-1',
      fileName: 'kvitto-1.pdf',
      status: 502,
      code: null,
      reason: null,
    })
  })

  it('reports every document when all links fail', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(errorResponse(500, 'DOC_LINK_FAILED'))

    const result = await linkDocuments(targets, 'entry-1', { fetchImpl })

    expect(result.linked).toEqual([])
    expect(result.failed).toHaveLength(3)
    expect(result.firstLinkedId).toBeNull()
    expect(result.allLinked).toBe(false)
    expect(formatFailedDocumentNames(result.failed)).toBe(
      'kvitto-1.pdf, kvitto-2.pdf, kvitto-3.pdf',
    )
  })

  it('reports a thrown network error instead of swallowing it', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse())
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(okResponse())

    const result = await linkDocuments(targets, 'entry-1', { fetchImpl })

    expect(result.linked).toEqual(['doc-1', 'doc-3'])
    expect(result.failed).toEqual([
      {
        documentId: 'doc-2',
        fileName: 'kvitto-2.pdf',
        status: 0,
        code: null,
        reason: 'Failed to fetch',
      },
    ])
  })

  it('never rejects, even when every call throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('offline'))

    await expect(linkDocuments(targets, 'entry-1', { fetchImpl })).resolves.toMatchObject({
      linked: [],
      allLinked: false,
    })
  })

  it('treats an empty target list as nothing to do', async () => {
    const fetchImpl = vi.fn()

    const result = await linkDocuments([], 'entry-1', { fetchImpl })

    expect(result).toEqual({ linked: [], failed: [], firstLinkedId: null, allLinked: true })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('encodes the document id in the URL', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse())

    await linkDocuments([{ documentId: 'a/b c' }], 'entry-1', { fetchImpl })

    expect(fetchImpl.mock.calls[0][0]).toBe('/api/documents/a%2Fb%20c/link')
  })
})

describe('formatFailedDocumentNames', () => {
  it('falls back to the document id when the file name is missing', () => {
    expect(
      formatFailedDocumentNames([
        { documentId: 'doc-1', fileName: null, status: 500, code: null, reason: null },
        { documentId: 'doc-2', fileName: 'kvitto.pdf', status: 0, code: null, reason: null },
      ]),
    ).toBe('doc-1, kvitto.pdf')
  })
})
