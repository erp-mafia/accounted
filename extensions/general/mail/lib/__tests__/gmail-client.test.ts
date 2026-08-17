/**
 * Reading a message well enough to know whether it carries an underlag.
 *
 * The case that matters is the one a provkörning caught: asking Gmail for
 * `format=metadata` returns headers and no `payload.parts`, so every message
 * looks attachment-free and the hunt can never file anything. These tests pin
 * the format and the MIME walk.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { clearMessageCache, getMessageSummary } from '../gmail-client'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', (...args: unknown[]) => mockFetch(...args))

function respond(message: Record<string, unknown>) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(message),
    text: () => Promise.resolve(''),
  })
}

const HEADERS = [
  { name: 'Subject', value: 'Faktura-20251070' },
  { name: 'From', value: 'info@tic.io' },
]

beforeEach(() => {
  vi.clearAllMocks()
  // The cache is keyed by message id, and these tests reuse ids.
  clearMessageCache()
})

describe('getMessageSummary', () => {
  it('asks for the full message, because metadata omits the parts tree', async () => {
    respond({ id: 'm1', payload: { headers: HEADERS } })
    await getMessageSummary('token', 'm1', 'conn-1', 'invoice@arcim.io')

    const url = String(mockFetch.mock.calls[0][0])
    expect(url).toContain('format=full')
    // The bug this replaces: metadata returns no payload.parts at all.
    expect(url).not.toContain('format=metadata')
  })

  it('finds a PDF nested inside a forwarded message', async () => {
    // Forwarding is how most of these receipts arrive, and it buries the
    // attachment two levels down inside a message/rfc822 part.
    respond({
      id: 'm1',
      payload: {
        headers: HEADERS,
        mimeType: 'multipart/mixed',
        parts: [
          { mimeType: 'text/plain', body: { size: 12 } },
          {
            mimeType: 'message/rfc822',
            parts: [
              {
                mimeType: 'multipart/mixed',
                parts: [
                  { mimeType: 'text/html', body: { size: 900 } },
                  {
                    mimeType: 'application/pdf',
                    filename: 'faktura.pdf',
                    body: { attachmentId: 'att-deep', size: 51200 },
                  },
                ],
              },
            ],
          },
        ],
      },
    })

    const candidate = await getMessageSummary('token', 'm1', 'conn-1', 'invoice@arcim.io')
    expect(candidate.attachmentIds).toEqual(['att-deep'])
    expect(candidate.bodyIsReceipt).toBe(false)
  })

  it('does not mistake an inline logo for an underlag', async () => {
    respond({
      id: 'm1',
      payload: {
        headers: HEADERS,
        parts: [
          { mimeType: 'image/png', filename: 'logo.png', body: { attachmentId: 'logo', size: 400 } },
        ],
      },
    })

    const candidate = await getMessageSummary('token', 'm1', 'conn-1', 'invoice@arcim.io')
    expect(candidate.attachmentIds).toEqual([])
    expect(candidate.bodyIsReceipt).toBe(true)
  })

  it('reports a genuinely attachment-free mail as a body receipt', async () => {
    respond({
      id: 'm1',
      payload: { headers: HEADERS, mimeType: 'text/html', body: { size: 4000 } },
    })

    const candidate = await getMessageSummary('token', 'm1', 'conn-1', 'invoice@arcim.io')
    expect(candidate.bodyIsReceipt).toBe(true)
    expect(candidate.subject).toBe('Faktura-20251070')
  })
})

/**
 * One receipt mail answers many purchases' queries, so the same message was
 * downloaded dozens of times per press. Content never changes, so reading it
 * once is both correct and the difference between a press that fits its time
 * budget and one that does not.
 */
describe('message reads are not repeated', () => {
  it('fetches a given message once per mailbox', async () => {
    respond({ id: 'cache-me', payload: { headers: HEADERS } })

    await getMessageSummary('token', 'cache-me', 'conn-1', 'invoice@arcim.io')
    await getMessageSummary('token', 'cache-me', 'conn-1', 'invoice@arcim.io')
    await getMessageSummary('token', 'cache-me', 'conn-1', 'invoice@arcim.io')

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('keeps mailboxes apart, since a hit in one says nothing about the other', async () => {
    respond({ id: 'shared', payload: { headers: HEADERS } })

    await getMessageSummary('token', 'shared', 'conn-1', 'invoice@arcim.io')
    await getMessageSummary('token', 'shared', 'conn-2', 'jakob@arcim.io')

    expect(mockFetch).toHaveBeenCalledTimes(2)
  })
})
