/**
 * The question list as MCP tools: file a question for the company's people,
 * read the list, close a question without an answer. An answer is a saved
 * fact: gnubok_remember_fact with answers_question_id (answerQuestionWithFact).
 *
 * The checks are the core's (src/lib/questions): the evidence must exist in
 * the company, every amount in the text must stand on it, the limits hold
 * and the same records are asked about once.
 *
 * gnubok_ask_question is a listed tool. The other two are search-only
 * (catalogVisibility 'search'): the read rides the gnubok_call_tool bridge;
 * the close saves at once and is reached by a client that can name a tool
 * outside tools/list.
 */
import { badArgument } from '@/lib/errors/refusal'
import { createLogger } from '@/lib/logger'
import { answerQuestion, closeQuestion } from '@/lib/questions/answer'
import { fileQuestion } from '@/lib/questions/file'
import { listQuestions } from '@/lib/questions/list'
import {
  EVIDENCE_KINDS,
  QUESTION_CLOSE_REASONS,
  QUESTION_LIMITS,
  QUESTION_STATUSES,
  type CompanyQuestion,
  type QuestionStatus,
} from '@/lib/questions/types'
import type { ActorContext, McpTool, McpToolAnnotations } from './server'

const log = createLogger('mcp-questions')

/** The briefing's directions for open_questions. */
export const OPEN_QUESTIONS_HOW =
  'open_questions wait for the person. When the conversation touches one, ask it in passing, in their language; never ask them all at once. Save the answer with gnubok_remember_fact and answers_question_id: that closes the question.'

/** A question as every door hands it out: qualified ids, evidence as <kind>:<id> references. */
export function questionView(question: CompanyQuestion) {
  return {
    question_id: question.question_id,
    status: question.status,
    close_reason: question.close_reason,
    question: question.question,
    why: question.why,
    options: question.options.map((option) => ({ option_id: option.id, label: option.label })),
    evidence: question.evidence.map((ref) => `${ref.kind}:${ref.id}`),
    asked_by: question.asked_by,
    client: question.client,
    asked_at: question.created_at,
    answer_option_id: question.answer_option,
    answer_text: question.answer_text,
    answered_at: question.answered_at,
    answered_via: question.answered_via,
    fact_id: question.fact_id,
  }
}

/** The part of an open question the briefing carries. */
export function briefingQuestion(question: CompanyQuestion) {
  return {
    question_id: question.question_id,
    question: question.question,
    ...(question.options.length > 0
      ? { options: question.options.map((option) => ({ option_id: option.id, label: option.label })) }
      : {}),
    ...(question.why ? { why: question.why } : {}),
    asked_at: question.created_at,
  }
}

/** The door an answer came through: the connection's client label, else how it signed in. */
function doorOf(actor: ActorContext | undefined): string {
  return actor?.client ?? actor?.type ?? 'mcp'
}

/**
 * Marks the question answered by a fact that was just saved. Never throws:
 * the fact is saved either way, so a question that could not be closed (not
 * found, in another company, already ended, the list switched off) is
 * reported beside the fact instead.
 */
