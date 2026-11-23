/**
 * A text from a linked person that nothing else takes, and the answer that
 * follows it, through the real webhook, the real list-question module and
 * the real answer path, on a database that answers from rows. Only the Graph
 * API, the deferred kick and the processing history are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'crypto'
import { createRowsMockSupabase, testRoutes } from '@/tests/helpers'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/extensions/general/whatsapp-inbox/lib/graph-api', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/whatsapp-inbox/lib/graph-api')
  >('@/extensions/general/whatsapp-inbox/lib/graph-api')
  return {
    ...actual,
    sendText: vi.fn(),
    sendReplyButtons: vi.fn(),
    sendReaction: vi.fn().mockResolvedValue(undefined),
    markReadWithTyping: vi.fn().mockResolvedValue(undefined),
    downloadMedia: vi.fn(),
  }
})

vi.mock('@/extensions/general/whatsapp-inbox/lib/process-inbound', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/whatsapp-inbox/lib/process-inbound')
  >('@/extensions/general/whatsapp-inbox/lib/process-inbound')
  return { ...actual, kickInboundProcessing: vi.fn() }
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

import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { EventPayload } from '@/lib/events/types'
import type { ExtensionContext } from '@/lib/extensions/types'
import { whatsappInboxExtension } from '@/extensions/general/whatsapp-inbox'
import { sendReplyButtons, sendText } from '@/extensions/general/whatsapp-inbox/lib/graph-api'
import { interpretChatAnswer } from '@/extensions/general/whatsapp-inbox/lib/interpret-answer'
import { kickInboundProcessing, processInboundMessage } from '@/extensions/general/whatsapp-inbox/lib/process-inbound'
import { MAX_QUESTIONS_PER_DAY, type ConversationContext } from '@/extensions/general/whatsapp-inbox/lib/conversation'
import { TEMPLATE } from '@/extensions/general/whatsapp-inbox/lib/messages'
import { encryptPhone, hashPhone } from '@/extensions/general/whatsapp-inbox/lib/phone-crypto'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { todayIsoStockholm } from '@/lib/dates/iso'

const createClientMock = vi.mocked(createClient)
const sendTextMock = vi.mocked(sendText)
const sendButtonsMock = vi.mocked(sendReplyButtons)
const kickMock = vi.mocked(kickInboundProcessing)
const interpretMock = vi.mocked(interpretChatAnswer)
const historyMock = vi.mocked(appendProcessingHistory)

const SECRET = 'meta-app-secret'
const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const OTHER_COMPANY = 'c0000000-0000-4000-8000-000000000002'
const THIRD_COMPANY = 'c0000000-0000-4000-8000-000000000003'
const COMPANY_NAME = 'Bolag A AB'
const OTHER_COMPANY_NAME = 'Bolag B AB'
const THIRD_COMPANY_NAME = 'Bolag C AB'
const USER = 'a0000000-0000-4000-8000-000000000001'
const OLDER_QUESTION = 'e0000000-0000-4000-8000-000000000001'
const NEWER_QUESTION = 'e0000000-0000-4000-8000-000000000002'
const PHONE = '46701234567'
const HOUR = 60 * 60 * 1000

const SENT = { ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null } as const
const SEND_FAILED = { ok: false, wamid: null, errorDetail: 'Send failed (HTTP 500)', failure: 'http_rejected' } as const

const OLDER_TEXT = 'Gäller hyran på 12 000 kr kontoret eller lagret?'
const OLDER_WHY = 'Svaret avgör vilket konto hyran bokförs på.'

type Row = Record<string, unknown>

interface Write {
  table: string
  method: string
  row: unknown
}

const route = testRoutes(whatsappInboxExtension).find((r) => r.method === 'POST' && r.path === '/webhook')!

function signed(message: Row): Request {
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

function signedText(body: string, wamid = 'wamid.TXT1'): Request {
  return signed({ from: PHONE, id: wamid, timestamp: '1754000000', type: 'text', text: { body } })
}

function signedTap(buttonId: string, wamid = 'wamid.TAP1'): Request {
  return signed({
    from: PHONE,
    id: wamid,
    timestamp: '1754000000',
    type: 'interactive',
    interactive: { type: 'button_reply', button_reply: { id: buttonId, title: 'Kontoret' } },
  })
}

function questionRow(id: string, createdAt: string, overrides: Row = {}): Row {
  return {
    id,
    company_id: COMPANY,
    status: 'open',
    close_reason: null,
    question: OLDER_TEXT,
    why: OLDER_WHY,
    options: [
      { id: 'office', label: 'Kontoret' },
      { id: 'storage', label: 'Lagret' },
    ],
    evidence: [],
    actor_label: null,
    client: null,
    answer_option: null,
    answer_text: null,
    answered_at: null,
    answered_via: null,
    fact_id: null,
    created_at: createdAt,
    ...overrides,
  }
}

/** A membership row as the reads see it: the company's name embedded, and its archive date as the filter column. */
function member(companyId: string, name: string, opts: { role?: string; archived?: boolean } = {}): Row {
  return {
    user_id: USER,
    company_id: companyId,
    role: opts.role ?? 'owner',
    companies: { name },
    ...(opts.archived ? { 'companies.archived_at': '2026-01-01T00:00:00.000Z' } : {}),
  }
}

/** Two open questions, the newer one first in the table. */
const twoOpenQuestions = (): Row[] => [
  questionRow(NEWER_QUESTION, '2026-11-20T08:00:00.000Z', { question: 'Är kortköpet på 499 kr privat?', why: null, options: [] }),
  questionRow(OLDER_QUESTION, '2026-11-18T08:00:00.000Z'),
]

