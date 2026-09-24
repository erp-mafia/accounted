import { z } from 'zod'
import type { AiService } from '@/lib/ai'

/**
 * The Skills creator is a short conversation: the user describes a task in
 * their own words, the assistant asks up to three follow-up questions, then
 * sums it up as a skill. Each call returns the next step: one more question,
 * or the summary. The model only writes short fields; the skill body is built
 * from them by buildOwnSkill, so it always passes the Markdown validator.
 */
export const MAX_QUESTIONS = 3

export interface CreatorTurn {
  question: string
  answer: string
}

export interface CreatorDraftInput {
  /** The AI the skill is for, e.g. "Claude". */
  client: string
  locale: 'sv' | 'en'
  description: string
  turns: CreatorTurn[]
  /** Extra context the user added at the summary. */
  extra: string[]
  /** Skip the remaining questions and sum up now. */
  summarize: boolean
}

export interface CreatorQuestion {
  kind: 'question'
  question: string
  /** A one or two word label for the station sign, e.g. "Leverantörer". */
  topic: string
  suggestions: string[]
}

export interface CreatorSummary {
  kind: 'summary'
  name: string
  /** One sentence: what the AI does and how often. */
  lede: string
  steps: string[]
  rules: string[]
  /** Two or three short chips: how often, what it covers, who approves. */
  facts: string[]
}

export type CreatorStep = CreatorQuestion | CreatorSummary

/** Strip what the Markdown validator rejects, and collapse whitespace. */
export function cleanText(text: string, max: number): string {
  return text.replace(/[{}<>`]/g, '').replace(/\s+/g, ' ').trim().slice(0, max).trim()
}

const text = (max: number) => z.string().transform((value) => cleanText(value, max)).pipe(z.string().min(1))
const list = (max: number, min: number, most: number) => z.array(z.unknown())
  .transform((items) => items.filter((item): item is string => typeof item === 'string').map((item) => cleanText(item, max)).filter(Boolean).slice(0, most))
  .pipe(z.array(z.string()).min(min))

const QuestionSchema = z.object({ question: text(160), topic: text(24), suggestions: list(60, 0, 3) })
const SummarySchema = z.object({ name: text(60), lede: text(200), steps: list(140, 2, 6), rules: list(100, 0, 4), facts: list(32, 1, 3) })

const JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['kind', 'question', 'topic', 'suggestions', 'name', 'lede', 'steps', 'rules', 'facts'],
  properties: {
    kind: { type: 'string', enum: ['question', 'summary'] },
    question: { type: ['string', 'null'] },
    topic: { type: ['string', 'null'] },
    suggestions: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 3 },
    name: { type: ['string', 'null'] },
    lede: { type: ['string', 'null'] },
    steps: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 6 },
    rules: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 4 },
    facts: { type: ['array', 'null'], items: { type: 'string' }, maxItems: 3 },
  },
} as const

function system(input: CreatorDraftInput, mustSummarize: boolean): string {
  const language = input.locale === 'sv' ? 'Swedish' : 'English'
  return [
    `You help the owner of a small Swedish business write a "skill": standing instructions their AI (${input.client}) follows when it works in Accounted, their bookkeeping app, over its MCP connection.`,
    `Write everything in ${language}, in plain everyday words a non-accountant understands. No jargon, no emoji, no quotation marks around the whole text.`,
    mustSummarize
      ? 'You have what you need. Answer with kind "summary".'
      : `Ask at most ${MAX_QUESTIONS} follow-up questions in total, one per reply, and only about what changes how the task is done: what it covers, how often, what must wait for the user's approval, what to do when something does not match. Never ask about something already answered. If the task is already clear enough, answer with kind "summary" instead.`,
    'A question: kind "question", "question" is one short sentence (under 110 characters), "topic" is a one or two word label for it, "suggestions" are two or three short likely answers (under 50 characters each). Leave the summary fields null.',
    `A summary: kind "summary", "name" is a short title for the skill (under 50 characters), "lede" one sentence on what ${input.client} does and how often, "steps" three to six short steps in order, "rules" up to four things it must always or never do, "facts" two or three chips of at most three words (how often, what it covers, who approves). Leave the question fields null.`,
    'Nothing is booked, sent or filed without the user approving it in Accounted. Never promise otherwise.',
  ].join('\n')
}

function prompt(input: CreatorDraftInput): string {
  const lines = [`The user's description:\n${input.description}`]
  input.turns.forEach((turn, i) => lines.push(`Question ${i + 1}: ${turn.question}\nAnswer: ${turn.answer}`))
  if (input.extra.length) lines.push(`Added at the summary:\n${input.extra.map((item) => `- ${item}`).join('\n')}`)
  return lines.join('\n\n')
}

export class CreatorDraftError extends Error {}

export async function draftCreatorStep(ai: AiService, input: CreatorDraftInput): Promise<CreatorStep> {
  const mustSummarize = input.summarize || input.turns.length >= MAX_QUESTIONS
  const result = await ai.generateStructured({
    tier: 'assistant',
    system: system(input, mustSummarize),
    prompt: prompt(input),
    maxTokens: 900,
    schema: { name: 'skill_creator_step', jsonSchema: JSON_SCHEMA as unknown as Record<string, unknown> },
  })
  const value = (result.value ?? {}) as Record<string, unknown>
  const wantsQuestion = value.kind === 'question' && !mustSummarize
  if (wantsQuestion) {
    const question = QuestionSchema.safeParse(value)
    if (question.success) return { kind: 'question', ...question.data }
  }
  const summary = SummarySchema.safeParse(value)
  if (summary.success) return { kind: 'summary', ...summary.data }
  throw new CreatorDraftError('The model answered with neither a usable question nor a summary.')
}
