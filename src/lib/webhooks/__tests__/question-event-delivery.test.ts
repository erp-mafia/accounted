/**
 * The question list events as public events: each of the five, emitted by the
 * write that files, answers, closes or reopens a question, or links a staged
 * operation to one, reaches the webhooks subscribed to its type as a
 * webhook_deliveries row and the event feed as an event_log row. Both carry
 * the question by id and its state (the linked operation by id for a link),
 * and never the text of the question, why it is asked, its options, its
 * evidence, the answer, the operation's title or the actor's user id.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'

const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() }))
vi.mock('@/lib/logger', () => ({ createLogger: () => logMock }))

const serviceClient = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn(() => serviceClient.current) }))

const kick = vi.hoisted(() => vi.fn())
vi.mock('../dispatch-kick', () => ({ kickWebhookDispatch: kick }))

import { eventBus } from '@/lib/events/bus'
import { writeEventLog } from '@/lib/events/handlers/event-log-handler'
import { answerQuestion, closeQuestion } from '@/lib/questions/answer'
import { reopenQuestion } from '@/lib/questions/app-answer'
import { fileQuestion } from '@/lib/questions/file'
import { linkQuestionOperation } from '@/lib/questions/operations'
import { fanOutEvent } from '../handler'
import { PUBLIC_WEBHOOK_EVENTS, SCOPED_EVENT_FAMILIES, isEventOfFamily } from '../public-events'
import { WebhookEventTypeListSchema } from '../subscription-event-types'

const COMPANY = 'c0000000-0000-4000-8000-000000000001'
const USER = 'a0000000-0000-4000-8000-000000000001'
const QUESTION_ID = 'e0000000-0000-4000-8000-000000000001'
const TX = '10000000-0000-4000-8000-000000000001'
const OPERATION_ID = '0b000000-0000-4000-8000-000000000001'
const KEY_ID = 'key-1'
const FILED_AT = '2026-11-19T08:00:00.000Z'
const ENDED_AT = '2026-11-19T09:00:00.000Z'

const QUESTION_TEXT = 'Vad avser betalningen?'
const WHY_TEXT = 'Den avviker från tidigare månader.'
const OPTION_LABEL = 'Årsbetalning'
const ANSWER_TEXT = 'Det var en årsavgift.'
const OPERATION_TITLE = 'Bokför årsavgiften'

const TYPES = [
  'company_question.filed',
  'company_question.answered',
  'company_question.closed',
  'company_question.reopened',
  'company_question.prepared',
] as const
type QuestionEventType = (typeof TYPES)[number]

/** A company_questions row with every text field filled in, so a leak would show. */
const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: QUESTION_ID,
  status: 'open',
  close_reason: null,
  question: QUESTION_TEXT,
  why: WHY_TEXT,
  options: [{ id: 'annual', label: OPTION_LABEL }],
  evidence: [{ kind: 'transaction', id: TX }],
  actor_label: 'Example key',
  client: 'example-client',
  answer_option: null,
  answer_text: null,
  answered_at: null,
  answered_via: null,
  fact_id: null,
  created_at: FILED_AT,
  ...overrides,
})

/** The read answers `current`; the write answers `written`. */
function questionsTable(current: Record<string, unknown>, written: Record<string, unknown>): TableMockResolver {
  return (calls) => (calls.some((call) => call.method === 'update') ? { data: written } : { data: current })
}

/** company_questions as a filing reads it: no earlier question, nothing open, nothing filed today, then the insert. */
const filingTable: TableMockResolver = (calls) => {
  const methods = calls.map((call) => call.method)
  if (methods.includes('insert')) return { data: row() }
  if (methods.includes('maybeSingle')) return { data: null }
  return { count: 0 }
}

function client(tables: Parameters<typeof createTableMockSupabase>[0]): SupabaseClient {
  return createTableMockSupabase(tables).supabase as unknown as SupabaseClient
}

interface Scenario {
  type: QuestionEventType
  /** The write that emits the event. */
  run: () => Promise<unknown>
  /** What the event says about the question, beside its id. */
  state: Record<string, string>
}

