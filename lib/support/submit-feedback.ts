import posthog from 'posthog-js'
import { isAnalyticsEnabled } from '@/lib/analytics/enabled'

export interface SubmitFeedbackInput {
  message: string
  subject?: string
  /** Screenshots or PDFs relayed on the support email only. */
  files?: File[]
}

/**
 * Delivery channels.
 *
 * 'email'  - Resend to the support inbox. The guarantee: it works with no
 *            third party beyond the mail provider and needs no analytics.
 * 'ticket' - PostHog Support conversation, linked to the person and their
 *            session replay so we can see what they were doing.
 *
 * Recapt used to be the second channel and would report success on its own,
 * masking a failing /api/support/contact. This does NOT repeat that: the
 * result is `ok` only when email actually delivered. A ticket alone is not
 * treated as delivery, because nobody is watching PostHog at 02:00.
 */
export type SupportChannel = 'email' | 'ticket'

export interface SubmitFeedbackResult {
  ok: boolean
  channels: SupportChannel[]
  error?: string
}

/**
 * JSON when there is nothing to attach, multipart when there is. The JSON path
 * is kept byte-identical rather than always sending multipart: it is the shape
 * every existing message uses, and a plain body is the one that still works if
 * multipart parsing is ever the thing that broke.
 */
function buildEmailRequest({ message, subject, files }: SubmitFeedbackInput): RequestInit {
  if (!files?.length) {
    return {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject, message }),
    }
  }

  const form = new FormData()
  if (subject) form.append('subject', subject)
  form.append('message', message)
  for (const file of files) form.append('files', file, file.name)
  // No Content-Type header: the browser has to set the multipart boundary.
  return { method: 'POST', body: form }
}

async function submitViaEmail(
  input: SubmitFeedbackInput
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await fetch('/api/support/contact', buildEmailRequest(input))
    if (!res.ok) {
      const data = await res.json().catch(() => ({}))
      return { ok: false, error: data.error || 'Kunde inte skicka meddelandet' }
    }
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'Nätverksfel' }
  }
}

/** Outcome of each channel, for the analytics breadcrumb. */
type ChannelOutcome = 'ok' | 'failed' | 'unavailable' | 'timeout'

/** How long the ticket call may run before we stop waiting on it. The user is
 *  waiting on this dialog, and the ticket is a complement, not the delivery. */
const TICKET_TIMEOUT_MS = 4000

/**
 * Breadcrumb on the user's PostHog timeline so a support message is visible
 * next to the session replay that led to it: the genuinely useful half of what
 * the Recapt channel provided. NOT a delivery channel, and deliberately
 * carries no message body: free text is user content and would be PII in an
 * event property. Email remains the only thing that actually delivers.
 *
 * Both channels are reported, because both fail silently from the user's side.
 * A ticket that never opened is invisible in the UI (email is the guarantee,
 * so the user still sees success) and invisible in PostHog Support (no ticket
 * exists to look at). Without `ticket` here, the only way to answer "did the
 * ticket open?" is to reproduce it with devtools open, which is what happened
 * the first time this shipped.
 *
 * 'unavailable' is kept distinct from 'failed' on purpose: unavailable is the
 * expected steady state when Support is off or analytics is disabled, whereas
 * failed means conversations were live and the call still did not land. Only
 * the second is worth alerting on.
 */
function noteInAnalytics(
  { subject }: SubmitFeedbackInput,
  outcomes: { email: boolean; ticket: ChannelOutcome }
): void {
  if (!isAnalyticsEnabled()) return
  try {
    posthog.capture('support_feedback_submitted', {
      subject: subject ?? null,
      // Kept for continuity: existing insights filter on `delivered`.
      delivered: outcomes.email,
      email: outcomes.email ? 'ok' : 'failed',
      ticket: outcomes.ticket,
      // True only when the user's message reached neither channel. This is the
      // one that deserves an alert.
      lost: !outcomes.email && outcomes.ticket !== 'ok',
    })
  } catch {
    // Telemetry must never affect whether the user's message went out.
  }
}

/**
 * Open a PostHog Support ticket alongside the email.
 *
 * Unlike the analytics breadcrumb this DOES carry the message body: a support
 * ticket the user deliberately wrote is the one place their words are the
 * point. That makes tickets a distinct processing purpose from analytics, so
 * it is declared separately in .compliance/ropa.yaml and on the privacy page.
 *
 * Never throws and never blocks: if conversations are unavailable (support
 * disabled, no analytics, older SDK) the user still gets the email path.
 */
async function submitViaTicket({ message, subject }: SubmitFeedbackInput): Promise<ChannelOutcome> {
  if (!isAnalyticsEnabled()) return 'unavailable'
  try {
    const conversations = posthog.conversations
    if (!conversations?.isAvailable?.()) return 'unavailable'
    await conversations.sendMessage(composeTicketBody(message, subject))
    return 'ok'
  } catch {
    return 'failed'
  }
}

function composeTicketBody(message: string, subject?: string): string {
  return subject ? `[${subject}]\n\n${message}` : message
}

/** Resolve to `fallback` if the promise has not settled in time. Never rejects:
 *  submitViaTicket already swallows its own errors. */
function withTimeout(
  promise: Promise<ChannelOutcome>,
  ms: number,
  fallback: ChannelOutcome
): Promise<ChannelOutcome> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    void promise.then((value) => {
      clearTimeout(timer)
      resolve(value)
    })
  })
}

export async function submitFeedback(input: SubmitFeedbackInput): Promise<SubmitFeedbackResult> {
  // Both channels start together, so the user waits max(email, ticket) rather
  // than the sum. Email is the delivery guarantee and decides `ok`; the ticket
  // is a complement, so it is additionally capped: a hung sendMessage must
  // never hold the confirmation dialog open. It resolves to 'timeout' instead,
  // which is reported rather than silently rounded to 'failed'.
  const ticketPromise = submitViaTicket(input)
  const emailResult = await submitViaEmail(input)
  const ticket = await withTimeout(ticketPromise, TICKET_TIMEOUT_MS, 'timeout')

  noteInAnalytics(input, { email: emailResult.ok, ticket })

  if (emailResult.ok) {
    return { ok: true, channels: ticket === 'ok' ? ['email', 'ticket'] : ['email'] }
  }

  return {
    ok: false,
    channels: ticket === 'ok' ? ['ticket'] : [],
    error: emailResult.error,
  }
}