interface Seed {
  link?: Row
  conversation?: Row
  questions?: Row[]
  memberships?: Row[]
}

/**
 * A linked owner of COMPANY with an idle conversation whose service window
 * closed an hour ago, and the webhook's client answering from these rows. The
 * conversation row takes its own updates, so a read after the text sees the
 * window the text opened; an update to a question lands on the question the
 * conversation holds at that moment, so an answered question is no longer
 * open to the read that follows.
 */
function world(seed: Seed = {}) {
  const conversation: Row = {
    id: 'conv-1',
    phone_link_id: 'link-1',
    state: 'idle',
    context: {},
    company_id: null,
    service_window_expires_at: new Date(Date.now() - HOUR).toISOString(),
    debounce_until: null,
    pending_ack: false,
    updated_at: '2026-11-20T09:00:00.000Z',
    ...seed.conversation,
  }
  const questions: Row[] = seed.questions ?? twoOpenQuestions()
  const apply = (row: Row | undefined, patch: Row): void => {
    if (!row) return
    for (const [column, value] of Object.entries(patch)) {
      if (value !== undefined) row[column] = value
    }
  }
  const writes: Write[] = []
  const record = writes.push.bind(writes)
  writes.push = (...items: Write[]): number => {
    for (const item of items) {
      if (item.method !== 'update') continue
      if (item.table === 'whatsapp_conversations') apply(conversation, item.row as Row)
      if (item.table === 'company_questions') {
        const inSlot = (conversation.context as ConversationContext).pending_question?.question_id
        apply(questions.find((question) => question.id === inSlot), item.row as Row)
      }
    }
    return record(...items)
  }
  const messages: Row[] = []
  const tables: Record<string, Row[]> = {
    whatsapp_phone_links: [
      {
        id: 'link-1',
        user_id: USER,
        phone_hash: hashPhone(PHONE),
        phone_enc: encryptPhone(PHONE),
        phone_masked: '+46 70 *** ** 67',
        default_company_id: COMPANY,
        last_company_id: null,
        revoked_at: null,
        muted_at: null,
        ...seed.link,
      },
    ],
    whatsapp_conversations: [conversation],
    whatsapp_messages: messages,
    company_members: seed.memberships ?? [member(COMPANY, COMPANY_NAME)],
    company_questions: questions,
    agent_memory: [],
  }
  const mock = createRowsMockSupabase(tables, writes)
  createClientMock.mockReturnValue(mock.supabase as never)
  return { writes, messages, conversation, supabase: mock.supabase as unknown as SupabaseClient }
}

/** The conversation writes that carry a context, in order. */
function contextWrites(writes: Write[]): ConversationContext[] {
  return writes
    .filter((write) => write.table === 'whatsapp_conversations')
    .map((write) => (write.row as { context?: ConversationContext }).context)
    .filter((context): context is ConversationContext => context !== undefined)
}

const writesTo = (writes: Write[], table: string): Row[] =>
  writes.filter((write) => write.table === table).map((write) => write.row as Row)

