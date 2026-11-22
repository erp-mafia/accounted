import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'crypto'
import { createQueuedMockSupabase, testRoutes } from '@/tests/helpers'

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
  }
})

vi.mock('@/extensions/general/whatsapp-inbox/lib/process-inbound', () => ({
  kickInboundProcessing: vi.fn(),
}))

vi.mock('@/extensions/general/whatsapp-inbox/lib/company-question', () => ({
  applyCompanyChoice: vi.fn(),
}))

vi.mock('@/extensions/general/whatsapp-inbox/lib/list-question', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/whatsapp-inbox/lib/list-question')
  >('@/extensions/general/whatsapp-inbox/lib/list-question')
  return {
    ...actual,
    applyListQuestionTap: vi.fn().mockResolvedValue(undefined),
    clearEndedListQuestion: vi.fn().mockResolvedValue(undefined),
    offerFiledListQuestion: vi.fn().mockResolvedValue(undefined),
    offerListQuestionOnText: vi.fn(),
  }
})

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { whatsappInboxExtension } from '@/extensions/general/whatsapp-inbox'
import type { ExtensionContext } from '@/lib/extensions/types'
import { sendText } from '@/extensions/general/whatsapp-inbox/lib/graph-api'
import { applyCompanyChoice } from '@/extensions/general/whatsapp-inbox/lib/company-question'
import { kickInboundProcessing } from '@/extensions/general/whatsapp-inbox/lib/process-inbound'
import {
  applyListQuestionTap,
  clearEndedListQuestion,
  offerFiledListQuestion,
  offerListQuestionOnText,
} from '@/extensions/general/whatsapp-inbox/lib/list-question'
import { QUESTION_TTL_MS } from '@/extensions/general/whatsapp-inbox/lib/conversation'
import { TEMPLATE } from '@/extensions/general/whatsapp-inbox/lib/messages'

const SECRET = 'meta-app-secret'
const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const QUESTION_ID = 'e0000000-0000-4000-8000-000000000001'
const PHONE = '46701234567'

const createClientMock = vi.mocked(createClient)
const sendTextMock = vi.mocked(sendText)
const kickMock = vi.mocked(kickInboundProcessing)
const tapMock = vi.mocked(applyListQuestionTap)
const clearMock = vi.mocked(clearEndedListQuestion)
const filedMock = vi.mocked(offerFiledListQuestion)
const onTextMock = vi.mocked(offerListQuestionOnText)
const companyChoiceMock = vi.mocked(applyCompanyChoice)

const route = testRoutes(whatsappInboxExtension).find((r) => r.method === 'POST' && r.path === '/webhook')!

function signedRequest(message: Record<string, unknown>): Request {
  const raw = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'waba-1', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', messages: [message] } }] }],
  })
  const signature = 'sha256=' + crypto.createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex')
  return new Request('http://localhost:3000/api/extensions/ext/whatsapp-inbox/webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature },
    body: raw,
  })
}

const tapMessage = (buttonId: string) => ({
  from: PHONE,
  id: 'wamid.TAP1',
  timestamp: '1754000000',
  type: 'interactive',
  interactive: { type: 'button_reply', button_reply: { id: buttonId, title: 'Kontoret' } },
})

const textMessage = (body: string) => ({ from: PHONE, id: 'wamid.TXT1', timestamp: '1754000000', type: 'text', text: { body } })

function makeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    user_id: 'user-1',
    phone_hash: 'hash-x',
    phone_enc: 'enc',
    phone_masked: '+46 70 *** ** 67',
    default_company_id: COMPANY,
    revoked_at: null,
    muted_at: null,
    ...overrides,
  }
}

/** An idle conversation with a list question sent `ageMs` ago. */
function conversationWithListQuestion(ageMs = 5 * 60 * 1000, overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    phone_link_id: 'link-1',
    state: 'idle',
    context: {
      pending_question: {
        type: 'list_question',
        inbox_item_id: null,
        asked_at: new Date(Date.now() - ageMs).toISOString(),
        question_id: QUESTION_ID,
        company_id: COMPANY,
      },
    },
    company_id: null,
    updated_at: '2026-11-20T09:00:00.000Z',
    ...overrides,
  }
}