export async function answerQuestionWithFact(
  supabase: Parameters<McpTool['execute']>[3],
  input: { companyId: string; questionId: string; factId: string; userId: string; actor?: ActorContext },
): Promise<{ answered_question_id: string } | { question_not_answered: string }> {
  try {
    const answered = await answerQuestion(supabase, {
      companyId: input.companyId,
      questionId: input.questionId,
      factId: input.factId,
      userId: input.userId,
      via: doorOf(input.actor),
    })
    return { answered_question_id: answered.question_id }
  } catch (error) {
    // A refusal (not found, already ended, switched off) is told as it is
    // worded; anything else is logged and told in general terms.
    const code = (error as { code?: unknown } | null)?.code
    if (error instanceof Error && typeof code === 'string' && /^[A-Z_]+$/.test(code)) {
      return { question_not_answered: error.message }
    }
    log.warn('a question could not be marked answered', {
      companyId: input.companyId,
      questionId: input.questionId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { question_not_answered: 'The fact is saved, but the question could not be marked answered. Read it with gnubok_list_questions.' }
  }
}

/** Evidence as the tool takes it: "<kind>:<id>" references, or { kind, id } objects. */
function evidenceRefs(value: unknown): unknown {
  if (!Array.isArray(value)) return value
  return value.map((entry) => {
    if (typeof entry !== 'string') return entry
    const at = entry.indexOf(':')
    return at === -1 ? { kind: null, id: entry.trim() } : { kind: entry.slice(0, at).trim(), id: entry.slice(at + 1).trim() }
  })
}

const QUESTION_PROPERTIES = {
  question_id: { type: 'string' },
  status: { type: 'string', enum: [...QUESTION_STATUSES] },
  close_reason: { type: ['string', 'null'], description: 'Set on a closed question.' },
  question: { type: 'string' },
  why: { type: ['string', 'null'] },
  options: {
    type: 'array',
    items: { type: 'object', properties: { option_id: { type: 'string' }, label: { type: 'string' } }, required: ['option_id', 'label'] },
  },
  evidence: { type: 'array', items: { type: 'string' }, description: 'The records it rests on, as <kind>:<id>.' },
  asked_by: { type: ['string', 'null'], description: 'The connection that filed it.' },
  client: { type: ['string', 'null'] },
  asked_at: { type: 'string' },
  answer_option_id: { type: ['string', 'null'] },
  answer_text: { type: ['string', 'null'] },
  answered_at: { type: ['string', 'null'], description: 'When it was answered or closed.' },
  answered_via: { type: ['string', 'null'] },
  fact_id: { type: ['string', 'null'], description: 'The saved fact that answered it.' },
} as const

const QUESTION_REQUIRED = ['question_id', 'status', 'question', 'options', 'evidence', 'asked_at'] as const

export function createQuestionTools(deps: {
  readOnly: McpToolAnnotations
  write: McpToolAnnotations
  idempotentWrite: McpToolAnnotations
}): McpTool[] {
  return [
    {
      name: 'gnubok_ask_question',
      keywords: ['fråga', 'frågor', 'fråga företaget', 'ställ en fråga', 'frågelista', 'question', 'ask the owner', 'klargörande'],
      title: 'Ask Company Question',
      description:
        "File one question for the company's people: only what changes a booking, an expectation or a deadline, and only when the books cannot answer it. Cite the records it rests on: every amount must stand on one. At most 5 open and 3 new per 24 h. Saves at once.",
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: {
            type: 'string',
            maxLength: QUESTION_LIMITS.maxText,
            description:
              "In the person's language. Name the amount (with its currency), the day, the counterparty; never an account number or a tax code.",
          },
          why: {
            type: 'string',
            maxLength: QUESTION_LIMITS.maxText,
            description: 'What the answer changes.',
          },
          options: {
            type: 'array',
            maxItems: QUESTION_LIMITS.maxOptions,
            description: `At most ${QUESTION_LIMITS.maxOptions} answers, each label at most ${QUESTION_LIMITS.maxOptionLabel} characters. The person can also answer in their own words.`,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', maxLength: QUESTION_LIMITS.maxOptionId },
                label: { type: 'string', maxLength: QUESTION_LIMITS.maxOptionLabel },
              },
              required: ['id', 'label'],
            },
          },
          evidence: {
            type: 'array',
            minItems: 1,
            maxItems: QUESTION_LIMITS.maxEvidence,
            items: { type: 'string' },
            description: `The records it rests on, each <kind>:<id>. Kinds: ${EVIDENCE_KINDS.join(', ')}. fact takes a fact_id; account an account number, read as its balance today.`,
          },
        },
        required: ['question', 'evidence'],
      },
      // The result is the whole question (questionView). Only the two keys a
      // caller acts on are declared; the others travel undeclared.
      outputSchema: {
        type: 'object',
        properties: {
          question_id: { type: 'string' },
          status: { type: 'string' },
        },
        required: ['question_id', 'status'],
      },
      annotations: deps.write,
      async execute(args, companyId, userId, supabase, actor) {
        const filed = await fileQuestion(supabase, {
          companyId,
          question: args.question,
          why: args.why,
          options: args.options,
          evidence: evidenceRefs(args.evidence),
          userId,
          actor: actor ? { type: actor.type, id: actor.id ?? null, label: actor.label ?? null, client: actor.client ?? null } : null,
        })
        return questionView(filed)
      },
    },
    {
      name: 'gnubok_list_questions',
      keywords: ['fråga', 'frågor', 'frågelista', 'öppna frågor', 'questions', 'open questions'],
      title: 'List Company Questions',
      description:
        "The company's question list: the open questions first, then those answered or closed in the last 90 days. Read it before filing a question.",
      catalogVisibility: 'search',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: [...QUESTION_STATUSES], description: 'Only this status. Default: all.' },
          limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Default 50.' },
        },
      },
      outputSchema: {
        type: 'object',
        properties: {
          questions: { type: 'array', items: { type: 'object', properties: QUESTION_PROPERTIES, required: [...QUESTION_REQUIRED] } },
          count: { type: 'integer' },
        },
        required: ['questions', 'count'],
      },
      annotations: deps.readOnly,
      async execute(args, companyId, _userId, supabase) {
        const status = (QUESTION_STATUSES as readonly unknown[]).includes(args.status) ? (args.status as QuestionStatus) : undefined
        const questions = await listQuestions(supabase, companyId, {
          status,
          limit: typeof args.limit === 'number' ? args.limit : undefined,
        })
        return { questions: questions.map(questionView), count: questions.length }
      },
    },
    {
      name: 'gnubok_close_question',
      keywords: ['fråga', 'stäng fråga', 'vet inte', 'close question', 'withdraw question'],
      title: 'Close Company Question',
      description: `Close an open question without an answer. reason: dont_know (the person cannot say), not_relevant (they do not want it asked), settled (the books answered it), withdrawn (you take it back). An answer is saved with gnubok_remember_fact and answers_question_id instead.`,
      catalogVisibility: 'search',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question_id: { type: 'string' },
          reason: { type: 'string', enum: [...QUESTION_CLOSE_REASONS] },
        },
        required: ['question_id', 'reason'],
      },
      outputSchema: {
        type: 'object',
        properties: QUESTION_PROPERTIES,
        required: [...QUESTION_REQUIRED],
      },
      annotations: deps.idempotentWrite,
      async execute(args, companyId, userId, supabase, actor) {
        const questionId = typeof args.question_id === 'string' ? args.question_id.trim() : ''
        if (!questionId) throw badArgument('question_id', 'question_id is required')
        const closed = await closeQuestion(supabase, {
          companyId,
          questionId,
          reason: args.reason,
          userId,
          via: doorOf(actor),
        })
        return questionView(closed)
      },
    },
  ]
}
