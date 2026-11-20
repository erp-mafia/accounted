/**
 * Briefings for the context graph's demo states on /sandbox/wiki, for an
 * invented company. ?graf=stor: a company with more of everything than the
 * graph draws, so the caps and the "+N" dots show. ?graf=tom: a briefing
 * with nothing to draw.
 *
 * The large one (graph-large.json) is shaped as gnubok_get_agent_briefing
 * answers, plus three keys the briefing does not send today (deadlines,
 * open_questions, permissions, in the prototype's shape): the graph draws
 * them when they arrive, and the sections under it list them by key name
 * until the context view learns them.
 */
import large from './graph-large.json'
import sample from './sample-answers.json'

export function largeGraphBriefing(): Record<string, unknown> {
  return large
}

/** A briefing that names the company and nothing else: the graph has only the agent, so it shows its empty line. */
export function emptyGraphBriefing(): Record<string, unknown> {
  return { company: sample.briefing.company }
}
