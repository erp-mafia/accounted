import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createRowsMockSupabase, createTableMockSupabase } from '@/tests/helpers'
import type { CompanyQuestion } from '@/lib/questions/types'
import type { WhatsAppConversation, WhatsAppPhoneLink } from '@/types'

vi.mock('@/extensions/general/whatsapp-inbox/lib/graph-api', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/whatsapp-inbox/lib/graph-api')
  >('@/extensions/general/whatsapp-inbox/lib/graph-api')
  return { ...actual, sendReplyButtons: vi.fn(), sendText: vi.fn() }
})

vi.mock('@/extensions/general/whatsapp-inbox/lib/routing', () => ({
  resolveRoutedCompany: vi.fn(),
}))

vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue('event-1'),
}))

vi.mock('@/lib/questions/app-answer', async () => {
  const actual = await vi.importActual<typeof import('@/lib/questions/app-answer')>('@/lib/questions/app-answer')
  return { ...actual, answerAsPerson: vi.fn(), closeAsPerson: vi.fn() }
})

vi.mock('@/lib/questions/list', () => ({ listOpenQuestionsAcross: vi.fn() }))

vi.mock('@/lib/questions/rows', async () => {
  const actual = await vi.importActual<typeof import('@/lib/questions/rows')>('@/lib/questions/rows')
  return { ...actual, readQuestionRow: vi.fn() }
})

import { INTERACTIVE_BODY_MAX, sendReplyButtons, sendText } from '@/extensions/general/whatsapp-inbox/lib/graph-api'
import { resolveRoutedCompany } from '@/extensions/general/whatsapp-inbox/lib/routing'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { answerAsPerson, closeAsPerson } from '@/lib/questions/app-answer'
import { listOpenQuestionsAcross } from '@/lib/questions/list'
import { readQuestionRow } from '@/lib/questions/rows'
import { codedRefusal } from '@/lib/errors/refusal'
import { todayIsoStockholm } from '@/lib/dates/iso'
import {
  MAX_QUESTIONS_PER_DAY,
  QUESTION_TTL_MS,
  type ConversationContext,
} from '@/extensions/general/whatsapp-inbox/lib/conversation'
import { TEMPLATE } from '@/extensions/general/whatsapp-inbox/lib/messages'
import { encryptPhone } from '@/extensions/general/whatsapp-inbox/lib/phone-crypto'
import {
  applyListQuestionTap,
  applyListQuestionText,
  clearEndedListQuestion,
  conversationTakesListQuestion,
  expireListQuestions,
  listQuestionBody,
  listQuestionReplyMarker,
  offerFiledListQuestion,
  offerListQuestionAfterBurst,
  offerListQuestionOnText,
  offerListQuestionWhenDone,
  parseListQuestionReplyMarker,
  parseQuestionButtonId,
  pendingListQuestion,
  questionButtonId,
  sendListQuestion,
  type QuestionTap,
} from '@/extensions/general/whatsapp-inbox/lib/list-question'

const sendButtonsMock = vi.mocked(sendReplyButtons)
const sendTextMock = vi.mocked(sendText)
const routedMock = vi.mocked(resolveRoutedCompany)
const historyMock = vi.mocked(appendProcessingHistory)
const answerMock = vi.mocked(answerAsPerson)
const closeMock = vi.mocked(closeAsPerson)
const listMock = vi.mocked(listOpenQuestionsAcross)
const readRowMock = vi.mocked(readQuestionRow)

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const OTHER_COMPANY = 'c0000000-0000-4000-8000-000000000002'
const THIRD_COMPANY = 'c0000000-0000-4000-8000-000000000003'
const COMPANY_NAME = 'Bolag A AB'
const OTHER_COMPANY_NAME = 'Bolag B AB'
const USER = 'a0000000-0000-4000-8000-000000000001'
const OTHER_USER = 'a0000000-0000-4000-8000-000000000002'
const QUESTION_ID = 'e0000000-0000-4000-8000-000000000001'
const OTHER_QUESTION_ID = 'e0000000-0000-4000-8000-000000000002'
const PHONE = '46701234567'
const HOUR = 60 * 60 * 1000
const NOW = new Date('2026-11-20T10:00:00.000Z')

const SENT = { ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null } as const
const SEND_FAILED = { ok: false, wamid: null, errorDetail: 'Send failed (HTTP 500)', failure: 'http_rejected' } as const

function makeLink(overrides: Partial<WhatsAppPhoneLink> = {}): WhatsAppPhoneLink {
  return {
    id: 'link-1',
    user_id: USER,
    phone_hash: 'hash-1',
    phone_enc: encryptPhone(PHONE),
    phone_masked: '+46 70 *** ** 67',
    wa_profile_name: null,
    default_company_id: null,
    last_company_id: null,
    verified_at: '2026-11-01T09:00:00.000Z',
    revoked_at: null,
    muted_at: null,
    last_message_at: null,
    created_at: '2026-11-01T09:00:00.000Z',
    updated_at: '2026-11-01T09:00:00.000Z',
    ...overrides,
  }
}

function makeConversation(overrides: Partial<WhatsAppConversation> = {}): WhatsAppConversation {
  return {
    id: 'conv-1',
    phone_link_id: 'link-1',
    state: 'idle',
    context: {},
    company_id: null,
    service_window_expires_at: new Date(NOW.getTime() + HOUR).toISOString(),
    debounce_until: null,
    pending_ack: false,
    last_inbound_at: null,
    last_outbound_at: null,
    created_at: '2026-11-01T09:00:00.000Z',
    updated_at: '2026-11-01T09:00:00.000Z',
    ...overrides,
  }
}

function makeQuestion(overrides: Partial<CompanyQuestion> = {}): CompanyQuestion {
  return {
    question_id: QUESTION_ID,
    status: 'open',
    close_reason: null,
    question: 'Gäller hyran på 12 000 kr kontoret eller lagret?',
    why: 'Svaret avgör vilket konto hyran bokförs på.',
    options: [
      { id: 'office', label: 'Kontoret' },
      { id: 'storage', label: 'Lagret' },
    ],
    evidence: [],
    asked_by: null,
    client: null,
    answer_option: null,
    answer_text: null,
    answered_at: null,
    answered_via: null,
    fact_id: null,
    created_at: '2026-11-19T08:00:00.000Z',
    ...overrides,
  }
}

/** A list question in the conversation's slot, sent `ageMs` ago. */
function pendingContext(ageMs = 5 * 60 * 1000, questionId = QUESTION_ID): Record<string, unknown> {
  const context: ConversationContext = {
    pending_question: {
      type: 'list_question',
      inbox_item_id: null,
      asked_at: new Date(NOW.getTime() - ageMs).toISOString(),
      question_id: questionId,
      company_id: COMPANY,
    },
  }
  return context as Record<string, unknown>
}

interface Write {
  table: string
  method: string
  row: unknown
}

interface ConversationWrite {
  context?: ConversationContext
  last_outbound_at?: string
  state?: string
}

/** The conversation writes, in order. */
const conversationWrites = (writes: Write[]): ConversationWrite[] =>
  writes.filter((write) => write.table === 'whatsapp_conversations').map((write) => write.row as ConversationWrite)

/** A membership row as the reads see it: the company's name embedded, and its archive date as the filter column. */
function membership(companyId: string, name: string | null, opts: { role?: string; archived?: boolean; userId?: string } = {}): Record<string, unknown> {
  return {
    user_id: opts.userId ?? USER,
    company_id: companyId,
    role: opts.role ?? 'owner',
    companies: { name },
    ...(opts.archived ? { 'companies.archived_at': '2026-01-01T00:00:00.000Z' } : {}),
  }
}

/** Open questions as the list hands them out, each with the company whose list it is on. */
const openOf = (questions: CompanyQuestion[], companyId: string = COMPANY) => questions.map((question) => ({ companyId, question }))

/**
 * A database where the person keeps the books of COMPANY with `role` (null:
 * no membership), or holds exactly the `memberships` given.
 */
function db(
  opts: {
    role?: string | null
    archived?: boolean
    memberships?: Record<string, unknown>[]
    link?: WhatsAppPhoneLink
    conversation?: WhatsAppConversation
    questions?: Record<string, unknown>[]
  } = {},
) {
  const writes: Write[] = []
  const role = opts.role === undefined ? 'owner' : opts.role
  const mock = createRowsMockSupabase(
    {
      company_members:
        opts.memberships ?? (role === null ? [] : [membership(COMPANY, COMPANY_NAME, { role, archived: opts.archived })]),
      whatsapp_phone_links: [{ ...(opts.link ?? makeLink()) }],
      whatsapp_conversations: [{ ...(opts.conversation ?? makeConversation()) }],
      company_questions: opts.questions ?? [],
    },
    writes,
  )
  return { supabase: mock.supabase as unknown as SupabaseClient, writes, mock }
}

const offer = (overrides: Partial<Parameters<typeof sendListQuestion>[1]> = {}): Parameters<typeof sendListQuestion>[1] => ({
  conversation: makeConversation(),
  link: makeLink(),
  question: makeQuestion(),
  companyId: COMPANY,
  companyName: null,
  usesBurstSlot: false,
  now: NOW,
  ...overrides,
})

const replyBase = { senderPhoneHash: 'hash-1', phoneLinkId: 'link-1', conversationId: 'conv-1', correlationId: null }

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', COMPANY)
  vi.stubEnv('WHATSAPP_PHONE_ENCRYPTION_KEY', 'a'.repeat(64))
  sendButtonsMock.mockResolvedValue(SENT)
  sendTextMock.mockResolvedValue(SENT)
  routedMock.mockResolvedValue({ companyId: COMPANY, via: 'default' })
  historyMock.mockResolvedValue('event-1')
  listMock.mockResolvedValue([])
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('the button id', () => {
  it('carries the company, the question and the option, and reads back', () => {
    const id = questionButtonId(COMPANY, QUESTION_ID, 'office')
    expect(id).toBe(`cq:${COMPANY}:${QUESTION_ID}:o:office`)
    expect(parseQuestionButtonId(id)).toEqual({ companyId: COMPANY, questionId: QUESTION_ID, kind: 'option', optionId: 'office' })
  })

  it('reads back "Vet inte"', () => {
    const id = questionButtonId(COMPANY, QUESTION_ID, null)
    expect(id).toBe(`cq:${COMPANY}:${QUESTION_ID}:k`)
    expect(parseQuestionButtonId(id)).toEqual({ companyId: COMPANY, questionId: QUESTION_ID, kind: 'dont_know' })
  })

  it('keeps an option id with colons, and one named like the "Vet inte" mark', () => {
    for (const optionId of ['a:b:c', 'k', 'o:k', 'Årsbetalning 2026']) {
      expect(parseQuestionButtonId(questionButtonId(COMPANY, QUESTION_ID, optionId))).toEqual({
        companyId: COMPANY,
        questionId: QUESTION_ID,
        kind: 'option',
        optionId,
      })
    }
  })

  it('stays within the 256 characters a reply id holds, with the longest option id', () => {
    expect(questionButtonId(COMPANY, QUESTION_ID, 'x'.repeat(40)).length).toBeLessThanOrEqual(256)
  })

  it('does not read a company choice id, or anything malformed, as a list question button', () => {
    const notButtons = [
      COMPANY,
      null,
      undefined,
      '',
      'cq:',
      `cq:${COMPANY}`,
      `cq:${COMPANY}:${QUESTION_ID}`,
      `cq:${COMPANY}:${QUESTION_ID}:`,
      `cq:${COMPANY}:${QUESTION_ID}:o:`,
      `cq:${COMPANY}:${QUESTION_ID}:x:office`,
      `cq:${COMPANY}:not-a-question-id-of-thirty-six-chars:k`,
      `cq:not-a-company-id-of-thirty-six-chars!:${QUESTION_ID}:k`,
      `cq:${COMPANY}-${QUESTION_ID}:k`,
    ]
    for (const id of notButtons) expect(parseQuestionButtonId(id), String(id)).toBeNull()
  })
})

