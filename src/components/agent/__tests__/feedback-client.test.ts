import { describe, it, expect, vi } from 'vitest'
import { sendFeedback } from '../feedback-client'

/**
 * The thumbs shipped wired to nothing: they lit up and the vote died in
 * component state. These pin the contract the button now depends on, in
 * particular that a failed send reports false, because the pressed state is
 * set from this return value and must never claim a report that never arrived.
 */

describe('sendFeedback', () => {
  it('posts the vote to the feedback endpoint', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true })

    const ok = await sendFeedback({
      conversationId: 'c1',
      sentiment: 'negative',
      messageIndex: 3,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })

    expect(ok).toBe(true)
    const [url, init] = fetchImpl.mock.calls[0]!
    expect(url).toBe('/api/agent/feedback')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body)).toEqual({
      conversation_id: 'c1',
      sentiment: 'negative',
      message_index: 3,
    })
  })

  it('omits the message index rather than sending null for it', async () => {
    // The route validates message_index as an integer when present; sending
    // null would fail validation and lose the vote for no reason.
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true })
    await sendFeedback({
      conversationId: 'c1',
      sentiment: 'positive',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    })
    expect(JSON.parse(fetchImpl.mock.calls[0]![1].body)).toEqual({
      conversation_id: 'c1',
      sentiment: 'positive',
    })
  })

  it('reports failure for a non-2xx instead of assuming it landed', async () => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status: 404 })
    expect(
      await sendFeedback({
        conversationId: 'c1',
        sentiment: 'positive',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).toBe(false)
  })

  it('reports failure instead of throwing when the request dies', async () => {
    // Offline, or the request cut off by a navigation. An unhandled rejection
    // here would surface as an error in the middle of reading an answer.
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    await expect(
      sendFeedback({
        conversationId: 'c1',
        sentiment: 'negative',
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).resolves.toBe(false)
  })
})
