/**
 * A staged operation linked to a question (company_question.prepared), as the
 * chat tells it: one message to the person who answered the question in the
 * chat, for the first operation linked to it, under the conditions the other
 * messages about a list question go out under. On a database that answers
 * from rows; only the Graph API and the app's address are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createRowsMockSupabase, type TableMockResolver } from '@/tests/helpers'
import type { EventPayload } from '@/lib/events/types'
import type { ExtensionContext } from '@/lib/extensions/types'
import type { WhatsAppConversation, WhatsAppPhoneLink } from '@/types'

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(),
}))

vi.mock('@/extensions/general/whatsapp-inbox/lib/graph-api', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/whatsapp-inbox/lib/graph-api')
  >('@/extensions/general/whatsapp-inbox/lib/graph-api')
  return { ...actual, sendReplyButtons: vi.fn(), sendText: vi.fn() }
})

vi.mock('@/lib/email/brand-sender', () => ({
  getBaseUrlForCompany: vi.fn(),
}))

vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue('event-1'),
}))

import { whatsappInboxExtension } from '@/extensions/general/whatsapp-inbox'
import { sendReplyButtons, sendText } from '@/extensions/general/whatsapp-inbox/lib/graph-api'
import { listPreparedBody, tellListPrepared } from '@/extensions/general/whatsapp-inbox/lib/list-question'
import { TEMPLATE } from '@/extensions/general/whatsapp-inbox/lib/messages'
import { encryptPhone } from '@/extensions/general/whatsapp-inbox/lib/phone-crypto'
import { getBaseUrlForCompany } from '@/lib/email/brand-sender'

const sendTextMock = vi.mocked(sendText)
const sendButtonsMock = vi.mocked(sendReplyButtons)
const baseUrlMock = vi.mocked(getBaseUrlForCompany)

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const OTHER_COMPANY = 'c0000000-0000-4000-8000-000000000002'
const USER = 'a0000000-0000-4000-8000-000000000001'
const QUESTION_ID = 'e0000000-0000-4000-8000-000000000001'
const OPERATION_ID = '0b000000-0000-4000-8000-000000000002'
// Sorts before OPERATION_ID as text: the order of linking decides, not the id.
const LATER_OPERATION_ID = '0b000000-0000-4000-8000-000000000001'
const PHONE = '46701234567'
const APP = 'https://app.example.test'
const HOUR = 60 * 60 * 1000
const NOW = new Date('2026-11-23T10:00:00.000Z')

const SV_SENTENCE = 'Jag har förberett bokföringen efter ditt svar. Den väntar på ditt godkännande i appen:'
const EN_SENTENCE = 'I have prepared the bookkeeping from your answer. It is waiting for your approval in the app:'

const SENT = { ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null } as const

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

/** The question as its row stands: answered by the person, in the chat. */
const questionRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: QUESTION_ID,
  company_id: COMPANY,
  status: 'answered',
  close_reason: null,
  answered_by: USER,
  answered_via: 'whatsapp',
  answered_at: '2026-11-23T09:50:00.000Z',
  ...overrides,
})

interface Linked {
  operation_id: string
  created_at: string
}

/** The operations linked to the question: OPERATION_ID first, by default alone. */
const linkedFirst: Linked[] = [{ operation_id: OPERATION_ID, created_at: '2026-11-23T09:55:00.000Z' }]

type Chain = Parameters<TableMockResolver>[0]
const filterOn = (chain: Chain, column: string): unknown =>
  chain.find((call) => call.method === 'eq' && call.args[0] === column)?.args[1]

/**
 * company_question_operations as the database orders it: the links of the
 * question the read names, the earliest first, the operation id deciding a
 * tie, cut at the read's limit.
 */
function linksTable(linked: Linked[]): TableMockResolver {
  return (chain) => {
    if (filterOn(chain, 'question_id') !== QUESTION_ID || filterOn(chain, 'company_id') !== COMPANY) return { data: [] }
    const ordered = [...linked].sort(
      (a, b) => a.created_at.localeCompare(b.created_at) || a.operation_id.localeCompare(b.operation_id),
    )
    const limit = chain.find((call) => call.method === 'limit')?.args[0]
    return { data: typeof limit === 'number' ? ordered.slice(0, limit) : ordered }
  }
}

interface Write {
  table: string
  method: string
  row: unknown
}