describe('the marker on a written reply', () => {
  it('names the company and the question, and reads back', () => {
    const marker = listQuestionReplyMarker({ companyId: COMPANY, questionId: QUESTION_ID })
    expect(marker).toBe(`list_question_reply:${COMPANY}:${QUESTION_ID}`)
    expect(parseListQuestionReplyMarker(marker)).toEqual({ companyId: COMPANY, questionId: QUESTION_ID })
  })

  it('is not read from any other text a row may carry there', () => {
    const others = [
      null,
      undefined,
      '',
      'staged_awaiting_company',
      'Muted by stopp: message not read',
      'list_question_reply:',
      `list_question_reply:${COMPANY}`,
      `list_question_reply:${COMPANY}:not-a-question-id`,
      `list_question_reply:${COMPANY}:${QUESTION_ID}:extra`,
    ]
    for (const text of others) expect(parseListQuestionReplyMarker(text), String(text)).toBeNull()
  })
})

describe('the body of the question message', () => {
  const CLOSING = { sv: 'Du kan också svara med egna ord.', en: 'You can also answer in your own words.' } as const

  it('is 1024 characters at most, the length an interactive body holds', () => {
    expect(INTERACTIVE_BODY_MAX).toBe(1024)
  })

  for (const locale of ['sv', 'en'] as const) {
    const closing = CLOSING[locale]
    /** The longest why that still fits beside this question and the closing line. */
    const whyRoom = (question: string) => INTERACTIVE_BODY_MAX - question.length - '\n'.length - '\n\n'.length - closing.length

    it(`${locale}: carries the question, the why on its own line and the closing line`, () => {
      expect(listQuestionBody({ question: 'Gäller hyran kontoret?', why: 'Det avgör kontot.' }, { locale })).toBe(
        `Gäller hyran kontoret?\nDet avgör kontot.\n\n${closing}`,
      )
      expect(listQuestionBody({ question: 'Gäller hyran kontoret?', why: null }, { locale })).toBe(`Gäller hyran kontoret?\n\n${closing}`)
    })

    it(`${locale}: keeps the why when the whole is exactly at the limit`, () => {
      const question = 'q'.repeat(500)
      const why = 'w'.repeat(whyRoom(question))
      const body = listQuestionBody({ question, why }, { locale })
      expect(body).toBe(`${question}\n${why}\n\n${closing}`)
      expect(body.length).toBe(INTERACTIVE_BODY_MAX)
    })

    it(`${locale}: leaves the why out first, one character over the limit`, () => {
      const question = 'q'.repeat(500)
      const why = 'w'.repeat(whyRoom(question) + 1)
      const body = listQuestionBody({ question, why }, { locale })
      expect(body).toBe(`${question}\n\n${closing}`)
      expect(body.length).toBeLessThanOrEqual(INTERACTIVE_BODY_MAX)
    })

    it(`${locale}: leaves the closing line out next, and never cuts the question`, () => {
      const tight = 'q'.repeat(INTERACTIVE_BODY_MAX - closing.length - 1)
      expect(listQuestionBody({ question: tight, why: 'Det avgör kontot.' }, { locale })).toBe(tight)
      const over = 'q'.repeat(INTERACTIVE_BODY_MAX + 100)
      expect(listQuestionBody({ question: over, why: null }, { locale })).toBe(over)
    })

    it(`${locale}: keeps the closing line when the question alone leaves room for it`, () => {
      const question = 'q'.repeat(INTERACTIVE_BODY_MAX - closing.length - 2)
      const body = listQuestionBody({ question, why: 'Det avgör kontot.' }, { locale })
      expect(body).toBe(`${question}\n\n${closing}`)
      expect(body.length).toBe(INTERACTIVE_BODY_MAX)
    })

    it(`${locale}: stays within the limit for the longest question and why the list holds`, () => {
      const body = listQuestionBody({ question: 'q'.repeat(500), why: 'w'.repeat(500) }, { locale })
      expect(body.length).toBeLessThanOrEqual(INTERACTIVE_BODY_MAX)
      expect(body.startsWith('q'.repeat(500))).toBe(true)
      expect(body.endsWith(closing)).toBe(true)
    })
  }

  it('writes in Swedish unless told otherwise', () => {
    expect(listQuestionBody({ question: 'Gäller hyran kontoret?', why: null })).toBe(`Gäller hyran kontoret?\n\n${CLOSING.sv}`)
  })

  for (const locale of ['sv', 'en'] as const) {
    const closing = CLOSING[locale]

    it(`${locale}: starts with the company's name in bold on a line of its own when one is given`, () => {
      expect(listQuestionBody({ question: 'Gäller hyran kontoret?', why: 'Det avgör kontot.' }, { company: COMPANY_NAME, locale })).toBe(
        `*${COMPANY_NAME}*\nGäller hyran kontoret?\nDet avgör kontot.\n\n${closing}`,
      )
      expect(listQuestionBody({ question: 'Gäller hyran kontoret?', why: null }, { company: COMPANY_NAME, locale })).toBe(
        `*${COMPANY_NAME}*\nGäller hyran kontoret?\n\n${closing}`,
      )
    })

    it(`${locale}: leaves the name line out when no name is given`, () => {
      for (const company of [null, undefined, '', '   ']) {
        expect(listQuestionBody({ question: 'Gäller hyran kontoret?', why: null }, { company, locale })).toBe(`Gäller hyran kontoret?\n\n${closing}`)
      }
    })

    it(`${locale}: with a long company name, leaves the why out first, then the closing line, and keeps the name and the question whole`, () => {
      const company = `${'Långa Exempelbolaget '.repeat(9)}AB`
      const head = `*${company}*\n`
      const question = 'q'.repeat(500)

      // Name, question, why and closing line fit: all of it goes out.
      const shortWhy = 'w'.repeat(INTERACTIVE_BODY_MAX - head.length - question.length - '\n'.length - '\n\n'.length - closing.length)
      const whole = listQuestionBody({ question, why: shortWhy }, { company, locale })
      expect(whole).toBe(`${head}${question}\n${shortWhy}\n\n${closing}`)
      expect(whole.length).toBe(INTERACTIVE_BODY_MAX)

      // One character more: the why goes first.
      const withoutWhy = listQuestionBody({ question, why: `${shortWhy}w` }, { company, locale })
      expect(withoutWhy).toBe(`${head}${question}\n\n${closing}`)
      expect(withoutWhy.length).toBeLessThanOrEqual(INTERACTIVE_BODY_MAX)

      // No room for the closing line beside the name and the question: it goes next.
      const tight = 'q'.repeat(INTERACTIVE_BODY_MAX - head.length - closing.length - 1)
      expect(listQuestionBody({ question: tight, why: 'Det avgör kontot.' }, { company, locale })).toBe(`${head}${tight}`)

      // The name and the question are never cut, whatever their length.
      const over = 'q'.repeat(INTERACTIVE_BODY_MAX)
      expect(listQuestionBody({ question: over, why: null }, { company, locale })).toBe(`${head}${over}`)
    })
  }

  it('keeps the name on one bold line: asterisks and line breaks in it are taken out', () => {
    expect(listQuestionBody({ question: 'Gäller hyran kontoret?', why: null }, { company: ' Bolag *A*\nAB ' })).toBe(
      `*Bolag A AB*\nGäller hyran kontoret?\n\n${CLOSING.sv}`,
    )
  })
})

