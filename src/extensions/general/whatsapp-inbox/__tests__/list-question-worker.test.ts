import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/extensions/general/whatsapp-inbox/lib/graph-api', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/whatsapp-inbox/lib/graph-api')
  >('@/extensions/general/whatsapp-inbox/lib/graph-api')
  return {
    ...actual,
    sendText: vi.fn().mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null }),
    markReadWithTyping: vi.fn().mockResolvedValue(undefined),
    downloadMedia: vi.fn(),
  }
})

vi.mock('@/extensions/general/whatsapp-inbox/lib/interpret-answer', () => ({
  interpretChatAnswer: vi.fn(),
}))

vi.mock('@/lib/rate-limits/agent', () => ({
  checkAgentRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/rate-limits/inbox', () => ({
  checkInboxUploadRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue('event-1'),
}))

vi.mock('@/extensions/general/whatsapp-inbox/lib/list-question', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/whatsapp-inbox/lib/list-question')
  >('@/extensions/general/whatsapp-inbox/lib/list-question')
  return {
    ...actual,
    applyListQuestionText: vi.fn().mockResolvedValue(undefined),
    offerListQuestionAfterBurst: vi.fn().mockResolvedValue(undefined),
    offerListQuestionWhenDone: vi.fn().mockResolvedValue(undefined),
  }
})

import { sendText } from '@/extensions/general/whatsapp-inbox/lib/graph-api'
import { interpretChatAnswer } from '@/extensions/general/whatsapp-inbox/lib/interpret-answer'
import { finalizeBurst, processInboundMessage } from '@/extensions/general/whatsapp-inbox/lib/process-inbound'
import {
  applyListQuestionText,
  offerListQuestionAfterBurst,
  offerListQuestionWhenDone,
} from '@/extensions/general/whatsapp-inbox/lib/list-question'
import { TEMPLATE } from '@/extensions/general/whatsapp-inbox/lib/messages'

const sendTextMock = vi.mocked(sendText)
const interpretMock = vi.mocked(interpretChatAnswer)
const textMock = vi.mocked(applyListQuestionText)
const afterBurstMock = vi.mocked(offerListQuestionAfterBurst)
const whenDoneMock = vi.mocked(offerListQuestionWhenDone)

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const QUESTION_ID = 'e0000000-0000-4000-8000-000000000001'
const SENT = { ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null } as const

function makeTextRow(body: string, overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-t1',
    direction: 'inbound',
    wamid: 'wamid.T1',
    sender_phone_hash: 'hash-1',
    phone_link_id: 'link-1',
    conversation_id: 'conv-1',
    message_type: 'text',
    body_text: body,
    media_id: null,
    media_mime: null,
    media_sha256: null,
    media_filename: null,
    raw_payload: { from: '46701234567' },
    processing_status: 'received',
    attempts: 0,
    error_message: null,
    inbox_item_id: null,
    delivery_status: null,
    correlation_id: 'corr-1',
    acked_at: null,
    created_at: '2026-11-20T10:00:00Z',
    updated_at: '2026-11-20T10:00:00Z',
    ...overrides,
  }
}

const link = {
  id: 'link-1',
  user_id: 'user-1',
  phone_hash: 'hash-1',
  phone_enc: 'enc',
  phone_masked: '+46 70 *** ** 67',
  default_company_id: COMPANY,
  last_company_id: null,
  verified_at: '2026-11-01T09:00:00Z',
  revoked_at: null,
  muted_at: null,
}

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    phone_link_id: 'link-1',
    state: 'idle',
    context: {},
    company_id: COMPANY,
    service_window_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    debounce_until: new Date(Date.now() - 1000).toISOString(),
    pending_ack: false,
    last_inbound_at: null,
    last_outbound_at: null,
    created_at: '2026-11-01T09:00:00Z',
    updated_at: '2026-11-01T09:00:00Z',
    ...overrides,
  }
}

const listQuestionPending = (askedAt: string) => ({
  pending_question: { type: 'list_question', inbox_item_id: null, asked_at: askedAt, question_id: QUESTION_ID, company_id: COMPANY },
})

/** What the webhook puts on a text row it read as the reply to the list question. */
const REPLY_MARKER = `list_question_reply:${COMPANY}:${QUESTION_ID}`