function world(
  opts: {
    question?: Record<string, unknown> | null
    linked?: Linked[]
    links?: WhatsAppPhoneLink[]
    conversations?: WhatsAppConversation[]
    role?: string | null
    /** Outbound rows already on record. */
    outbound?: Record<string, unknown>[]
    /** The linked operation as its row stands; null for none. Waiting for approval by default. */
    operation?: Record<string, unknown> | null
  } = {},
) {
  const writes: Write[] = []
  const role = opts.role === undefined ? 'owner' : opts.role
  const mock = createRowsMockSupabase(
    {
      company_questions: opts.question === null ? [] : [opts.question ?? questionRow()],
      whatsapp_phone_links: (opts.links ?? [makeLink()]).map((link) => ({ ...link })),
      whatsapp_conversations: (opts.conversations ?? [makeConversation()]).map((conversation) => ({ ...conversation })),
      company_members: role === null ? [] : [{ user_id: USER, company_id: COMPANY, role, companies: { name: 'Bolag A AB' } }],
      whatsapp_messages: opts.outbound ?? [],
      pending_operations: opts.operation === null ? [] : [{ id: OPERATION_ID, company_id: COMPANY, status: 'pending', ...(opts.operation ?? {}) }],
    },
    writes,
  )
  mock.setTable('company_question_operations', linksTable(opts.linked ?? linkedFirst))
  return { supabase: mock.supabase as unknown as SupabaseClient, mock, writes }
}

/** An outbound row of the prepared message for the question, as a read by template and correlation id finds it. */
const toldRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'out-1',
  direction: 'outbound',
  correlation_id: QUESTION_ID,
  'raw_payload->>template': 'm31_list_prepared',
  wamid: 'wamid.EARLIER',
  delivery_status: 'sent',
  ...overrides,
})

const prepared = { companyId: COMPANY, questionId: QUESTION_ID, operationId: OPERATION_ID }

beforeEach(() => {
  vi.resetAllMocks()
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', COMPANY)
  vi.stubEnv('WHATSAPP_PHONE_ENCRYPTION_KEY', 'a'.repeat(64))
  sendTextMock.mockResolvedValue(SENT)
  baseUrlMock.mockResolvedValue(APP)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})

describe('the message that says the bookkeeping is prepared', () => {
  it('is the sentence, then the address of the review list on a line of its own', () => {
    expect(listPreparedBody(APP)).toBe(`${SV_SENTENCE}\n${APP}/pending`)
    expect(listPreparedBody(APP, 'en')).toBe(`${EN_SENTENCE}\n${APP}/pending`)
  })

  it('joins the address to a base that ends in a slash without doubling it', () => {
    expect(listPreparedBody(`${APP}/`)).toBe(`${SV_SENTENCE}\n${APP}/pending`)
    expect(listPreparedBody(`${APP}///`, 'en')).toBe(`${EN_SENTENCE}\n${APP}/pending`)
  })

  it('has its own message id, shared with no other message', () => {
    expect(TEMPLATE.m31ListPrepared).toBe('m31_list_prepared')
    const ids = Object.values(TEMPLATE)
    expect(new Set(ids).size).toBe(ids.length)
  })
})

