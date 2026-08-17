/**
 * Structured view of the answers a human gave about one underlag in a capture
 * channel (today: the WhatsApp intake conversation, stored on
 * invoice_inbox_items.channel_context).
 *
 * Why this exists rather than reading the blob inline where it is rendered:
 *
 *  1. A DENIAL IS AN ANSWER, and the raw shape hides that. Answering "nej" to
 *     the representation question stores `representation` with
 *     `participants: []` and `purpose: null` and `denied: true`. Any renderer
 *     that branches on `if (!representation.purpose)` therefore reads a settled
 *     "this was not representation" as a half-finished answer and asks the user
 *     for the purpose of a meal they just said was not a business meal. The
 *     denial and the genuine half answer (participants named, purpose missing,
 *     which BFL 5 kap 6-7 § does want completed) are different states and are
 *     modelled here as different fields.
 *
 *  2. THE VERIFIKAT RENDERER IS THE WRONG SHAPE. Its sibling,
 *     lib/documents/channel-context-notes.ts, exists to put answers on a
 *     verifikat, so for a denial it correctly renders nothing at all: "the user
 *     says this was not representation" is not verifikat text. Feeding a prompt
 *     from it loses exactly the answer that stops the agent asking again.
 *
 * Core lib: must not import from @/extensions. Pure: no DB, no model, so the
 * ask-or-not decision is unit-testable on its own.
 */
import { flattenMemoryContent } from '@/lib/agent/chat/system-prompt'
import type { InboxChannelContext } from '@/types'

export interface ChatClarifications {
  /** Answered representation: who was there and why. Null when unanswered. */
  representation: {
    participants: { name: string; company: string | null }[]
    purpose: string | null
  } | null
  /**
   * The human explicitly answered that this is NOT representation. Distinct
   * from `representation === null` (nobody has been asked yet): a settled
   * question must never be asked again, an unasked one may be.
   */
  representationDenied: boolean
  /**
   * Participants were named but the purpose was not. BFL 5 kap 6-7 § wants
   * both, so this is a real gap, but only the missing half may be asked for:
   * re-asking who was there when the user already listed them is the same
   * failure this module exists to prevent. Never true for a denial, where
   * there is no purpose to want.
   */
  representationPurposeMissing: boolean
  /** Event date, when the user gave one. */
  eventDate: string | null
  /** Free-text note the sender attached, as paraphrased at capture time. */
  userNote: string | null
  /** What the human actually typed when answering a context question. */
  contextAnswerRaw: string | null
  /**
   * A question that was asked and is still unanswered. `moved_to_app` means
   * the capture channel gave up waiting (48h TTL) and the app now owns it, so
   * whichever surface the user reaches first should ask exactly this.
   */
  openQuestion: {
    type: 'representation' | 'context' | 'resend'
    status: 'open' | 'moved_to_app'
  } | null
  /**
   * Where these answers were captured, for provenance in the prompt.
   *
   * Only WhatsApp asks a human anything, so only WhatsApp produces
   * clarifications. The mail hunt writes the same column with its own shape
   * and never carries answers, which is why this stays narrow while
   * InboxChannelContext.channel spans both intakes.
   */
  channel: 'whatsapp'
}

/**
 * Flatten a channel_context blob into the states an asking surface branches on.
 * Returns null when the record carries no human answer at all, so callers can
 * treat "no clarifications" as a single falsy check.
 *
 * The photo caption is deliberately not carried. It is the one field on the
 * record that nobody was asked for and nobody reviewed (the rationale is
 * written out in lib/documents/channel-context-notes.ts), and the reasoning
 * that keeps unreviewed text off an immutable verifikat applies at least as
 * strongly to text entering a prompt that can call tools.
 */
