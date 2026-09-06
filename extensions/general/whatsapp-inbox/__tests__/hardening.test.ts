/**
 * Regression tests for the adversarial-review hardening pass.
 *
 * Every case here fails against the pre-fix code: a failed send stranding the
 * company question, an ignored ack send result, SEK-labelled foreign amounts,
 * unguarded terminal status writes, quoted corrections landing on the wrong
 * receipt, blind whole-context conversation writes, the plaintext phone in
 * raw_payload, text answers to the re-send question, and the 48h expiry
 * discarding parked receipts.
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
    sendReplyButtons: vi.fn().mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null }),
    sendList: vi.fn().mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null }),
    markReadWithTyping: vi.fn().mockResolvedValue(undefined),
    downloadMedia: vi.fn(),
  }
})

vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue('event-1'),
}))

vi.mock('@/lib/rate-limits/agent', () => ({
  checkAgentRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/extensions/general/whatsapp-inbox/lib/interpret-answer', () => ({
  interpretChatAnswer: vi.fn().mockResolvedValue({ ok: false }),
}))

import { sendText, sendReplyButtons } from '@/extensions/general/whatsapp-inbox/lib/graph-api'
import { askCompanyQuestion } from '@/extensions/general/whatsapp-inbox/lib/company-question'
import {
  finalizeBurst,
  processInboundMessage,
} from '@/extensions/general/whatsapp-inbox/lib/process-inbound'
import {
  redactRawPayload,
  resolveAnswerTarget,
  resolveRecipient,
  updateConversation,
} from '@/extensions/general/whatsapp-inbox/lib/conversation'
import { encryptPhone } from '@/extensions/general/whatsapp-inbox/lib/phone-crypto'
import { runSweep } from '@/extensions/general/whatsapp-inbox/lib/sweep'
import { botCopy, TEMPLATE } from '@/extensions/general/whatsapp-inbox/lib/messages'

const sendTextMock = vi.mocked(sendText)
const sendButtonsMock = vi.mocked(sendReplyButtons)

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    phone_link_id: 'link-1',
    state: 'idle',
    context: {},
    company_id: 'company-1',
    service_window_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    debounce_until: new Date(Date.now() - 1000).toISOString(),
    pending_ack: true,
    last_inbound_at: null,
    last_outbound_at: null,
    created_at: '2026-08-01T09:00:00Z',
    updated_at: '2026-08-01T09:00:00Z',
    ...overrides,
  }
}

function makeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    user_id: 'user-1',
    phone_hash: 'hash-1',
    phone_enc: 'enc',
    phone_masked: '+46 70 *** ** 67',
    default_company_id: null,
    last_company_id: null,
    verified_at: '2026-08-01T09:00:00Z',
    revoked_at: null,
    muted_at: null,
    ...overrides,
  }
}

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    direction: 'inbound',
    wamid: 'wamid.IN1',
    sender_phone_hash: 'hash-1',
    phone_link_id: 'link-1',
    conversation_id: 'conv-1',
    message_type: 'image',
    body_text: null,
    media_id: 'media-1',
    media_mime: 'image/jpeg',
    media_sha256: 'abc',
    media_filename: 'kvitto.jpg',
    raw_payload: { from: '46701234567' },
    processing_status: 'received',
    attempts: 0,
    error_message: null,
    inbox_item_id: null,
    delivery_status: null,
    correlation_id: 'corr-1',
    acked_at: null,
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-01T10:00:00Z',
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.WHATSAPP_PHONE_HASH_KEY = 'test-pepper'
  process.env.WHATSAPP_PHONE_ENCRYPTION_KEY = 'a'.repeat(64)
  sendTextMock.mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null })
  sendButtonsMock.mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null })
})

describe('company question is not one-shot when the send fails', () => {
  function enqueueAsk(mock: ReturnType<typeof createQueuedMockSupabase>) {
    mock.enqueue({ data: [{ company_id: 'company-1' }, { company_id: 'company-2' }] })
    mock.enqueue({
      data: [
        { id: 'company-1', name: 'Bolag A AB' },
        { id: 'company-2', name: 'Bolag B AB' },
      ],
    })
    mock.enqueue({ data: [{ ...makeConversation(), state: 'awaiting_company' }] }) // guarded commit
  }

  it('rolls the question back so the next receipt re-asks', async () => {
    sendButtonsMock.mockResolvedValue({ ok: false, wamid: null, errorDetail: 'Send failed (HTTP 500)', failure: 'http_rejected' })
    // The numbered text fallback (#1589) must fail too before anything rolls
    // back; with the default ok:true text mock the question would stay armed.
    sendTextMock.mockResolvedValue({ ok: false, wamid: null, errorDetail: 'Send failed (HTTP 500)', failure: 'http_rejected' })
    const mock = createQueuedMockSupabase()
    enqueueAsk(mock)
    mock.enqueue({
      data: [
        {
          ...makeConversation(),
          state: 'awaiting_company',
          context: { company_options: [{ id: 'company-1', name: 'Bolag A AB' }] },
        },
      ],
    })

    const asked = await askCompanyQuestion(mock.supabase as unknown as SupabaseClient, {
      conversation: makeConversation() as never,
      link: makeLink() as never,
      to: '46701234567',
      replyBase: {},
      stagedCount: 3,
    })

    expect(asked).toBe('not_asked')
    // The numbered fallback was tried once, with the same template id, before
    // giving up.
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m6CompanyQuestion)
    expect(sendTextMock.mock.calls[0][1].body).toContain('1. Bolag A AB')
    const updates = mock
      .findCalls('whatsapp_conversations', 'update')
      .map((args) => args[0] as { state?: string; context?: Record<string, unknown> })
    // First write arms the question, the second undoes it.
    expect(updates[0].state).toBe('awaiting_company')
    expect(updates[1].state).toBe('idle')
    expect(updates[1].context?.company_options).toBeUndefined()
    expect(updates[1].context?.pending_question).toBeUndefined()
  })

  it('keeps the question when the send succeeded', async () => {
    const mock = createQueuedMockSupabase()
    enqueueAsk(mock)

    const asked = await askCompanyQuestion(mock.supabase as unknown as SupabaseClient, {
      conversation: makeConversation() as never,
      link: makeLink() as never,
      to: '46701234567',
      replyBase: {},
      stagedCount: 1,
    })

    expect(asked).toBe('asked')
    expect(mock.findCalls('whatsapp_conversations', 'update')).toHaveLength(1)
  })
})

describe('combined ack', () => {
  function enqueueBurst(
    mock: ReturnType<typeof createQueuedMockSupabase>,
    extracted: Record<string, unknown>,
  ) {
    mock.enqueue({ data: [{ id: 'conv-1' }] }) // claimAck
    mock.enqueue({ data: makeConversation() })
    mock.enqueue({
      data: [
        {
          ...makeRow(),
          processing_status: 'done',
          inbox_item_id: 'item-1',
        },
      ],
    })
    mock.enqueue({
      data: [
        {
          id: 'item-1',
          company_id: 'company-1',
          extracted_data: extracted,
          channel_context: { channel: 'whatsapp' },
          document_id: null,
        },
      ],
    })
    mock.enqueue({ data: [makeConversation()] }) // guarded state write
  }

  it('states a foreign total in its own currency, never as kronor', async () => {
    const mock = createQueuedMockSupabase()
    enqueueBurst(mock, {
      documentKind: 'receipt',
      legibility: 'good',
      supplier: { name: 'Hotel Adlon' },
      invoice: { invoiceDate: '2026-07-30', currency: 'EUR' },
      totals: { total: 250 },
      lineItems: [],
    })

    await finalizeBurst(mock.supabase as unknown as SupabaseClient, 'conv-1')

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    const body = sendTextMock.mock.calls[0][1].body
    expect(body).toContain('250 EUR')
    expect(body).not.toContain('250 kr')
  })

  it('still says kr for SEK and for an unstated currency', async () => {
    const mock = createQueuedMockSupabase()
    enqueueBurst(mock, {
      documentKind: 'receipt',
      legibility: 'good',
      supplier: { name: 'ICA Maxi' },
      invoice: { invoiceDate: '2026-07-30' },
      totals: { total: 234 },
      lineItems: [],
    })

    await finalizeBurst(mock.supabase as unknown as SupabaseClient, 'conv-1')
    expect(sendTextMock.mock.calls[0][1].body).toContain('234 kr')
  })

  it('leaves the rows unacked when the send failed so the sweep retries', async () => {
    sendTextMock.mockResolvedValue({ ok: false, wamid: null, errorDetail: 'Send failed (HTTP 500)', failure: 'http_rejected' })
    const mock = createQueuedMockSupabase()
    enqueueBurst(mock, {
      documentKind: 'receipt',
      legibility: 'good',
      supplier: { name: 'ICA Maxi' },
      invoice: { invoiceDate: '2026-07-30' },
      totals: { total: 234 },
      lineItems: [],
    })

    await finalizeBurst(mock.supabase as unknown as SupabaseClient, 'conv-1')

    const messageUpdates = mock
      .findCalls('whatsapp_messages', 'update')
      .map((args) => args[0] as Record<string, unknown>)
    expect(messageUpdates.some((patch) => 'acked_at' in patch)).toBe(false)
  })
})

describe('terminal status writes hold the claim', () => {
  it('guards markStatus on processing_status=processing', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: makeRow() })
    mock.enqueue({ data: { id: 'msg-1' } }) // claim
    mock.enqueue({ data: makeLink({ revoked_at: '2026-08-01T10:00:00Z' }) })
    mock.enqueue({ data: null }) // markStatus skipped

    await processInboundMessage(mock.supabase as unknown as SupabaseClient, 'msg-1')

    const guards = mock
      .findCalls('whatsapp_messages', 'eq')
      .filter((args) => args[0] === 'processing_status')
    // The claim guards on 'received'; the terminal write must guard on
    // 'processing' so a losing worker cannot clobber the winner's row.
    expect(guards.map((args) => args[1])).toContain('processing')
  })
})

describe('answer targeting', () => {
  const askedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()

  function conversationWith(recent: Record<string, unknown>[], overrides = {}) {
    return makeConversation({
      state: 'awaiting_context',
      context: {
        pending_question: { type: 'context', inbox_item_id: 'item-B', asked_at: askedAt },
        recent_questions: recent,
      },
      ...overrides,
    })
  }

  it('binds a quoted follow-up to the quoted receipt, not to another open question', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: { inbox_item_id: 'item-A' } }) // quoted wamid resolves

    const target = await resolveAnswerTarget(
      mock.supabase as unknown as SupabaseClient,
      conversationWith([
        { type: 'representation', inbox_item_id: 'item-A', asked_at: askedAt, status: 'answered' },
        { type: 'context', inbox_item_id: 'item-B', asked_at: askedAt, status: 'open' },
      ]) as never,
      'wamid.QUOTED',
    )

    expect(target?.inboxItemId).toBe('item-A')
    expect(target?.followUp).toBe(true)
  })

  it('quoting the open question is still an ordinary answer, not a late one', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: { inbox_item_id: 'item-B' } })

    const target = await resolveAnswerTarget(
      mock.supabase as unknown as SupabaseClient,
      conversationWith([
        { type: 'context', inbox_item_id: 'item-B', asked_at: askedAt, status: 'open' },
      ]) as never,
      'wamid.QUOTED',
    )

    expect(target).toEqual({ type: 'context', inboxItemId: 'item-B', late: false })
  })
})

describe('conversation writes are compare-and-set', () => {
  it('re-applies the mutation against fresh state after losing a race', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [] }) // guard did not match: someone else wrote first
    mock.enqueue({ data: makeConversation({ context: { budget: { day_key: 'x', count: 2 } } }) })
    mock.enqueue({ data: [makeConversation()] })

    const seen: number[] = []
    const result = await updateConversation(
      mock.supabase as unknown as SupabaseClient,
      makeConversation() as never,
      (_current, context) => {
        seen.push(context.budget?.count ?? 0)
        return { context: { ...context, question_queue: [] } }
      },
    )

    expect(result).not.toBeNull()
    // Second pass saw the concurrent writer's state, not the stale snapshot.
    expect(seen).toEqual([0, 2])
  })

  it('gives up rather than looping forever', async () => {
    const mock = createQueuedMockSupabase()
    for (let i = 0; i < 12; i++) {
      mock.enqueue({ data: [] })
      mock.enqueue({ data: makeConversation() })
    }

    const result = await updateConversation(
      mock.supabase as unknown as SupabaseClient,
      makeConversation() as never,
      (_current, context) => ({ context }),
    )
    expect(result).toBeNull()
  })
})

describe('phone PII', () => {
  it('strips the sender number from the persisted payload but keeps the quote id', () => {
    const redacted = redactRawPayload({
      from: '46701234567',
      id: 'wamid.IN1',
      type: 'text',
      context: { id: 'wamid.QUOTED' },
    })
    expect(redacted).not.toHaveProperty('from')
    expect(redacted).toMatchObject({ id: 'wamid.IN1', context: { id: 'wamid.QUOTED' } })
  })

  it('resolves the reply address from the encrypted link when the payload is redacted', () => {
    const row = makeRow({ raw_payload: { id: 'wamid.IN1', type: 'text' } })
    const link = { phone_enc: encryptPhone('46701234567') }
    expect(resolveRecipient(row as never, link)).toBe('46701234567')
  })

  it('returns null instead of throwing on a shredded link', () => {
    const row = makeRow({ raw_payload: {} })
    expect(resolveRecipient(row as never, { phone_enc: '' })).toBeNull()
  })
})

describe('text reply while a re-send question is open', () => {
  it('keeps it as a note on that receipt and leaves the question open', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({
      data: makeRow({
        id: 'msg-t1',
        message_type: 'text',
        body_text: 'det var lunch på Ica, 240 kr',
        media_id: null,
      }),
    })
    mock.enqueue({ data: { id: 'msg-t1' } }) // claim
    mock.enqueue({ data: makeLink() })
    mock.enqueue({
      data: makeConversation({
        state: 'awaiting_resend',
        context: {
          pending_question: {
            type: 'resend',
            inbox_item_id: 'item-9',
            asked_at: new Date().toISOString(),
          },
        },
      }),
    })
    mock.enqueue({ data: { channel_context: { channel: 'whatsapp' } } }) // load item context
    mock.enqueue({ data: null }) // item update
    mock.enqueue({ data: null }) // markStatus done

    await processInboundMessage(mock.supabase as unknown as SupabaseClient, 'msg-t1')

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m9NoteSaved)
    const itemPatch = mock.findCall('invoice_inbox_items', 'update') as [
      { channel_context: Record<string, unknown> },
    ]
    expect(itemPatch[0].channel_context.user_note).toContain('lunch på Ica')
    // The question is untouched: only a sharper file can answer it.
    expect(mock.findCalls('whatsapp_conversations', 'update')).toHaveLength(0)
  })
})

describe('answer worker re-claims', () => {
  it('does not follow a delivered confirm with the M16 fallback', async () => {
    // A worker that died after applying the answer leaves the row
    // 'processing'; the sweep re-runs it and the question now resolves to
    // nothing, which used to send "I did not understand" right after the
    // confirmation the user already received.
    const mock = createQueuedMockSupabase()
    mock.enqueue({
      data: makeRow({
        id: 'msg-t1',
        message_type: 'text',
        body_text: 'Lunch med Anna Berg',
        media_id: null,
        attempts: 1,
      }),
    })
    mock.enqueue({ data: { id: 'msg-t1' } }) // claim
    mock.enqueue({ data: makeLink() })
    mock.enqueue({ data: makeConversation({ state: 'idle', context: {} }) })
    mock.enqueue({ data: null }) // markStatus done

    await processInboundMessage(mock.supabase as unknown as SupabaseClient, 'msg-t1')

    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('still explains itself on a first attempt with nothing to answer', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({
      data: makeRow({
        id: 'msg-t1',
        message_type: 'text',
        body_text: 'kan du bokföra allt åt mig?',
        media_id: null,
        attempts: 0,
      }),
    })
    mock.enqueue({ data: { id: 'msg-t1' } })
    mock.enqueue({ data: makeLink() })
    mock.enqueue({ data: makeConversation({ state: 'idle', context: {} }) })
    mock.enqueue({ data: null })

    await processInboundMessage(mock.supabase as unknown as SupabaseClient, 'msg-t1')

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m16Fallback)
  })
})

describe('48h company-question expiry', () => {
  it('keeps the parked receipts recoverable by a late answer', async () => {
    const mock = createQueuedMockSupabase()
    mock.enqueue({ data: [] }) // 1a stuck received
    mock.enqueue({ data: [] }) // 1b stuck processing
    mock.enqueue({ data: [] }) // 2a stale pending_ack
    mock.enqueue({ data: [] }) // 2b unacked rows
    mock.enqueue({
      data: [
        makeConversation({
          state: 'awaiting_company',
          context: {
            company_options: [{ id: 'company-1', name: 'Bolag A AB' }],
            pending_question: {
              type: 'company',
              inbox_item_id: null,
              asked_at: new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString(),
            },
          },
        }),
      ],
    }) // 3 question TTL
    mock.enqueue({ data: null }) // stamp only rows past the media window
    mock.enqueue({ count: 2 }) // rows still staged
    mock.enqueue({ data: null }) // conversation back to idle
    mock.enqueue({ data: [] }) // 4 pins

    await runSweep(mock.supabase as unknown as SupabaseClient)

    const expiryStamp = mock
      .findCalls('whatsapp_messages', 'update')
      .map((args) => args[0] as Record<string, unknown>)
      .find((patch) => patch.error_message === 'company_choice_expired')
    // The stamp is now bounded by how long Meta still serves the media.
    expect(expiryStamp).toBeTruthy()
    const stampFilters = mock.findCalls('whatsapp_messages', 'lt')
    expect(stampFilters.some((args) => args[0] === 'created_at')).toBe(true)

    const idleUpdate = mock
      .findCalls('whatsapp_conversations', 'update')
      .map((args) => args[0] as { state?: string; context?: Record<string, unknown> })
      .find((patch) => patch.state === 'idle')
    // company_options survive, so a late digit still maps to a company.
    expect(idleUpdate?.context?.company_options).toBeTruthy()
    expect(idleUpdate?.context?.pending_question).toBeUndefined()
  })
})

describe('stop copy', () => {
  it('does not claim the number is disconnected: stopp only pauses', () => {
    for (const locale of ['sv', 'en'] as const) {
      const body = botCopy(locale).m11Stop()
      expect(body).not.toMatch(/kopplas från|is disconnected/)
      expect(body).toMatch(/pausar|pausing/)
    }
  })
})