describe('a text from a linked person that nothing else takes', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    sendTextMock.mockResolvedValue(SENT)
    sendButtonsMock.mockResolvedValue(SENT)
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

  it('gets the oldest open question with its buttons, and no fallback: the text itself opens the window', async () => {
    const { writes, messages } = world()

    const response = await route.handler(signedText('Hey'))

    expect(response.status).toBe(200)
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    const message = sendButtonsMock.mock.calls[0][1]
    expect(message.to).toBe(PHONE)
    expect(message.template).toBe(TEMPLATE.m23ListQuestion)
    expect(message.body).toBe(`${OLDER_TEXT}\n${OLDER_WHY}\n\nDu kan också svara med egna ord.`)
    expect(message.buttons).toEqual([
      { id: `cq:${COMPANY}:${OLDER_QUESTION}:o:office`, title: 'Kontoret' },
      { id: `cq:${COMPANY}:${OLDER_QUESTION}:o:storage`, title: 'Lagret' },
      { id: `cq:${COMPANY}:${OLDER_QUESTION}:k`, title: 'Vet inte' },
    ])
    expect(sendTextMock).not.toHaveBeenCalled()

    // The conversation holds the question, on its own daily counter.
    const [held] = contextWrites(writes)
    expect(held.pending_question).toMatchObject({ type: 'list_question', question_id: OLDER_QUESTION, company_id: COMPANY })
    expect(held.list_question_budget).toEqual({ day_key: todayIsoStockholm(), count: 1 })
    expect(held.budget).toBeUndefined()
    expect(historyMock.mock.calls[0][0]).toMatchObject({ aggregateId: OLDER_QUESTION, eventType: 'ChannelQuestionAsked' })

    // The text itself is handled and answers nothing.
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ body_text: 'Hey', processing_status: 'done', error_message: null })
    expect(writesTo(writes, 'company_questions')).toEqual([])
    expect(writesTo(writes, 'agent_memory')).toEqual([])
    expect(kickMock).toHaveBeenCalledWith([])
  })

  const fallbackAsBefore: Array<[string, () => Seed]> = [
    ['no question is open', () => ({ questions: [] })],
    ['every question is answered or closed', () => ({
      questions: [
        questionRow(OLDER_QUESTION, '2026-11-18T08:00:00.000Z', { status: 'answered', answered_at: '2026-11-19T08:00:00.000Z' }),
        questionRow(NEWER_QUESTION, '2026-11-20T08:00:00.000Z', { status: 'closed', close_reason: 'dont_know', answered_at: '2026-11-20T09:00:00.000Z' }),
      ],
    })],
    ['a burst of receipts waits for its ack', () => ({ conversation: { pending_ack: true } })],
    ['the company choice still takes a late answer', () => ({
      conversation: { context: { company_options: [{ id: COMPANY, name: 'A AB' }, { id: OTHER_COMPANY, name: 'B AB' }] } },
    })],
    ['a receipt question waits in the queue', () => ({
      conversation: { context: { question_queue: [{ type: 'context', inbox_item_id: 'item-2' }] } },
    })],
    ['the day has no question left: receipt questions used it', () => ({
      conversation: { context: { budget: { day_key: todayIsoStockholm(), count: MAX_QUESTIONS_PER_DAY } } },
    })],
    ['the day has no question left: list questions used it', () => ({
      conversation: { context: { list_question_budget: { day_key: todayIsoStockholm(), count: MAX_QUESTIONS_PER_DAY } } },
    })],
    ['the person only reads the books', () => ({ memberships: [member(COMPANY, COMPANY_NAME, { role: 'viewer' })] })],
    ['the only open question is on the list of a company that has the list switched off', () => ({
      memberships: [member(COMPANY, COMPANY_NAME), member(OTHER_COMPANY, OTHER_COMPANY_NAME)],
      questions: [questionRow(OLDER_QUESTION, '2026-11-18T08:00:00.000Z', { company_id: OTHER_COMPANY })],
    })],
    ['the only open question expired in this conversation', () => ({
      conversation: { context: { list_questions_expired: [OLDER_QUESTION] } },
      questions: [questionRow(OLDER_QUESTION, '2026-11-18T08:00:00.000Z')],
    })],
  ]

  it.each(fallbackAsBefore)('gets the fallback as before when %s', async (_name, seed) => {
    const { writes, messages } = world(seed())

    await route.handler(signedText('Hey'))

    expect(sendButtonsMock).not.toHaveBeenCalled()
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1]).toMatchObject({ to: PHONE, template: TEMPLATE.m16Fallback })
    expect(contextWrites(writes)).toEqual([])
    expect(messages[0]).toMatchObject({ processing_status: 'done', error_message: null })
  })

  it.each([
    ['the list is switched on for another company only', OTHER_COMPANY],
    ['the list is switched on for nobody', ''],
  ])('gets the fallback as before when %s', async (_name, rollout) => {
    process.env.COMPANY_QUESTIONS_COMPANY_IDS = rollout
    const { writes } = world()

    await route.handler(signedText('Hey'))

    expect(sendButtonsMock).not.toHaveBeenCalled()
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m16Fallback)
    expect(contextWrites(writes)).toEqual([])
  })

  it('is not read while the link is paused, as before: no question and no reply', async () => {
    const { writes, messages } = world({ link: { muted_at: '2026-11-19T00:00:00.000Z' } })

    await route.handler(signedText('Hey'))

    expect(sendButtonsMock).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
    expect(contextWrites(writes)).toEqual([])
    expect(messages[0]).toMatchObject({ processing_status: 'skipped', body_text: null })
  })

  it('pauses the link on "stopp" as before, with open questions waiting', async () => {
    const { writes } = world()

    await route.handler(signedText('stopp'))

    expect(sendButtonsMock).not.toHaveBeenCalled()
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m11Stop)
    expect(contextWrites(writes)).toEqual([])
  })

  it('takes the question back and sends nothing more when the question cannot be sent', async () => {
    sendButtonsMock.mockResolvedValue(SEND_FAILED)
    const { writes } = world()

    await route.handler(signedText('Hey'))

    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock).not.toHaveBeenCalled()
    const [held, takenBack] = contextWrites(writes)
    expect(held.pending_question?.question_id).toBe(OLDER_QUESTION)
    expect(takenBack.pending_question).toBeUndefined()
    expect(takenBack.list_question_budget?.count).toBe(0)
    expect(contextWrites(writes)).toHaveLength(2)
    expect(historyMock).not.toHaveBeenCalled()
  })

  it('takes the next written reply as the answer, saved on the question and as a fact through the whatsapp door', async () => {
    const first = world()
    await route.handler(signedText('Hey', 'wamid.TXT1'))
    const [held] = contextWrites(first.writes)
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)

    // The reply arrives on the conversation as the question left it.
    const second = world({ conversation: { context: held as Row } })
    await route.handler(signedText('Kontoret på Storgatan', 'wamid.TXT2'))

    expect(second.messages).toHaveLength(1)
    const reply = second.messages[0]
    expect(reply).toMatchObject({
      body_text: 'Kontoret på Storgatan',
      processing_status: 'received',
      error_message: `list_question_reply:${COMPANY}:${OLDER_QUESTION}`,
    })
    expect(kickMock).toHaveBeenLastCalledWith([reply.id as string])
    expect(sendTextMock).not.toHaveBeenCalled()
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)

    // The worker answers the question from the reply.
    reply.attempts = 0
    await processInboundMessage(second.supabase, reply.id as string)

    expect(interpretMock).not.toHaveBeenCalled()
    const [fact] = writesTo(second.writes, 'agent_memory')
    expect(fact).toMatchObject({
      company_id: COMPANY,
      kind: 'fact',
      content: `${OLDER_TEXT} Svar: Kontoret på Storgatan`,
      source: 'user_taught',
      created_by_user_id: USER,
    })
    const [answered] = writesTo(second.writes, 'company_questions')
    expect(answered).toMatchObject({
      status: 'answered',
      answer_option: null,
      answer_text: 'Kontoret på Storgatan',
      answered_by: USER,
      answered_via: 'whatsapp',
    })
    expect(answered.fact_id).toEqual(expect.any(String))
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m24ListAnswered)
    // The text that brought the question out is in neither.
    expect(JSON.stringify([fact, answered])).not.toContain('Hey')

    // The other open question follows the acknowledgement, and the conversation holds it.
    expect(sendButtonsMock).toHaveBeenCalledTimes(2)
    const next = sendButtonsMock.mock.calls[1][1]
    expect(next.body).toBe('Är kortköpet på 499 kr privat?\n\nDu kan också svara med egna ord.')
    expect(next.buttons).toEqual([{ id: `cq:${COMPANY}:${NEWER_QUESTION}:k`, title: 'Vet inte' }])
    expect(sendButtonsMock.mock.invocationCallOrder[1]).toBeGreaterThan(sendTextMock.mock.invocationCallOrder[0])
    const context = second.conversation.context as ConversationContext
    expect(context.pending_question).toMatchObject({ type: 'list_question', question_id: NEWER_QUESTION, company_id: COMPANY })
    expect(context.list_question_slots).toBeUndefined()
  })

  it('answers by a tap, acknowledges, and sends the other open question with no burst slot', async () => {
    const first = world()
    await route.handler(signedText('Hey', 'wamid.TXT1'))
    const [held] = contextWrites(first.writes)

    const second = world({ conversation: { context: held as Row } })
    const response = await route.handler(signedTap(`cq:${COMPANY}:${OLDER_QUESTION}:o:office`))

    expect(response.status).toBe(200)
    const [answered] = writesTo(second.writes, 'company_questions')
    expect(answered).toMatchObject({ status: 'answered', answer_option: 'office', answer_text: null, answered_by: USER, answered_via: 'whatsapp' })
    expect(writesTo(second.writes, 'agent_memory')[0]).toMatchObject({ content: `${OLDER_TEXT} Svar: Kontoret`, created_by_user_id: USER })
    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m24ListAnswered])
    expect(sendButtonsMock).toHaveBeenCalledTimes(2)
    expect(sendButtonsMock.mock.calls[1][1].buttons).toEqual([{ id: `cq:${COMPANY}:${NEWER_QUESTION}:k`, title: 'Vet inte' }])
    expect(sendButtonsMock.mock.invocationCallOrder[1]).toBeGreaterThan(sendTextMock.mock.invocationCallOrder[0])
    const context = second.conversation.context as ConversationContext
    expect(context.pending_question?.question_id).toBe(NEWER_QUESTION)
    expect(context.list_question_budget?.count).toBe(2)
    // The tap is persisted as handled.
    expect(second.messages[0]).toMatchObject({ message_type: 'interactive', processing_status: 'done' })
  })

  it('closes on a "Vet inte" tap, acknowledges, and sends the other open question', async () => {
    const first = world()
    await route.handler(signedText('Hey', 'wamid.TXT1'))
    const [held] = contextWrites(first.writes)

    const second = world({ conversation: { context: held as Row } })
    await route.handler(signedTap(`cq:${COMPANY}:${OLDER_QUESTION}:k`))

    expect(writesTo(second.writes, 'company_questions')[0]).toMatchObject({ status: 'closed', close_reason: 'dont_know', answered_by: USER, answered_via: 'whatsapp' })
    expect(writesTo(second.writes, 'agent_memory')).toEqual([])
    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m24ListClosed])
    expect(sendButtonsMock).toHaveBeenCalledTimes(2)
    expect(sendButtonsMock.mock.calls[1][1].buttons).toEqual([{ id: `cq:${COMPANY}:${NEWER_QUESTION}:k`, title: 'Vet inte' }])
  })

  it('sends nothing after the acknowledgement when the answered question was the last one open', async () => {
    const only = [questionRow(OLDER_QUESTION, '2026-11-18T08:00:00.000Z')]
    const first = world({ questions: only })
    await route.handler(signedText('Hey', 'wamid.TXT1'))
    const [held] = contextWrites(first.writes)

    const second = world({ conversation: { context: held as Row }, questions: [questionRow(OLDER_QUESTION, '2026-11-18T08:00:00.000Z')] })
    await route.handler(signedTap(`cq:${COMPANY}:${OLDER_QUESTION}:o:office`))

    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m24ListAnswered])
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect((second.conversation.context as ConversationContext).pending_question).toBeUndefined()
  })
})