beforeEach(() => {
  vi.clearAllMocks()
  sendTextMock.mockResolvedValue(SENT)
  interpretMock.mockResolvedValue({ ok: false })
})

describe('a written reply in the worker', () => {
  const askedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()

  it('goes to the list question the row is marked with, as written: no model call, no receipt is touched', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    const conversation = makeConversation({ context: listQuestionPending(askedAt) })
    enqueue({ data: makeTextRow('Kontoret på Storgatan', { error_message: REPLY_MARKER }) })
    enqueue({ data: { id: 'msg-t1' } }) // claim
    enqueue({ data: link })
    enqueue({ data: conversation })
    enqueue({ data: null }) // markStatus done

    const outcome = await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-t1')

    expect(outcome).toEqual({ kind: 'answer', conversationId: 'conv-1' })
    expect(textMock).toHaveBeenCalledTimes(1)
    const args = textMock.mock.calls[0][1]
    expect(args.text).toBe('Kontoret på Storgatan')
    expect(args.question).toEqual({ questionId: QUESTION_ID, companyId: COMPANY })
    expect(args.link.user_id).toBe('user-1')
    expect(args.to).toBe('46701234567')
    expect(args.announceEnded).toBe(true)
    expect(interpretMock).not.toHaveBeenCalled()
    expect(findCalls('invoice_inbox_items', 'update')).toEqual([])
    const done = findCalls('whatsapp_messages', 'update').at(-1)![0] as { processing_status: string }
    expect(done.processing_status).toBe('done')
  })

  it('leaves a written reply alone when another worker already took the message', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeTextRow('Kontoret på Storgatan', { error_message: REPLY_MARKER }) })
    enqueue({ data: null }) // claim: the row is no longer 'received'

    const outcome = await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-t1')

    expect(outcome).toEqual({ kind: 'none' })
    expect(textMock).not.toHaveBeenCalled()
    expect(findCalls('whatsapp_messages', 'update')).toHaveLength(1)
  })

  it('does not announce an ended question again when the message is processed a second time', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeTextRow('Kontoret', { attempts: 1, error_message: REPLY_MARKER }) })
    enqueue({ data: { id: 'msg-t1' } })
    enqueue({ data: link })
    enqueue({ data: makeConversation({ context: listQuestionPending(askedAt) }) })

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-t1')

    expect(textMock.mock.calls[0][1].announceEnded).toBe(false)
  })

  it('stays with the receipt when the quoted message belongs to one, and leaves the list question in flight', async () => {
    interpretMock.mockResolvedValue({
      ok: true,
      data: { is_denial: false, participants: null, purpose: null, event_date: null, note: 'taxi till kundmöte' },
    })
    const receiptAskedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()
    const conversation = makeConversation({
      context: {
        ...listQuestionPending(askedAt),
        recent_questions: [{ type: 'context', inbox_item_id: 'item-7', asked_at: receiptAskedAt, status: 'moved_to_app' }],
      },
    })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: makeTextRow('taxi till kundmöte 240 kr', {
        error_message: REPLY_MARKER,
        raw_payload: { from: '46701234567', context: { id: 'wamid.QUOTED' } },
      }),
    })
    enqueue({ data: { id: 'msg-t1' } })
    enqueue({ data: link })
    enqueue({ data: conversation })
    enqueue({ data: { inbox_item_id: 'item-7' } }) // the quoted message is a receipt's
    enqueue({ data: { inbox_item_id: 'item-7' } }) // quoted wamid -> item
    enqueue({ data: { channel_context: { channel: 'whatsapp', pending_question: { type: 'context', asked_at: receiptAskedAt, status: 'moved_to_app' } } } })
    enqueue({ data: null }) // item update
    enqueue({ data: null }) // conversation update
    enqueue({ data: { company_id: COMPANY, correlation_id: null } }) // history lookup
    enqueue({ data: conversation }) // askNext load (idle, no queue)
    enqueue({ data: null }) // markStatus

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-t1')

    expect(textMock).not.toHaveBeenCalled()
    expect(interpretMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m10ContextConfirm)
    expect(sendTextMock.mock.calls[0][1].inboxItemId).toBe('item-7')
    const conversationPatch = findCalls('whatsapp_conversations', 'update')[0][0] as {
      context: { pending_question?: { type: string } }
    }
    expect(conversationPatch.context.pending_question?.type).toBe('list_question')
  })

  it('goes to the list question when the quoted message is not a receipt\'s', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: makeTextRow('Kontoret', {
        error_message: REPLY_MARKER,
        raw_payload: { from: '46701234567', context: { id: 'wamid.QUESTION' } },
      }),
    })
    enqueue({ data: { id: 'msg-t1' } })
    enqueue({ data: link })
    enqueue({ data: makeConversation({ context: listQuestionPending(askedAt) }) })
    enqueue({ data: null }) // the quoted message has no receipt

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-t1')

    expect(textMock).toHaveBeenCalledTimes(1)
    expect(interpretMock).not.toHaveBeenCalled()
  })
})

