/**
 * Filing a hunted receipt. What matters here is what must NOT happen: no
 * duplicate ingest, no oversized download, and one unreadable attachment never
 * costing the rest of the run.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MailCandidate } from '@/lib/mail-search/service'

const mockUploadDocument = vi.fn()
vi.mock('@/lib/core/documents/document-service', () => ({
  uploadDocument: (...args: unknown[]) => mockUploadDocument(...args),
}))

const mockAppendHistory = vi.fn()
vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: (...args: unknown[]) => mockAppendHistory(...args),
}))

const mockFetchAttachment = vi.fn()
vi.mock('@/lib/mail-search/service', () => ({
  getMailSearchService: () => ({
    fetchAttachment: (...args: unknown[]) => mockFetchAttachment(...args),
    search: vi.fn(),
    isConfigured: () => true,
  }),
}))

import { ingestMailCandidate, sniffMimeType } from '../ingest'

function candidate(overrides: Partial<MailCandidate> = {}): MailCandidate {
  return {
    connectionId: 'conn-1',
    mailbox: 'ekonomi@nordvik.se',
    provider: 'gmail',
    messageId: 'msg-1',
    subject: 'Ditt kvitto',
    from: 'no-reply@circlek.se',
    receivedAt: '2026-05-02T10:00:00Z',
    attachmentIds: ['att-1'],
    bodyIsReceipt: false,
    ...overrides,
  }
}

/** Table-dispatching Supabase stand-in with a settable existing-row answer. */
function mockSupabase(
  existing: { id: string } | null,
  insertResult: { data?: unknown; error?: unknown } = {},
  laterInboxAnswers: Array<{ id: string } | null> = [],
) {
  const inboxQueue: Array<{ id: string } | null> = [existing, ...laterInboxAnswers]
  const inserted: Array<Record<string, unknown>> = []
  const client = {
    from(table: string) {
      const chain: Record<string, unknown> = {}
      for (const m of ['select', 'eq', 'is', 'not', 'order', 'limit']) chain[m] = vi.fn(() => chain)
      chain.maybeSingle = vi.fn(() =>
        Promise.resolve(
          table === 'document_attachments'
            ? { data: { extracted_data: { total_amount: 425 } }, error: null }
            : { data: inboxQueue.length ? inboxQueue.shift() ?? null : null, error: null },
        ),
      )
      chain.insert = vi.fn((row: Record<string, unknown>) => {
        inserted.push(row)
        return {
          select: () => ({
            single: () =>
              Promise.resolve(
                insertResult.error
                  ? { data: null, error: insertResult.error }
                  : { data: insertResult.data ?? { id: 'item-1' }, error: null },
              ),
          }),
        }
      })
      return chain
    },
  }
  return { client: client as never, inserted }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockUploadDocument.mockResolvedValue({ id: 'doc-1' })
  mockFetchAttachment.mockResolvedValue({
    filename: 'kvitto.pdf',
    mimeType: 'application/pdf',
    bytes: Buffer.from('%PDF-1.4 fake'),
  })
})

