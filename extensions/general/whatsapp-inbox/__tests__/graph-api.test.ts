import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { TimeoutError } from '@/lib/http/fetch-with-timeout'
import {
  sendText,
  sendReplyButtons,
  sendList,
  sendReaction,
  RECEIVED_REACTION_EMOJI,
  downloadMedia,
  getDisplayPhoneNumber,
  resetDisplayNumberCacheForTests,
  GraphApiError,
  MAX_MEDIA_BYTES,
} from '@/extensions/general/whatsapp-inbox/lib/graph-api'
import { TEMPLATE } from '@/extensions/general/whatsapp-inbox/lib/messages'
import type { SupabaseClient } from '@supabase/supabase-js'

const fetchMock = vi.fn()

describe('graph-api', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', fetchMock)
    resetDisplayNumberCacheForTests()
    process.env.WHATSAPP_ACCESS_TOKEN = 'token-1'
    process.env.WHATSAPP_PHONE_NUMBER_ID = '111222333'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    process.env = { ...originalEnv }
  })

  describe('sendText', () => {
    it('sends and persists an outbound row with the response wamid', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.OUT1' }] }), { status: 200 }),
      )
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      enqueue({ data: null, error: null })

      const result = await sendText(supabase as unknown as SupabaseClient, {
        to: '46701234567',
        body: 'Hej!',
        template: TEMPLATE.m16Fallback,
        senderPhoneHash: 'hash-1',
      })

      expect(result).toEqual({ ok: true, wamid: 'wamid.OUT1', errorDetail: null })
      const [row] = findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
      expect(row.direction).toBe('outbound')
      expect(row.wamid).toBe('wamid.OUT1')
      expect(row.delivery_status).toBe('sent')
      expect(row.error_message).toBeNull()
      expect(row.processing_status).toBe('done')
      expect(row.raw_payload).toEqual({ template: TEMPLATE.m16Fallback })
      expect(row.sender_phone_hash).toBe('hash-1')

      // The Graph call itself
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toContain('/111222333/messages')
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1')
      expect(JSON.parse(init.body as string).text.body).toBe('Hej!')
    })

    it('never throws on non-2xx and records a failed row', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{"error":{}}', { status: 500 }))
      const { supabase, enqueue, findCall } = createQueuedMockSupabase()
      enqueue({ data: null, error: null })

      const result = await sendText(supabase as unknown as SupabaseClient, {
        to: '46701234567',
        body: 'Hej!',
        template: TEMPLATE.m18Error,
      })

      expect(result.ok).toBe(false)
      expect(result.wamid).toBeNull()
      const [row] = findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
      expect(row.delivery_status).toBe('failed')
      expect(row.wamid).toBeNull()
      // #1552: the row keeps WHY the send failed, not just that it failed.
      expect(row.error_message).toContain('HTTP 500')
    })

    it('never throws on a network error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: null, error: null })

      const result = await sendText(supabase as unknown as SupabaseClient, {
        to: '46701234567',
        body: 'Hej!',
        template: TEMPLATE.m18Error,
      })
      expect(result.ok).toBe(false)
    })
  })

  describe('interactive titles are unique (#1589, Meta #131009 "Duplicate button title")', () => {
    it('sendReplyButtons sends distinct titles when two options share a name, ids untouched', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.BTN' }] }), { status: 200 }),
      )
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: null, error: null })

      await sendReplyButtons(supabase as unknown as SupabaseClient, {
        to: '46701234567',
        body: 'Vilket företag gäller kvittot?',
        template: TEMPLATE.m6CompanyQuestion,
        buttons: [
          { id: 'company-live', title: 'Capelix AB' },
          { id: 'company-archived', title: 'Capelix AB' },
        ],
      })

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      const payload = JSON.parse(init.body as string) as {
        interactive: { action: { buttons: { reply: { id: string; title: string } }[] } }
      }
      const [first, second] = payload.interactive.action.buttons
      expect(first.reply.title).not.toBe(second.reply.title)
      expect(first.reply.title.length).toBeLessThanOrEqual(20)
      expect(second.reply.title.length).toBeLessThanOrEqual(20)
      expect(first.reply.id).toBe('company-live')
      expect(second.reply.id).toBe('company-archived')
    })

    it('sendList sends distinct row titles when two options share a name, ids untouched', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.LIST' }] }), { status: 200 }),
      )
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: null, error: null })

      await sendList(supabase as unknown as SupabaseClient, {
        to: '46701234567',
        body: 'Vilket företag gäller kvittot?',
        template: TEMPLATE.m6CompanyQuestion,
        buttonLabel: 'Välj företag',
        rows: [
          { id: 'c-1', title: 'Bolag A AB' },
          { id: 'c-2', title: 'Wennberg Fastighetsförvaltning AB' },
          { id: 'c-3', title: 'Wennberg Fastighetsförvaltning Holding AB' },
          { id: 'c-4', title: 'Bolag D AB' },
        ],
      })

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      const payload = JSON.parse(init.body as string) as {
        interactive: { action: { sections: { rows: { id: string; title: string }[] }[] } }
      }
      const rows = payload.interactive.action.sections[0].rows
      expect(new Set(rows.map((r) => r.title.toLowerCase())).size).toBe(4)
      for (const row of rows) expect(row.title.length).toBeLessThanOrEqual(24)
      expect(rows.map((r) => r.id)).toEqual(['c-1', 'c-2', 'c-3', 'c-4'])
      expect(rows[0].title).toBe('Bolag A AB')
      expect(rows[3].title).toBe('Bolag D AB')
    })
  })

  describe('sendReaction', () => {
    it('posts a reaction payload targeting the inbound wamid', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ messages: [{ id: 'wamid.REACT' }] }), { status: 200 }),
      )

      await sendReaction('46701234567', 'wamid.IN1')

      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
      expect(url).toContain('/111222333/messages')
      expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1')
      const body = JSON.parse(init.body as string)
      expect(body.type).toBe('reaction')
      expect(body.to).toBe('46701234567')
      expect(body.reaction).toEqual({
        message_id: 'wamid.IN1',
        emoji: RECEIVED_REACTION_EMOJI,
      })
      // U+2705 exactly: the checkmark must never silently become another char.
      expect(RECEIVED_REACTION_EMOJI.codePointAt(0)).toBe(0x2705)
    })

    it('never throws on non-2xx (best-effort, like mark-read)', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{"error":{}}', { status: 500 }))
      await expect(sendReaction('46701234567', 'wamid.IN1')).resolves.toBeUndefined()
    })

    it('never throws on a network error', async () => {
      fetchMock.mockRejectedValueOnce(new Error('ECONNRESET'))
      await expect(sendReaction('46701234567', 'wamid.IN1')).resolves.toBeUndefined()
    })

    it('never throws when the access token is missing', async () => {
      delete process.env.WHATSAPP_ACCESS_TOKEN
      await expect(sendReaction('46701234567', 'wamid.IN1')).resolves.toBeUndefined()
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })

  describe('downloadMedia', () => {
    it('resolves the media id, downloads with Bearer auth, and returns the bytes', async () => {
      const bytes = new Uint8Array([1, 2, 3, 4])
      fetchMock
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ url: 'https://lookaside.example/m1', mime_type: 'image/jpeg' }),
            { status: 200 },
          ),
        )
        .mockResolvedValueOnce(new Response(bytes, { status: 200 }))

      const media = await downloadMedia('media-1')
      expect(media.mime).toBe('image/jpeg')
      expect(media.fileSize).toBe(4)
      expect(new Uint8Array(media.buffer)).toEqual(bytes)

      const [downloadUrl, downloadInit] = fetchMock.mock.calls[1] as [string, RequestInit]
      expect(downloadUrl).toBe('https://lookaside.example/m1')
      expect((downloadInit.headers as Record<string, string>).Authorization).toBe('Bearer token-1')
    })

    it('rejects a non-2xx lookup', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 404 }))
      await expect(downloadMedia('media-1')).rejects.toThrow(GraphApiError)
    })

    it('rejects a non-2xx download', async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ url: 'https://lookaside.example/m1' }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response('gone', { status: 410 }))
      await expect(downloadMedia('media-1')).rejects.toThrow(/download failed/)
    })

    it('rejects when the declared file size exceeds the cap', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({ url: 'https://x/m1', file_size: MAX_MEDIA_BYTES + 1 }),
          { status: 200 },
        ),
      )
      await expect(downloadMedia('media-1')).rejects.toThrow(/size limit/)
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('rejects via the content-length header before reading the body', async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ url: 'https://x/m1' }), { status: 200 }),
        )
        .mockResolvedValueOnce(
          new Response('x', {
            status: 200,
            headers: { 'content-length': String(MAX_MEDIA_BYTES + 1) },
          }),
        )
      await expect(downloadMedia('media-1')).rejects.toThrow(/size limit/)
    })

    it('rejects an oversized stream even without a content-length header', async () => {
      const chunk = new Uint8Array(6 * 1024 * 1024)
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(chunk)
          controller.enqueue(chunk) // 12 MB total > 10 MB cap
          controller.close()
        },
      })
      fetchMock
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ url: 'https://x/m1' }), { status: 200 }),
        )
        .mockResolvedValueOnce(new Response(stream, { status: 200 }))

      await expect(downloadMedia('media-1')).rejects.toThrow(/size limit/)
    })

    it('propagates timeouts as TimeoutError', async () => {
      fetchMock.mockRejectedValueOnce(new TimeoutError('WhatsApp media lookup timed out'))
      await expect(downloadMedia('media-1')).rejects.toThrow(TimeoutError)
    })

    it('throws when the access token is missing', async () => {
      delete process.env.WHATSAPP_ACCESS_TOKEN
      await expect(downloadMedia('media-1')).rejects.toThrow(/WHATSAPP_ACCESS_TOKEN/)
    })
  })

  describe('getDisplayPhoneNumber', () => {
    it('resolves and caches the display number as digits', async () => {
      fetchMock.mockResolvedValueOnce(
        new Response(JSON.stringify({ display_phone_number: '+46 10 123 45 67' }), { status: 200 }),
      )
      expect(await getDisplayPhoneNumber()).toBe('46101234567')
      // Cached: second call issues no fetch.
      expect(await getDisplayPhoneNumber()).toBe('46101234567')
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    it('returns null on failure instead of throwing', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 500 }))
      expect(await getDisplayPhoneNumber()).toBeNull()
    })
  })
})