describe('a written reply the webhook did not mark', () => {
  it('never goes to a list question, even with one in flight: the receipt path is as it was', async () => {
    const askedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeTextRow('vad händer?') })
    enqueue({ data: { id: 'msg-t1' } })
    enqueue({ data: link })
    enqueue({ data: makeConversation({ context: listQuestionPending(askedAt) }) })
    enqueue({ data: null }) // markStatus done

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-t1')

    expect(textMock).not.toHaveBeenCalled()
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m16Fallback)
  })

  it('a marked reply answers its question even when the conversation no longer holds it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeTextRow('Kontoret', { error_message: REPLY_MARKER }) })
    enqueue({ data: { id: 'msg-t1' } })
    enqueue({ data: link })
    enqueue({ data: makeConversation() })

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-t1')

    expect(textMock).toHaveBeenCalledTimes(1)
    expect(textMock.mock.calls[0][1].question).toEqual({ questionId: QUESTION_ID, companyId: COMPANY })
    expect(interpretMock).not.toHaveBeenCalled()
  })
})

describe('the moments after a burst', () => {
  const doneRow = {
    ...makeTextRow('', { id: 'msg-1', wamid: 'wamid.IN1', message_type: 'image', processing_status: 'done', attempts: 1 }),
    media_id: 'media-1',
    media_mime: 'image/jpeg',
    media_filename: 'kvitto-1.jpg',
    inbox_item_id: 'item-1',
  }
  const item = (extracted: Record<string, unknown>) => ({
    id: 'item-1',
    company_id: COMPANY,
    extracted_data: extracted,
    channel_context: { channel: 'whatsapp' },
    document_id: 'doc-1',
  })
  const receipt = (merchantCategory: string) => ({
    documentKind: 'receipt',
    merchantCategory,
    legibility: 'good',
    supplier: { name: 'Butiken' },
    invoice: { invoiceDate: '2026-11-19' },
    totals: { total: 234 },
    lineItems: [],
  })

  function enqueueBurst(enqueue: ReturnType<typeof createQueuedMockSupabase>['enqueue'], extracted: Record<string, unknown>) {
    enqueue({ data: [{ id: 'conv-1' }] }) // claim won
    enqueue({ data: makeConversation({ pending_ack: true }) })
    enqueue({ data: [doneRow] })
    enqueue({ data: [item(extracted)] })
    enqueue({ data: [{ id: 'doc-1', file_size_bytes: 500_000 }] })
  }

  it('offers a list question after the ack of a burst that asked nothing of its own', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueBurst(enqueue, receipt('grocery'))

    await finalizeBurst(supabase as unknown as SupabaseClient, 'conv-1')

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m4Ack)
    expect(afterBurstMock).toHaveBeenCalledTimes(1)
    expect(afterBurstMock).toHaveBeenCalledWith(supabase, 'conv-1', { admitted: 0, companyIds: [COMPANY] })
    expect(afterBurstMock.mock.invocationCallOrder[0]).toBeGreaterThan(sendTextMock.mock.invocationCallOrder[0])
  })

  it('tells how many questions of its own the burst admitted, and asks its own question as before', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueBurst(enqueue, receipt('restaurant'))

    await finalizeBurst(supabase as unknown as SupabaseClient, 'conv-1')

    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m7Representation)
    const patch = findCalls('whatsapp_conversations', 'update')[1][0] as { state: string; context: { pending_question: { type: string } } }
    expect(patch.state).toBe('awaiting_representation')
    expect(patch.context.pending_question.type).toBe('representation')
    expect(afterBurstMock).toHaveBeenCalledWith(supabase, 'conv-1', { admitted: 1, companyIds: [COMPANY] })
  })

  it('a receipt question takes the place of a list question in flight, as on any idle conversation', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'conv-1' }] })
    enqueue({ data: makeConversation({ pending_ack: true, context: listQuestionPending(new Date().toISOString()) }) })
    enqueue({ data: [doneRow] })
    enqueue({ data: [item(receipt('restaurant'))] })
    enqueue({ data: [{ id: 'doc-1', file_size_bytes: 500_000 }] })

    await finalizeBurst(supabase as unknown as SupabaseClient, 'conv-1')

    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m7Representation)
    const patch = findCalls('whatsapp_conversations', 'update')[1][0] as {
      state: string
      context: { pending_question: { type: string; inbox_item_id: string | null } }
    }
    expect(patch.state).toBe('awaiting_representation')
    expect(patch.context.pending_question).toMatchObject({ type: 'representation', inbox_item_id: 'item-1' })
  })

  it('offers nothing when the ack could not be sent', async () => {
    sendTextMock.mockResolvedValue({ ok: false, wamid: null, errorDetail: 'Send failed (HTTP 500)', failure: 'http_rejected' })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueueBurst(enqueue, receipt('grocery'))

    await finalizeBurst(supabase as unknown as SupabaseClient, 'conv-1')

    expect(afterBurstMock).not.toHaveBeenCalled()
  })

  it('offers nothing when the service window closed before the ack', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'conv-1' }] })
    enqueue({ data: makeConversation({ pending_ack: true, service_window_expires_at: new Date(Date.now() - 1000).toISOString() }) })
    enqueue({ data: [doneRow] })

    await finalizeBurst(supabase as unknown as SupabaseClient, 'conv-1')

    expect(sendTextMock).not.toHaveBeenCalled()
    expect(afterBurstMock).not.toHaveBeenCalled()
  })

  it('offers a list question once the last receipt question is answered', async () => {
    const askedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const awaiting = makeConversation({
      state: 'awaiting_representation',
      context: {
        pending_question: { type: 'representation', inbox_item_id: 'item-9', asked_at: askedAt },
        recent_questions: [{ type: 'representation', inbox_item_id: 'item-9', asked_at: askedAt, status: 'open' }],
      },
    })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeTextRow('nej') })
    enqueue({ data: { id: 'msg-t1' } }) // claim
    enqueue({ data: link })
    enqueue({ data: awaiting })
    enqueue({ data: { channel_context: { channel: 'whatsapp', pending_question: { type: 'representation', asked_at: askedAt, status: 'open' } } } })
    enqueue({ data: null }) // item context update
    enqueue({ data: null }) // conversation update
    enqueue({ data: { company_id: COMPANY, correlation_id: null } }) // history lookup
    enqueue({ data: makeConversation() }) // askNext load: idle, nothing queued
    enqueue({ data: null }) // markStatus done

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-t1')

    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m8RepDenied)
    expect(whenDoneMock).toHaveBeenCalledTimes(1)
    expect(whenDoneMock).toHaveBeenCalledWith(supabase, 'conv-1')
    expect(whenDoneMock.mock.invocationCallOrder[0]).toBeGreaterThan(sendTextMock.mock.invocationCallOrder[0])
  })

  it('offers nothing while a receipt answer leaves its question open', async () => {
    interpretMock.mockResolvedValue({
      ok: true,
      data: { is_denial: false, participants: [{ name: 'Erik Exempel', company: 'Exempel Media' }], purpose: null, event_date: null, note: null },
    })
    const askedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString()
    const awaiting = makeConversation({
      state: 'awaiting_representation',
      context: {
        pending_question: { type: 'representation', inbox_item_id: 'item-9', asked_at: askedAt },
        recent_questions: [{ type: 'representation', inbox_item_id: 'item-9', asked_at: askedAt, status: 'open' }],
      },
    })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeTextRow('Erik Exempel från Exempel Media') })
    enqueue({ data: { id: 'msg-t1' } })
    enqueue({ data: link })
    enqueue({ data: awaiting })
    enqueue({ data: { channel_context: { channel: 'whatsapp', pending_question: { type: 'representation', asked_at: askedAt, status: 'open' } } } })

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-t1')

    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m8RepNeedPurpose)
    expect(whenDoneMock).not.toHaveBeenCalled()
  })
})