describe('a staged operation linked to a question that was answered in the chat', () => {
  it('tells the person who answered, once, with the address of the review list', async () => {
    const { supabase, writes } = world()

    await tellListPrepared(supabase, prepared)

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][0]).toBe(supabase)
    expect(sendTextMock.mock.calls[0][1]).toEqual({
      to: PHONE,
      body: `${SV_SENTENCE}\n${APP}/pending`,
      template: 'm31_list_prepared',
      senderPhoneHash: 'hash-1',
      phoneLinkId: 'link-1',
      conversationId: 'conv-1',
      // The question, so that a second delivery of the event finds the message.
      correlationId: QUESTION_ID,
    })
    // The address is the app's own for the company.
    expect(baseUrlMock).toHaveBeenCalledWith(COMPANY)
    // It is not a question: nothing about the conversation is written, and no buttons go out.
    expect(writes).toEqual([])
    expect(sendButtonsMock).not.toHaveBeenCalled()
  })

  it('reads the question, its first link and the person\'s own link, each in its scope', async () => {
    const { supabase, mock } = world()

    await tellListPrepared(supabase, prepared)

    expect(mock.findCalls('company_questions', 'eq')).toEqual([
      ['id', QUESTION_ID],
      ['company_id', COMPANY],
    ])
    expect(mock.findCalls('company_question_operations', 'eq')).toEqual([
      ['company_id', COMPANY],
      ['question_id', QUESTION_ID],
    ])
    expect(mock.findCalls('company_question_operations', 'order')).toEqual([
      ['created_at', { ascending: true }],
      ['operation_id', { ascending: true }],
    ])
    expect(mock.findCalls('company_question_operations', 'limit')).toEqual([[1]])
    expect(mock.findCalls('pending_operations', 'eq')).toEqual([
      ['id', OPERATION_ID],
      ['company_id', COMPANY],
    ])
    expect(mock.findCalls('whatsapp_phone_links', 'eq')).toEqual([['user_id', USER]])
    expect(mock.findCalls('whatsapp_phone_links', 'is')).toEqual([
      ['revoked_at', null],
      ['muted_at', null],
    ])
    expect(mock.findCalls('whatsapp_conversations', 'eq')).toEqual([['phone_link_id', 'link-1']])
  })

  it('sends nothing for an operation that no longer waits for approval, or that is not in the company', async () => {
    for (const status of ['committed', 'committing', 'rejected', 'failed_partial', 'unknown']) {
      const { supabase } = world({ operation: { status } })
      await tellListPrepared(supabase, prepared)
      expect(sendTextMock, status).not.toHaveBeenCalled()
    }
    for (const operation of [null, { company_id: OTHER_COMPANY }]) {
      const { supabase } = world({ operation })
      await tellListPrepared(supabase, prepared)
      expect(sendTextMock).not.toHaveBeenCalled()
    }
  })

  it('sends nothing for a second operation of the same question', async () => {
    const linked: Linked[] = [...linkedFirst, { operation_id: LATER_OPERATION_ID, created_at: '2026-11-23T09:58:00.000Z' }]
    const { supabase } = world({ linked })

    await tellListPrepared(supabase, { ...prepared, operationId: LATER_OPERATION_ID })

    expect(sendTextMock).not.toHaveBeenCalled()
    // The first one is still told when its own event comes.
    await tellListPrepared(supabase, prepared)
    expect(sendTextMock).toHaveBeenCalledTimes(1)
  })

  it('sends nothing for an operation that is not linked to the question', async () => {
    const { supabase } = world({ linked: [] })
    await tellListPrepared(supabase, prepared)
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('sends nothing a second time: a message already on record for the question is found', async () => {
    const { supabase, mock } = world({ outbound: [toldRow()] })

    await tellListPrepared(supabase, prepared)

    expect(sendTextMock).not.toHaveBeenCalled()
    // The read names the question's own messages of this kind, and leaves out a send that was refused.
    expect(mock.findCalls('whatsapp_messages', 'eq')).toEqual([
      ['direction', 'outbound'],
      ['correlation_id', QUESTION_ID],
      ['raw_payload->>template', 'm31_list_prepared'],
    ])
    expect(mock.findCalls('whatsapp_messages', 'or')).toEqual([['wamid.not.is.null,delivery_status.neq.failed']])
  })

  it('is not held back by a message of another kind, or one about another question', async () => {
    const { supabase } = world({
      outbound: [
        toldRow({ id: 'out-2', 'raw_payload->>template': 'm24_list_answered' }),
        toldRow({ id: 'out-3', correlation_id: 'e0000000-0000-4000-8000-000000000009' }),
      ],
    })
    await tellListPrepared(supabase, prepared)
    expect(sendTextMock).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['closed as settled', questionRow({ status: 'closed', close_reason: 'settled', answered_via: 'claude' })],
    ['closed as settled by the person\'s own door', questionRow({ status: 'closed', close_reason: 'settled' })],
    ['answered in the app', questionRow({ answered_via: 'app' })],
    ['answered through an agent connection', questionRow({ answered_via: 'claude' })],
    ['answered with no door on record', questionRow({ answered_via: null })],
    ['answered with no person on record', questionRow({ answered_by: null })],
    ['open again', questionRow({ status: 'open', answered_by: null, answered_via: null, answered_at: null })],
  ])('sends nothing for a question that is %s', async (_how, question) => {
    const { supabase, mock } = world({ question })
    await tellListPrepared(supabase, prepared)
    expect(sendTextMock).not.toHaveBeenCalled()
    // Nothing more is read once the question says no.
    expect(mock.tables()).toEqual(['company_questions'])
  })

  it('sends nothing for a question that is missing or in another company', async () => {
    const missing = world({ question: null })
    await tellListPrepared(missing.supabase, prepared)
    const foreign = world({ question: questionRow({ company_id: OTHER_COMPANY }) })
    await tellListPrepared(foreign.supabase, prepared)
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('sends nothing outside the service window', async () => {
    for (const expires of [new Date(NOW.getTime() - 1000).toISOString(), null]) {
      const { supabase } = world({ conversations: [makeConversation({ service_window_expires_at: expires })] })
      await tellListPrepared(supabase, prepared)
    }
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('sends nothing to a paused link, a revoked link, or a person without a link or a conversation', async () => {
    for (const opts of [
      { links: [makeLink({ muted_at: '2026-11-23T09:59:00.000Z' })] },
      { links: [makeLink({ revoked_at: '2026-11-23T09:59:00.000Z' })] },
      { links: [] },
      { links: [makeLink({ user_id: 'a0000000-0000-4000-8000-000000000002' })] },
      { conversations: [] },
    ]) {
      const { supabase } = world(opts)
      await tellListPrepared(supabase, prepared)
    }
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('sends nothing to a person who no longer keeps the books of the company', async () => {
    for (const role of ['viewer', 'invoicer', null]) {
      const { supabase } = world({ role })
      await tellListPrepared(supabase, prepared)
    }
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('sends nothing when the link has no phone left to send to', async () => {
    const { supabase } = world({ links: [makeLink({ phone_enc: '' })] })
    await tellListPrepared(supabase, prepared)
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('sends nothing, and reads nothing, where the list is not switched on or the question id is not an id', async () => {
    const malformed = world()
    await tellListPrepared(malformed.supabase, { ...prepared, questionId: 'not-an-id' })
    expect(malformed.mock.supabase.from).not.toHaveBeenCalled()

    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', OTHER_COMPANY)
    const off = world()
    await tellListPrepared(off.supabase, prepared)
    expect(off.mock.supabase.from).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it.each(['company_questions', 'company_question_operations', 'whatsapp_phone_links', 'whatsapp_conversations', 'company_members', 'whatsapp_messages'])(
    'sends nothing and does not throw when %s cannot be read',
    async (table) => {
      const { supabase, mock } = world()
      mock.setTable(table, { error: { code: '57014', message: 'canceling statement due to statement timeout' } })

      await expect(tellListPrepared(supabase, prepared)).resolves.toBeUndefined()

      expect(sendTextMock).not.toHaveBeenCalled()
    },
  )

  it('does not throw when the app\'s address cannot be resolved or the send fails', async () => {
    baseUrlMock.mockRejectedValueOnce(new Error('brand lookup failed'))
    await expect(tellListPrepared(world().supabase, prepared)).resolves.toBeUndefined()
    expect(sendTextMock).not.toHaveBeenCalled()

    sendTextMock.mockRejectedValueOnce(new Error('network down'))
    await expect(tellListPrepared(world().supabase, prepared)).resolves.toBeUndefined()
  })
})

describe('company_question.prepared at the extension', () => {
  /** The extension's own handler of the event, as the event bus calls it. */
  const emitPrepared = (supabase: SupabaseClient, operationId: string): Promise<void> | void => {
    const registration = (whatsappInboxExtension.eventHandlers ?? []).find((entry) => entry.eventType === 'company_question.prepared')
    if (!registration) throw new Error('no handler for company_question.prepared')
    const payload: EventPayload<'company_question.prepared'> = { questionId: QUESTION_ID, operationId, userId: USER, companyId: COMPANY }
    return registration.handler(payload, { supabase } as unknown as ExtensionContext)
  }

  it('tells the first operation linked, and nothing for the second', async () => {
    const linked: Linked[] = [...linkedFirst, { operation_id: LATER_OPERATION_ID, created_at: '2026-11-23T09:58:00.000Z' }]
    const { supabase } = world({ linked })

    await emitPrepared(supabase, OPERATION_ID)
    await emitPrepared(supabase, LATER_OPERATION_ID)

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1]).toMatchObject({ template: 'm31_list_prepared', to: PHONE, correlationId: QUESTION_ID })
  })
})