describe('sendListQuestion: when a question is sent', () => {
  it('sends the question, then the why on its own line, with the options in order and "Vet inte"', async () => {
    const { supabase, writes } = db()

    expect(await sendListQuestion(supabase, offer())).toBe('sent')

    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    const message = sendButtonsMock.mock.calls[0][1]
    expect(message.to).toBe(PHONE)
    expect(message.template).toBe(TEMPLATE.m23ListQuestion)
    expect(message.body).toBe(
      'Gäller hyran på 12 000 kr kontoret eller lagret?\nSvaret avgör vilket konto hyran bokförs på.\n\nDu kan också svara med egna ord.',
    )
    expect(message.buttons).toEqual([
      { id: `cq:${COMPANY}:${QUESTION_ID}:o:office`, title: 'Kontoret' },
      { id: `cq:${COMPANY}:${QUESTION_ID}:o:storage`, title: 'Lagret' },
      { id: `cq:${COMPANY}:${QUESTION_ID}:k`, title: 'Vet inte' },
    ])
    expect(message.phoneLinkId).toBe('link-1')
    expect(message.conversationId).toBe('conv-1')
    expect(message.senderPhoneHash).toBe('hash-1')
    // The plaintext phone goes to the send and nowhere else.
    expect(JSON.stringify(writes)).not.toContain(PHONE)
    expect(JSON.stringify(historyMock.mock.calls)).not.toContain(PHONE)
  })

  it('holds the question in the conversation before the send, on a conversation that stays idle', async () => {
    const { supabase, writes } = db()
    let writtenBeforeSend: ConversationWrite[] = []
    sendButtonsMock.mockImplementation(async () => {
      writtenBeforeSend = conversationWrites(writes)
      return SENT
    })

    await sendListQuestion(supabase, offer())

    expect(writtenBeforeSend).toHaveLength(1)
    const [written] = writtenBeforeSend
    expect(written.state).toBeUndefined()
    expect(written.context?.pending_question).toEqual({
      type: 'list_question',
      inbox_item_id: null,
      asked_at: NOW.toISOString(),
      question_id: QUESTION_ID,
      company_id: COMPANY,
    })
    expect(written.context?.list_question_budget).toEqual({ day_key: todayIsoStockholm(NOW), count: 1 })
    // The receipt questions' own counter is not touched.
    expect(written.context?.budget).toBeUndefined()
    expect(written.last_outbound_at).toBe(NOW.toISOString())
  })

  it('records the question as asked in the processing history', async () => {
    const { supabase } = db()
    await sendListQuestion(supabase, offer())
    expect(historyMock).toHaveBeenCalledTimes(1)
    expect(historyMock.mock.calls[0][0]).toMatchObject({
      companyId: COMPANY,
      aggregateType: 'System',
      aggregateId: QUESTION_ID,
      eventType: 'ChannelQuestionAsked',
      payload: { channel: 'whatsapp', question_id: QUESTION_ID, question_type: 'list_question' },
    })
  })

  it('sends the question and the closing line when it has no why, and leaves "Vet inte" out when it has three options', async () => {
    const { supabase } = db()
    const question = makeQuestion({
      why: null,
      options: [
        { id: 'a', label: 'Ett' },
        { id: 'b', label: 'Två' },
        { id: 'c', label: 'Tre' },
      ],
    })

    await sendListQuestion(supabase, offer({ question }))

    const message = sendButtonsMock.mock.calls[0][1]
    expect(message.body).toBe('Gäller hyran på 12 000 kr kontoret eller lagret?\n\nDu kan också svara med egna ord.')
    expect(message.buttons.map((button) => button.title)).toEqual(['Ett', 'Två', 'Tre'])
  })

  it('sends the longest question the list holds without its why, within the interactive body limit', async () => {
    const { supabase } = db()
    const question = makeQuestion({ question: 'q'.repeat(500), why: 'w'.repeat(500) })

    expect(await sendListQuestion(supabase, offer({ question }))).toBe('sent')

    const message = sendButtonsMock.mock.calls[0][1]
    expect(message.body).toBe(`${'q'.repeat(500)}\n\nDu kan också svara med egna ord.`)
    expect(message.body.length).toBeLessThanOrEqual(INTERACTIVE_BODY_MAX)
  })

  it('sends a question without options with "Vet inte" alone', async () => {
    const { supabase } = db()
    await sendListQuestion(supabase, offer({ question: makeQuestion({ options: [] }) }))
    expect(sendButtonsMock.mock.calls[0][1].buttons).toEqual([{ id: `cq:${COMPANY}:${QUESTION_ID}:k`, title: 'Vet inte' }])
  })

  const notSent: Array<[string, () => { args: Parameters<typeof sendListQuestion>[1]; role?: string | null; archived?: boolean }]> = [
    ['the question list is not switched on for the company', () => ({ args: offer({ companyId: OTHER_COMPANY }) })],
    ['the question is answered', () => ({ args: offer({ question: makeQuestion({ status: 'answered' }) }) })],
    ['the question is closed', () => ({ args: offer({ question: makeQuestion({ status: 'closed', close_reason: 'settled' }) }) })],
    ['the person is not a member of the company', () => ({ args: offer(), role: null })],
    ['the person only reads the books', () => ({ args: offer(), role: 'viewer' })],
    ['the person only invoices', () => ({ args: offer(), role: 'invoicer' })],
    ['the company is archived', () => ({ args: offer(), archived: true })],
    ['the link is revoked', () => ({ args: offer({ link: makeLink({ revoked_at: '2026-11-19T00:00:00.000Z' }) }) })],
    ['the link is paused', () => ({ args: offer({ link: makeLink({ muted_at: '2026-11-19T00:00:00.000Z' }) }) })],
    ['the service window is closed', () => ({ args: offer({ conversation: makeConversation({ service_window_expires_at: new Date(NOW.getTime() - 1000).toISOString() }) }) })],
    ['there has never been a service window', () => ({ args: offer({ conversation: makeConversation({ service_window_expires_at: null }) }) })],
    ['a receipt question is in flight', () => ({
      args: offer({
        conversation: makeConversation({
          state: 'awaiting_representation',
          context: { pending_question: { type: 'representation', inbox_item_id: 'item-1', asked_at: NOW.toISOString() } },
        }),
      }),
    })],
    ['a receipt question waits in the queue', () => ({
      args: offer({ conversation: makeConversation({ context: { question_queue: [{ type: 'context', inbox_item_id: 'item-2' }] } }) }),
    })],
    ['the company choice is asked', () => ({
      args: offer({
        conversation: makeConversation({
          state: 'awaiting_company',
          context: {
            pending_question: { type: 'company', inbox_item_id: null, asked_at: NOW.toISOString() },
            company_options: [{ id: COMPANY, name: 'A AB' }, { id: OTHER_COMPANY, name: 'B AB' }],
          },
        }),
      }),
    })],
    ['the company choice still takes a late answer', () => ({
      args: offer({ conversation: makeConversation({ context: { company_options: [{ id: COMPANY, name: 'A AB' }, { id: OTHER_COMPANY, name: 'B AB' }] } }) }),
    })],
    ['another list question is in flight', () => ({
      args: offer({ conversation: makeConversation({ context: pendingContext(5 * 60 * 1000, OTHER_QUESTION_ID) }) }),
    })],
    ['a burst waits for its ack', () => ({ args: offer({ conversation: makeConversation({ pending_ack: true }) }) })],
    ['the day has no question left: receipt questions used it', () => ({
      args: offer({ conversation: makeConversation({ context: { budget: { day_key: todayIsoStockholm(NOW), count: MAX_QUESTIONS_PER_DAY } } }) }),
    })],
    ['the day has no question left: list questions used it', () => ({
      args: offer({
        conversation: makeConversation({ context: { list_question_budget: { day_key: todayIsoStockholm(NOW), count: MAX_QUESTIONS_PER_DAY } } }),
      }),
    })],
    ['the day has no question left: receipt and list questions together used it', () => ({
      args: offer({
        conversation: makeConversation({
          context: {
            budget: { day_key: todayIsoStockholm(NOW), count: MAX_QUESTIONS_PER_DAY - 2 },
            list_question_budget: { day_key: todayIsoStockholm(NOW), count: 2 },
          },
        }),
      }),
    })],
    ['the burst has no question left', () => ({
      args: offer({ usesBurstSlot: true, conversation: makeConversation({ context: { list_question_slots: 0 } }) }),
    })],
    ['the burst never recorded a slot', () => ({ args: offer({ usesBurstSlot: true }) })],
  ]

  it.each(notSent)('sends nothing and writes nothing when %s', async (_name, build) => {
    const { args, role, archived } = build()
    const { supabase, writes } = db({ role, archived, conversation: args.conversation, link: args.link })

    expect(await sendListQuestion(supabase, args)).toBe('not_sent')

    expect(sendButtonsMock).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
    expect(writes).toEqual([])
    expect(historyMock).not.toHaveBeenCalled()
  })

  it.each(['owner', 'admin', 'member'])('sends to a member with the bookkeeping role %s', async (role) => {
    const { supabase } = db({ role })
    expect(await sendListQuestion(supabase, offer())).toBe('sent')
  })

  it('counts yesterday\'s questions as none today', async () => {
    const { supabase } = db()
    const conversation = makeConversation({
      context: {
        budget: { day_key: '2026-11-19', count: MAX_QUESTIONS_PER_DAY },
        list_question_budget: { day_key: '2026-11-19', count: MAX_QUESTIONS_PER_DAY },
      },
    })
    expect(await sendListQuestion(supabase, offer({ conversation }))).toBe('sent')
  })

  it('sends the last question of the day when five were asked, receipt and list questions together', async () => {
    const { supabase, writes } = db()
    const conversation = makeConversation({
      context: {
        budget: { day_key: todayIsoStockholm(NOW), count: 3 },
        list_question_budget: { day_key: todayIsoStockholm(NOW), count: 2 },
      },
    })

    expect(await sendListQuestion(supabase, offer({ conversation }))).toBe('sent')

    const written = conversationWrites(writes)[0].context
    expect(written?.list_question_budget?.count).toBe(3)
    expect(written?.budget?.count).toBe(3)
  })

  it('takes one of the burst\'s slots when it is sent after a burst', async () => {
    const { supabase, writes } = db()
    const conversation = makeConversation({ context: { list_question_slots: 2 } })

    expect(await sendListQuestion(supabase, offer({ conversation, usesBurstSlot: true }))).toBe('sent')

    expect(conversationWrites(writes)[0].context?.list_question_slots).toBe(1)
  })

  it('takes the place of a list question that has expired, and remembers it as expired', async () => {
    const { supabase, writes } = db()
    const conversation = makeConversation({ context: pendingContext(QUESTION_TTL_MS + 1000, OTHER_QUESTION_ID) })

    expect(await sendListQuestion(supabase, offer({ conversation }))).toBe('sent')

    const written = conversationWrites(writes)[0].context
    expect(written?.pending_question?.question_id).toBe(QUESTION_ID)
    expect(written?.list_questions_expired).toEqual([OTHER_QUESTION_ID])
  })

  it('takes the question back when the send fails: the slot is free, the day and the burst get their count back', async () => {
    sendButtonsMock.mockResolvedValue(SEND_FAILED)
    const { supabase, writes } = db()
    const conversation = makeConversation({
      context: {
        list_question_slots: 2,
        budget: { day_key: todayIsoStockholm(NOW), count: 3 },
        list_question_budget: { day_key: todayIsoStockholm(NOW), count: 1 },
      },
    })

    expect(await sendListQuestion(supabase, offer({ conversation, usesBurstSlot: true }))).toBe('send_failed')

    const [held, takenBack] = conversationWrites(writes)
    expect(held.context?.pending_question?.question_id).toBe(QUESTION_ID)
    expect(held.context?.list_question_budget?.count).toBe(2)
    expect(held.context?.list_question_slots).toBe(1)
    expect(takenBack.context?.pending_question).toBeUndefined()
    expect(takenBack.context?.list_question_budget?.count).toBe(1)
    expect(takenBack.context?.list_question_slots).toBe(2)
    // The receipt questions' counter stays where it was throughout.
    expect(held.context?.budget?.count).toBe(3)
    expect(takenBack.context?.budget?.count).toBe(3)
    expect(conversationWrites(writes)).toHaveLength(2)
    // Nothing else is tried, and nothing is recorded as asked.
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock).not.toHaveBeenCalled()
    expect(historyMock).not.toHaveBeenCalled()
  })

  it('sends nothing when the link has no phone left to decrypt', async () => {
    const { supabase, writes } = db()
    expect(await sendListQuestion(supabase, offer({ link: makeLink({ phone_enc: '' }) }))).toBe('not_sent')
    expect(sendButtonsMock).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })
})