describe('POST /webhook: replies to a list question', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    sendTextMock.mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null })
    onTextMock.mockResolvedValue('not_sent')
    process.env.COMPANY_QUESTIONS_COMPANY_IDS = COMPANY
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

  it('reads a tap on a list question button as an answer to that question, and persists the tap after it is applied', async () => {
    const mock = mockSupabase()
    const conversation = conversationWithListQuestion()
    mock.enqueue({ data: makeLink() }) // active link lookup
    mock.enqueue({ data: conversation }) // conversation lookup
    mock.enqueue({ data: null }) // wamid dedupe pre-check
    mock.enqueue({ data: null }) // link last_message_at
    mock.enqueue({ data: null }) // conversation window update
    mock.enqueue({ data: null }) // terminal row insert

    const response = await route.handler(signedRequest(tapMessage(`cq:${COMPANY}:${QUESTION_ID}:o:office`)))

    expect(response.status).toBe(200)
    expect(tapMock).toHaveBeenCalledTimes(1)
    const args = tapMock.mock.calls[0][1]
    expect(args.tap).toEqual({ companyId: COMPANY, questionId: QUESTION_ID, kind: 'option', optionId: 'office' })
    expect(args.link.id).toBe('link-1')
    expect(args.conversation?.id).toBe('conv-1')
    expect(args.to).toBe(PHONE)
    expect(args.replyBase).toMatchObject({ phoneLinkId: 'link-1', conversationId: 'conv-1' })

    const [row] = mock.findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
    expect(row.processing_status).toBe('done')
    expect(row.message_type).toBe('interactive')
    // The stored payload carries the tapped id and never the sender's number.
    expect(JSON.stringify(row.raw_payload)).toContain(QUESTION_ID)
    expect(JSON.stringify(row)).not.toContain(PHONE)
    expect(kickMock).toHaveBeenCalledWith([])
  })

  it('reads "Vet inte" from its button', async () => {
    const mock = mockSupabase()
    mock.enqueue({ data: makeLink() })
    mock.enqueue({ data: conversationWithListQuestion() })

    await route.handler(signedRequest(tapMessage(`cq:${COMPANY}:${QUESTION_ID}:k`)))

    expect(tapMock.mock.calls[0][1].tap).toEqual({ companyId: COMPANY, questionId: QUESTION_ID, kind: 'dont_know' })
  })

  it('reads the tap as the question\'s even while the company choice is open, and after the question left the conversation', async () => {
    const mock = mockSupabase()
    mock.enqueue({ data: makeLink() })
    mock.enqueue({
      data: {
        id: 'conv-1',
        phone_link_id: 'link-1',
        state: 'awaiting_company',
        context: {
          company_options: [{ id: COMPANY, name: 'A AB' }],
          pending_question: { type: 'company', inbox_item_id: null, asked_at: new Date().toISOString() },
        },
      },
    })

    await route.handler(signedRequest(tapMessage(`cq:${COMPANY}:${QUESTION_ID}:o:office`)))

    expect(tapMock).toHaveBeenCalledTimes(1)
    expect(companyChoiceMock).not.toHaveBeenCalled()
  })

  it('still reads a bare company id as the company choice', async () => {
    companyChoiceMock.mockResolvedValue({ ok: false, reason: 'already_applied' })
    const mock = mockSupabase()
    mock.enqueue({ data: makeLink() })
    mock.enqueue({
      data: {
        id: 'conv-1',
        phone_link_id: 'link-1',
        state: 'awaiting_company',
        context: { company_options: [{ id: COMPANY, name: 'A AB' }] },
      },
    })

    await route.handler(signedRequest(tapMessage(COMPANY)))

    expect(companyChoiceMock).toHaveBeenCalledTimes(1)
    expect(tapMock).not.toHaveBeenCalled()
  })

  it('does not apply a tap that was already persisted', async () => {
    const mock = mockSupabase()
    mock.enqueue({ data: makeLink() })
    mock.enqueue({ data: conversationWithListQuestion() })
    mock.enqueue({ data: { id: 'msg-row-1' } }) // wamid dedupe pre-check: seen before

    await route.handler(signedRequest(tapMessage(`cq:${COMPANY}:${QUESTION_ID}:o:office`)))

    expect(tapMock).not.toHaveBeenCalled()
    expect(mock.findCall('whatsapp_messages', 'insert')).toBeUndefined()
  })

  it('does not read a tap from a paused link', async () => {
    const mock = mockSupabase()
    mock.enqueue({ data: makeLink({ muted_at: '2026-11-19T00:00:00.000Z' }) })
    mock.enqueue({ data: conversationWithListQuestion() })
    mock.enqueue({ data: { id: 'msg-row-1' } })

    await route.handler(signedRequest(tapMessage(`cq:${COMPANY}:${QUESTION_ID}:o:office`)))

    expect(tapMock).not.toHaveBeenCalled()
    const [row] = mock.findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
    expect(row.processing_status).toBe('skipped')
  })

  it('hands a written reply to the worker, marked with the list question in flight', async () => {
    const mock = mockSupabase()
    mock.enqueue({ data: makeLink() })
    mock.enqueue({ data: conversationWithListQuestion() })
    mock.enqueue({ data: { id: 'msg-row-1' } }) // message insert

    await route.handler(signedRequest(textMessage('Kontoret på Storgatan')))

    const [row] = mock.findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
    expect(row.processing_status).toBe('received')
    expect(row.body_text).toBe('Kontoret på Storgatan')
    expect(row.error_message).toBe(`list_question_reply:${COMPANY}:${QUESTION_ID}`)
    expect(kickMock).toHaveBeenCalledWith(['msg-row-1'])
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('does not take a written reply as the answer once the 48 hours have passed', async () => {
    const mock = mockSupabase()
    mock.enqueue({ data: makeLink() })
    mock.enqueue({ data: conversationWithListQuestion(QUESTION_TTL_MS + 60 * 1000) })
    mock.enqueue({ data: { id: 'msg-row-1' } }) // message insert

    await route.handler(signedRequest(textMessage('Kontoret på Storgatan')))

    const [row] = mock.findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
    expect(row.processing_status).toBe('done')
    expect(row.error_message).toBeNull()
    expect(kickMock).toHaveBeenCalledWith([])
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m16Fallback)
  })

  it('does not take a written reply as the answer once the list is switched off for the company', async () => {
    process.env.COMPANY_QUESTIONS_COMPANY_IDS = ''
    const mock = mockSupabase()
    mock.enqueue({ data: makeLink() })
    mock.enqueue({ data: conversationWithListQuestion() })
    mock.enqueue({ data: { id: 'msg-row-1' } }) // message insert

    await route.handler(signedRequest(textMessage('Kontoret på Storgatan')))

    const [row] = mock.findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
    expect(row.processing_status).toBe('done')
    expect(row.error_message).toBeNull()
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m16Fallback)
  })

  it('keeps the keywords: "stopp" pauses the link even while a list question is in flight', async () => {
    const mock = mockSupabase()
    mock.enqueue({ data: makeLink() })
    mock.enqueue({ data: conversationWithListQuestion() })

    await route.handler(signedRequest(textMessage('stopp')))

    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m11Stop)
    expect(kickMock).toHaveBeenCalledWith([])
  })
})

