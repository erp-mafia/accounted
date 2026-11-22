/**
 * The reply reader: an outside service that is handed a question and a
 * written reply to it, and says what the reply is. A door that takes written
 * replies asks readReply and acts on the reading itself. The reader writes
 * nothing and never changes the words of a reply.
 *
 * Configuration (environment). A reader is used for a company only when all
 * three allow it:
 *   QUESTION_REPLY_READER_URL          where the request is posted: https,
 *                                      or http on a loopback host
 *   QUESTION_REPLY_READER_SECRET       the key the request is signed with;
 *                                      whitespace around it is not part of it
 *   QUESTION_REPLY_READER_COMPANY_IDS  `*` for every company, or a
 *                                      comma-separated list of company ids,
 *                                      read like COMPANY_QUESTIONS_COMPANY_IDS
 *
 * Request: POST <url> with `Content-Type: application/json` and
 *   X-Accounted-Signature: t=<unix seconds>,v1=<hex>
 * where <hex> is the lowercase hex HMAC-SHA256 of the UTF-8 string
 * `<t>.<raw request body>`, keyed with the secret's UTF-8 bytes (signPayload,
 * lib/webhooks/signing.ts). A redirect is not followed. The body:
 *   { "version": 1, "company_id": "<uuid>",
 *     "question": { "id": "<uuid>", "text": "<question>", "why": "<why>" | null,
 *                   "options": [{ "id": "<id>", "label": "<label>" }] },
 *     "reply": { "text": "<the written reply>" }, "locale": "sv" | "en" }
 * Nothing in it says who replied: no phone number, no person, no conversation.
 *
 * Answer: only an HTTP 200 inside REPLY_READER_TIMEOUT_MS whose JSON body is
 *   { "kind": "answer" | "dont_know" | "later" | "question_back" | "other", "reply"?: string }
 * counts. `reply` is the reader's own words to the person: required for
 * question_back, ignored for every other kind. Anything else is no reading
 * (null), and the caller carries on as without a reader.
 *
 * Logs: the company, the question, the kind, the duration and the failure
 * class. Never the question's text, the written reply or the reader's reply.
 */
import { z } from 'zod'
import { createLogger } from '@/lib/logger'
import { signPayload } from '@/lib/webhooks/signing'

const log = createLogger('questions/reply-reader')

type Env = Record<string, string | undefined>

export const REPLY_READER_SIGNATURE_HEADER = 'X-Accounted-Signature'
export const REPLY_READER_TIMEOUT_MS = 8_000
/** Characters of the reader's own reply that are kept. */
export const REPLY_READER_REPLY_MAX = 600

export const REPLY_KINDS = ['answer', 'dont_know', 'later', 'question_back', 'other'] as const
export type ReplyKind = (typeof REPLY_KINDS)[number]

/** What the reader made of a written reply. Only question_back carries words of the reader's own. */
export type ReplyReading = { kind: Exclude<ReplyKind, 'question_back'> } | { kind: 'question_back'; reply: string }

export interface ReadReplyInput {
  companyId: string
  question: {
    id: string
    text: string
    why: string | null
    options: readonly { id: string; label: string }[]
  }
  /** The written reply, as written. */
  replyText: string
  locale: 'sv' | 'en'
}

/** How a request to the reader ended without a reading. */
export type ReplyReaderFailure = 'timeout' | 'transport' | 'http_status' | 'invalid_json' | 'invalid_shape'

interface ReplyReaderConfig {
  url: string
  secret: string
}

/** The url when a request may go to it: https, or http on a loopback host. */
function usableUrl(raw: string | undefined): string | null {
  const value = raw?.trim()
  if (!value || !URL.canParse(value)) return null
  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  return url.protocol === 'https:' || (url.protocol === 'http:' && loopback) ? url.href : null
}

/** Whether QUESTION_REPLY_READER_COMPANY_IDS names the company: `*`, or its id in the list. */
function listsCompany(raw: string | undefined, companyId: string): boolean {
  const value = raw?.trim().toLowerCase()
  if (!value) return false
  if (value === '*') return true
  return value.split(',').some((id) => id.trim() === companyId.toLowerCase())
}