describe('conversationTakesListQuestion', () => {
  it('takes one on an idle conversation with an open window', () => {
    expect(conversationTakesListQuestion(makeConversation(), makeLink(), { usesBurstSlot: false, now: NOW })).toBe(true)
  })

  it('takes one after a burst only while the burst has a slot left', () => {
    const link = makeLink()
    expect(conversationTakesListQuestion(makeConversation({ context: { list_question_slots: 1 } }), link, { usesBurstSlot: true, now: NOW })).toBe(true)
    expect(conversationTakesListQuestion(makeConversation({ context: { list_question_slots: 0 } }), link, { usesBurstSlot: true, now: NOW })).toBe(false)
  })
})

describe('the 48 hours', () => {
  it('keeps a list question in flight for 48 hours and not a moment longer', () => {
    const fresh = makeConversation({ context: pendingContext(QUESTION_TTL_MS) })
    const old = makeConversation({ context: pendingContext(QUESTION_TTL_MS + 1) })
    expect(pendingListQuestion(fresh, NOW)).toEqual({
      questionId: QUESTION_ID,
      companyId: COMPANY,
      askedAt: new Date(NOW.getTime() - QUESTION_TTL_MS).toISOString(),
    })
    expect(pendingListQuestion(old, NOW)).toBeNull()
  })

  it('has no list question in flight for a reply once the list is switched off for its company', () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', OTHER_COMPANY)
    expect(pendingListQuestion(makeConversation({ context: pendingContext() }), NOW)).toBeNull()
  })

  it('has no list question in flight while a receipt question or the company choice holds the conversation', () => {
    expect(pendingListQuestion(makeConversation({ state: 'awaiting_context', context: pendingContext() }), NOW)).toBeNull()
    expect(
      pendingListQuestion(
        makeConversation({ context: { pending_question: { type: 'representation', inbox_item_id: 'item-1', asked_at: NOW.toISOString() } } }),
        NOW,
      ),
    ).toBeNull()
  })

  it('expires a list question past 48 hours without a message: out of the conversation, remembered there, recorded', async () => {
    const expired = makeConversation({ context: { ...pendingContext(QUESTION_TTL_MS + HOUR), list_question_slots: 1 } })
    const mock = createTableMockSupabase({ whatsapp_conversations: { data: [expired] } })

    const count = await expireListQuestions(mock.supabase as unknown as SupabaseClient, NOW.getTime())

    expect(count).toBe(1)
    expect(mock.findCalls('whatsapp_conversations', 'eq')).toContainEqual(['context->pending_question->>type', 'list_question'])
    expect(mock.findCalls('whatsapp_conversations', 'lt')).toEqual([
      ['context->pending_question->>asked_at', new Date(NOW.getTime() - QUESTION_TTL_MS).toISOString()],
    ])
    const [written] = mock.payloads('whatsapp_conversations', 'update') as ConversationWrite[]
    expect(written.context?.pending_question).toBeUndefined()
    expect(written.context?.list_questions_expired).toEqual([QUESTION_ID])
    expect(written.context?.list_question_slots).toBe(1)
    expect(written.state).toBeUndefined()
    expect(historyMock.mock.calls[0][0]).toMatchObject({ companyId: COMPANY, aggregateId: QUESTION_ID, eventType: 'ChannelQuestionExpired' })
    // Nothing is sent, and the question itself is not touched.
    expect(sendButtonsMock).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
    expect(mock.tables()).not.toContain('company_questions')
    expect(answerMock).not.toHaveBeenCalled()
    expect(closeMock).not.toHaveBeenCalled()
  })

  it('leaves a list question inside its 48 hours where it is', async () => {
    const mock = createTableMockSupabase({ whatsapp_conversations: { data: [makeConversation({ context: pendingContext(HOUR) })] } })
    expect(await expireListQuestions(mock.supabase as unknown as SupabaseClient, NOW.getTime())).toBe(0)
    expect(mock.payloads('whatsapp_conversations', 'update')).toEqual([])
    expect(historyMock).not.toHaveBeenCalled()
  })

  it('throws when the scan cannot be read', async () => {
    const mock = createTableMockSupabase({ whatsapp_conversations: { error: { message: 'statement timeout' } } })
    await expect(expireListQuestions(mock.supabase as unknown as SupabaseClient, NOW.getTime())).rejects.toThrow('statement timeout')
  })
})

describe('after a burst', () => {
  const burst = (admitted: number, companyIds: (string | null)[] = [COMPANY]) => ({ admitted, companyIds })

  it('reads nothing when the list is not switched on for a company the burst filed into', async () => {
    const { supabase, mock } = db()
    await offerListQuestionAfterBurst(supabase, 'conv-1', burst(0, [OTHER_COMPANY, null]))
    expect(mock.supabase.from).not.toHaveBeenCalled()
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })

  it('sends the oldest open question when the burst asked nothing of its own, and leaves one slot', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion(), makeQuestion({ question_id: OTHER_QUESTION_ID })]))
    const { supabase, writes } = db()

    await offerListQuestionAfterBurst(supabase, 'conv-1', burst(0))

    expect(listMock).toHaveBeenCalledWith(supabase, [COMPANY])
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect(sendButtonsMock.mock.calls[0][1].buttons[0].id).toBe(`cq:${COMPANY}:${QUESTION_ID}:o:office`)
    const [recorded, held] = conversationWrites(writes)
    expect(recorded.context?.list_question_slots).toBe(2)
    expect(held.context?.list_question_slots).toBe(1)
    expect(held.context?.pending_question?.question_id).toBe(QUESTION_ID)
  })

  it('sends nothing when the burst admitted two questions of its own', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    const { supabase, writes } = db({ conversation: makeConversation({ context: { list_question_slots: 2 } }) })

    await offerListQuestionAfterBurst(supabase, 'conv-1', burst(2))

    expect(conversationWrites(writes).map((write) => write.context?.list_question_slots)).toEqual([0])
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })

  it('keeps the slot the burst leaves while the burst\'s own question is in flight', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    const conversation = makeConversation({
      state: 'awaiting_representation',
      context: { pending_question: { type: 'representation', inbox_item_id: 'item-1', asked_at: NOW.toISOString() } },
    })
    const { supabase, writes } = db({ conversation })

    await offerListQuestionAfterBurst(supabase, 'conv-1', burst(1))

    expect(conversationWrites(writes).map((write) => write.context?.list_question_slots)).toEqual([1])
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })

  it('does not send a question that expired in this conversation again, and takes the next one', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion(), makeQuestion({ question_id: OTHER_QUESTION_ID, options: [] })]))
    const { supabase } = db({ conversation: makeConversation({ context: { list_questions_expired: [QUESTION_ID] } }) })

    await offerListQuestionAfterBurst(supabase, 'conv-1', burst(0))

    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect(sendButtonsMock.mock.calls[0][1].buttons).toEqual([{ id: `cq:${COMPANY}:${OTHER_QUESTION_ID}:k`, title: 'Vet inte' }])
  })

  it('sends nothing when every open question has expired here, or none is open', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    const first = db({ conversation: makeConversation({ context: { list_questions_expired: [QUESTION_ID] } }) })
    await offerListQuestionAfterBurst(first.supabase, 'conv-1', burst(0))

    listMock.mockResolvedValue([])
    const second = db()
    await offerListQuestionAfterBurst(second.supabase, 'conv-1', burst(0))

    expect(sendButtonsMock).not.toHaveBeenCalled()
  })

  it('never throws: a failed read is logged and nothing is sent', async () => {
    listMock.mockRejectedValue(new Error('boom'))
    const { supabase } = db()
    await expect(offerListQuestionAfterBurst(supabase, 'conv-1', burst(0))).resolves.toBeUndefined()
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })

  it('stays with the company the conversation is routed to: only its questions are read', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    routedMock.mockResolvedValue({ companyId: COMPANY, via: 'pin' })
    const { supabase } = db({ memberships: [membership(COMPANY, COMPANY_NAME), membership(OTHER_COMPANY, OTHER_COMPANY_NAME)] })

    await offerListQuestionAfterBurst(supabase, 'conv-1', burst(0))

    expect(listMock).toHaveBeenCalledTimes(1)
    expect(listMock).toHaveBeenCalledWith(supabase, [COMPANY])
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })

  it('sends nothing after a burst when the conversation is routed nowhere, or to a company the person only reads', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    routedMock.mockResolvedValue(null)
    const nowhere = db({ memberships: [membership(COMPANY, COMPANY_NAME), membership(OTHER_COMPANY, OTHER_COMPANY_NAME)] })
    await offerListQuestionAfterBurst(nowhere.supabase, 'conv-1', burst(0))

    routedMock.mockResolvedValue({ companyId: OTHER_COMPANY, via: 'pin' })
    const reader = db({ memberships: [membership(COMPANY, COMPANY_NAME), membership(OTHER_COMPANY, OTHER_COMPANY_NAME, { role: 'viewer' })] })
    await offerListQuestionAfterBurst(reader.supabase, 'conv-1', burst(0, [OTHER_COMPANY]))

    expect(listMock).not.toHaveBeenCalled()
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })

  it('names the company after a burst too, for a person who keeps the books of several', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    const { supabase } = db({ memberships: [membership(COMPANY, COMPANY_NAME), membership(OTHER_COMPANY, OTHER_COMPANY_NAME)] })

    await offerListQuestionAfterBurst(supabase, 'conv-1', burst(0))

    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect(sendButtonsMock.mock.calls[0][1].body.startsWith(`*${COMPANY_NAME}*\n`)).toBe(true)
  })
})

describe('when the conversation\'s questions are done', () => {
  it('sends the next open question against the slot the burst left', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    const { supabase, writes } = db({ conversation: makeConversation({ context: { list_question_slots: 1 } }) })

    await offerListQuestionWhenDone(supabase, 'conv-1')

    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect(conversationWrites(writes)[0].context?.list_question_slots).toBe(0)
  })

  it('sends nothing when the burst has no slot left', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    const { supabase } = db({ conversation: makeConversation({ context: { list_question_slots: 0 } }) })
    await offerListQuestionWhenDone(supabase, 'conv-1')
    expect(sendButtonsMock).not.toHaveBeenCalled()
    expect(listMock).not.toHaveBeenCalled()
  })

  it('reads nothing while the list is switched on for nobody', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '')
    const { supabase, mock } = db()
    await offerListQuestionWhenDone(supabase, 'conv-1')
    expect(mock.supabase.from).not.toHaveBeenCalled()
  })

  it('sends nothing when the conversation is routed to a company without the list', async () => {
    routedMock.mockResolvedValue({ companyId: OTHER_COMPANY, via: 'pin' })
    const { supabase } = db({ conversation: makeConversation({ context: { list_question_slots: 1 } }) })
    await offerListQuestionWhenDone(supabase, 'conv-1')
    expect(listMock).not.toHaveBeenCalled()
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })
})

