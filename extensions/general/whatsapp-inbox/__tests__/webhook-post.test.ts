import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import crypto from 'crypto'
import { createQueuedMockSupabase } from '@/tests/helpers'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/extensions/general/whatsapp-inbox/lib/graph-api', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/whatsapp-inbox/lib/graph-api')
  >('@/extensions/general/whatsapp-inbox/lib/graph-api')
  return {
    ...actual,
    sendText: vi.fn().mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null }),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    markReadWithTyping: vi.fn().mockResolvedValue(undefined),
    downloadMedia: vi.fn(),
    getDisplayPhoneNumber: vi.fn().mockResolvedValue(null),
  }
})

vi.mock('@/extensions/general/whatsapp-inbox/lib/process-inbound', () => ({
  kickInboundProcessing: vi.fn(),
}))

import { createClient } from '@supabase/supabase-js'
import { whatsappInboxExtension } from '@/extensions/general/whatsapp-inbox'
import {
  sendText,
  sendReaction,
  downloadMedia,
} from '@/extensions/general/whatsapp-inbox/lib/graph-api'
import { kickInboundProcessing } from '@/extensions/general/whatsapp-inbox/lib/process-inbound'
import { TEMPLATE } from '@/extensions/general/whatsapp-inbox/lib/messages'
import { hashLinkCode } from '@/extensions/general/whatsapp-inbox/lib/linking'

const SECRET = 'meta-app-secret'
const createClientMock = vi.mocked(createClient)
const sendTextMock = vi.mocked(sendText)
const sendReactionMock = vi.mocked(sendReaction)
const kickMock = vi.mocked(kickInboundProcessing)

function findRoute(method: string, path: string) {
  return whatsappInboxExtension.apiRoutes!.find((r) => r.method === method && r.path === path)!
}
const route = findRoute('POST', '/webhook')

function signedRequest(body: unknown, secret = SECRET): Request {
  const raw = JSON.stringify(body)
  const signature =
    'sha256=' + crypto.createHmac('sha256', secret).update(raw, 'utf8').digest('hex')
  return new Request('http://localhost:3000/api/extensions/ext/whatsapp-inbox/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
    body: raw,
  })
}

function envelope(value: Record<string, unknown>) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'messages',
            value: { messaging_product: 'whatsapp', ...value },
          },
        ],
      },
    ],
  }
}

function textMessage(body: string, overrides: Record<string, unknown> = {}) {
  return {
    from: '46701234567',
    id: 'wamid.IN1',
    timestamp: '1754000000',
    type: 'text',
    text: { body },
    ...overrides,
  }
}

function imageMessage(overrides: Record<string, unknown> = {}) {
  return {
    from: '46701234567',
    id: 'wamid.IN1',
    timestamp: '1754000000',
    type: 'image',
    image: { id: 'media-1', mime_type: 'image/jpeg', sha256: 'abc', caption: 'kvitto' },
    ...overrides,
  }
}

function makeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    user_id: 'user-1',
    phone_hash: 'hash-x',
    phone_enc: 'enc',
    phone_masked: '+46 70 *** ** 67',
    default_company_id: null,
    revoked_at: null,
    muted_at: null,
    ...overrides,
  }
}