/** The reader for the company, or null when the environment names none for it. */
function replyReaderFor(companyId: string | null | undefined, env: Env): ReplyReaderConfig | null {
  if (!companyId || !listsCompany(env.QUESTION_REPLY_READER_COMPANY_IDS, companyId)) return null
  const url = usableUrl(env.QUESTION_REPLY_READER_URL)
  const secret = env.QUESTION_REPLY_READER_SECRET?.trim()
  return url && secret ? { url, secret } : null
}

/** Whether a reply reader is configured for this company. */
export function hasReplyReader(companyId: string | null | undefined, env: Env = process.env): boolean {
  return replyReaderFor(companyId, env) !== null
}

/** The X-Accounted-Signature value for a raw request body. `timestamp` is unix seconds: now when left out. */
export function replyReaderSignature(body: string, secret: string, timestamp?: number): string {
  return signPayload({ body, secret, timestamp }).header
}

/**
 * The reader's own reply as it may be sent on: control characters taken out,
 * each run of whitespace one space, trimmed, and at most
 * REPLY_READER_REPLY_MAX characters. Empty for anything that is not text.
 */
function cleanReply(value: unknown): string {
  if (typeof value !== 'string') return ''
  const flat = value.replace(/\p{Cc}/gu, ' ').replace(/\s+/gu, ' ').trim()
  return [...flat].slice(0, REPLY_READER_REPLY_MAX).join('').trim()
}

const ReadingSchema = z.object({
  kind: z.enum(REPLY_KINDS),
  reply: z.unknown().optional(),
})

/** The reading in an answer's JSON body, or null when the body is not one. */
function toReading(body: unknown): ReplyReading | null {
  const parsed = ReadingSchema.safeParse(body)
  if (!parsed.success) return null
  const kind: ReplyKind = parsed.data.kind
  if (kind !== 'question_back') return { kind }
  const reply = cleanReply(parsed.data.reply)
  return reply ? { kind, reply } : null
}

/**
 * Asks the company's reply reader what a written reply to a question is.
 * Null when no reader is configured for the company, or when it gave no
 * usable answer in time: the caller then carries on as without a reader.
 * Never throws.
 */
export async function readReply(input: ReadReplyInput, env: Env = process.env): Promise<ReplyReading | null> {
  const reader = replyReaderFor(input.companyId, env)
  if (!reader) return null

  const startedAt = Date.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REPLY_READER_TIMEOUT_MS)
  let reading: ReplyReading | null = null
  let failure: ReplyReaderFailure | null = null
  let status: number | null = null
  try {
    const body = JSON.stringify({
      version: 1,
      company_id: input.companyId,
      question: {
        id: input.question.id,
        text: input.question.text,
        why: input.question.why,
        options: input.question.options.map((option) => ({ id: option.id, label: option.label })),
      },
      reply: { text: input.replyText },
      locale: input.locale,
    })
    const response = await fetch(reader.url, {
      method: 'POST',
      signal: controller.signal,
      redirect: 'error',
      cache: 'no-store',
      headers: {
        'Content-Type': 'application/json',
        [REPLY_READER_SIGNATURE_HEADER]: replyReaderSignature(body, reader.secret),
      },
      body,
    })
    status = response.status
    if (response.status !== 200) {
      failure = 'http_status'
    } else {
      // The body is read before the timer is cleared: an answer whose body stalls ends as a timeout.
      const raw = await response.text()
      let json: unknown = null
      try {
        json = JSON.parse(raw)
      } catch {
        // Not JSON: recorded as its own failure class and logged below.
        failure = 'invalid_json'
      }
      if (failure === null) {
        reading = toReading(json)
        if (reading === null) failure = 'invalid_shape'
      }
    }
  } catch {
    // The request or the body read did not complete: the class is logged below, never the content.
    failure = controller.signal.aborted ? 'timeout' : 'transport'
  } finally {
    clearTimeout(timer)
  }

  const record = { companyId: input.companyId, questionId: input.question.id, durationMs: Date.now() - startedAt }
  if (reading) log.info('reply read', { ...record, kind: reading.kind })
  else log.warn('reply not read', { ...record, failure, status })
  return reading
}
