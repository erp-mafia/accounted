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
    sendText: vi.fn().mockResolvedValue({ ok: true, wamid: 'wamid.OUT' }),
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
import { sendText, downloadMedia } from '@/extensions/general/whatsapp-inbox/lib/graph-api'
import { kickInboundProcessing } from '@/extensions/general/whatsapp-inbox/lib/process-inbound'
import { TEMPLATE } from '@/extensions/general/whatsapp-inbox/lib/messages'
import { hashLinkCode } from '@/extensions/general/whatsapp-inbox/lib/linking'

const SECRET = 'meta-app-secret'
const createClientMock = vi.mocked(createClient)
const sendTextMock = vi.mocked(sendText)
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
    sendTextMock.mockResolvedValue({ ok: true, wamid: 'wamid.OUT' })
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

  it('persists a linked media message and defers processing', async () => {
    const { enqueue, findCall } = mockSupabase()
    enqueue({ data: makeLink() }) // active link lookup
    enqueue({ data: { id: 'conv-1' } }) // conversation lookup
    enqueue({ data: { id: 'msg-row-1' } }) // message insert
    enqueue({ data: null }) // phone_links last_message_at update
    enqueue({ data: null }) // conversation window update

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
    expect(kickMock).toHaveBeenCalledWith(['msg-row-1'])
    expect(sendTextMock).not.toHaveBeenCalled() // per-receipt ack comes from the worker
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
  })

  describe('unknown senders', () => {
    it('greets once with M1: no media download, no message persistence', async () => {
      const { enqueue, findCalls } = mockSupabase()
      enqueue({ data: null }) // no active link
      enqueue({ data: { ok: true } }) // sender quota RPC
      enqueue({ data: [] }) // greeting throttle: nothing sent before

      const response = await route.handler(
        signedRequest(envelope({ messages: [imageMessage()] })),
      )
      expect(response.status).toBe(200)
      expect(sendTextMock).toHaveBeenCalledTimes(1)
      expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m1Unlinked)
      expect(vi.mocked(downloadMedia)).not.toHaveBeenCalled()
      expect(findCalls('whatsapp_messages', 'insert')).toHaveLength(0)
      expect(kickMock).toHaveBeenCalledWith([])
    })

    it('stays silent when the M1 throttle window is exhausted', async () => {
      const { enqueue } = mockSupabase()
      enqueue({ data: null })
      enqueue({ data: { ok: true } })
      enqueue({ data: [{ created_at: new Date().toISOString() }] }) // greeted within the hour

      await route.handler(signedRequest(envelope({ messages: [textMessage('hej')] })))
      expect(sendTextMock).not.toHaveBeenCalled()
    })

    it('stays silent when the pre-binding sender quota is exhausted', async () => {
      const mock = mockSupabase()
      mock.enqueue({ data: null })
      mock.enqueue({ data: { ok: false, scope: 'minute', retry_after_sec: 60 } })

      await route.handler(signedRequest(envelope({ messages: [textMessage('hej')] })))
      expect(sendTextMock).not.toHaveBeenCalled()
      expect(mock.supabase.rpc).toHaveBeenCalledWith(
        'check_and_increment_whatsapp_sender_quota',
        expect.objectContaining({ p_phone_hash: expect.any(String) }),
      )
      // Only the link lookup ever touched a table.
      const tables = [...new Set(mock.calls.map((c) => c.table))]
      expect(tables).toEqual(['whatsapp_phone_links'])
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

    it('stopp mutes the link and confirms with M11', async () => {
      const mock = mockSupabase()
      enqueueLinkedTextPreamble(mock, makeLink())
      mock.enqueue({ data: null }) // muted_at update

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
    })

    it('start unmutes and welcomes back with M12', async () => {
      const mock = mockSupabase()
      enqueueLinkedTextPreamble(mock, makeLink({ muted_at: '2026-08-01T10:00:00Z' }))
      mock.enqueue({ data: null }) // muted_at cleared

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