export function summariseClarifications(
  ctx: InboxChannelContext | null | undefined,
): ChatClarifications | null {
  if (!ctx) return null

  const rep = ctx.representation
  const denied = rep?.denied === true
  const participants = (rep?.participants ?? []).filter((p) => (p?.name ?? '').trim().length > 0)
  const purpose = rep?.purpose?.trim() || null
  // A denial carries no participants and no purpose; it is an answer all the
  // same, so it must not collapse into "unanswered".
  const answeredRepresentation =
    !denied && (participants.length > 0 || purpose !== null) ? { participants, purpose } : null

  const userNote = ctx.user_note?.trim() || null
  const contextAnswerRaw = ctx.context_answer?.raw_answer?.trim() || null

  const pending = ctx.pending_question
  const openQuestion =
    pending && (pending.status === 'open' || pending.status === 'moved_to_app')
      ? { type: pending.type, status: pending.status }
      : null

  if (!answeredRepresentation && !denied && !userNote && !contextAnswerRaw && !openQuestion) {
    return null
  }

  return {
    representation: answeredRepresentation,
    representationDenied: denied,
    representationPurposeMissing: !denied && participants.length > 0 && purpose === null,
    eventDate: rep?.event_date ?? null,
    userNote,
    contextAnswerRaw,
    openQuestion,
    channel: 'whatsapp',
  }
}

/**
 * Render clarifications as Swedish prompt lines.
 *
 * Every free-text field passes through flattenMemoryContent, the same defence
 * the system prompt applies to agent memory. This is human-typed text arriving
 * from an external channel, and an intent's promptTemplate output is seeded as
 * a user message: wrapToolResult (lib/agent/chat/run-turn.ts) wraps tool
 * RESULTS and never sees this path, so flattening here is the only thing
 * standing between a receipt caption and a line that reads as new instructions.
 */
export function renderClarificationLines(c: ChatClarifications): string[] {
  const lines: string[] = []

  if (c.representation) {
    const names = c.representation.participants
      .map((p) => {
        const name = flattenMemoryContent(p.name)
        const company = p.company ? flattenMemoryContent(p.company) : null
        return company ? `${name} (${company})` : name
      })
      .filter((n) => n.length > 0)
    if (names.length > 0) {
      lines.push(`deltagare (uppgivna av användaren): ${names.join(', ')}`)
    }
    if (c.representation.purpose) {
      lines.push(`syfte (uppgivet av användaren): ${flattenMemoryContent(c.representation.purpose)}`)
    }
  }

  if (c.eventDate) {
    lines.push(`datum (uppgivet av användaren): ${flattenMemoryContent(c.eventDate)}`)
  }

  if (c.representationPurposeMissing) {
    lines.push('syfte SAKNAS: fråga bara efter syftet, inte om deltagarna igen.')
  }

  // The case a naive read of the blob gets backwards.
  if (c.representationDenied) {
    lines.push(
      'svar från användaren: detta är INTE representation. Fråga varken om deltagare eller syfte.',
    )
  }

  if (c.userNote) {
    lines.push(`anteckning från användaren: ${flattenMemoryContent(c.userNote)}`)
  }

  if (c.contextAnswerRaw && c.contextAnswerRaw !== c.userNote) {
    lines.push(`användarens egna ord: ${flattenMemoryContent(c.contextAnswerRaw)}`)
  }

  if (c.openQuestion) {
    const via = c.channel === 'whatsapp' ? 'WhatsApp' : c.channel
    const what =
      c.openQuestion.type === 'representation'
        ? 'deltagare och syfte (representation)'
        : c.openQuestion.type === 'resend'
          ? 'ett tydligare foto av underlaget'
          : 'vad köpet avsåg'
    const where =
      c.openQuestion.status === 'moved_to_app'
        ? `frågan ställdes i ${via} men förblev obesvarad och ägs nu av appen`
        : `frågan är ställd i ${via} och väntar på svar`
    // Marker text must match the instruction in the intent's promptTemplate
    // verbatim: a rule keyed to a string the renderer never emits is a rule
    // the model cannot follow.
    lines.push(`OBESVARAD FRÅGA: ${what}. Detta är den ENDA fråga som saknar svar (${where}).`)
  }

  return lines
}
