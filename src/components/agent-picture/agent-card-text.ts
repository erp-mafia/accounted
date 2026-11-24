/**
 * What an agent card's line says, in words: the line agent-cards.ts worked
 * out, written with the picture's own messages. Pure, so the words can be
 * read in both languages without a screen.
 */
import type { AgentCardLine, AgentCardState } from '@/lib/agent-context/agent-cards'
import { dayWords } from '@/lib/agent-context/agent-picture-view'

/** A message of the wiki namespace, with its values. */
export type PictureMessages = (key: string, values?: Record<string, string | number>) => string

/** How the picture says an instant. */
export interface PictureWords {
  /** The time of day of an instant ("14:32"). */
  time: (instant: string) => string
  /** An instant in words: today with its time, another day by its date. */
  when: (instant: string) => string
}

/** The picture's words with a day said short, for a line that has little room. */
export interface CardWords extends PictureWords {
  /** An instant's day in few words: "i dag", "30 mars", "2025" (shortDay). */
  day: (instant: string) => string
}

/**
 * How many characters of a card's 12px line fit whole at the card's
 * narrowest desktop width. The picture's three columns start at a 768px
 * wide picture, where a side column is 208px: less the insets of its group
 * and of the card, the mark and the gap after it, 138px are left for the
 * text, and the lines here run about 6px a character.
 */
export const CARD_LINE_BUDGET = 23

/**
 * A day in few words: today in the picture's own word (`today`), a day of
 * this year by its day and short month ("30 mars", "30 Sept"), a day of
 * another year by the year ("2025"). Swedish time, like the day an instant
 * is counted to. Empty for something that is no date.
 */
export function shortDay(instant: string, now: Date, locale: string, today: string): string {
  const words = dayWords(instant, now)
  if (!words) return ''
  if (words.kind === 'today') return today
  const parts: Intl.DateTimeFormatOptions = words.kind === 'day' ? { day: 'numeric', month: 'short' } : { year: 'numeric' }
  return new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'sv-SE', { ...parts, timeZone: 'Europe/Stockholm' }).format(words.date)
}

/** The line itself: what the card is doing, did today, or when it was last used. */
export function agentLineText(line: AgentCardLine, t: PictureMessages, words: PictureWords): string {
  switch (line.kind) {
    case 'reading':
      return t('picture.reading_now')
    case 'work':
      if (line.questions > 0 && line.proposals > 0) return t('picture.agent_work_both', { questions: line.questions, proposals: line.proposals })
      return line.questions > 0 ? t('picture.agent_work_questions', { count: line.questions }) : t('picture.agent_work_proposals', { count: line.proposals })
    case 'calls':
      return t(line.capped ? 'picture.calls_today_capped' : 'picture.calls_today', { count: line.count, time: words.time(line.last_call_at) })
    case 'last_used':
      return t('picture.last_used', { when: words.when(line.at) })
    case 'never_used':
      return t('picture.never_used')
    case 'connected':
      return t('picture.connected')
  }
}

/**
 * The line in its short wording, each case within CARD_LINE_BUDGET: the
 * calls without the time of the last one, the last use by its day alone
 * (shortDay), the questions and the proposals without "today".
 */
export function agentShortLineText(line: AgentCardLine, t: PictureMessages, words: CardWords): string {
  switch (line.kind) {
    case 'work':
      if (line.questions > 0 && line.proposals > 0) return t('picture.agent_work_both_short', { questions: line.questions, proposals: line.proposals })
      return agentLineText(line, t, words)
    case 'calls':
      return t(line.capped ? 'picture.calls_today_capped_short' : 'picture.calls_today_short', { count: line.count })
    case 'last_used':
      return t('picture.last_used', { when: words.day(line.at) })
    default:
      return agentLineText(line, t, words)
  }
}

/**
 * A card's text under its name. A card that stands for one connection has
 * the line in its full wording. A card that stands for several has the line
 * in its short wording, and how many connections it stands for on a row of
 * its own under the line (`under`): the two never share a row, so neither is
 * cut to make room for the other, and each fits the card at its narrowest
 * (CARD_LINE_BUDGET).
 */
export function agentCardDetail(state: Pick<AgentCardState, 'line' | 'connections'>, t: PictureMessages, words: CardWords): { lead: string; under?: string } {
  if (state.connections <= 1) return { lead: agentLineText(state.line, t, words) }
  return { lead: agentShortLineText(state.line, t, words), under: t('picture.agent_connections', { count: state.connections }) }
}