describe('a text that would get the fallback reply', () => {
  const onText = (supabase: SupabaseClient, link: WhatsAppPhoneLink = makeLink()) => offerListQuestionOnText(supabase, 'conv-1', link)

  it('gets the oldest open question of the routed company, without a burst slot', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion(), makeQuestion({ question_id: OTHER_QUESTION_ID })]))
    const { supabase, writes } = db()

    expect(await onText(supabase)).toBe('sent')

    expect(listMock).toHaveBeenCalledWith(supabase, [COMPANY])
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect(sendButtonsMock.mock.calls[0][1].buttons).toEqual([
      { id: `cq:${COMPANY}:${QUESTION_ID}:o:office`, title: 'Kontoret' },
      { id: `cq:${COMPANY}:${QUESTION_ID}:o:storage`, title: 'Lagret' },
      { id: `cq:${COMPANY}:${QUESTION_ID}:k`, title: 'Vet inte' },
    ])
    const [held] = conversationWrites(writes)
    expect(held.context?.pending_question).toMatchObject({ type: 'list_question', question_id: QUESTION_ID, company_id: COMPANY })
    expect(held.context?.list_question_budget).toEqual({ day_key: todayIsoStockholm(NOW), count: 1 })
    expect(held.context?.list_question_slots).toBeUndefined()
    expect(held.state).toBeUndefined()
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('holds the question in the conversation before the send', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    const { supabase, writes } = db()
    let heldBeforeSend = 0
    sendButtonsMock.mockImplementation(async () => {
      heldBeforeSend = conversationWrites(writes).length
      return SENT
    })

    await onText(supabase)

    expect(heldBeforeSend).toBe(1)
  })

  it('is sent with no burst slot left, and leaves the slots as they are', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    const { supabase, writes } = db({ conversation: makeConversation({ context: { list_question_slots: 0 } }) })

    expect(await onText(supabase)).toBe('sent')

    expect(conversationWrites(writes)[0].context?.list_question_slots).toBe(0)
  })

  it('passes by a question that expired in this conversation and takes the next one', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion(), makeQuestion({ question_id: OTHER_QUESTION_ID, options: [] })]))
    const { supabase } = db({ conversation: makeConversation({ context: { list_questions_expired: [QUESTION_ID] } }) })

    expect(await onText(supabase)).toBe('sent')

    expect(sendButtonsMock.mock.calls[0][1].buttons).toEqual([{ id: `cq:${COMPANY}:${OTHER_QUESTION_ID}:k`, title: 'Vet inte' }])
  })

  const noQuestion: Array<[string, () => { conversation?: WhatsAppConversation; link?: WhatsAppPhoneLink; role?: string | null; open?: CompanyQuestion[] }]> = [
    ['no question is open', () => ({ open: [] })],
    ['the only open question expired in this conversation', () => ({ conversation: makeConversation({ context: { list_questions_expired: [QUESTION_ID] } }) })],
    ['the link is paused', () => ({ link: makeLink({ muted_at: '2026-11-19T00:00:00.000Z' }) })],
    ['the link is revoked', () => ({ link: makeLink({ revoked_at: '2026-11-19T00:00:00.000Z' }) })],
    ['the service window is closed', () => ({ conversation: makeConversation({ service_window_expires_at: new Date(NOW.getTime() - 1000).toISOString() }) })],
    ['the person only reads the books', () => ({ role: 'viewer' })],
    ['a receipt question is in flight', () => ({
      conversation: makeConversation({
        state: 'awaiting_context',
        context: { pending_question: { type: 'context', inbox_item_id: 'item-1', asked_at: NOW.toISOString() } },
      }),
    })],
    ['a receipt question waits in the queue', () => ({
      conversation: makeConversation({ context: { question_queue: [{ type: 'context', inbox_item_id: 'item-2' }] } }),
    })],
    ['the company choice is asked', () => ({
      conversation: makeConversation({
        state: 'awaiting_company',
        context: { company_options: [{ id: COMPANY, name: 'A AB' }, { id: OTHER_COMPANY, name: 'B AB' }] },
      }),
    })],
    ['the company choice still takes a late answer', () => ({
      conversation: makeConversation({ context: { company_options: [{ id: COMPANY, name: 'A AB' }, { id: OTHER_COMPANY, name: 'B AB' }] } }),
    })],
    ['another list question is in flight', () => ({ conversation: makeConversation({ context: pendingContext(5 * 60 * 1000, OTHER_QUESTION_ID) }) })],
    ['a burst waits for its ack', () => ({ conversation: makeConversation({ pending_ack: true }) })],
    ['the day has no question left: receipt questions used it', () => ({
      conversation: makeConversation({ context: { budget: { day_key: todayIsoStockholm(NOW), count: MAX_QUESTIONS_PER_DAY } } }),
    })],
    ['the day has no question left: list questions used it', () => ({
      conversation: makeConversation({ context: { list_question_budget: { day_key: todayIsoStockholm(NOW), count: MAX_QUESTIONS_PER_DAY } } }),
    })],
  ]

  it.each(noQuestion)('sends nothing, writes nothing and leaves the fallback to go out when %s', async (_name, build) => {
    const { conversation, link, role, open } = build()
    listMock.mockResolvedValue(openOf(open ?? [makeQuestion()]))
    const { supabase, writes } = db({ conversation, link, role })

    expect(await onText(supabase, link)).toBe('not_sent')

    expect(sendButtonsMock).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
    expect(writes).toEqual([])
    expect(historyMock).not.toHaveBeenCalled()
  })

  it('sends the question whatever company the conversation is routed to, or to none', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    routedMock.mockResolvedValue({ companyId: OTHER_COMPANY, via: 'pin' })
    const elsewhere = db()
    expect(await onText(elsewhere.supabase)).toBe('sent')

    routedMock.mockResolvedValue(null)
    const nowhere = db()
    expect(await onText(nowhere.supabase)).toBe('sent')

    expect(sendButtonsMock).toHaveBeenCalledTimes(2)
    // One company to choose from: the routing is not read.
    expect(routedMock).not.toHaveBeenCalled()
  })

  it('sends nothing when the list is on for none of the companies the person keeps the books of', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    const { supabase } = db({ memberships: [membership(OTHER_COMPANY, OTHER_COMPANY_NAME), membership(THIRD_COMPANY, 'Bolag C AB')] })

    expect(await onText(supabase)).toBe('not_sent')

    expect(listMock).not.toHaveBeenCalled()
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })

  it('reads nothing while the list is switched on for nobody', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '')
    const { supabase, mock } = db()
    expect(await onText(supabase)).toBe('not_sent')
    expect(mock.supabase.from).not.toHaveBeenCalled()
    expect(routedMock).not.toHaveBeenCalled()
  })

  it('says the send failed, with the question taken back and nothing else sent', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    sendButtonsMock.mockResolvedValue(SEND_FAILED)
    const { supabase, writes } = db()

    expect(await onText(supabase)).toBe('send_failed')

    const [held, takenBack] = conversationWrites(writes)
    expect(held.context?.pending_question?.question_id).toBe(QUESTION_ID)
    expect(takenBack.context?.pending_question).toBeUndefined()
    expect(takenBack.context?.list_question_budget?.count).toBe(0)
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock).not.toHaveBeenCalled()
    expect(historyMock).not.toHaveBeenCalled()
  })

  it('never throws: a read that fails ends as not sent', async () => {
    listMock.mockRejectedValue(new Error('statement timeout'))
    const { supabase, writes } = db()
    await expect(onText(supabase)).resolves.toBe('not_sent')
    expect(sendButtonsMock).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('makes the next written reply the answer: the question it sent is the one in flight', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    const first = db()
    await onText(first.supabase)
    const held: ConversationContext = conversationWrites(first.writes)[0].context ?? {}

    const conversation = makeConversation({ context: held as Record<string, unknown> })
    const inFlight = pendingListQuestion(conversation, NOW)
    expect(inFlight).toMatchObject({ questionId: QUESTION_ID, companyId: COMPANY })

    const second = db({ conversation })
    await applyListQuestionText(second.supabase, {
      link: makeLink(),
      conversation,
      question: { companyId: COMPANY, questionId: QUESTION_ID },
      text: 'Kontoret',
      to: PHONE,
      replyBase,
      announceEnded: true,
    })
    expect(answerMock).toHaveBeenCalledWith(second.supabase, second.supabase, {
      companyId: COMPANY,
      questionId: QUESTION_ID,
      optionId: null,
      text: 'Kontoret',
      userId: USER,
      locale: 'sv',
      door: 'whatsapp',
    })
    expect(conversationWrites(second.writes)[0].context?.pending_question).toBeUndefined()
  })
})