describe('POST /webhook: a text that would get the fallback reply', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    sendTextMock.mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null })
    onTextMock.mockResolvedValue('not_sent')
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

  const idleConversation = (overrides: Record<string, unknown> = {}) => ({
    id: 'conv-1',
    phone_link_id: 'link-1',
    state: 'idle',
    context: {},
    company_id: null,
    updated_at: '2026-11-20T09:00:00.000Z',
    ...overrides,
  })

  /** The reads and writes of an idle text up to the reply: link, conversation, the inbound row. */
  function enqueueIdleText(mock: ReturnType<typeof createQueuedMockSupabase>, link: Record<string, unknown> = makeLink()) {
    mock.enqueue({ data: link }) // active link lookup
    mock.enqueue({ data: idleConversation() }) // conversation lookup
    mock.enqueue({ data: { id: 'msg-row-1' } }) // message insert
  }

  it('sends a list question in place of the fallback, after the text is persisted and the window is open', async () => {
    const mock = mockSupabase()
    enqueueIdleText(mock)
    let rowsBeforeOffer = 0
    let windowWritesBeforeOffer = 0
    onTextMock.mockImplementation(async () => {
      rowsBeforeOffer = mock.findCalls('whatsapp_messages', 'insert').length
      windowWritesBeforeOffer = mock.findCalls('whatsapp_conversations', 'update').length
      return 'sent'
    })

    const response = await route.handler(signedRequest(textMessage('Hey')))

    expect(response.status).toBe(200)
    expect(onTextMock).toHaveBeenCalledTimes(1)
    // The offer reads the conversation and its link itself, as they stand now.
    expect(onTextMock.mock.calls[0].slice(1)).toEqual(['conv-1'])
    expect(rowsBeforeOffer).toBe(1)
    expect(windowWritesBeforeOffer).toBe(1)
    const windowWrite = mock.findCalls('whatsapp_conversations', 'update')[0][0] as { service_window_expires_at: string }
    expect(new Date(windowWrite.service_window_expires_at).getTime()).toBeGreaterThan(Date.now())
    // No fallback, and the text itself is no answer: handled, unmarked, not handed to the worker.
    expect(sendTextMock).not.toHaveBeenCalled()
    const [row] = mock.findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
    expect(row.processing_status).toBe('done')
    expect(row.error_message).toBeNull()
    expect(row.body_text).toBe('Hey')
    expect(kickMock).toHaveBeenCalledWith([])
  })

  it('sends the fallback as before when no question was there to send', async () => {
    const mock = mockSupabase()
    enqueueIdleText(mock)

    await route.handler(signedRequest(textMessage('Hey')))

    expect(onTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1]).toMatchObject({ to: PHONE, template: TEMPLATE.m16Fallback, conversationId: 'conv-1' })
    const [row] = mock.findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
    expect(row.processing_status).toBe('done')
  })

  it('sends nothing more when the question could not be sent', async () => {
    onTextMock.mockResolvedValue('send_failed')
    const mock = mockSupabase()
    enqueueIdleText(mock)

    await route.handler(signedRequest(textMessage('Hey')))

    expect(onTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('does not look for a question a second time when the same text is delivered again', async () => {
    const mock = mockSupabase()
    mock.enqueue({ data: makeLink() })
    mock.enqueue({ data: idleConversation() })
    mock.enqueue({ error: { code: '23505', message: 'duplicate key value' } }) // message insert: seen before

    await route.handler(signedRequest(textMessage('Hey')))

    expect(onTextMock).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('does not read a text from a paused link, as before: no question, no reply', async () => {
    const mock = mockSupabase()
    enqueueIdleText(mock, makeLink({ muted_at: '2026-11-19T00:00:00.000Z' }))

    await route.handler(signedRequest(textMessage('Hey')))

    expect(onTextMock).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
    const [row] = mock.findCall('whatsapp_messages', 'insert') as [Record<string, unknown>]
    expect(row.processing_status).toBe('skipped')
    expect(row.body_text).toBeNull()
  })

  it.each([
    ['stopp', TEMPLATE.m11Stop],
    ['start', TEMPLATE.m12Start],
    ['hjälp', TEMPLATE.m13Help],
    ['byt', TEMPLATE.m6BytPin],
  ])('answers the keyword "%s" as before, without looking for a question', async (keyword, template) => {
    const mock = mockSupabase()
    mock.enqueue({ data: makeLink() })
    mock.enqueue({ data: idleConversation() })

    await route.handler(signedRequest(textMessage(keyword)))

    expect(onTextMock).not.toHaveBeenCalled()
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(template)
  })

  it('hands a text to the worker as before while a receipt question is asked', async () => {
    const mock = mockSupabase()
    mock.enqueue({ data: makeLink() })
    mock.enqueue({
      data: idleConversation({
        state: 'awaiting_context',
        context: { pending_question: { type: 'context', inbox_item_id: 'item-1', asked_at: new Date().toISOString() } },
      }),
    })
    mock.enqueue({ data: { id: 'msg-row-1' } })

    await route.handler(signedRequest(textMessage('taxi till kundmöte')))

    expect(onTextMock).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
    expect(kickMock).toHaveBeenCalledWith(['msg-row-1'])
  })

  it('repeats the company choice as before while it is asked', async () => {
    const mock = mockSupabase()
    mock.enqueue({ data: makeLink() })
    mock.enqueue({
      data: idleConversation({
        state: 'awaiting_company',
        context: { company_options: [{ id: COMPANY, name: 'A AB' }, { id: 'c0000000-0000-4000-8000-000000000002', name: 'B AB' }] },
      }),
    })
    mock.enqueue({ data: { id: 'msg-row-1' } })

    await route.handler(signedRequest(textMessage('A AB')))

    expect(onTextMock).not.toHaveBeenCalled()
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m6CompanyRetry)
  })

  it('takes a file as before, without looking for a question', async () => {
    const mock = mockSupabase()
    mock.enqueue({ data: makeLink() })
    mock.enqueue({ data: idleConversation() })
    mock.enqueue({ data: { id: 'msg-row-1' } })

    await route.handler(
      signedRequest({
        from: PHONE,
        id: 'wamid.IMG1',
        timestamp: '1754000000',
        type: 'image',
        image: { id: 'media-1', mime_type: 'image/jpeg', sha256: 'abc' },
      }),
    )

    expect(onTextMock).not.toHaveBeenCalled()
    expect(kickMock).toHaveBeenCalledWith(['msg-row-1'])
  })

  it('greets a sender who is not linked as before, without looking for a question', async () => {
    const mock = mockSupabase()
    mock.enqueue({ data: null }) // no active link
    mock.enqueue({ data: { ok: true } }) // sender quota
    mock.enqueue({ data: [] }) // greeting throttle window
    mock.enqueue({ data: null }) // trace row

    await route.handler(signedRequest(textMessage('Hey')))

    expect(onTextMock).not.toHaveBeenCalled()
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m1Unlinked)
  })
})

describe('the question list event handlers', () => {
  const handlerFor = (eventType: string) => {
    const registration = (whatsappInboxExtension.eventHandlers ?? []).find((entry) => entry.eventType === eventType)
    if (!registration) throw new Error(`no handler for ${eventType}`)
    return registration.handler
  }
  const client = { from: vi.fn() } as unknown as SupabaseClient
  const ctx = { supabase: client } as unknown as ExtensionContext

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('subscribes to a question filed, answered and closed, and to nothing else', () => {
    expect((whatsappInboxExtension.eventHandlers ?? []).map((entry) => entry.eventType)).toEqual([
      'company_question.filed',
      'company_question.answered',
      'company_question.closed',
    ])
  })

  it('offers a filed question to the company\'s people', async () => {
    await handlerFor('company_question.filed')({ questionId: QUESTION_ID, companyId: COMPANY, userId: 'user-1' }, ctx)
    expect(filedMock).toHaveBeenCalledWith(client, { companyId: COMPANY, questionId: QUESTION_ID })
  })

  it.each(['company_question.answered', 'company_question.closed'])('clears the question from its conversations on %s', async (eventType) => {
    await handlerFor(eventType)({ questionId: QUESTION_ID, companyId: COMPANY, userId: 'user-1', via: 'app', reason: 'dont_know' }, ctx)
    expect(clearMock).toHaveBeenCalledWith(client, QUESTION_ID)
    expect(filedMock).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
  })
})
