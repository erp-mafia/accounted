import { NextResponse } from 'next/server'
import { requestClientIp, truncateIp } from '@/lib/api/ip'
import { createTokenRateLimiter } from '@/lib/api/token-rate-limit'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import {
  recordReminderAnswer,
  REMINDER_ANSWER_ACTIONS,
  REMINDER_ANSWER_NOTE_MAX,
} from '@/lib/reminders/answer'
import type { ReminderResponseType } from '@/types'

/**
 * Records the customer's answer to a reminder, posted by the answer page
 * (/invoice-action/[token], which reads the reminder itself on the server).
 * Public: the link token in the reminder mail is the only credential, so it
 * writes with the service role and reveals nothing for an unknown token.
 * Errors are short codes the page maps to text in the customer's language.
 */

const log = createLogger('api/invoices/reminders/action')

// Process-local, like the payslip link's limiter. A link answers once, so 10
// posts per token per 10 minutes covers retries and a second tab; the client
// budget bounds a caller trying made-up tokens, which a per-token limit never
// sees twice.
const tokenLimiter = createTokenRateLimiter({ max: 10, windowMs: 10 * 60_000 })
const clientLimiter = createTokenRateLimiter({ max: 60, windowMs: 10 * 60_000 })

export async function POST(request: Request) {
  let body: { token?: unknown; action?: unknown; note?: unknown }
  try {
    body = await request.json()
  } catch {
    // A body that is not JSON is the caller's mistake: answered 400, nothing to log.
    return NextResponse.json({ error: 'INVALID_BODY' }, { status: 400 })
  }
  const { token, action } = body
  if (typeof token !== 'string' || token === '') return NextResponse.json({ error: 'TOKEN_MISSING' }, { status: 400 })
  if (typeof action !== 'string' || !(REMINDER_ANSWER_ACTIONS as readonly string[]).includes(action)) {
    return NextResponse.json({ error: 'ACTION_INVALID' }, { status: 400 })
  }
  if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
    return NextResponse.json({ error: 'NOTE_INVALID' }, { status: 400 })
  }
  const note = typeof body.note === 'string' ? body.note.trim() : ''
  if (note.length > REMINDER_ANSWER_NOTE_MAX) return NextResponse.json({ error: 'NOTE_TOO_LONG' }, { status: 400 })

  const client = truncateIp(requestClientIp(request))
  if (!tokenLimiter.allow(token) || (client !== undefined && !clientLimiter.allow(client))) {
    return NextResponse.json({ error: 'RATE_LIMITED' }, { status: 429 })
  }

  try {
    const result = await recordReminderAnswer(createServiceClientNoCookies(), {
      token,
      action: action as ReminderResponseType,
      note: note === '' ? null : note,
      now: new Date(),
    })
    if (result === 'not_found') return NextResponse.json({ error: 'LINK_INVALID' }, { status: 404 })
    if (result === 'already_answered') return NextResponse.json({ error: 'ALREADY_ANSWERED' }, { status: 409 })
    return NextResponse.json({ success: true })
  } catch (error) {
    log.error('reminder answer not saved', error as Error)
    return NextResponse.json({ error: 'FAILED' }, { status: 500 })
  }
}