describe('which question a person who keeps the books of several companies gets', () => {
  const onText = (supabase: SupabaseClient, link: WhatsAppPhoneLink = makeLink()) => offerListQuestionOnText(supabase, 'conv-1', link)
  const THIRD_COMPANY_NAME = 'Bolag C AB'
  const three = () => [
    membership(COMPANY, COMPANY_NAME),
    membership(OTHER_COMPANY, OTHER_COMPANY_NAME),
    membership(THIRD_COMPANY, THIRD_COMPANY_NAME),
  ]
  const older = makeQuestion({ question_id: QUESTION_ID, created_at: '2026-11-17T08:00:00.000Z' })
  const newer = makeQuestion({ question_id: OTHER_QUESTION_ID, created_at: '2026-11-19T08:00:00.000Z' })

  it('in three companies with no default company: the question of the one company with the list on, with its name on top', async () => {
    routedMock.mockResolvedValue(null)
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    const { supabase, writes } = db({ memberships: three() })

    expect(await onText(supabase)).toBe('sent')

    expect(listMock).toHaveBeenCalledWith(supabase, [COMPANY])
    const message = sendButtonsMock.mock.calls[0][1]
    expect(message.body).toBe(
      `*${COMPANY_NAME}*\nGäller hyran på 12 000 kr kontoret eller lagret?\nSvaret avgör vilket konto hyran bokförs på.\n\nDu kan också svara med egna ord.`,
    )
    expect(message.buttons.map((button) => button.id)).toEqual([
      `cq:${COMPANY}:${QUESTION_ID}:o:office`,
      `cq:${COMPANY}:${QUESTION_ID}:o:storage`,
      `cq:${COMPANY}:${QUESTION_ID}:k`,
    ])
    expect(conversationWrites(writes)[0].context?.pending_question).toMatchObject({ question_id: QUESTION_ID, company_id: COMPANY })
    // One company with the list on: the routing decides nothing and is not read.
    expect(routedMock).not.toHaveBeenCalled()
  })

  it('puts the questions of the routed company first, though another company has an older one', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    routedMock.mockResolvedValue({ companyId: OTHER_COMPANY, via: 'pin' })
    listMock.mockResolvedValue([
      { companyId: COMPANY, question: older },
      { companyId: OTHER_COMPANY, question: newer },
    ])
    const { supabase, writes } = db({ memberships: three() })

    expect(await onText(supabase)).toBe('sent')

    expect(listMock).toHaveBeenCalledWith(supabase, [COMPANY, OTHER_COMPANY, THIRD_COMPANY])
    const message = sendButtonsMock.mock.calls[0][1]
    expect(message.body.startsWith(`*${OTHER_COMPANY_NAME}*\n`)).toBe(true)
    expect(message.buttons[0].id).toBe(`cq:${OTHER_COMPANY}:${OTHER_QUESTION_ID}:o:office`)
    expect(conversationWrites(writes)[0].context?.pending_question).toMatchObject({ question_id: OTHER_QUESTION_ID, company_id: OTHER_COMPANY })
  })

  it('takes the oldest question of any company when the conversation is routed to none', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    routedMock.mockResolvedValue(null)
    listMock.mockResolvedValue([
      { companyId: THIRD_COMPANY, question: older },
      { companyId: COMPANY, question: newer },
    ])
    const { supabase } = db({ memberships: three() })

    expect(await onText(supabase)).toBe('sent')

    const message = sendButtonsMock.mock.calls[0][1]
    expect(message.body.startsWith(`*${THIRD_COMPANY_NAME}*\n`)).toBe(true)
    expect(message.buttons[0].id).toBe(`cq:${THIRD_COMPANY}:${QUESTION_ID}:o:office`)
  })

  it('goes on to the other companies once the routed company has none left for this conversation', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    routedMock.mockResolvedValue({ companyId: OTHER_COMPANY, via: 'default' })
    listMock.mockResolvedValue([
      { companyId: COMPANY, question: older },
      { companyId: OTHER_COMPANY, question: newer },
    ])
    const { supabase } = db({
      memberships: three(),
      conversation: makeConversation({ context: { list_questions_expired: [OTHER_QUESTION_ID] } }),
    })

    expect(await onText(supabase)).toBe('sent')

    expect(sendButtonsMock.mock.calls[0][1].buttons[0].id).toBe(`cq:${COMPANY}:${QUESTION_ID}:o:office`)
  })

  it('reads the routing as none when it cannot be read, and still sends the oldest question', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    routedMock.mockResolvedValue('transient_error')
    listMock.mockResolvedValue([
      { companyId: COMPANY, question: older },
      { companyId: OTHER_COMPANY, question: newer },
    ])
    const { supabase } = db({ memberships: three() })

    expect(await onText(supabase)).toBe('sent')

    expect(sendButtonsMock.mock.calls[0][1].buttons[0].id).toBe(`cq:${COMPANY}:${QUESTION_ID}:o:office`)
  })

  const contributesNothing: Array<[string, string, () => Record<string, unknown>[]]> = [
    ['with the list switched off', `${COMPANY},${THIRD_COMPANY}`, () => three()],
    ['that is archived', '*', () => [
      membership(COMPANY, COMPANY_NAME),
      membership(OTHER_COMPANY, OTHER_COMPANY_NAME, { archived: true }),
      membership(THIRD_COMPANY, THIRD_COMPANY_NAME),
    ]],
    ['where the person only invoices', '*', () => [
      membership(COMPANY, COMPANY_NAME),
      membership(OTHER_COMPANY, OTHER_COMPANY_NAME, { role: 'invoicer' }),
      membership(THIRD_COMPANY, THIRD_COMPANY_NAME),
    ]],
    ['where the person only reads the books', '*', () => [
      membership(COMPANY, COMPANY_NAME),
      membership(OTHER_COMPANY, OTHER_COMPANY_NAME, { role: 'viewer' }),
      membership(THIRD_COMPANY, THIRD_COMPANY_NAME),
    ]],
  ]

  it.each(contributesNothing)('reads no question of a company %s', async (_name, rollout, memberships) => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', rollout)
    routedMock.mockResolvedValue(null)
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    const { supabase } = db({ memberships: memberships() })

    expect(await onText(supabase)).toBe('sent')

    expect(listMock).toHaveBeenCalledTimes(1)
    expect(listMock).toHaveBeenCalledWith(supabase, [COMPANY, THIRD_COMPANY])
  })

  it('counts only the companies the person keeps the books of: one such company gets the message without a name', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    const { supabase } = db({
      memberships: [
        membership(COMPANY, COMPANY_NAME),
        membership(OTHER_COMPANY, OTHER_COMPANY_NAME, { role: 'viewer' }),
        membership(THIRD_COMPANY, THIRD_COMPANY_NAME, { archived: true }),
      ],
    })

    expect(await onText(supabase)).toBe('sent')

    expect(listMock).toHaveBeenCalledWith(supabase, [COMPANY])
    expect(sendButtonsMock.mock.calls[0][1].body).toBe(
      'Gäller hyran på 12 000 kr kontoret eller lagret?\nSvaret avgör vilket konto hyran bokförs på.\n\nDu kan också svara med egna ord.',
    )
  })

  it('leaves the name line out for a company with no name on record', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    const { supabase } = db({ memberships: [membership(COMPANY, null), membership(OTHER_COMPANY, OTHER_COMPANY_NAME)] })

    expect(await onText(supabase)).toBe('sent')

    expect(sendButtonsMock.mock.calls[0][1].body.startsWith('Gäller hyran')).toBe(true)
  })

  it('sends nothing when the person keeps the books of no company', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    listMock.mockResolvedValue(openOf([makeQuestion()]))
    const { supabase, writes } = db({
      memberships: [membership(COMPANY, COMPANY_NAME, { role: 'viewer' }), membership(OTHER_COMPANY, OTHER_COMPANY_NAME, { role: 'invoicer' })],
    })

    expect(await onText(supabase)).toBe('not_sent')

    expect(listMock).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('ends as not sent, never throwing, when the memberships cannot be read', async () => {
    const mock = createTableMockSupabase({
      whatsapp_conversations: { data: makeConversation() },
      company_members: { error: { message: 'statement timeout' } },
    })
    await expect(onText(mock.supabase as unknown as SupabaseClient)).resolves.toBe('not_sent')
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })
})

describe('when a question is filed', () => {
  const filed = { companyId: COMPANY, questionId: QUESTION_ID }
  const questionRow = {
    id: QUESTION_ID,
    status: 'open',
    close_reason: null,
    question: 'Gäller hyran på 12 000 kr kontoret eller lagret?',
    why: null,
    options: [{ id: 'office', label: 'Kontoret' }],
    evidence: [],
    actor_label: null,
    client: null,
    answer_option: null,
    answer_text: null,
    answered_at: null,
    answered_via: null,
    fact_id: null,
    created_at: '2026-11-20T09:59:00.000Z',
  }

  beforeEach(() => {
    readRowMock.mockResolvedValue(questionRow)
  })

  it('sends it to a member whose window is open, without taking a burst slot', async () => {
    const { supabase, writes } = db()

    await offerFiledListQuestion(supabase, filed)

    expect(readRowMock).toHaveBeenCalledWith(supabase, COMPANY, QUESTION_ID)
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect(sendButtonsMock.mock.calls[0][1].buttons).toEqual([
      { id: `cq:${COMPANY}:${QUESTION_ID}:o:office`, title: 'Kontoret' },
      { id: `cq:${COMPANY}:${QUESTION_ID}:k`, title: 'Vet inte' },
    ])
    expect(conversationWrites(writes)[0].context?.list_question_slots).toBeUndefined()
  })

  it('sends nothing when the window is closed, and does not read the question', async () => {
    const { supabase } = db({ conversation: makeConversation({ service_window_expires_at: new Date(NOW.getTime() - HOUR).toISOString() }) })
    await offerFiledListQuestion(supabase, filed)
    expect(readRowMock).not.toHaveBeenCalled()
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })

  it('sends nothing to a member who only reads the books, and nothing where the list is off', async () => {
    const viewer = db({ role: 'viewer' })
    await offerFiledListQuestion(viewer.supabase, filed)

    const off = db()
    await offerFiledListQuestion(off.supabase, { companyId: OTHER_COMPANY, questionId: QUESTION_ID })
    expect(off.mock.supabase.from).not.toHaveBeenCalled()

    expect(sendButtonsMock).not.toHaveBeenCalled()
  })

  it('sends nothing to a paused or a revoked link', async () => {
    const paused = db({ link: makeLink({ muted_at: '2026-11-19T00:00:00.000Z' }) })
    await offerFiledListQuestion(paused.supabase, filed)
    const revoked = db({ link: makeLink({ revoked_at: '2026-11-19T00:00:00.000Z' }) })
    await offerFiledListQuestion(revoked.supabase, filed)
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })

  it('a person in two companies gets the question of either company, whatever the conversation is routed to, with the company named', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    const twoCompanies = () =>
      db({
        memberships: [membership(COMPANY, COMPANY_NAME), membership(OTHER_COMPANY, OTHER_COMPANY_NAME)],
        link: makeLink({ default_company_id: COMPANY }),
      }).supabase

    await offerFiledListQuestion(twoCompanies(), { companyId: OTHER_COMPANY, questionId: OTHER_QUESTION_ID })
    await offerFiledListQuestion(twoCompanies(), filed)

    expect(sendButtonsMock).toHaveBeenCalledTimes(2)
    const [forOther, forFirst] = sendButtonsMock.mock.calls.map((call) => call[1])
    expect(forOther.body.startsWith(`*${OTHER_COMPANY_NAME}*\n`)).toBe(true)
    expect(forOther.buttons[0].id.startsWith(`cq:${OTHER_COMPANY}:`)).toBe(true)
    expect(forFirst.body.startsWith(`*${COMPANY_NAME}*\n`)).toBe(true)
    expect(forFirst.buttons[0].id.startsWith(`cq:${COMPANY}:`)).toBe(true)
    // The routing is not read for a filed question.
    expect(routedMock).not.toHaveBeenCalled()
  })

  it('sends the question without a company name to a person with one company', async () => {
    const { supabase } = db()
    await offerFiledListQuestion(supabase, filed)
    expect(sendButtonsMock.mock.calls[0][1].body.startsWith('Gäller hyran')).toBe(true)
  })

  it('sends nothing to a member whose company is archived', async () => {
    const { supabase } = db({ archived: true })
    await offerFiledListQuestion(supabase, filed)
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })

  it('never throws: a question that cannot be read sends nothing', async () => {
    readRowMock.mockRejectedValue(codedRefusal('COMPANY_QUESTION_NOT_FOUND', 'No question in this company.'))
    const { supabase } = db()
    await expect(offerFiledListQuestion(supabase, filed)).resolves.toBeUndefined()
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })
})