describe('a person who keeps the books of several companies', () => {
  const originalEnv = { ...process.env }

  beforeEach(() => {
    vi.clearAllMocks()
    sendTextMock.mockResolvedValue(SENT)
    sendButtonsMock.mockResolvedValue(SENT)
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

  const three = (): Row[] => [member(COMPANY, COMPANY_NAME), member(OTHER_COMPANY, OTHER_COMPANY_NAME), member(THIRD_COMPANY, THIRD_COMPANY_NAME)]
  const CLOSING = 'Du kan också svara med egna ord.'

  it('with three companies and no default company: gets the question of the one company with the list on, its name on top', async () => {
    const { writes, messages } = world({ link: { default_company_id: null }, memberships: three() })

    await route.handler(signedText('Hey'))

    expect(sendTextMock).not.toHaveBeenCalled()
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    const message = sendButtonsMock.mock.calls[0][1]
    expect(message.body).toBe(`*${COMPANY_NAME}*\n${OLDER_TEXT}\n${OLDER_WHY}\n\n${CLOSING}`)
    expect(message.buttons.map((button) => button.id)).toEqual([
      `cq:${COMPANY}:${OLDER_QUESTION}:o:office`,
      `cq:${COMPANY}:${OLDER_QUESTION}:o:storage`,
      `cq:${COMPANY}:${OLDER_QUESTION}:k`,
    ])
    const [held] = contextWrites(writes)
    expect(held.pending_question).toMatchObject({ type: 'list_question', question_id: OLDER_QUESTION, company_id: COMPANY })
    expect(messages[0]).toMatchObject({ body_text: 'Hey', processing_status: 'done', error_message: null })
  })

  it('answers the right company\'s question from a written reply, though the conversation is routed to another company', async () => {
    process.env.COMPANY_QUESTIONS_COMPANY_IDS = '*'
    const seed = (): Seed => ({
      // The conversation is routed to the second company, which has no open question.
      link: { default_company_id: OTHER_COMPANY },
      memberships: three(),
      questions: [questionRow(OLDER_QUESTION, '2026-11-18T08:00:00.000Z', { company_id: THIRD_COMPANY })],
    })
    const first = world(seed())
    await route.handler(signedText('Hey', 'wamid.TXT1'))
    const [held] = contextWrites(first.writes)
    expect(sendButtonsMock.mock.calls[0][1].body.startsWith(`*${THIRD_COMPANY_NAME}*\n`)).toBe(true)
    expect(held.pending_question).toMatchObject({ question_id: OLDER_QUESTION, company_id: THIRD_COMPANY })

    const second = world({ ...seed(), conversation: { context: held as Row } })
    await route.handler(signedText('Kontoret på Storgatan', 'wamid.TXT2'))
    const reply = second.messages[0]
    expect(reply.error_message).toBe(`list_question_reply:${THIRD_COMPANY}:${OLDER_QUESTION}`)

    reply.attempts = 0
    await processInboundMessage(second.supabase, reply.id as string)

    const [fact] = writesTo(second.writes, 'agent_memory')
    expect(fact).toMatchObject({ company_id: THIRD_COMPANY, content: `${OLDER_TEXT} Svar: Kontoret på Storgatan`, created_by_user_id: USER })
    const [answered] = writesTo(second.writes, 'company_questions')
    expect(answered).toMatchObject({ status: 'answered', answer_text: 'Kontoret på Storgatan', answered_by: USER, answered_via: 'whatsapp' })
    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m24ListAnswered])
  })

  it('answers the right company\'s question from a tap, and follows with the next company\'s question under its own name', async () => {
    process.env.COMPANY_QUESTIONS_COMPANY_IDS = '*'
    const seed = (): Seed => ({
      link: { default_company_id: OTHER_COMPANY },
      memberships: three(),
      questions: [
        questionRow(NEWER_QUESTION, '2026-11-20T08:00:00.000Z', { company_id: THIRD_COMPANY, question: 'Är kortköpet på 499 kr privat?', why: null, options: [] }),
        questionRow(OLDER_QUESTION, '2026-11-18T08:00:00.000Z', { company_id: COMPANY }),
      ],
    })
    const first = world(seed())
    await route.handler(signedText('Hey', 'wamid.TXT1'))
    const [held] = contextWrites(first.writes)
    // No open question in the routed company: the oldest of the others goes first.
    expect(sendButtonsMock.mock.calls[0][1].body.startsWith(`*${COMPANY_NAME}*\n${OLDER_TEXT}`)).toBe(true)

    const second = world({ ...seed(), conversation: { context: held as Row } })
    await route.handler(signedTap(`cq:${COMPANY}:${OLDER_QUESTION}:o:office`))

    const [answered] = writesTo(second.writes, 'company_questions')
    expect(answered).toMatchObject({ status: 'answered', answer_option: 'office', answered_by: USER, answered_via: 'whatsapp' })
    expect(writesTo(second.writes, 'agent_memory')[0]).toMatchObject({ company_id: COMPANY, content: `${OLDER_TEXT} Svar: Kontoret` })
    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m24ListAnswered])
    expect(sendButtonsMock).toHaveBeenCalledTimes(2)
    const next = sendButtonsMock.mock.calls[1][1]
    expect(next.body).toBe(`*${THIRD_COMPANY_NAME}*\nÄr kortköpet på 499 kr privat?\n\n${CLOSING}`)
    expect(next.buttons).toEqual([{ id: `cq:${THIRD_COMPANY}:${NEWER_QUESTION}:k`, title: 'Vet inte' }])
    expect((second.conversation.context as ConversationContext).pending_question).toMatchObject({ question_id: NEWER_QUESTION, company_id: THIRD_COMPANY })
  })

  it('puts the question of the company the conversation is routed to first, though another company has an older one', async () => {
    process.env.COMPANY_QUESTIONS_COMPANY_IDS = '*'
    world({
      link: { default_company_id: OTHER_COMPANY },
      memberships: three(),
      questions: [
        questionRow(OLDER_QUESTION, '2026-11-18T08:00:00.000Z', { company_id: COMPANY }),
        questionRow(NEWER_QUESTION, '2026-11-20T08:00:00.000Z', { company_id: OTHER_COMPANY, question: 'Är kortköpet på 499 kr privat?', why: null, options: [] }),
      ],
    })

    await route.handler(signedText('Hey'))

    const message = sendButtonsMock.mock.calls[0][1]
    expect(message.body).toBe(`*${OTHER_COMPANY_NAME}*\nÄr kortköpet på 499 kr privat?\n\n${CLOSING}`)
    expect(message.buttons).toEqual([{ id: `cq:${OTHER_COMPANY}:${NEWER_QUESTION}:k`, title: 'Vet inte' }])
  })

  const contributesNothing: Array<[string, () => Row[]]> = [
    ['that is archived', () => [member(COMPANY, COMPANY_NAME), member(OTHER_COMPANY, OTHER_COMPANY_NAME, { archived: true })]],
    ['where the person only invoices', () => [member(COMPANY, COMPANY_NAME), member(OTHER_COMPANY, OTHER_COMPANY_NAME, { role: 'invoicer' })]],
    ['where the person only reads the books', () => [member(COMPANY, COMPANY_NAME), member(OTHER_COMPANY, OTHER_COMPANY_NAME, { role: 'viewer' })]],
  ]

  it.each(contributesNothing)('gets the fallback when the only open question is on the list of a company %s', async (_name, memberships) => {
    process.env.COMPANY_QUESTIONS_COMPANY_IDS = '*'
    const { writes } = world({
      memberships: memberships(),
      questions: [questionRow(OLDER_QUESTION, '2026-11-18T08:00:00.000Z', { company_id: OTHER_COMPANY })],
    })

    await route.handler(signedText('Hey'))

    expect(sendButtonsMock).not.toHaveBeenCalled()
    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m16Fallback])
    expect(contextWrites(writes)).toEqual([])
  })

  it('names no company for a person who keeps the books of one company and only reads another', async () => {
    process.env.COMPANY_QUESTIONS_COMPANY_IDS = '*'
    world({ memberships: [member(COMPANY, COMPANY_NAME), member(OTHER_COMPANY, OTHER_COMPANY_NAME, { role: 'viewer' })] })

    await route.handler(signedText('Hey'))

    expect(sendButtonsMock.mock.calls[0][1].body).toBe(`${OLDER_TEXT}\n${OLDER_WHY}\n\n${CLOSING}`)
  })
})