const SCENARIOS: Scenario[] = [
  {
    type: 'company_question.filed',
    run: () =>
      fileQuestion(
        client({
          company_questions: filingTable,
          transactions: { data: [{ id: TX, amount: -4990, amount_sek: -4990, instructed_amount: null }] },
        }),
        {
          companyId: COMPANY,
          question: QUESTION_TEXT,
          why: WHY_TEXT,
          options: [{ id: 'annual', label: OPTION_LABEL }],
          evidence: [{ kind: 'transaction', id: TX }],
          userId: USER,
        },
      ),
    state: { status: 'open', createdAt: FILED_AT },
  },
  {
    type: 'company_question.answered',
    run: () =>
      answerQuestion(
        client({
          company_questions: questionsTable(
            row(),
            row({ status: 'answered', answer_text: ANSWER_TEXT, answered_at: ENDED_AT, answered_via: 'whatsapp' }),
          ),
        }),
        { companyId: COMPANY, questionId: QUESTION_ID, text: ANSWER_TEXT, userId: USER, via: 'whatsapp' },
      ),
    state: { status: 'answered', answeredVia: 'whatsapp', answeredAt: ENDED_AT },
  },
  {
    type: 'company_question.closed',
    run: () =>
      closeQuestion(
        client({
          company_questions: questionsTable(
            row(),
            row({ status: 'closed', close_reason: 'not_relevant', answered_at: ENDED_AT, answered_via: 'app' }),
          ),
        }),
        { companyId: COMPANY, questionId: QUESTION_ID, reason: 'not_relevant', userId: USER, via: 'app' },
      ),
    state: { status: 'closed', closeReason: 'not_relevant', answeredVia: 'app', answeredAt: ENDED_AT },
  },
  {
    type: 'company_question.reopened',
    run: () =>
      reopenQuestion(
        client({
          company_questions: {
            data: { id: QUESTION_ID, status: 'closed', answered_by: USER, answered_at: ENDED_AT, answered_via: 'app', fact_id: null },
          },
        }),
        client({ company_questions: { data: row() } }),
        { companyId: COMPANY, questionId: QUESTION_ID, userId: USER, now: new Date('2026-11-19T09:05:00.000Z') },
      ),
    state: { status: 'open', createdAt: FILED_AT },
  },
  {
    type: 'company_question.prepared',
    run: () =>
      linkQuestionOperation(
        client({
          company_questions: { data: row({ status: 'answered', answer_text: ANSWER_TEXT, answered_at: ENDED_AT, answered_via: 'whatsapp' }) },
          pending_operations: { data: { id: OPERATION_ID, user_id: USER, actor_id: KEY_ID, title: OPERATION_TITLE } },
          // Nothing linked before; the insert answers no error.
          company_question_operations: (calls) => (calls.some((call) => call.method === 'insert') ? { data: null } : { data: [] }),
        }),
        { companyId: COMPANY, questionId: QUESTION_ID, operationId: OPERATION_ID, userId: USER, actorId: KEY_ID },
      ),
    state: { operationId: OPERATION_ID },
  },
]

/** The keys a public question payload may carry, whatever the event. */
const ALLOWED_KEYS = new Set(['questionId', 'companyId', 'status', 'answeredVia', 'closeReason', 'createdAt', 'answeredAt', 'operationId'])

/** What a public question payload must never carry: text of the question, the answer or the operation, records, the actor. */
const FORBIDDEN_TEXT = [QUESTION_TEXT, WHY_TEXT, OPTION_LABEL, ANSWER_TEXT, OPERATION_TITLE, TX, USER, KEY_ID, 'Example key', 'example-client']

function expectIdsAndStateOnly(payload: Record<string, unknown>): void {
  expect(Object.keys(payload).filter((key) => !ALLOWED_KEYS.has(key))).toEqual([])
  for (const key of ['question', 'why', 'options', 'evidence', 'answer_text', 'answerText', 'answer_option', 'userId', 'user_id']) {
    expect(payload, key).not.toHaveProperty(key)
  }
  const serialised = JSON.stringify(payload)
  for (const text of FORBIDDEN_TEXT) expect(serialised).not.toContain(text)
}

/** The service-role client the two consumers write through: one verified webhook subscribed to everything. */
function consumerSink() {
  return createTableMockSupabase({
    webhooks: {
      data: [{ id: 'wh-1', api_version_pinned: null, verified_at: '2026-10-01T00:00:00Z', verification_grace_ends_at: null }],
    },
  })
}

describe('question list events as public events', () => {
  let sink: ReturnType<typeof consumerSink>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubEnv('COMPANY_QUESTIONS_COMPANY_IDS', '*')
    eventBus.clear()
    sink = consumerSink()
    serviceClient.current = sink.supabase
    // The two consumers the catalogue subscribes, in dispatch order.
    for (const type of TYPES) {
      eventBus.on(type, (payload) => writeEventLog(type, payload))
      eventBus.on(type, (payload) => fanOutEvent(type, payload))
    }
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    eventBus.clear()
  })

  it('are in the public catalogue and subscribable', () => {
    for (const type of TYPES) expect(PUBLIC_WEBHOOK_EVENTS).toContain(type)
    expect(WebhookEventTypeListSchema.safeParse([...TYPES]).success).toBe(true)
  })

  it('belong to the event family that needs agent:read', () => {
    for (const type of TYPES) {
      const families = SCOPED_EVENT_FAMILIES.filter((family) => isEventOfFamily(family, type))
      expect(families.map((family) => family.scope), type).toEqual(['agent:read'])
    }
  })

  it.each(SCENARIOS)('$type reaches the subscribed webhook with the question by id and its state only', async (scenario) => {
    await scenario.run()

    // The lookup asks for webhooks subscribed to this very type.
    expect(sink.findCall('webhooks', 'contains')).toEqual(['event_types', [scenario.type]])
    const deliveries = sink.payloads('webhook_deliveries', 'insert') as Array<Array<Record<string, unknown>>>
    expect(deliveries).toHaveLength(1)
    expect(deliveries[0]).toHaveLength(1)
    const delivery = deliveries[0]![0]!
    expect(delivery).toMatchObject({ webhook_id: 'wh-1', company_id: COMPANY, event_type: scenario.type })
    expect(delivery.payload).toEqual({ questionId: QUESTION_ID, ...scenario.state, companyId: COMPANY })
    expectIdsAndStateOnly(delivery.payload as Record<string, unknown>)
    expect(kick).toHaveBeenCalledTimes(1)
  })

  it.each(SCENARIOS)('$type is written to the event log, the question as its entity, with its state only', async (scenario) => {
    await scenario.run()

    const rows = sink.payloads('event_log', 'insert') as Array<Record<string, unknown>>
    expect(rows).toHaveLength(1)
    expect(rows[0]).toEqual({
      user_id: USER,
      company_id: COMPANY,
      event_type: scenario.type,
      entity_id: QUESTION_ID,
      data: { questionId: QUESTION_ID, ...scenario.state },
    })
    expectIdsAndStateOnly(rows[0]!.data as Record<string, unknown>)
  })
})
