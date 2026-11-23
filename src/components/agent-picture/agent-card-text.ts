/**
 * What an agent card's line says, in words: the line agent-cards.ts worked
 * out, written with the picture's own messages. Pure, so the words can be
 * read in both languages without a screen.
 */
import type { AgentCardLine, AgentCardState } from '@/lib/agent-context/agent-cards'

/** A message of the wiki namespace, with its values. */
export type PictureMessages = (key: string, values?: Record<string, string | number>) => string

/** How the picture says an instant. */
export interface PictureWords {
  /** The time of day of an instant ("14:32"). */
  time: (instant: string) => string
  /** An instant in words: today with its time, another day by its date. */
  when: (instant: string) => string
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
  }
}

/**
 * A card's detail line: the line, and after it how many connections the card
 * stands for when there are several. The count is the part that is kept
 * whole when the card is narrow.
 */
export function agentCardDetail(state: Pick<AgentCardState, 'line' | 'connections'>, t: PictureMessages, words: PictureWords): { lead: string; tail?: string } {
  const lead = agentLineText(state.line, t, words)
  return state.connections > 1 ? { lead, tail: ` · ${t('picture.agent_connections', { count: state.connections })}` } : { lead }
}