describe('a written reply when the company has a reply reader', () => {
  const originalEnv = { ...process.env }
  const READER_URL = 'https://reader.example.test/read'
  const fetchMock = vi.fn<typeof fetch>()

  /** The reader answers every request with this body. */
  const reads = (body: unknown, status = 200): void => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(body), { status })))
  }

  /** The bodies the reader was sent, in order. */
  const handedOver = (): Row[] => fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as Row)

  beforeEach(() => {
    vi.clearAllMocks()
    sendTextMock.mockResolvedValue(SENT)
    sendButtonsMock.mockResolvedValue(SENT)
    vi.stubGlobal('fetch', fetchMock)
    process.env.COMPANY_QUESTIONS_COMPANY_IDS = COMPANY
    process.env.QUESTION_REPLY_READER_URL = READER_URL
    process.env.QUESTION_REPLY_READER_SECRET = 'test-secret'
    process.env.QUESTION_REPLY_READER_COMPANY_IDS = COMPANY
    process.env.WHATSAPP_APP_SECRET = SECRET
    process.env.WHATSAPP_PHONE_HASH_KEY = 'test-pepper'
    process.env.WHATSAPP_PHONE_ENCRYPTION_KEY = 'a'.repeat(64)
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://test.supabase.co'
    process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-key'
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    process.env = { ...originalEnv }
  })

  /** A conversation that holds the older question, as the first text left it. */
  async function withQuestionInFlight() {
    const first = world()
    await route.handler(signedText('Hey', 'wamid.TXT1'))
    const [held] = contextWrites(first.writes)
    expect(held.pending_question).toMatchObject({ type: 'list_question', question_id: OLDER_QUESTION })
    vi.clearAllMocks()
    sendTextMock.mockResolvedValue(SENT)
    sendButtonsMock.mockResolvedValue(SENT)
    return world({ conversation: { context: held as Row } })
  }

  /** The written reply goes through the webhook, then the worker takes its row. */
  async function sendsReply(current: ReturnType<typeof world>, text: string, wamid: string): Promise<Row> {
    await route.handler(signedText(text, wamid))
    const row = current.messages.at(-1)!
    expect(row.error_message).toBe(`list_question_reply:${COMPANY}:${OLDER_QUESTION}`)
    row.attempts = 0
    await processInboundMessage(current.supabase, row.id as string)
    return row
  }

  const stillInFlight = (current: ReturnType<typeof world>): void => {
    expect((current.conversation.context as ConversationContext).pending_question).toMatchObject({
      type: 'list_question',
      question_id: OLDER_QUESTION,
      company_id: COMPANY,
    })
    expect(writesTo(current.writes, 'company_questions')).toEqual([])
    expect(writesTo(current.writes, 'agent_memory')).toEqual([])
    expect(sendButtonsMock).not.toHaveBeenCalled()
  }

  it('later: the question stays open and in flight with m27, and the reply after it can still answer it', async () => {
    const current = await withQuestionInFlight()
    reads({ kind: 'later' })

    await sendsReply(current, 'Jag kollar med hyresvärden och återkommer', 'wamid.TXT2')

    expect(handedOver()).toEqual([
      {
        version: 1,
        company_id: COMPANY,
        question: {
          id: OLDER_QUESTION,
          text: OLDER_TEXT,
          why: OLDER_WHY,
          options: [
            { id: 'office', label: 'Kontoret' },
            { id: 'storage', label: 'Lagret' },
          ],
        },
        reply: { text: 'Jag kollar med hyresvärden och återkommer' },
        locale: 'sv',
      },
    ])
    expect(JSON.stringify(handedOver())).not.toContain(PHONE)
    expect(JSON.stringify(handedOver())).not.toContain(USER)
    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual(['m27_list_later'])
    expect(sendTextMock.mock.calls[0][1]).toMatchObject({ to: PHONE, body: 'Okej, frågan ligger kvar. Svara här när du vet.' })
    stillInFlight(current)

    // The next written reply is read again, and this time it is the answer.
    reads({ kind: 'answer' })
    await sendsReply(current, 'Kontoret på Storgatan', 'wamid.TXT3')

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [answered] = writesTo(current.writes, 'company_questions')
    expect(answered).toMatchObject({ status: 'answered', answer_text: 'Kontoret på Storgatan', answered_by: USER, answered_via: 'whatsapp' })
    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual(['m27_list_later', TEMPLATE.m24ListAnswered])
    // The other open question follows the answer, as without a reader.
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
  })

  it('question_back: the reader\'s cleaned reply goes out as m28, and the question stays open and in flight', async () => {
    const current = await withQuestionInFlight()
    reads({ kind: 'question_back', reply: ' Menar du kontoret\n på Storgatan\u0000 eller   lagret? ' })

    const row = await sendsReply(current, 'Vilken hyra?', 'wamid.TXT2')

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1]).toMatchObject({
      to: PHONE,
      template: 'm28_list_question_back',
      body: 'Menar du kontoret på Storgatan eller lagret?',
    })
    stillInFlight(current)
    expect(writesTo(current.writes, 'whatsapp_messages').at(-1)).toMatchObject({ processing_status: 'done' })
    expect(row.body_text).toBe('Vilken hyra?')
  })

  it('other: the fallback reply goes out, and the question stays open and in flight', async () => {
    const current = await withQuestionInFlight()
    reads({ kind: 'other' })

    await sendsReply(current, 'Kan du boka en taxi åt mig?', 'wamid.TXT2')

    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m16Fallback])
    stillInFlight(current)
  })

  it('dont_know: closes the question as the typed "vet inte" does', async () => {
    const current = await withQuestionInFlight()
    reads({ kind: 'dont_know' })

    await sendsReply(current, 'Ingen aning faktiskt', 'wamid.TXT2')

    const [closed] = writesTo(current.writes, 'company_questions')
    expect(closed).toMatchObject({ status: 'closed', close_reason: 'dont_know', answered_via: 'whatsapp' })
    expect(writesTo(current.writes, 'agent_memory')).toEqual([])
    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m24ListClosed])
  })

  it('saves the reply as written when the reader does not answer within its 8 seconds', async () => {
    const current = await withQuestionInFlight()
    fetchMock.mockImplementation(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new DOMException('The operation was aborted.', 'AbortError')))
        }),
    )
    await route.handler(signedText('Kontoret på Storgatan', 'wamid.TXT2'))
    const row = current.messages.at(-1)!
    row.attempts = 0

    vi.useFakeTimers()
    const processed = processInboundMessage(current.supabase, row.id as string)
    await vi.advanceTimersByTimeAsync(8_000)
    await processed

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [answered] = writesTo(current.writes, 'company_questions')
    expect(answered).toMatchObject({ status: 'answered', answer_text: 'Kontoret på Storgatan', answered_via: 'whatsapp' })
    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m24ListAnswered])
  })

  it('saves the reply as written, with no call, for a company that is not in the reader list', async () => {
    process.env.QUESTION_REPLY_READER_COMPANY_IDS = OTHER_COMPANY
    const current = await withQuestionInFlight()
    reads({ kind: 'later' })

    await sendsReply(current, 'Jag återkommer', 'wamid.TXT2')

    expect(fetchMock).not.toHaveBeenCalled()
    const [answered] = writesTo(current.writes, 'company_questions')
    expect(answered).toMatchObject({ status: 'answered', answer_text: 'Jag återkommer' })
    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m24ListAnswered])
  })

  it('a tap on a button answers the question without a call to the reader', async () => {
    const current = await withQuestionInFlight()
    reads({ kind: 'later' })

    await route.handler(signedTap(`cq:${COMPANY}:${OLDER_QUESTION}:o:office`))

    expect(fetchMock).not.toHaveBeenCalled()
    const [answered] = writesTo(current.writes, 'company_questions')
    expect(answered).toMatchObject({ status: 'answered', answer_option: 'office', answered_via: 'whatsapp' })
    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m24ListAnswered])
  })
})