describe('ingestMailCandidate', () => {
  it('files an attachment and returns the pairing material', async () => {
    const { client, inserted } = mockSupabase(null)
    const result = await ingestMailCandidate(client, 'co-1', 'user-1', candidate())

    expect(result).toMatchObject({ documentId: 'doc-1', inboxItemId: 'item-1', fileName: 'kvitto.pdf' })
    expect(inserted).toHaveLength(1)
    expect(inserted[0].source).toBe('mail_hunt')
    // Provenance goes in channel_context, never extracted_data: retrying
    // extraction overwrites extracted_data wholesale, and the record of which
    // mailbox a receipt came from has to survive that.
    const ctx = inserted[0].channel_context as Record<string, unknown>
    expect(ctx.mail_message_id).toBe('msg-1')
    expect(ctx.mail_mailbox).toBe('ekonomi@nordvik.se')
    // Keyed per attachment: a batch forward carries receipts for several
    // purchases, and filing the first must not block the rest.
    expect(ctx.mail_file_key).toBe('msg-1::att-1')
    const extracted = inserted[0].extracted_data as Record<string, unknown> | null
    expect(extracted).not.toHaveProperty('mail_message_id')
    // The extraction that ran on upload is copied onto the inbox item: the
    // pool is read from here, and a row with no amount can never be paired.
    expect(extracted).toMatchObject({ total_amount: 425 })
  })

  it('does not fetch anything for a message already ingested', async () => {
    const { client } = mockSupabase({ id: 'existing' })
    const result = await ingestMailCandidate(client, 'co-1', 'user-1', candidate())

    expect(result).toBeNull()
    // The point of the pre-check is that a known message costs no provider call.
    expect(mockFetchAttachment).not.toHaveBeenCalled()
  })

  it('treats a unique-violation as success, not an error', async () => {
    // Another run won the race; the receipt is filed either way.
    const { client } = mockSupabase(null, { error: { code: '23505', message: 'duplicate key' } })
    await expect(ingestMailCandidate(client, 'co-1', 'user-1', candidate())).resolves.toBeNull()
  })

  it('skips filing when the archived duplicate already has an inbox item', async () => {
    // The provenance key catches a re-hunted message; this catches the same
    // receipt arriving through ANOTHER inbox: the receipt is already in the
    // Underlag flow, so no second item is filed.
    mockUploadDocument.mockResolvedValue({ id: 'doc-orig', deduplicated: true })
    const { client, inserted } = mockSupabase(null, {}, [{ id: 'item-existing' }])
    const result = await ingestMailCandidate(client, 'co-1', 'user-1', candidate())
    expect(result).toBeNull()
    expect(inserted).toHaveLength(0)
    // Locks the flag itself: without dedupeByContent the mock still answers
    // deduplicated, but production would silently archive copies again.
    expect(mockUploadDocument).toHaveBeenCalledWith(
      expect.anything(),
      'user-1',
      'co-1',
      expect.anything(),
      { upload_source: 'mail_hunt', dedupeByContent: true },
    )
    // The skip is behandlingshistorik, not just an app log; and the payload
    // stays pseudonymous (never a mailbox address).
    expect(mockAppendHistory).toHaveBeenCalledTimes(1)
    const event = mockAppendHistory.mock.calls[0]![0] as {
      eventType: string
      aggregateId: string
      payload: Record<string, unknown>
    }
    expect(event.eventType).toBe('DocumentDuplicateSkipped')
    expect(event.aggregateId).toBe('doc-orig')
    expect(event.payload).toMatchObject({
      channel: 'mail_hunt',
      document_id: 'doc-orig',
      inbox_item_id: 'item-existing',
      reason: 'duplicate_content',
    })
    expect(JSON.stringify(event.payload)).not.toContain('@')
  })

  it('still skips the duplicate when the history append fails', async () => {
    // The audit write is best-effort by design: a history outage must not
    // turn a correct skip into a duplicate filing.
    mockUploadDocument.mockResolvedValue({ id: 'doc-orig', deduplicated: true })
    mockAppendHistory.mockRejectedValueOnce(new Error('history down'))
    const { client, inserted } = mockSupabase(null, {}, [{ id: 'item-existing' }])
    const result = await ingestMailCandidate(client, 'co-1', 'user-1', candidate())
    expect(result).toBeNull()
    expect(inserted).toHaveLength(0)
  })

  it('files an item against the existing document when the duplicate never passed the inbox', async () => {
    // A content match against a document with no inbox item (a manually
    // attached copy) must not swallow the receipt: the affärshändelse still
    // needs routing to matching (BFL 5 kap), just without a second archive copy.
    mockUploadDocument.mockResolvedValue({ id: 'doc-orig', deduplicated: true })
    const { client, inserted } = mockSupabase(null, {}, [null])
    const result = await ingestMailCandidate(client, 'co-1', 'user-1', candidate())
    expect(result).toMatchObject({ documentId: 'doc-orig', inboxItemId: 'item-1' })
    expect(inserted).toHaveLength(1)
    expect(inserted[0].document_id).toBe('doc-orig')
  })

  it('ignores a body-only receipt, which has nothing to download', async () => {
    const { client } = mockSupabase(null)
    const result = await ingestMailCandidate(
      client,
      'co-1',
      'user-1',
      candidate({ attachmentIds: [], bodyIsReceipt: true }),
    )
    expect(result).toBeNull()
    expect(mockFetchAttachment).not.toHaveBeenCalled()
  })

  it('skips an oversized attachment rather than storing a report', async () => {
    mockFetchAttachment.mockResolvedValue({
      filename: 'arsredovisning.pdf',
      mimeType: 'application/pdf',
      bytes: Buffer.alloc(11 * 1024 * 1024),
    })
    const { client, inserted } = mockSupabase(null)
    const result = await ingestMailCandidate(client, 'co-1', 'user-1', candidate())
    expect(result).toBeNull()
    expect(inserted).toHaveLength(0)
  })

  it('tries the next attachment when one cannot be fetched', async () => {
    mockFetchAttachment
      .mockRejectedValueOnce(new Error('gmail 404'))
      .mockResolvedValueOnce({
        filename: 'kvitto.pdf',
        mimeType: 'application/pdf',
        bytes: Buffer.from('%PDF-1.4 fake'),
      })
    const { client } = mockSupabase(null)
    const result = await ingestMailCandidate(
      client,
      'co-1',
      'user-1',
      candidate({ attachmentIds: ['bad', 'good'] }),
    )
    expect(result).toMatchObject({ documentId: 'doc-1' })
  })

  it('never throws when the upload itself is rejected', async () => {
    // Magic-byte validation rejects a mislabelled file; one bad message must
    // not abort a night's hunt.
    mockUploadDocument.mockRejectedValue(new Error('File content does not match'))
    const { client } = mockSupabase(null)
    await expect(ingestMailCandidate(client, 'co-1', 'user-1', candidate())).resolves.toBeNull()
  })
})