describe('POST /webhook', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    sendTextMock.mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null })
    process.env.WHATSAPP_APP_SECRET = SECRET
    process.env.WHATSAPP_PHONE_HASH_KEY = 'test-pepper'
    process.env.WHATSAPP_PHONE_ENCRYPTION_KEY = 'a'.repeat(64)
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  })

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  function mockSupabase() {
    const mock = createQueuedMockSupabase()
    createClientMock.mockReturnValue(mock.supabase as never)
    return mock
  }

  it('503s when the app secret is not configured', async () => {
    delete process.env.WHATSAPP_APP_SECRET
    const response = await route.handler(signedRequest(envelope({ messages: [] })))
    expect(response.status).toBe(503)
  })

  it('401s on an invalid signature before touching anything', async () => {
    mockSupabase()
    const response = await route.handler(
      signedRequest(envelope({ messages: [textMessage('hej')] }), 'wrong-secret'),
    )
    expect(response.status).toBe(401)
    expect(sendTextMock).not.toHaveBeenCalled()
    expect(kickMock).not.toHaveBeenCalled()
  })

  it('updates outbound delivery status from statuses[]', async () => {
    const { enqueue, findCall } = mockSupabase()
    enqueue({ data: null }) // update chain

    const response = await route.handler(
      signedRequest(envelope({ statuses: [{ id: 'wamid.OUT9', status: 'delivered' }] })),
    )
    expect(response.status).toBe(200)
    const updateArgs = findCall('whatsapp_messages', 'update') as [Record<string, unknown>]
    expect(updateArgs[0]).toEqual({ delivery_status: 'delivered' })
  })

  it('keeps the Meta error detail on a failed delivery status (#1552)', async () => {
    const { enqueue, findCall } = mockSupabase()
    enqueue({ data: null }) // update chain

    await route.handler(
      signedRequest(
        envelope({
          statuses: [
            {
              id: 'wamid.OUT9',
              status: 'failed',
              errors: [{ code: 131026, title: 'Message undeliverable' }],
            },
          ],
        }),
      ),
    )
    const updateArgs = findCall('whatsapp_messages', 'update') as [Record<string, unknown>]
    expect(updateArgs[0]).toEqual({
      delivery_status: 'failed',
      error_message: '131026: Message undeliverable',
    })
  })

  it('persists a linked media message, arms the burst debounce and defers processing', async () => {
    const { enqueue, findCall } = mockSupabase()
    enqueue({ data: makeLink() }) // active link lookup
    enqueue({ data: { id: 'conv-1' } }) // conversation lookup
    enqueue({ data: { id: 'msg-row-1' } }) // message insert
    enqueue({ data: null }) // phone_links last_message_at update
    enqueue({ data: null }) // conversation window + debounce update

    const before = Date.now()
    const response = await route.handler(
      signedRequest(envelope({ messages: [imageMessage()] })),
    )
    expect(response.status).toBe(200)

    const [row] = findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
    expect(row.direction).toBe('inbound')
    expect(row.wamid).toBe('wamid.IN1')
    expect(row.processing_status).toBe('received')
    expect(row.media_id).toBe('media-1')
    expect(row.media_mime).toBe('image/jpeg')
    expect(row.body_text).toBe('kvitto') // caption travels in body_text

    // Debounce armed: pending_ack + a ~12s deadline pushed forward.
    const [patch] = findCall('whatsapp_conversations', 'update') as [Record<string, unknown>]
    expect(patch.pending_ack).toBe(true)
    const deadline = new Date(patch.debounce_until as string).getTime() - before
    expect(deadline).toBeGreaterThan(10_000)
    expect(deadline).toBeLessThan(14_000)

    expect(kickMock).toHaveBeenCalledWith(['msg-row-1'])
    expect(sendTextMock).not.toHaveBeenCalled() // the combined ack comes from the worker
    // The instant "received" signal: a checkmark reaction on the sender's own
    // message, sent before the webhook 200s (the detailed ack waits on
    // extraction, which is exactly the latency users complained about).
    expect(sendReactionMock).toHaveBeenCalledWith('46701234567', 'wamid.IN1')
  })

  it('reacts to a supported document (PDF) as well', async () => {
    const { enqueue } = mockSupabase()
    enqueue({ data: makeLink() })
    enqueue({ data: { id: 'conv-1' } })
    enqueue({ data: { id: 'msg-row-1' } })
    enqueue({ data: null })
    enqueue({ data: null })

    await route.handler(
      signedRequest(
        envelope({
          messages: [
            {
              from: '46701234567',
              id: 'wamid.IN1',
              timestamp: '1754000000',
              type: 'document',
              document: { id: 'media-1', mime_type: 'application/pdf', filename: 'kvitto.pdf' },
            },
          ],
        }),
      ),
    )
    expect(sendReactionMock).toHaveBeenCalledWith('46701234567', 'wamid.IN1')
  })

  it('does not react to media the pipeline will reject (unsupported mime)', async () => {
    const { enqueue } = mockSupabase()
    enqueue({ data: makeLink() })
    enqueue({ data: { id: 'conv-1' } })
    enqueue({ data: { id: 'msg-row-1' } })
    enqueue({ data: null })
    enqueue({ data: null })

    await route.handler(
      signedRequest(
        envelope({
          messages: [
            {
              from: '46701234567',
              id: 'wamid.IN1',
              timestamp: '1754000000',
              type: 'document',
              document: { id: 'media-1', mime_type: 'application/zip', filename: 'arkiv.zip' },
            },
          ],
        }),
      ),
    )
    // The row still becomes a job (the worker owns the M15 rejection reply),
    // but junk never earns the checkmark.
    expect(kickMock).toHaveBeenCalledWith(['msg-row-1'])
    expect(sendReactionMock).not.toHaveBeenCalled()
  })

  it('dedupes a redelivered wamid via the unique index (23505): no reply, no processing', async () => {
    const { enqueue } = mockSupabase()
    enqueue({ data: makeLink() })
    enqueue({ data: { id: 'conv-1' } })
    enqueue({ data: null, error: { code: '23505', message: 'duplicate key' } })

    const response = await route.handler(
      signedRequest(envelope({ messages: [imageMessage()] })),
    )
    expect(response.status).toBe(200)
    expect(kickMock).toHaveBeenCalledWith([])
    expect(sendTextMock).not.toHaveBeenCalled()
    // A Meta redelivery of an already-handled message must not re-react.
    expect(sendReactionMock).not.toHaveBeenCalled()
  })

  describe('unknown senders', () => {
    it('greets once with M1: no media download, no CONTENT persistence', async () => {
      const { enqueue, findCalls } = mockSupabase()
      enqueue({ data: null }) // no active link
      enqueue({ data: { ok: true } }) // sender quota RPC
      enqueue({ data: [] }) // greeting throttle: nothing sent before
      enqueue({ data: null, error: null }) // trace row insert ('done': no cap query)

      const response = await route.handler(
        signedRequest(envelope({ messages: [imageMessage()] })),
      )
      expect(response.status).toBe(200)
      expect(sendTextMock).toHaveBeenCalledTimes(1)
      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m1Unlinked)
      expect(vi.mocked(downloadMedia)).not.toHaveBeenCalled()
      // No checkmark for unlinked senders: nothing was received into any inbox.
      expect(sendReactionMock).not.toHaveBeenCalled()
      // #1552: a metadata-only trace row IS persisted, but it must carry no
      // content: no body, no media reference, no raw payload, no link.
      const inserts = findCalls('whatsapp_messages', 'insert')
      expect(inserts).toHaveLength(1)
      const [row] = inserts[0] as [Record<string, unknown>]
      expect(row.processing_status).toBe('done')
      expect(row.error_message).toContain('greeted')
      expect(row.phone_link_id).toBeNull()
      expect(row.body_text).toBeUndefined()
      expect(row.media_id).toBeUndefined()
      expect(row.raw_payload).toBeUndefined()
      expect(kickMock).toHaveBeenCalledWith([])
    })

    it('does not re-greet a redelivered wamid (trace row dedupe)', async () => {
      const { enqueue } = mockSupabase()
      enqueue({ data: null })
      enqueue({ data: { ok: true } })
      enqueue({ data: [] }) // throttle window clear
      enqueue({ data: null, error: { code: '23505', message: 'duplicate key' } }) // trace insert

      await route.handler(signedRequest(envelope({ messages: [imageMessage()] })))
      expect(sendTextMock).not.toHaveBeenCalled()
    })

    it('records a declined trace row when the M1 throttle window is exhausted', async () => {
      const { enqueue, findCalls } = mockSupabase()
      enqueue({ data: null })
      enqueue({ data: { ok: true } })
      enqueue({ data: [{ created_at: new Date().toISOString() }] }) // greeted within the hour
      enqueue({ count: 0 }) // decline-trace day cap
      enqueue({ data: null, error: null }) // trace row insert

      await route.handler(signedRequest(envelope({ messages: [textMessage('hej')] })))
      expect(sendTextMock).not.toHaveBeenCalled()
      const inserts = findCalls('whatsapp_messages', 'insert')
      expect(inserts).toHaveLength(1)
      const [row] = inserts[0] as [Record<string, unknown>]
      expect(row.processing_status).toBe('skipped')
      expect(row.error_message).toContain('greeting throttled')
      expect(row.body_text).toBeUndefined()
    })

    it('media inside the hour but outside the 10 min burst window still gets M1', async () => {
      const { enqueue } = mockSupabase()
      enqueue({ data: null }) // no active link
      enqueue({ data: { ok: true } }) // sender quota RPC
      enqueue({
        data: [{ created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() }],
      }) // one greeting 30 min ago: inside the text hour, outside the burst
      enqueue({ data: null, error: null }) // trace row insert ('done')

      await route.handler(signedRequest(envelope({ messages: [imageMessage()] })))

      expect(sendTextMock).toHaveBeenCalledTimes(1)
      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m1Unlinked)
      // The privacy invariant holds: still no media touch for unlinked senders.
      expect(vi.mocked(downloadMedia)).not.toHaveBeenCalled()
    })

    it('media inside the 10 min burst window stays silent (one M1 per burst)', async () => {
      const { enqueue } = mockSupabase()
      enqueue({ data: null })
      enqueue({ data: { ok: true } })
      enqueue({
        data: [{ created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString() }],
      }) // greeted 2 min ago: same burst
      enqueue({ count: 0 }) // decline-trace day cap
      enqueue({ data: null, error: null }) // declined trace insert

      await route.handler(signedRequest(envelope({ messages: [imageMessage()] })))
      expect(sendTextMock).not.toHaveBeenCalled()
    })

    it('a text message inside the hour stays silent (hour rule unchanged for text)', async () => {
      const { enqueue } = mockSupabase()
      enqueue({ data: null })
      enqueue({ data: { ok: true } })
      enqueue({
        data: [{ created_at: new Date(Date.now() - 30 * 60 * 1000).toISOString() }],
      }) // greeted 30 min ago: text keeps the 1/hour rule
      enqueue({ count: 0 }) // decline-trace day cap
      enqueue({ data: null, error: null }) // declined trace insert

      await route.handler(signedRequest(envelope({ messages: [textMessage('hej')] })))
      expect(sendTextMock).not.toHaveBeenCalled()
    })

    it('the fourth media greeting of the day stays silent (daily cap kept)', async () => {
      const { enqueue } = mockSupabase()
      enqueue({ data: null })
      enqueue({ data: { ok: true } })
      enqueue({
        data: [
          { created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
          { created_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() },
          { created_at: new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString() },
        ],
      }) // GREETING_DAY_MAX greetings already sent today
      enqueue({ count: 0 }) // decline-trace day cap
      enqueue({ data: null, error: null }) // declined trace insert

      await route.handler(signedRequest(envelope({ messages: [imageMessage()] })))
      expect(sendTextMock).not.toHaveBeenCalled()
    })

    it('stays silent but records the decline when the pre-binding quota is exhausted', async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: null })
      mock.enqueue({ data: { ok: false, scope: 'minute', retry_after_sec: 60 } })
      mock.enqueue({ count: 0 }) // decline-trace day cap
      mock.enqueue({ data: null, error: null }) // trace row insert

      await route.handler(signedRequest(envelope({ messages: [textMessage('hej')] })))
      expect(sendTextMock).not.toHaveBeenCalled()
      expect(mock.supabase.rpc).toHaveBeenCalledWith(
        'check_and_increment_whatsapp_sender_quota',
        expect.objectContaining({ p_phone_hash: expect.any(String) }),
      )
      // The link lookup plus the metadata-only decline trace (#1552).
      const tables = [...new Set(mock.calls.map((c) => c.table))]
      expect(tables).toEqual(['whatsapp_phone_links', 'whatsapp_messages'])
      const [row] = mock.findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
      expect(row.error_message).toContain('over pre-binding quota')
    })

    it('stops recording decline traces past the per-day cap', async () => {
      const { enqueue, findCalls } = mockSupabase()
      enqueue({ data: null })
      enqueue({ data: { ok: false } })
      enqueue({ count: 20 }) // cap reached

      await route.handler(signedRequest(envelope({ messages: [textMessage('hej')] })))
      expect(findCalls('whatsapp_messages', 'insert')).toHaveLength(0)
    })

    // #1599: an UNAVAILABLE limiter (RPC error or throw) fails open into the
    // throttled greeting path. Over-quota (ok: false) above stays silent.
    describe('quota RPC unavailable (fail open, #1599)', () => {
      const rpcError = { data: null, error: { message: 'PGRST202 could not find function' } }

      it('media still earns the throttled M1, no content persisted', async () => {
        const { enqueue, findCalls } = mockSupabase()
        enqueue({ data: null }) // no active link
        enqueue(rpcError) // sender quota RPC unavailable
        enqueue({ data: [] }) // greeting throttle: nothing sent before
        enqueue({ data: null, error: null }) // trace row insert ('done': no cap query)

        const response = await route.handler(
          signedRequest(envelope({ messages: [imageMessage()] })),
        )
        expect(response.status).toBe(200)
        expect(sendTextMock).toHaveBeenCalledTimes(1)
        expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m1Unlinked)
        // The hard rules hold in degraded mode: no media touch, no checkmark.
        expect(vi.mocked(downloadMedia)).not.toHaveBeenCalled()
        expect(sendReactionMock).not.toHaveBeenCalled()
        // Exactly one trace row (no fail-closed 'skipped' insert ahead of it:
        // a second insert would 23505 on the wamid and read as a redelivery).
        const inserts = findCalls('whatsapp_messages', 'insert')
        expect(inserts).toHaveLength(1)
        const [row] = inserts[0] as [Record<string, unknown>]
        expect(row.processing_status).toBe('done')
        expect(row.error_message).toContain('greeted')
        expect(row.error_message).toContain('quota limiter unavailable')
        expect(row.phone_link_id).toBeNull()
        expect(row.body_text).toBeUndefined()
        expect(row.media_id).toBeUndefined()
        expect(row.raw_payload).toBeUndefined()
        expect(kickMock).toHaveBeenCalledWith([])
      })

      it('inside the greeting window stays silent (the throttle is the remaining cap)', async () => {
        const { enqueue, findCalls } = mockSupabase()
        enqueue({ data: null })
        enqueue(rpcError)
        enqueue({ data: [{ created_at: new Date().toISOString() }] }) // greeted within the hour
        enqueue({ count: 0 }) // decline-trace day cap
        enqueue({ data: null, error: null }) // declined trace insert

        await route.handler(signedRequest(envelope({ messages: [textMessage('hej')] })))
        expect(sendTextMock).not.toHaveBeenCalled()
        const inserts = findCalls('whatsapp_messages', 'insert')
        expect(inserts).toHaveLength(1)
        const [row] = inserts[0] as [Record<string, unknown>]
        expect(row.processing_status).toBe('skipped')
        expect(row.error_message).toContain('greeting throttled')
        expect(row.error_message).toContain('quota limiter unavailable')
      })

      it('still binds a valid link code and replies M3', async () => {
        const { enqueue, findCall } = mockSupabase()
        enqueue({ data: null }) // no active link
        enqueue(rpcError) // quota unavailable
        enqueue({
          data: {
            id: 'code-1',
            user_id: 'user-1',
            expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
            used_at: null,
          },
        }) // code lookup
        enqueue({ data: { id: 'code-1' } }) // code claim
        enqueue({ data: null }) // revoke by phone hash
        enqueue({ data: null }) // revoke by user
        enqueue({ data: { id: 'link-9', user_id: 'user-1' } }) // link insert
        enqueue({ data: { id: 'conv-9' } }) // conversation insert
        enqueue({ data: null }) // content-free code-message row
        enqueue({ data: [{ company_id: 'company-1' }] }) // memberships
        enqueue({ data: { name: 'Bolaget AB' } }) // company name

        const response = await route.handler(
          signedRequest(
            envelope({
              contacts: [{ wa_id: '46701234567', profile: { name: 'Jakob' } }],
              messages: [textMessage('ac-7kp4qf')],
            }),
          ),
        )
        expect(response.status).toBe(200)
        const [linkRow] = findCall('whatsapp_phone_links', 'insert') as [Record<string, unknown>]
        expect(linkRow.user_id).toBe('user-1')
        expect(sendTextMock).toHaveBeenCalledTimes(1)
        expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m3Linked)
      })

      it('a bad code still gets M2 under its own throttle, even inside the M1 hour', async () => {
        // The greeting throttle is never consulted on this path: only the
        // M2 window read gates the reply, so a sender greeted with M1 five
        // minutes ago is still told their code was rejected.
        const { enqueue, findCalls } = mockSupabase()
        enqueue({ data: null }) // no active link
        enqueue(rpcError) // quota unavailable
        enqueue({ data: null }) // code lookup: nothing
        enqueue({ data: [] }) // M2 throttle window: no M2 sent before
        enqueue({ data: null, error: null }) // trace row insert ('done')

        await route.handler(signedRequest(envelope({ messages: [textMessage('ac-zzzz99')] })))
        expect(sendTextMock).toHaveBeenCalledTimes(1)
        expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m2BadCode)
        const inserts = findCalls('whatsapp_messages', 'insert')
        expect(inserts).toHaveLength(1)
        const [row] = inserts[0] as [Record<string, unknown>]
        expect(row.error_message).toContain('invalid link code')
        expect(row.error_message).toContain('quota limiter unavailable')
        expect(row.body_text).toBeUndefined()
      })

      it('a repeated bad code inside the M2 window falls through and stays silent', async () => {
        const { enqueue, findCalls } = mockSupabase()
        enqueue({ data: null })
        enqueue(rpcError)
        enqueue({ data: null }) // code lookup: nothing
        enqueue({
          data: [{ created_at: new Date(Date.now() - 2 * 60 * 1000).toISOString() }],
        }) // M2 sent 2 min ago: inside the 10 min window
        enqueue({ data: [{ created_at: new Date().toISOString() }] }) // M1 within the hour
        enqueue({ count: 0 }) // decline-trace day cap
        enqueue({ data: null, error: null }) // declined trace insert

        await route.handler(signedRequest(envelope({ messages: [textMessage('ac-zzzz99')] })))
        expect(sendTextMock).not.toHaveBeenCalled()
        const inserts = findCalls('whatsapp_messages', 'insert')
        expect(inserts).toHaveLength(1)
        const [row] = inserts[0] as [Record<string, unknown>]
        expect(row.processing_status).toBe('skipped')
        expect(row.error_message).toContain('greeting throttled')
      })

      it('the fourth M2 of the day is withheld (daily cap)', async () => {
        const { enqueue } = mockSupabase()
        enqueue({ data: null })
        enqueue(rpcError)
        enqueue({ data: null }) // code lookup: nothing
        enqueue({
          data: [
            { created_at: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString() },
            { created_at: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() },
            { created_at: new Date(Date.now() - 9 * 60 * 60 * 1000).toISOString() },
          ],
        }) // BAD_CODE_DAY_MAX already sent today, all outside the 10 min window
        enqueue({ data: [] }) // greeting throttle: nothing sent before
        enqueue({ data: null, error: null }) // trace row insert ('done')

        await route.handler(signedRequest(envelope({ messages: [textMessage('ac-zzzz99')] })))
        expect(sendTextMock).toHaveBeenCalledTimes(1)
        expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m1Unlinked)
      })

      it('an unreadable M2 window fails closed to the M1 path', async () => {
        const { enqueue } = mockSupabase()
        enqueue({ data: null })
        enqueue(rpcError)
        enqueue({ data: null }) // code lookup: nothing
        enqueue({ data: null, error: { message: 'read failed' } }) // M2 window unreadable
        enqueue({ data: [] }) // greeting throttle: nothing sent before
        enqueue({ data: null, error: null }) // trace row insert ('done')

        await route.handler(signedRequest(envelope({ messages: [textMessage('ac-zzzz99')] })))
        expect(sendTextMock).toHaveBeenCalledTimes(1)
        expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m1Unlinked)
      })

      it('a throwing RPC (network) is treated like an RPC error', async () => {
        const mock = mockSupabase()
        mock.enqueue({ data: null }) // no active link
        mock.supabase.rpc.mockRejectedValueOnce(new Error('fetch failed'))
        mock.enqueue({ data: [] }) // greeting throttle: nothing sent before
        mock.enqueue({ data: null, error: null }) // trace row insert ('done')

        const response = await route.handler(
          signedRequest(envelope({ messages: [imageMessage()] })),
        )
        expect(response.status).toBe(200)
        expect(sendTextMock).toHaveBeenCalledTimes(1)
        expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m1Unlinked)
      })
    })
  })

  describe('link codes', () => {
    it('binds a valid code: creates link + conversation, replies M3 with the company name', async () => {
      const { enqueue, findCall } = mockSupabase()
      enqueue({ data: null }) // no active link
      enqueue({ data: { ok: true } }) // quota
      enqueue({
        data: {
          id: 'code-1',
          user_id: 'user-1',
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          used_at: null,
        },
      }) // code lookup
      enqueue({ data: { id: 'code-1' } }) // code claim
      enqueue({ data: null }) // revoke by phone hash
      enqueue({ data: null }) // revoke by user
      enqueue({ data: { id: 'link-9', user_id: 'user-1' } }) // link insert
      enqueue({ data: { id: 'conv-9' } }) // conversation insert
      enqueue({ data: null }) // content-free code-message row
      enqueue({ data: [{ company_id: 'company-1' }] }) // memberships
      enqueue({ data: { name: 'Bolaget AB' } }) // company name

      const response = await route.handler(
        signedRequest(
          envelope({
            contacts: [{ wa_id: '46701234567', profile: { name: 'Jakob' } }],
            messages: [textMessage('ac-7kp4qf')],
          }),
        ),
      )
      expect(response.status).toBe(200)

      const [linkRow] = findCall('whatsapp_phone_links', 'insert') as [Record<string, unknown>]
      expect(linkRow.user_id).toBe('user-1')
      expect(linkRow.wa_profile_name).toBe('Jakob')
      expect(linkRow.phone_masked).toBe('+46 70 *** ** 67')

      // The code message row is persisted content-free (dedupe only).
      const [codeRow] = findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
      expect(codeRow.wamid).toBe('wamid.IN1')
      expect(codeRow.body_text).toBeUndefined()
      expect(codeRow.raw_payload).toBeUndefined()

      // The code was claimed single-use.
      const [claim] = findCall('whatsapp_link_codes', 'update') as [Record<string, unknown>]
      expect(claim.used_at).toBeTruthy()

      expect(sendTextMock).toHaveBeenCalledTimes(1)
      const reply = sendTextMock.mock.calls[0][1]
      expect(reply.template).toBe(TEMPLATE.m3Linked)
      expect(reply.body).toContain('Bolaget AB')
    })

    it('replies M2 to an unknown code', async () => {
      const { enqueue } = mockSupabase()
      enqueue({ data: null })
      enqueue({ data: { ok: true } })
      enqueue({ data: null }) // code lookup: nothing

      await route.handler(signedRequest(envelope({ messages: [textMessage('AC-7KP4QF')] })))
      expect(sendTextMock).toHaveBeenCalledTimes(1)
      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m2BadCode)
    })

    it('replies M2 to an expired code', async () => {
      const { enqueue } = mockSupabase()
      enqueue({ data: null })
      enqueue({ data: { ok: true } })
      enqueue({
        data: {
          id: 'code-1',
          user_id: 'user-1',
          expires_at: new Date(Date.now() - 1000).toISOString(),
          used_at: null,
        },
      })

      await route.handler(signedRequest(envelope({ messages: [textMessage('AC-7KP4QF')] })))
      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m2BadCode)
    })

    it('replies M2 to a reused code (single use)', async () => {
      const { enqueue } = mockSupabase()
      enqueue({ data: null })
      enqueue({ data: { ok: true } })
      enqueue({
        data: {
          id: 'code-1',
          user_id: 'user-1',
          expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
          used_at: new Date().toISOString(),
        },
      })

      await route.handler(signedRequest(envelope({ messages: [textMessage('AC-7KP4QF')] })))
      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m2BadCode)
    })

    it('answers a code it could not CHECK with M21 (retry), never with M2 (bad code)', async () => {
      // #2062 residual 5: the quota RPC succeeded but the whatsapp_link_codes
      // read failed. The code is untouched and still valid, so "the code is
      // wrong" would send a user holding a VALID code back to mint another.
      const { enqueue, findCalls } = mockSupabase()
      enqueue({ data: null }) // no active link
      enqueue({ data: { ok: true } }) // quota ok
      enqueue({ error: { message: 'canceling statement due to statement timeout' } }) // code lookup failed
      enqueue({ data: null }) // trace row insert

      await route.handler(signedRequest(envelope({ messages: [textMessage('AC-7KP4QF')] })))
      expect(sendTextMock).toHaveBeenCalledTimes(1)
      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m21CodeRetry)
      // Nothing was claimed: the same code works on the retry.
      expect(findCalls('whatsapp_link_codes', 'update')).toHaveLength(0)
      const [row] = findCalls('whatsapp_messages', 'insert')[0] as [Record<string, unknown>]
      expect(row.error_message).toContain('link code lookup failed')
    })

    it('hashLinkCode matches what the webhook looks up', () => {
      // Regression guard: panel mints, webhook consumes; both must hash alike.
      expect(hashLinkCode('AC-7KP4QF')).toMatch(/^[0-9a-f]{64}$/)
    })
  })

  describe('keywords', () => {
    function enqueueLinkedTextPreamble(
      mock: ReturnType<typeof mockSupabase>,
      link: Record<string, unknown>,
    ) {
      mock.enqueue({ data: link }) // link lookup
      mock.enqueue({ data: { id: 'conv-1' } }) // conversation
      mock.enqueue({ data: { id: 'msg-row-1' } }) // insert
      mock.enqueue({ data: null }) // link last_message_at
      mock.enqueue({ data: null }) // conversation window
    }

    /** Dispositions with a durable side effect run it BEFORE the terminal row
     *  is written, so the wamid dedupe becomes a pre-check and the insert
     *  lands last (see handleLinkedSender). */
    function enqueueDurablePreamble(
      mock: ReturnType<typeof mockSupabase>,
      link: Record<string, unknown>,
      conversation: Record<string, unknown> = { id: 'conv-1', state: 'idle', context: {} },
    ) {
      mock.enqueue({ data: link }) // link lookup
      mock.enqueue({ data: conversation }) // conversation
      mock.enqueue({ data: null }) // wamid dedupe pre-check: not seen yet
      mock.enqueue({ data: null }) // link last_message_at
      mock.enqueue({ data: null }) // conversation window
    }

    it('stopp mutes the link and confirms with M11', async () => {
      const mock = mockSupabase()
      enqueueDurablePreamble(mock, makeLink())
      mock.enqueue({ data: null }) // muted_at update
      mock.enqueue({ data: null }) // terminal row insert

      await route.handler(signedRequest(envelope({ messages: [textMessage('Stopp')] })))

      const linkUpdates = mock.findCalls('whatsapp_phone_links', 'update')
      const mutedUpdate = linkUpdates.find(
        (args) => (args[0] as Record<string, unknown>).muted_at != null,
      )
      expect(mutedUpdate).toBeTruthy()
      expect(sendTextMock).toHaveBeenCalledTimes(1)
      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m11Stop)
    })

    it('while muted everything except start is silence', async () => {
      const mock = mockSupabase()
      enqueueLinkedTextPreamble(mock, makeLink({ muted_at: '2026-08-01T10:00:00Z' }))

      await route.handler(signedRequest(envelope({ messages: [textMessage('hej, är du där?')] })))

      expect(sendTextMock).not.toHaveBeenCalled()
      const [row] = mock.findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
      expect(row.processing_status).toBe('skipped')
    })

    it('while muted media is also silence', async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: makeLink({ muted_at: '2026-08-01T10:00:00Z' }) })
      mock.enqueue({ data: { id: 'conv-1' } })
      mock.enqueue({ data: { id: 'msg-row-1' } })
      mock.enqueue({ data: null })
      mock.enqueue({ data: null })

      await route.handler(signedRequest(envelope({ messages: [imageMessage()] })))

      expect(sendTextMock).not.toHaveBeenCalled()
      expect(kickMock).toHaveBeenCalledWith([])
      // Muted means the channel is paused: no checkmark either.
      expect(sendReactionMock).not.toHaveBeenCalled()
    })

    it('start unmutes and welcomes back with M12', async () => {
      const mock = mockSupabase()
      enqueueDurablePreamble(mock, makeLink({ muted_at: '2026-08-01T10:00:00Z' }))
      mock.enqueue({ data: null }) // muted_at cleared
      mock.enqueue({ data: null }) // terminal row insert

      await route.handler(signedRequest(envelope({ messages: [textMessage('start')] })))

      const linkUpdates = mock.findCalls('whatsapp_phone_links', 'update')
      const unmute = linkUpdates.find(
        (args) => (args[0] as Record<string, unknown>).muted_at === null,
      )
      expect(unmute).toBeTruthy()
      expect(sendTextMock).toHaveBeenCalledTimes(1)
      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m12Start)
    })

    it('hjälp escalates to a human with M13', async () => {
      const mock = mockSupabase()
      enqueueLinkedTextPreamble(mock, makeLink())

      await route.handler(signedRequest(envelope({ messages: [textMessage('Hjälp')] })))
      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m13Help)
      expect(sendTextMock.mock.calls[0][1].body).toContain('support@accounted.se')
    })

    it('other free text gets the M16 fallback', async () => {
      const mock = mockSupabase()
      enqueueLinkedTextPreamble(mock, makeLink())

      await route.handler(
        signedRequest(envelope({ messages: [textMessage('kan du bokföra allt åt mig?')] })),
      )
      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m16Fallback)
    })

    it('voice notes get M14', async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: makeLink() })
      mock.enqueue({ data: { id: 'conv-1' } })
      mock.enqueue({ data: { id: 'msg-row-1' } })
      mock.enqueue({ data: null })
      mock.enqueue({ data: null })

      await route.handler(
        signedRequest(
          envelope({
            messages: [
              {
                from: '46701234567',
                id: 'wamid.IN1',
                type: 'audio',
                audio: { id: 'media-2', mime_type: 'audio/ogg', voice: true },
              },
            ],
          }),
        ),
      )
      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m14Voice)
      expect(kickMock).toHaveBeenCalledWith([])
    })

    it('stickers get M15', async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: makeLink() })
      mock.enqueue({ data: { id: 'conv-1' } })
      mock.enqueue({ data: { id: 'msg-row-1' } })
      mock.enqueue({ data: null })
      mock.enqueue({ data: null })

      await route.handler(
        signedRequest(
          envelope({
            messages: [
              {
                from: '46701234567',
                id: 'wamid.IN1',
                type: 'sticker',
                sticker: { id: 'media-3', mime_type: 'image/webp' },
              },
            ],
          }),
        ),
      )
      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m15Unsupported)
    })
  })

  describe('conversation layer routing', () => {
    const awaitingCompany = () => ({
      id: 'conv-1',
      state: 'awaiting_company',
      context: {
        company_options: [
          { id: 'company-1', name: 'Bolag A AB' },
          { id: 'company-2', name: 'Bolag B AB' },
        ],
        pending_question: {
          type: 'company',
          inbox_item_id: null,
          asked_at: new Date().toISOString(),
        },
      },
      company_id: null,
    })

    it('a typed digit in awaiting_company applies the choice and kicks the parked rows', async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: makeLink() })
      mock.enqueue({ data: awaitingCompany() })
      mock.enqueue({ data: null }) // wamid dedupe pre-check
      mock.enqueue({ data: null }) // link last_message_at
      mock.enqueue({ data: null }) // conversation window update
      mock.enqueue({ data: { company_id: 'company-2' } }) // membership check
      mock.enqueue({ data: null }) // guarded conversation pin update
      mock.enqueue({ data: null }) // link last_company_id
      mock.enqueue({ data: [] }) // expiry stamp: nothing past the media window
      mock.enqueue({ data: [{ id: 'stg-1' }, { id: 'stg-2' }] }) // staged reopen
      mock.enqueue({ data: null }) // terminal row insert

      await route.handler(signedRequest(envelope({ messages: [textMessage('2')] })))

      expect(sendTextMock).toHaveBeenCalledTimes(1)
      const confirm = sendTextMock.mock.calls[0][1]
      expect(confirm.template).toBe(TEMPLATE.m6CompanyConfirm)
      expect(confirm.body).toContain('Bolag B AB')
      expect(kickMock).toHaveBeenCalledWith(['stg-1', 'stg-2'], { companySelectedVia: 'numbered' })
    })

    it('an interactive button reply in awaiting_company applies the tapped company', async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: makeLink() })
      mock.enqueue({ data: awaitingCompany() })
      mock.enqueue({ data: null }) // wamid dedupe pre-check
      mock.enqueue({ data: null })
      mock.enqueue({ data: null })
      mock.enqueue({ data: { company_id: 'company-1' } }) // membership check
      mock.enqueue({ data: null }) // guarded conversation pin update
      mock.enqueue({ data: null }) // link last_company_id
      mock.enqueue({ data: [] }) // expiry stamp: nothing past the media window
      mock.enqueue({ data: [{ id: 'stg-1' }] }) // staged reopen
      mock.enqueue({ data: null }) // terminal row insert

      await route.handler(
        signedRequest(
          envelope({
            messages: [
              {
                from: '46701234567',
                id: 'wamid.IN1',
                type: 'interactive',
                interactive: {
                  type: 'button_reply',
                  button_reply: { id: 'company-1', title: 'Bolag A AB' },
                },
              },
            ],
          }),
        ),
      )

      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m6CompanyConfirm)
      expect(kickMock).toHaveBeenCalledWith(['stg-1'], { companySelectedVia: 'button' })
    })

    it('a stale interactive tap outside awaiting_company is silence', async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: makeLink() })
      mock.enqueue({ data: { id: 'conv-1', state: 'idle', context: {} } })
      mock.enqueue({ data: { id: 'msg-row-1' } })
      mock.enqueue({ data: null })
      mock.enqueue({ data: null })

      await route.handler(
        signedRequest(
          envelope({
            messages: [
              {
                from: '46701234567',
                id: 'wamid.IN1',
                type: 'interactive',
                interactive: {
                  type: 'button_reply',
                  button_reply: { id: 'company-1', title: 'Bolag A AB' },
                },
              },
            ],
          }),
        ),
      )

      expect(sendTextMock).not.toHaveBeenCalled()
      const [row] = mock.findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
      expect(row.processing_status).toBe('skipped')
    })

    it("'byt' in idle clears the company pin and confirms", async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: makeLink() })
      mock.enqueue({
        data: {
          id: 'conv-1',
          state: 'idle',
          context: {
            pin_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            pin_source: 'button',
          },
          company_id: 'company-2',
        },
      })
      mock.enqueue({ data: null }) // wamid dedupe pre-check
      mock.enqueue({ data: null }) // link update
      mock.enqueue({ data: null }) // conversation window update
      mock.enqueue({ data: null }) // guarded pin clear update
      mock.enqueue({ data: null }) // terminal row insert

      await route.handler(signedRequest(envelope({ messages: [textMessage('byt')] })))

      expect(sendTextMock).toHaveBeenCalledTimes(1)
      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m6BytPin)
      const pinClear = mock
        .findCalls('whatsapp_conversations', 'update')
        .map((args) => args[0] as Record<string, unknown>)
        .find((patch) => 'company_id' in patch)
      expect(pinClear?.company_id).toBeNull()
      expect((pinClear?.context as Record<string, unknown>).pin_expires_at).toBeUndefined()
    })

    it('free text while awaiting_representation is deferred as an answer (never handled inline)', async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: makeLink() })
      mock.enqueue({
        data: {
          id: 'conv-1',
          state: 'awaiting_representation',
          context: {
            pending_question: {
              type: 'representation',
              inbox_item_id: 'item-9',
              asked_at: new Date().toISOString(),
            },
          },
        },
      })
      mock.enqueue({ data: { id: 'msg-row-9' } })
      mock.enqueue({ data: null })
      mock.enqueue({ data: null })

      await route.handler(
        signedRequest(envelope({ messages: [textMessage('Lunch med Anna Berg (Volvo)')] })),
      )

      const [row] = mock.findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
      expect(row.processing_status).toBe('received') // durable job row for the worker
      expect(kickMock).toHaveBeenCalledWith(['msg-row-9'])
      expect(sendTextMock).not.toHaveBeenCalled() // no inline M16 while a question is open
    })

    it('idle free text quoting an earlier receipt routes as a late answer', async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: makeLink() })
      mock.enqueue({
        data: {
          id: 'conv-1',
          state: 'idle',
          context: {
            recent_questions: [
              {
                type: 'context',
                inbox_item_id: 'item-7',
                asked_at: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString(),
                status: 'moved_to_app',
              },
            ],
          },
        },
      })
      mock.enqueue({ data: { inbox_item_id: 'item-7' } }) // quoted wamid lookup
      mock.enqueue({ data: { id: 'msg-row-7' } })
      mock.enqueue({ data: null })
      mock.enqueue({ data: null })

      await route.handler(
        signedRequest(
          envelope({
            messages: [textMessage('taxi till kundmöte', { context: { id: 'wamid.QUOTED' } })],
          }),
        ),
      )

      const [row] = mock.findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
      expect(row.processing_status).toBe('received')
      expect(kickMock).toHaveBeenCalledWith(['msg-row-7'])
      expect(sendTextMock).not.toHaveBeenCalled()
    })
  })

  describe('hardening: dispositions, late company answers, payload redaction', () => {
    const withOptions = (state: string) => ({
      id: 'conv-1',
      state,
      context: {
        company_options: [
          { id: 'company-1', name: 'Bolag A AB' },
          { id: 'company-2', name: 'Bolag B AB' },
        ],
      },
      company_id: null,
    })

    it('an out-of-range digit gets the options repeated instead of silence', async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: makeLink() })
      mock.enqueue({ data: withOptions('awaiting_company') })
      mock.enqueue({ data: null }) // wamid dedupe pre-check
      mock.enqueue({ data: null }) // link last_message_at
      mock.enqueue({ data: null }) // conversation window
      mock.enqueue({ data: null }) // terminal row insert

      await route.handler(signedRequest(envelope({ messages: [textMessage('9')] })))

      expect(sendTextMock).toHaveBeenCalledTimes(1)
      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m6CompanyRetry)
      expect(sendTextMock.mock.calls[0][1].body).toContain('Bolag B AB')
    })

    it('a typed company name gets the options repeated, not the M16 lecture', async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: makeLink() })
      mock.enqueue({ data: withOptions('awaiting_company') })
      mock.enqueue({ data: { id: 'msg-row-1' } }) // insert (reply-only disposition)
      mock.enqueue({ data: null })
      mock.enqueue({ data: null })

      await route.handler(signedRequest(envelope({ messages: [textMessage('Bolag B AB')] })))

      expect(sendTextMock).toHaveBeenCalledTimes(1)
      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m6CompanyRetry)
    })

    it('accepts a LATE company answer after the 48h reset (options still present)', async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: makeLink() })
      mock.enqueue({ data: withOptions('idle') })
      mock.enqueue({ data: null }) // wamid dedupe pre-check
      mock.enqueue({ data: null }) // link last_message_at
      mock.enqueue({ data: null }) // conversation window
      mock.enqueue({ data: { company_id: 'company-2' } }) // membership check
      mock.enqueue({ data: null }) // guarded pin write
      mock.enqueue({ data: null }) // link last_company_id
      mock.enqueue({ data: [] }) // expiry stamp: nothing past the media window
      mock.enqueue({ data: [{ id: 'stg-1' }] }) // staged reopen
      mock.enqueue({ data: null }) // terminal row insert

      await route.handler(signedRequest(envelope({ messages: [textMessage('2')] })))

      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m6CompanyConfirm)
      expect(kickMock).toHaveBeenCalledWith(['stg-1'], { companySelectedVia: 'numbered' })
    })

    it("recognises 'byt' inside an awaiting state, the word m6-confirm teaches", async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: makeLink() })
      mock.enqueue({
        data: {
          id: 'conv-1',
          state: 'awaiting_context',
          context: {
            pin_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
            pending_question: {
              type: 'context',
              inbox_item_id: 'item-1',
              asked_at: new Date().toISOString(),
            },
          },
          company_id: 'company-2',
        },
      })
      mock.enqueue({ data: null }) // wamid dedupe pre-check
      mock.enqueue({ data: null }) // link last_message_at
      mock.enqueue({ data: null }) // conversation window
      mock.enqueue({ data: null }) // guarded pin clear
      mock.enqueue({ data: null }) // terminal row insert

      await route.handler(signedRequest(envelope({ messages: [textMessage('byt')] })))

      expect(sendTextMock).toHaveBeenCalledTimes(1)
      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m6BytPin)
      expect(kickMock).toHaveBeenCalledWith([])
    })

    it('applies STOP before writing its terminal row, so a crash cannot lose the opt-out', async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: makeLink() })
      mock.enqueue({ data: { id: 'conv-1', state: 'idle', context: {} } })
      mock.enqueue({ data: null }) // wamid dedupe pre-check
      mock.enqueue({ data: null }) // link last_message_at
      mock.enqueue({ data: null }) // conversation window
      mock.enqueue({ data: null }) // muted_at
      mock.enqueue({ data: null }) // terminal row insert

      await route.handler(signedRequest(envelope({ messages: [textMessage('stopp')] })))

      const order = mock.calls
        .filter(
          (c) =>
            (c.table === 'whatsapp_phone_links' &&
              c.method === 'update' &&
              (c.args[0] as Record<string, unknown>).muted_at != null) ||
            (c.table === 'whatsapp_messages' && c.method === 'insert'),
        )
        .map((c) => `${c.table}.${c.method}`)
      expect(order).toEqual(['whatsapp_phone_links.update', 'whatsapp_messages.insert'])
      const [row] = mock.findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
      expect(row.processing_status).toBe('done')
    })

    it('never persists the sender plaintext number in raw_payload', async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: makeLink() })
      mock.enqueue({ data: { id: 'conv-1', state: 'idle', context: {} } })
      mock.enqueue({ data: { id: 'msg-row-1' } })
      mock.enqueue({ data: null })
      mock.enqueue({ data: null })

      await route.handler(signedRequest(envelope({ messages: [imageMessage()] })))

      const [row] = mock.findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
      expect(JSON.stringify(row.raw_payload)).not.toContain('46701234567')
      expect(row.raw_payload).toMatchObject({ id: 'wamid.IN1', type: 'image' })
    })

    it('a muted sender contributes no chat content at all', async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: makeLink({ muted_at: '2026-08-01T10:00:00Z' }) })
      mock.enqueue({ data: { id: 'conv-1', state: 'idle', context: {} } })
      mock.enqueue({ data: { id: 'msg-row-1' } })
      mock.enqueue({ data: null })
      mock.enqueue({ data: null })

      await route.handler(
        signedRequest(envelope({ messages: [textMessage('känslig text till en död linje')] })),
      )

      const [row] = mock.findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
      expect(row.processing_status).toBe('skipped')
      expect(row.body_text).toBeNull()
      expect(row.raw_payload).toBeNull()
    })
  })

  it('acks signed-but-unparseable bodies without redelivery bait', async () => {
    mockSupabase()
    const raw = 'not json'
    const signature =
      'sha256=' + crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex')
    const response = await route.handler(
      new Request('http://localhost:3000/api/extensions/ext/whatsapp-inbox/webhook', {
        method: 'POST',
        headers: { 'X-Hub-Signature-256': signature },
        body: raw,
      }),
    )
    expect(response.status).toBe(200)
  })
})