describe('a question in flight that ends through another door', () => {
  const originalEnv = { ...process.env }
  const NOTE = 'Betalningen på 12 000 kr är bokförd mot hyresfakturan.'
  const SENTENCE = 'Den här frågan är löst, du behöver inte svara.'

  beforeEach(() => {
    vi.clearAllMocks()
    sendTextMock.mockResolvedValue(SENT)
    sendButtonsMock.mockResolvedValue(SENT)
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

  /** The extension's own handler of the event, as the event bus calls it. */
  const closed = (supabase: SupabaseClient, closeReason: EventPayload<'company_question.closed'>['closeReason']): Promise<void> | void => {
    const registration = (whatsappInboxExtension.eventHandlers ?? []).find((entry) => entry.eventType === 'company_question.closed')
    if (!registration) throw new Error('no handler for company_question.closed')
    const payload: EventPayload<'company_question.closed'> = {
      questionId: OLDER_QUESTION,
      status: 'closed',
      closeReason,
      answeredVia: 'claude',
      answeredAt: '2026-11-20T10:05:00.000Z',
      userId: USER,
      companyId: COMPANY,
    }
    return registration.handler(payload, { supabase } as unknown as ExtensionContext)
  }
  const answered = (supabase: SupabaseClient): Promise<void> | void => {
    const registration = (whatsappInboxExtension.eventHandlers ?? []).find((entry) => entry.eventType === 'company_question.answered')
    if (!registration) throw new Error('no handler for company_question.answered')
    const payload: EventPayload<'company_question.answered'> = {
      questionId: OLDER_QUESTION,
      status: 'answered',
      answeredVia: 'app',
      answeredAt: '2026-11-20T10:05:00.000Z',
      userId: USER,
      companyId: COMPANY,
    }
    return registration.handler(payload, { supabase } as unknown as ExtensionContext)
  }

  /**
   * The conversation holds the older question as the first text left it, the
   * window is open, and the older question has ended on its row the way
   * `ending` says. The other question is still open.
   */
  async function withQuestionInFlight(ending: Row, conversation: Row = {}) {
    const first = world()
    await route.handler(signedText('Hey', 'wamid.TXT1'))
    const [held] = contextWrites(first.writes)
    expect(held.pending_question).toMatchObject({ type: 'list_question', question_id: OLDER_QUESTION })
    vi.clearAllMocks()
    sendTextMock.mockResolvedValue(SENT)
    sendButtonsMock.mockResolvedValue(SENT)
    return world({
      conversation: {
        context: held as Row,
        // The column the scan for a question in flight filters on.
        'context->pending_question->>question_id': OLDER_QUESTION,
        service_window_expires_at: new Date(Date.now() + HOUR).toISOString(),
        ...conversation,
      },
      questions: [
        questionRow(NEWER_QUESTION, '2026-11-20T08:00:00.000Z', { question: 'Är kortköpet på 499 kr privat?', why: null, options: [] }),
        questionRow(OLDER_QUESTION, '2026-11-18T08:00:00.000Z', { answered_at: '2026-11-20T10:05:00.000Z', ...ending }),
      ],
    })
  }
  const settledEnding = (note: string | null): Row => ({ status: 'closed', close_reason: 'settled', close_note: note, close_evidence: [], answered_via: 'claude' })
  const heldQuestion = (current: ReturnType<typeof world>): string | undefined =>
    (current.conversation.context as ConversationContext).pending_question?.question_id

  it('closed as settled: the chat says so with the note of the close, and the other open question follows', async () => {
    const current = await withQuestionInFlight(settledEnding(NOTE))

    await closed(current.supabase, 'settled')

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1]).toMatchObject({ to: PHONE, template: 'm30_list_settled', body: `${SENTENCE}\n${NOTE}`, conversationId: 'conv-1' })
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    const next = sendButtonsMock.mock.calls[0][1]
    expect(next.body).toBe('Är kortköpet på 499 kr privat?\n\nDu kan också svara med egna ord.')
    expect(next.buttons).toEqual([{ id: `cq:${COMPANY}:${NEWER_QUESTION}:k`, title: 'Vet inte' }])
    expect(sendButtonsMock.mock.invocationCallOrder[0]).toBeGreaterThan(sendTextMock.mock.invocationCallOrder[0])
    expect(heldQuestion(current)).toBe(NEWER_QUESTION)
    // Nothing is written on the question: it ended where it was closed.
    expect(writesTo(current.writes, 'company_questions')).toEqual([])
    expect(writesTo(current.writes, 'agent_memory')).toEqual([])

    // The same close delivered again says nothing more.
    await closed(current.supabase, 'settled')
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect(heldQuestion(current)).toBe(NEWER_QUESTION)
  })

  it('closed as settled without a note: the chat says only that it is settled', async () => {
    const current = await withQuestionInFlight(settledEnding(null))

    await closed(current.supabase, 'settled')

    expect(sendTextMock.mock.calls.map((call) => [call[1].template, call[1].body])).toEqual([['m30_list_settled', SENTENCE]])
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
  })

  it('closed as settled outside the service window: nothing is sent, and the question leaves the conversation', async () => {
    const current = await withQuestionInFlight(settledEnding(NOTE), { service_window_expires_at: new Date(Date.now() - HOUR).toISOString() })

    await closed(current.supabase, 'settled')

    expect(sendTextMock).not.toHaveBeenCalled()
    expect(sendButtonsMock).not.toHaveBeenCalled()
    expect(heldQuestion(current)).toBeUndefined()
  })

  it.each(['dont_know', 'not_relevant', 'withdrawn'] as const)('closed as %s: nothing is said, and the question leaves the conversation', async (reason) => {
    const current = await withQuestionInFlight({ status: 'closed', close_reason: reason, answered_via: 'claude' })

    await closed(current.supabase, reason)

    expect(sendTextMock).not.toHaveBeenCalled()
    expect(sendButtonsMock).not.toHaveBeenCalled()
    expect(heldQuestion(current)).toBeUndefined()
  })

  it('answered through another door: nothing is said, and the question leaves the conversation', async () => {
    const current = await withQuestionInFlight({ status: 'answered', answer_text: 'Kontoret', answered_via: 'app' })

    await answered(current.supabase)

    expect(sendTextMock).not.toHaveBeenCalled()
    expect(sendButtonsMock).not.toHaveBeenCalled()
    expect(heldQuestion(current)).toBeUndefined()
  })
})

