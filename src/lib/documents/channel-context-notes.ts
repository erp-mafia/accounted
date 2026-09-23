/**
 * Render the verified human answers captured on a chat-sourced inbox item
 * (invoice_inbox_items.channel_context, written by the WhatsApp intake bot)
 * as ONE compact Swedish line for the booking notes path.
 *
 * The rendered string travels through the existing `notes` parameters
 * (book-direct, convert, bulk-book via categorize-core) and ends up appended
 * to the verifikat description, which caps at 500 chars in
 * lib/bookkeeping/transaction-entries.ts. This renderer therefore stays well
 * under that: at most CHANNEL_CONTEXT_NOTES_MAX chars, truncating the
 * participant list by WHOLE names ("… och 3 till"), never mid-name.
 *
 * Precedence: representation answers first (Skatteverket's dokumentationskrav
 * for representation: deltagare + syfte belong on the verifikat), then the
 * sender's explicit note. Both are answers a human typed to a question the bot
 * asked, having been told they reach the bookkeeping. The photo caption is the
 * weakest signal: nobody was asked for it and nobody reviewed it, so it is
 * OFF by default and only renders where a human sees the result before it is
 * posted (see ChannelContextNotesOptions.includeCaption).
 *
 * Core lib: must not import from @/extensions. Deliberately Swedish-only
 * output: the verifikat description is a regulatory surface (see
 * .claude/rules/i18n.md), not UI chrome.
 */
import type { InboxChannelContext } from '@/types'

/**
 * Cap on the rendered line. 220 leaves the description's 500-char cap plenty
 * of room for the bank text / supplier prefix it is appended to.
 */
export const CHANNEL_CONTEXT_NOTES_MAX = 220

/** "Anna Berg (Volvo)" with a company, bare "Jakob W" without (the sender
 *  themselves usually answers without naming their own company). */
export function renderChannelParticipant(p: {
  name: string
  company: string | null
}): string {
  const name = (p.name ?? '').trim()
  if (!name) return ''
  const company = (p.company ?? '').trim()
  return company ? `${name} (${company})` : name
}

function buildLine(
  names: string[],
  droppedCount: number,
  purpose: string | null,
  userNote: string | null,
): string {
  const parts: string[] = []
  if (names.length > 0) {
    const suffix = droppedCount > 0 ? ` … och ${droppedCount} till` : ''
    parts.push(`Representation: ${names.join(', ')}${suffix}`)
  }
  if (purpose) parts.push(`Syfte: ${purpose}`)
  if (userNote) parts.push(userNote)
  return parts.join(' · ')
}

/** Last-resort cap for free text (purpose/note/caption): the whole-name rule
 *  above governs the participant list; a runaway free-text field is cut with
 *  an ellipsis instead. Result is always <= CHANNEL_CONTEXT_NOTES_MAX. */
function capFreeText(line: string): string {
  if (line.length <= CHANNEL_CONTEXT_NOTES_MAX) return line
  return `${line.slice(0, CHANNEL_CONTEXT_NOTES_MAX - 1).trimEnd()}…`
}

export interface ChannelContextNotesOptions {
  /**
   * Render the raw photo caption when there is neither a representation
   * answer nor a sender note. Default false.
   *
   * Off by default on purpose. The representation answer and the note are
   * replies to a question the bot asked, so the sender knew they were writing
   * bookkeeping text; the caption is whatever happened to be typed next to a
   * photo and nobody reviewed it. Every unattended path (bulk-book, the
   * server-side note defaults used by MCP and API callers) writes straight
   * into a posted verifikat, which BFL 5 kap 5 § only lets you change through
   * a formal rättelse. Pass true only where a human sees the string and can
   * edit or delete it before booking: today that is the Bokför direkt dialog
   * prefill.
   */
  includeCaption?: boolean
}

export function renderChannelContextNotes(
  ctx: InboxChannelContext | null | undefined,
  options: ChannelContextNotesOptions = {},
): string | null {
  if (!ctx) return null

  const names = (ctx.representation?.participants ?? [])
    .map(renderChannelParticipant)
    .filter((n) => n.length > 0)
  const purpose = ctx.representation?.purpose?.trim() || null
  const userNote = ctx.user_note?.trim() || null
  const caption = options.includeCaption ? ctx.caption?.trim() || null : null

  // Caption (when allowed) only if there is neither a representation answer
  // nor a note.
  if (names.length === 0 && !purpose && !userNote) {
    return caption ? capFreeText(caption) : null
  }

  // Full participant list first; drop whole names from the end until the
  // line fits. Keeps at least one name so the representation trail never
  // degrades to a bare count.
  let keep = names.length
  for (;;) {
    const line = buildLine(names.slice(0, keep), names.length - keep, purpose, userNote)
    if (line.length <= CHANNEL_CONTEXT_NOTES_MAX) return line
    if (keep > 1) {
      keep--
      continue
    }
    return capFreeText(line)
  }
}
