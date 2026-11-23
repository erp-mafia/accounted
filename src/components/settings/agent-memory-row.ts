/**
 * How one row of the memory panel reads, pure: the row's text and the line
 * under it. One rendering for the panel's full and plain variants.
 *
 * A row that a person's answer to a question saved holds the question and
 * the answer as one stored sentence. It reads as two lines instead: the
 * question as the quiet line and the answer as the main line, both taken
 * from the question itself (answered_question), never cut out of the stored
 * sentence. Every other row reads as its stored text.
 *
 * The line under a row says who saved it and when: the person, or the
 * connection and the person it acted for ("Claude åt Jonas Ek"), then the
 * date. It names the kind only on a row that is not a plain fact, and where
 * the row came from only when no person or connection saved it. It names no
 * later date: the row's updated_at also moves when the row is pinned, hidden
 * or read by an assistant, so it does not say that the text was changed.
 */
import { attributionWordsFrom, formatActorAttribution, mcpClientDisplayName, type AttributionWords } from '@/lib/attribution/format-actor'
import type { Creator } from '@/lib/attribution/person-names'
import type { FactKind, FactSource } from '@/lib/agent-context/agent-competence'
import { isAnswerFactContent } from '@/lib/questions/answer-fact'
import type { AnsweredQuestionOfFact } from '@/lib/questions/fact-questions'
import { formatDateLong } from '@/lib/utils'

export interface MemoryRowText {
  /** The row's main line: the answer, or the stored text. */
  main: string
  /** The quiet line over it: the question the answer was given to. Null on a row without one. */
  quiet: string | null
}

/**
 * The two lines of a row. The question and the answer are shown only while
 * the stored text is still the sentence that answer saved: a row whose text
 * was changed since, or was worded another way, shows the stored text, which
 * is what a connected agent is given.
 */
export function memoryRowText(row: { content: string; answered_question?: AnsweredQuestionOfFact | null }): MemoryRowText {
  const answered = row.answered_question
  if (answered && isAnswerFactContent(row.content, answered.question, answered.answer)) {
    return { main: answered.answer, quiet: answered.question }
  }
  return { main: row.content, quiet: null }
}

/** What the line under a row is built from. */
export interface MemoryLineRow {
  kind: FactKind
  source: FactSource
  /** The MCP client label that wrote it; null outside MCP. */
  client: string | null
  /** Who saved it; null or absent when the row records no one. */
  created_by?: Creator | null
  created_at: string
  is_active: boolean
}

/** The words of the line, in the reader's language. */
export interface MemoryLineWords {
  /** The name of a kind that is not a plain fact. */
  kind: (kind: Exclude<FactKind, 'fact'>) => string
  /** Where a row came from that neither a person nor a connection saved. */
  origin: (source: 'composer' | 'derived') => string
  /** A person whose account is deleted, as said inside a sentence ("en borttagen användare"). */
  creatorDeleted: string
  /** A row that is hidden. */
  hidden: string
  attribution: AttributionWords
}

type Translate = (key: string, values?: Record<string, string>) => string

/** The line's words from the message namespaces `settings`, `agentKnowledge` and `attribution`. */
export function memoryLineWordsFrom(t: { settings: Translate; knowledge: Translate; attribution: Translate }): MemoryLineWords {
  return {
    kind: (kind) => t.knowledge(kind === 'preference' ? 'kind_preference' : kind === 'pattern' ? 'kind_pattern' : 'kind_correction'),
    origin: (source) => t.knowledge(source === 'composer' ? 'source_composer' : 'source_derived'),
    creatorDeleted: t.settings('memory_creator_deleted'),
    hidden: t.settings('memory_hidden'),
    attribution: attributionWordsFrom(t.attribution),
  }
}

function upperFirst(value: string): string {
  return value ? value.charAt(0).toLocaleUpperCase() + value.slice(1) : value
}

/**
 * Who saved the row: the person, or the connection and the person it acted
 * for. A write through MCP carries the client label; an agent's row without
 * one reads as an AI connection, and one that records no person names the
 * connection alone. Null when the row records no one.
 */
export function memoryRowWho(row: Pick<MemoryLineRow, 'source' | 'client' | 'created_by'>, words: MemoryLineWords): string | null {
  const byAgent = Boolean(row.client) || row.source === 'agent_learned'
  const creator = row.created_by ?? null
  if (!creator && !byAgent) return null
  const deleted = Boolean(creator?.deleted) && !creator?.name
  const personName = creator?.name ?? (deleted ? words.creatorDeleted : null)
  if (byAgent) {
    return formatActorAttribution({ actorType: 'mcp_oauth', actorLabel: mcpClientDisplayName(row.client), personName }, words.attribution)
  }
  const person = formatActorAttribution({ actorType: 'user', personName }, words.attribution)
  // The deleted person's phrase is worded for the middle of a sentence; here it stands first.
  return deleted ? upperFirst(person) : person
}

/**
 * The line under a row, its parts joined by " · ": the kind (not on a plain
 * fact), where it came from (only when nobody saved it), who saved it, the
 * date it was saved and that it is hidden.
 */
export function memoryRowLine(row: MemoryLineRow, words: MemoryLineWords, locale: string): string {
  const parts: string[] = []
  if (row.kind !== 'fact') parts.push(words.kind(row.kind))
  const who = memoryRowWho(row, words)
  if (who) parts.push(who)
  else if (row.source === 'composer' || row.source === 'derived') parts.push(words.origin(row.source))
  parts.push(formatDateLong(row.created_at, locale))
  if (!row.is_active) parts.push(words.hidden)
  return parts.join(' · ')
}
