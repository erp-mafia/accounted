/**
 * An M18 ("your file failed") that Meta never accepted used to be the end of
 * it: sendText never throws, the failed send was persisted as an m18_error
 * row, errorNoticeAlreadySent counted that row as a notice already sent, and
 * the inbound row was already terminal 'error', so nothing resent it. The
 * sender never heard about that receipt at all (GitHub #1600, point 2). The
 * sweep now resends it, the way it re-arms a combined ack whose send failed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/extensions/general/whatsapp-inbox/lib/graph-api', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/whatsapp-inbox/lib/graph-api')
  >('@/extensions/general/whatsapp-inbox/lib/graph-api')
  return {
    ...actual,
    sendText: vi.fn().mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null }),
  }
})

vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue('event-1'),
}))

import { sendText } from '@/extensions/general/whatsapp-inbox/lib/graph-api'
import { encryptPhone } from '@/extensions/general/whatsapp-inbox/lib/phone-crypto'
import { runSweep } from '@/extensions/general/whatsapp-inbox/lib/sweep'
import { TEMPLATE } from '@/extensions/general/whatsapp-inbox/lib/messages'

const sendTextMock = vi.mocked(sendText)
const MINUTES = 60 * 1000

function failedNotice(overrides: Record<string, unknown> = {}) {
  return {
    correlation_id: 'corr-1',
    phone_link_id: 'link-1',
    conversation_id: 'conv-1',
    sender_phone_hash: 'hash-1',
    created_at: new Date(Date.now() - 3 * MINUTES).toISOString(),
    ...overrides,
  }
}

/** Passes 1 to 6 find nothing, so the queue reaches the resend pass. */
function emptyEarlierPasses(mock: ReturnType<typeof createQueuedMockSupabase>) {
  mock.enqueue({ data: [] }) // 1a stuck received
  mock.enqueue({ data: [] }) // 1b stuck processing
  mock.enqueue({ data: [] }) // 2a stale pending_ack
  mock.enqueue({ data: [] }) // 2b unacked rows
  mock.enqueue({ data: [] }) // 3 question TTL
  mock.enqueue({ data: [] }) // 4 pins
  mock.enqueue({ count: 0 }) // 5 outbound failures
  mock.enqueue({ data: [] }) // 6 orphaned parked rows
}

describe('sweep: M18 notices Meta never accepted', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    process.env.WHATSAPP_PHONE_ENCRYPTION_KEY = 'a'.repeat(64)
    sendTextMock.mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null })
  })

  it('resends a notice whose send failed, to the sender behind the link', async () => {
    const mock = createQueuedMockSupabase()
    emptyEarlierPasses(mock)
    mock.enqueue({ data: [failedNotice()] }) // 7 failed M18 sends
    mock.enqueue({ data: { phone_enc: encryptPhone('46701234567'), revoked_at: null } }) // link
    mock.enqueue({ data: null }) // errorNoticeAlreadySent: no accepted notice

    const summary = await runSweep(mock.supabase as unknown as SupabaseClient)

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    const args = sendTextMock.mock.calls[0][1]
    expect(args.template).toBe(TEMPLATE.m18Error)
    expect(args.to).toBe('46701234567')
    expect(args.correlationId).toBe('corr-1')
    expect(summary.resentErrorNotices).toBe(1)

    // Only sends Meta never took: a wamid means Meta accepted it, and a later
    // failure (131047, the 24h window closed) is not one a resend can fix.
    expect(mock.findCalls('whatsapp_messages', 'is')).toContainEqual(['wamid', null])
    // The once-per-message check no longer counts a send Meta refused.
    expect(mock.findCalls('whatsapp_messages', 'or')).toContainEqual([
      'wamid.not.is.null,delivery_status.neq.failed',
    ])
  })

  it('stops after the third failed send for the same message', async () => {
    const mock = createQueuedMockSupabase()
    emptyEarlierPasses(mock)
    mock.enqueue({
      data: [
        failedNotice({ created_at: new Date(Date.now() - 2 * MINUTES).toISOString() }),
        failedNotice({ created_at: new Date(Date.now() - 3 * MINUTES).toISOString() }),
        failedNotice({ created_at: new Date(Date.now() - 4 * MINUTES).toISOString() }),
      ],
    })

    const summary = await runSweep(mock.supabase as unknown as SupabaseClient)

    expect(sendTextMock).not.toHaveBeenCalled()
    expect(summary.resentErrorNotices).toBe(0)
  })

  it('waits a minute after the last failed send before trying again', async () => {
    const mock = createQueuedMockSupabase()
    emptyEarlierPasses(mock)
    mock.enqueue({
      data: [failedNotice({ created_at: new Date(Date.now() - 10 * 1000).toISOString() })],
    })

    await runSweep(mock.supabase as unknown as SupabaseClient)

    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('does not resend to a number that has been unlinked since', async () => {
    const mock = createQueuedMockSupabase()
    emptyEarlierPasses(mock)
    mock.enqueue({ data: [failedNotice()] })
    mock.enqueue({
      data: { phone_enc: encryptPhone('46701234567'), revoked_at: '2026-11-21T08:00:00Z' },
    })

    await runSweep(mock.supabase as unknown as SupabaseClient)

    expect(sendTextMock).not.toHaveBeenCalled()
  })
})