/**
 * The conversation as the database holds it once a list question was
 * answered in the chat (nothing in the slot), in the shapes where no other
 * question may follow. `open` is what the company's list holds besides.
 */
const nothingFollows: Array<[string, () => { conversation?: WhatsAppConversation; link?: WhatsAppPhoneLink; open?: CompanyQuestion[] }]> = [
  ['no other question is open', () => ({ open: [] })],
  ['the only other open question expired in this conversation', () => ({
    conversation: makeConversation({ context: { list_questions_expired: [OTHER_QUESTION_ID] } }),
  })],
  ['the day has no question left', () => ({
    conversation: makeConversation({
      context: {
        budget: { day_key: todayIsoStockholm(NOW), count: MAX_QUESTIONS_PER_DAY - 2 },
        list_question_budget: { day_key: todayIsoStockholm(NOW), count: 2 },
      },
    }),
  })],
  ['a receipt question waits in the queue', () => ({
    conversation: makeConversation({ context: { question_queue: [{ type: 'context', inbox_item_id: 'item-2' }] } }),
  })],
  ['a receipt question is in flight', () => ({
    conversation: makeConversation({
      state: 'awaiting_representation',
      context: { pending_question: { type: 'representation', inbox_item_id: 'item-1', asked_at: NOW.toISOString() } },
    }),
  })],
  ['a burst waits for its ack', () => ({ conversation: makeConversation({ pending_ack: true }) })],
  ['the link is paused', () => ({ link: makeLink({ muted_at: '2026-11-19T00:00:00.000Z' }) })],
  ['the service window is closed', () => ({
    conversation: makeConversation({ service_window_expires_at: new Date(NOW.getTime() - 1000).toISOString() }),
  })],
]

describe('a tap on a button', () => {
  const optionTap = { companyId: COMPANY, questionId: QUESTION_ID, kind: 'option', optionId: 'office' } satisfies QuestionTap
  const dontKnowTap = { companyId: COMPANY, questionId: QUESTION_ID, kind: 'dont_know' } satisfies QuestionTap
  const openRow = { id: QUESTION_ID, company_id: COMPANY, status: 'open', close_reason: null, answer_option: null, answered_by: null, answered_via: null }
  const tapArgs = (tap: QuestionTap, conversation: WhatsAppConversation | null = makeConversation({ context: pendingContext() })) => ({
    link: makeLink(),
    conversation,
    tap,
    to: PHONE,
    replyBase,
  })

  it('answers with the option through the path the app uses, as the linked person, with the door whatsapp', async () => {
    const { supabase, writes } = db({ questions: [openRow] })

    await applyListQuestionTap(supabase, tapArgs(optionTap))

    expect(answerMock).toHaveBeenCalledTimes(1)
    expect(answerMock).toHaveBeenCalledWith(supabase, supabase, {
      companyId: COMPANY,
      questionId: QUESTION_ID,
      optionId: 'office',
      text: null,
      userId: USER,
      locale: 'sv',
      door: 'whatsapp',
    })
    expect(closeMock).not.toHaveBeenCalled()
    // The slot is free again, and one short line confirms.
    expect(conversationWrites(writes)[0].context?.pending_question).toBeUndefined()
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1]).toMatchObject({ to: PHONE, template: TEMPLATE.m24ListAnswered, body: 'Tack! Svaret är sparat.' })
    expect(historyMock.mock.calls[0][0]).toMatchObject({ aggregateId: QUESTION_ID, eventType: 'ChannelQuestionAnswered' })
  })

  it('closes with dont_know on "Vet inte"', async () => {
    const { supabase } = db({ questions: [openRow] })

    await applyListQuestionTap(supabase, tapArgs(dontKnowTap))

    expect(closeMock).toHaveBeenCalledWith(supabase, {
      companyId: COMPANY,
      questionId: QUESTION_ID,
      reason: 'dont_know',
      userId: USER,
      door: 'whatsapp',
    })
    expect(answerMock).not.toHaveBeenCalled()
    expect(sendTextMock.mock.calls[0][1]).toMatchObject({ template: TEMPLATE.m24ListClosed })
  })

  it('answers an open question that is no longer in flight here', async () => {
    const { supabase } = db({ questions: [openRow] })
    await applyListQuestionTap(supabase, tapArgs(optionTap, makeConversation()))
    expect(answerMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1]).toMatchObject({ template: TEMPLATE.m24ListAnswered })
  })

  it('says in one line that the question was already answered elsewhere, and writes nothing', async () => {
    const answeredElsewhere = { ...openRow, status: 'answered', answer_option: 'storage', answered_by: OTHER_USER, answered_via: 'app' }
    const { supabase, writes } = db({ questions: [answeredElsewhere], conversation: makeConversation() })

    await applyListQuestionTap(supabase, tapArgs(optionTap, makeConversation()))

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1]).toMatchObject({ template: TEMPLATE.m25ListEnded })
    expect(answerMock).not.toHaveBeenCalled()
    expect(closeMock).not.toHaveBeenCalled()
    expect(writes).toEqual([])
    expect(historyMock).not.toHaveBeenCalled()
  })

  it('says the same of a question closed elsewhere, and of one somebody else answered here with the same option', async () => {
    const closed = db({ questions: [{ ...openRow, status: 'closed', close_reason: 'settled', answered_via: 'claude' }] })
    await applyListQuestionTap(closed.supabase, tapArgs(optionTap, makeConversation()))

    const sameOption = db({ questions: [{ ...openRow, status: 'answered', answer_option: 'office', answered_by: OTHER_USER, answered_via: 'whatsapp' }] })
    await applyListQuestionTap(sameOption.supabase, tapArgs(optionTap, makeConversation()))

    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m25ListEnded, TEMPLATE.m25ListEnded])
    expect(answerMock).not.toHaveBeenCalled()
  })

  it('confirms again, and writes nothing, when the same tap is delivered a second time', async () => {
    const own = { ...openRow, status: 'answered', answer_option: 'office', answered_by: USER, answered_via: 'whatsapp' }
    const { supabase } = db({ questions: [own] })

    await applyListQuestionTap(supabase, tapArgs(optionTap, makeConversation()))

    expect(sendTextMock.mock.calls[0][1]).toMatchObject({ template: TEMPLATE.m24ListAnswered })
    expect(answerMock).not.toHaveBeenCalled()
  })

  it('says the question ended when another answer lands between the read and the write', async () => {
    answerMock.mockRejectedValue(codedRefusal('COMPANY_QUESTION_ALREADY_ENDED', 'Question is already answered; a question ends once.'))
    const { supabase } = db({ questions: [openRow] })

    await applyListQuestionTap(supabase, tapArgs(optionTap))

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1]).toMatchObject({ template: TEMPLATE.m25ListEnded })
    expect(historyMock).not.toHaveBeenCalled()
  })

  const dropped: Array<[string, { role: string | null; questions: Record<string, unknown>[] }]> = [
    ['the person does not keep the books of that company', { role: 'viewer', questions: [openRow] }],
    ['the person is not a member of that company', { role: null, questions: [openRow] }],
    ['the question is not in that company', { role: 'owner', questions: [] }],
  ]

  it.each(dropped)('drops the tap without a reply when %s', async (_name, opts) => {
    const { supabase, writes } = db(opts)
    await applyListQuestionTap(supabase, tapArgs(optionTap, makeConversation()))
    expect(answerMock).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('drops the tap without a reply when the membership cannot be read', async () => {
    const mock = createTableMockSupabase({ company_members: { error: { message: 'statement timeout' } } })
    await applyListQuestionTap(mock.supabase as unknown as SupabaseClient, tapArgs(optionTap))
    expect(answerMock).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
    expect(mock.tables()).toEqual(['company_members'])
  })

  it('drops the tap without a read where the list is switched off', async () => {
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', OTHER_COMPANY)
    const { supabase, mock } = db({ questions: [openRow] })
    await applyListQuestionTap(supabase, tapArgs(optionTap))
    expect(mock.supabase.from).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('drops a tap that names an option the question does not have, and leaves the question in flight', async () => {
    answerMock.mockRejectedValue(Object.assign(new Error('option_id "x" is not an option of this question'), { code: 'VALIDATION_ERROR' }))
    const { supabase, writes } = db({ questions: [openRow] })
    await applyListQuestionTap(supabase, tapArgs({ ...optionTap, optionId: 'x' }))
    expect(sendTextMock).not.toHaveBeenCalled()
    expect(historyMock).not.toHaveBeenCalled()
    expect(writes).toEqual([])
  })

  it('takes the question out of the conversation, without a reply, when the core says it is gone', async () => {
    answerMock.mockRejectedValue(codedRefusal('COMPANY_QUESTION_NOT_FOUND', 'No question in this company.'))
    const { supabase, writes } = db({ questions: [openRow] })
    await applyListQuestionTap(supabase, tapArgs(optionTap))
    expect(sendTextMock).not.toHaveBeenCalled()
    expect(conversationWrites(writes)[0].context?.pending_question).toBeUndefined()
  })

  it('sends the next open question after the acknowledgement, with no burst slot', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion({ question_id: OTHER_QUESTION_ID }), makeQuestion({ question_id: QUESTION_ID })]))
    const { supabase, writes } = db({ questions: [openRow] })

    await applyListQuestionTap(supabase, tapArgs(optionTap))

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m24ListAnswered)
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect(sendButtonsMock.mock.calls[0][1].template).toBe(TEMPLATE.m23ListQuestion)
    expect(sendButtonsMock.mock.calls[0][1].buttons[0].id).toBe(`cq:${COMPANY}:${OTHER_QUESTION_ID}:o:office`)
    expect(sendButtonsMock.mock.invocationCallOrder[0]).toBeGreaterThan(sendTextMock.mock.invocationCallOrder[0])
    // The conversation holds the next question, on the day's counter and on no burst slot.
    const held = conversationWrites(writes).at(-1)
    expect(held?.context?.pending_question).toMatchObject({ type: 'list_question', question_id: OTHER_QUESTION_ID })
    expect(held?.context?.list_question_budget).toEqual({ day_key: todayIsoStockholm(NOW), count: 1 })
    expect(held?.context?.list_question_slots).toBeUndefined()
  })

  it('sends the next open question with the burst slots used up, and leaves them as they are', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion({ question_id: OTHER_QUESTION_ID })]))
    const { supabase, writes } = db({ questions: [openRow], conversation: makeConversation({ context: { list_question_slots: 0 } }) })

    await applyListQuestionTap(supabase, tapArgs(optionTap))

    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect(conversationWrites(writes).at(-1)?.context?.list_question_slots).toBe(0)
  })

  it('sends the next open question after "Vet inte" too', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion({ question_id: OTHER_QUESTION_ID })]))
    const { supabase } = db({ questions: [openRow] })

    await applyListQuestionTap(supabase, tapArgs(dontKnowTap))

    expect(closeMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m24ListClosed])
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect(sendButtonsMock.mock.calls[0][1].buttons[0].id).toBe(`cq:${COMPANY}:${OTHER_QUESTION_ID}:o:office`)
  })

  it.each(nothingFollows)('sends the acknowledgement and nothing after it when %s', async (_name, build) => {
    const { conversation, link, open } = build()
    listMock.mockResolvedValue(openOf(open ?? [makeQuestion({ question_id: OTHER_QUESTION_ID })]))
    const { supabase } = db({ questions: [openRow], conversation, link })

    await applyListQuestionTap(supabase, { ...tapArgs(optionTap), link: link ?? makeLink() })

    expect(answerMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m24ListAnswered])
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })

  it('sends nothing after a tap on a question that had already ended', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion({ question_id: OTHER_QUESTION_ID })]))
    const { supabase } = db({ questions: [{ ...openRow, status: 'answered', answer_option: 'storage', answered_by: OTHER_USER, answered_via: 'app' }] })

    await applyListQuestionTap(supabase, tapArgs(optionTap, makeConversation()))

    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m25ListEnded])
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })

  it('never fails the answer when the next question cannot be read', async () => {
    listMock.mockRejectedValue(new Error('statement timeout'))
    const { supabase } = db({ questions: [openRow] })

    await expect(applyListQuestionTap(supabase, tapArgs(optionTap))).resolves.toBeUndefined()

    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m24ListAnswered])
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })
})