/**
 * The first live fetch died here: Gmail declared a PDF as
 * application/octet-stream, and uploadDocument validates content against the
 * declared type, so the receipt was rejected at the door.
 */
describe('sniffMimeType', () => {
  it('believes the bytes over a mail that says octet-stream', () => {
    const pdf = Buffer.from('%PDF-1.4 ...')
    expect(sniffMimeType(pdf, 'application/octet-stream', 'kvitto.pdf')).toBe('application/pdf')
  })

  it('recognises a photographed receipt', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])
    expect(sniffMimeType(jpeg, 'application/octet-stream', 'IMG_5626')).toBe('image/jpeg')
  })

  it('falls back to the filename when the bytes say nothing', () => {
    const unknown = Buffer.from('not a known header at all')
    expect(sniffMimeType(unknown, 'application/octet-stream', 'faktura.pdf')).toBe('application/pdf')
  })

  it('keeps the declared type when nothing else identifies it', () => {
    const unknown = Buffer.from('mystery bytes')
    expect(sniffMimeType(unknown, 'text/plain', 'anteckning')).toBe('text/plain')
  })
})

/**
 * A message can carry several receipts. Whichever one is stored has to be
 * filed under its own identity: recording index 0 while the loop is on a later
 * attachment would both mislabel the row and permanently block the sibling,
 * since the file key is unique.
 */
describe('ingestMailCandidate, over several attachments', () => {
  it('files the attachment it actually stored, not the first one', async () => {
    // The first attachment cannot be fetched, so the second is stored.
    mockFetchAttachment
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        filename: 'ignored-by-caller.pdf',
        mimeType: 'application/pdf',
        bytes: Buffer.from('%PDF-1.4 fake'),
      })
    const { client, inserted } = mockSupabase(null)
    const result = await ingestMailCandidate(
      client,
      'co-1',
      'user-1',
      candidate({ attachmentIds: ['att-1', 'att-2'], attachmentNames: ['first.pdf', 'second.pdf'] }),
    )

    const ctx = inserted[0].channel_context as Record<string, unknown>
    expect(ctx.mail_attachment_id).toBe('att-2')
    expect(ctx.mail_file_key).toBe('msg-1::att-2')
    expect(result?.fileName).toBe('second.pdf')
  })
})