describe('a written reply to a list question', () => {
  const question = { questionId: QUESTION_ID, companyId: COMPANY }
  const textArgs = (text: string, announceEnded = true) => ({
    link: makeLink(),
    conversation: makeConversation({ context: pendingContext() }),
    question,
    text,
    to: PHONE,
    replyBase,
    announceEnded,
  })

  it('is the answer as written, through the path the app uses, with the door whatsapp', async () => {
    const { supabase, writes } = db()

    await applyListQuestionText(supabase, textArgs('  Kontoret på Storgatan, hela året.  '))

    expect(answerMock).toHaveBeenCalledWith(supabase, supabase, {
      companyId: COMPANY,
      questionId: QUESTION_ID,
      optionId: null,
      text: 'Kontoret på Storgatan, hela året.',
      userId: USER,
      locale: 'sv',
      door: 'whatsapp',
    })
    expect(conversationWrites(writes)[0].context?.pending_question).toBeUndefined()
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1]).toMatchObject({ template: TEMPLATE.m24ListAnswered })
  })

  it.each(['vet inte', 'Vet inte', '  VET INTE  '])('closes with dont_know on exactly "%s"', async (text) => {
    const { supabase } = db()
    await applyListQuestionText(supabase, textArgs(text))
    expect(closeMock).toHaveBeenCalledWith(supabase, { companyId: COMPANY, questionId: QUESTION_ID, reason: 'dont_know', userId: USER, door: 'whatsapp' })
    expect(answerMock).not.toHaveBeenCalled()
    expect(sendTextMock.mock.calls[0][1]).toMatchObject({ template: TEMPLATE.m24ListClosed })
  })

  it('takes a longer sentence that begins with "vet inte" as an answer', async () => {
    const { supabase } = db()
    await applyListQuestionText(supabase, textArgs('Vet inte säkert, troligen lagret'))
    expect(closeMock).not.toHaveBeenCalled()
    expect(answerMock.mock.calls[0][2]).toMatchObject({ text: 'Vet inte säkert, troligen lagret' })
  })

  it('takes 1,000 characters and refuses 1,001 with one line, keeping the question in flight', async () => {
    const atLimit = db()
    await applyListQuestionText(atLimit.supabase, textArgs('x'.repeat(1000)))
    expect(answerMock).toHaveBeenCalledTimes(1)

    vi.clearAllMocks()
    sendTextMock.mockResolvedValue(SENT)
    const over = db()
    await applyListQuestionText(over.supabase, textArgs('x'.repeat(1001)))
    expect(answerMock).not.toHaveBeenCalled()
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1]).toMatchObject({ template: TEMPLATE.m26ListAnswerTooLong })
    expect(sendTextMock.mock.calls[0][1].body).toContain('1000')
    expect(over.writes).toEqual([])
  })

  it('drops the reply and frees the slot when the person no longer keeps the books of the company', async () => {
    const { supabase, writes } = db({ role: 'viewer' })
    await applyListQuestionText(supabase, textArgs('Kontoret'))
    expect(answerMock).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
    expect(conversationWrites(writes)[0].context?.pending_question).toBeUndefined()
  })

  it('says the question ended when it was answered elsewhere in between, once', async () => {
    answerMock.mockRejectedValue(codedRefusal('COMPANY_QUESTION_ALREADY_ENDED', 'Question is already answered; a question ends once.'))
    const first = db()
    await applyListQuestionText(first.supabase, textArgs('Kontoret'))
    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m25ListEnded])

    const retry = db()
    await applyListQuestionText(retry.supabase, textArgs('Kontoret', false))
    expect(sendTextMock).toHaveBeenCalledTimes(1)
  })

  it('passes on a failure that is not a refusal', async () => {
    answerMock.mockRejectedValue(new Error('connection reset'))
    const { supabase } = db()
    await expect(applyListQuestionText(supabase, textArgs('Kontoret'))).rejects.toThrow('connection reset')
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('throws, writing nothing, when the membership cannot be read', async () => {
    const mock = createTableMockSupabase({ company_members: { error: { message: 'statement timeout' } } })
    await expect(applyListQuestionText(mock.supabase as unknown as SupabaseClient, textArgs('Kontoret'))).rejects.toThrow('could not be read')
    expect(answerMock).not.toHaveBeenCalled()
    expect(mock.payloads('whatsapp_conversations', 'update')).toEqual([])
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('sends the next open question after the acknowledgement of a written answer, with no burst slot', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion({ question_id: OTHER_QUESTION_ID })]))
    const { supabase, writes } = db()

    await applyListQuestionText(supabase, textArgs('Kontoret på Storgatan'))

    expect(answerMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m24ListAnswered])
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect(sendButtonsMock.mock.calls[0][1].buttons[0].id).toBe(`cq:${COMPANY}:${OTHER_QUESTION_ID}:o:office`)
    expect(sendButtonsMock.mock.invocationCallOrder[0]).toBeGreaterThan(sendTextMock.mock.invocationCallOrder[0])
    const held = conversationWrites(writes).at(-1)
    expect(held?.context?.pending_question).toMatchObject({ type: 'list_question', question_id: OTHER_QUESTION_ID })
    expect(held?.context?.list_question_slots).toBeUndefined()
  })

  it('sends the next open question after a written "vet inte" too', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion({ question_id: OTHER_QUESTION_ID })]))
    const { supabase } = db()

    await applyListQuestionText(supabase, textArgs('Vet inte'))

    expect(closeMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m24ListClosed])
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect(sendButtonsMock.mock.calls[0][1].buttons[0].id).toBe(`cq:${COMPANY}:${OTHER_QUESTION_ID}:o:office`)
  })

  it.each(nothingFollows)('sends the acknowledgement and nothing after it when %s', async (_name, build) => {
    const { conversation, link, open } = build()
    listMock.mockResolvedValue(openOf(open ?? [makeQuestion({ question_id: OTHER_QUESTION_ID })]))
    const { supabase } = db({ conversation, link })

    await applyListQuestionText(supabase, { ...textArgs('Kontoret på Storgatan'), link: link ?? makeLink() })

    expect(answerMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m24ListAnswered])
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })

  it('sends nothing after a reply that was too long to save', async () => {
    listMock.mockResolvedValue(openOf([makeQuestion({ question_id: OTHER_QUESTION_ID })]))
    const { supabase } = db()

    await applyListQuestionText(supabase, textArgs('x'.repeat(1001)))

    expect(sendTextMock.mock.calls.map((call) => call[1].template)).toEqual([TEMPLATE.m26ListAnswerTooLong])
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })
})

describe('an answer through another door', () => {
  it('takes the question out of every conversation it is in flight in, and sends nothing', async () => {
    const first = makeConversation({ id: 'conv-1', context: { ...pendingContext(), list_question_slots: 1 } })
    const second = makeConversation({ id: 'conv-2', phone_link_id: 'link-2', context: pendingContext() })
    const mock = createTableMockSupabase({ whatsapp_conversations: { data: [first, second] } })

    await clearEndedListQuestion(mock.supabase as unknown as SupabaseClient, QUESTION_ID)

    expect(mock.findCalls('whatsapp_conversations', 'eq')).toContainEqual(['context->pending_question->>question_id', QUESTION_ID])
    const written = mock.payloads('whatsapp_conversations', 'update') as ConversationWrite[]
    expect(written).toHaveLength(2)
    for (const write of written) expect(write.context?.pending_question).toBeUndefined()
    expect(written[0].context?.list_question_slots).toBe(1)
    expect(sendButtonsMock).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('leaves a conversation alone where another question is in flight', async () => {
    const other = makeConversation({ context: pendingContext(5 * 60 * 1000, OTHER_QUESTION_ID) })
    const mock = createTableMockSupabase({ whatsapp_conversations: { data: [other] } })
    await clearEndedListQuestion(mock.supabase as unknown as SupabaseClient, QUESTION_ID)
    expect(mock.payloads('whatsapp_conversations', 'update')).toEqual([])
  })

  it('never throws, and reads nothing for an id that is not a question id', async () => {
    const failing = createTableMockSupabase({ whatsapp_conversations: { error: { message: 'boom' } } })
    await expect(clearEndedListQuestion(failing.supabase as unknown as SupabaseClient, QUESTION_ID)).resolves.toBeUndefined()

    const untouched = createTableMockSupabase()
    await clearEndedListQuestion(untouched.supabase as unknown as SupabaseClient, 'not-an-id')
    expect(untouched.supabase.from).not.toHaveBeenCalled()
  })
})
