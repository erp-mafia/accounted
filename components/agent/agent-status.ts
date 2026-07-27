/**
 * One channel for "what is the assistant doing right now".
 *
 * Today the only publisher is the streaming turn inside AgentSheet, and the
 * only subscriber is the floating trigger. Both used to be blind: collapsing
 * the panel mid-answer hid the fact that the agent was still working, and the
 * moment it finished nothing said so, so the user either sat watching a static
 * pill or reopened the panel repeatedly to check.
 *
 * It is a reducer over a small event set rather than a pair of booleans in the
 * provider because the same channel has to carry a durable background run
 * later: a run publishes the same turn_start / step / turn_end events from a
 * poll or a socket, and the pill needs no changes. `detached` is that state,
 * built and rendered now even though v1 never dispatches it, so adding runs is
 * a publisher and not a redesign.
 *
 * React-free on purpose: this repo's unit project is node-only, so the state
 * machine is tested directly rather than through a component harness.
 */

export type AgentActivity =
  /** Nothing running, nothing waiting to be read. */
  | 'idle'
  /** A turn is streaming and the user can see it. */
  | 'working'
  /** A turn finished while the panel was hidden: there is something to read. */
  | 'done'
  /** Work is running somewhere the user cannot see it (durable runs, later). */
  | 'detached'

export interface AgentStatus {
  activity: AgentActivity
  /** What the agent is doing, already human-readable, e.g. "Bokar…". */
  step: string | null
  /** True while the panel showing this work is on screen. */
  visible: boolean
}

export type AgentStatusEvent =
  | { type: 'turn_start' }
  | { type: 'step'; label: string }
  | { type: 'turn_end' }
  | { type: 'visibility'; visible: boolean }
  /** Reserved for durable runs; v1 never dispatches it. */
  | { type: 'detached'; label?: string }
  /** Session ended (panel closed): forget everything. */
  | { type: 'reset' }

export const INITIAL_AGENT_STATUS: AgentStatus = {
  activity: 'idle',
  step: null,
  visible: true,
}

export function reduceAgentStatus(state: AgentStatus, event: AgentStatusEvent): AgentStatus {
  switch (event.type) {
    case 'turn_start':
      return { ...state, activity: 'working', step: null }

    case 'step':
      // A step can arrive for work that started before this channel was
      // listening (a resumed stream), so it implies working rather than
      // requiring it.
      return { ...state, activity: 'working', step: event.label }

    case 'turn_end':
      // Finishing on screen is not news: the answer is right there. Finishing
      // behind a collapsed panel is the whole point of this channel.
      return state.visible
        ? { ...state, activity: 'idle', step: null }
        : { ...state, activity: 'done', step: null }

    case 'visibility':
      if (!event.visible) return { ...state, visible: false }
      // Coming back into view consumes the notification, but must not cancel
      // work that is still running.
      return {
        ...state,
        visible: true,
        activity: state.activity === 'done' ? 'idle' : state.activity,
        step: state.activity === 'done' ? null : state.step,
      }

    case 'detached':
      return { ...state, activity: 'detached', step: event.label ?? null }

    case 'reset':
      return { ...INITIAL_AGENT_STATUS, visible: state.visible }

    default:
      return state
  }
}

/**
 * The trigger's label for a session that is hidden but alive.
 *
 * Returns null when the status has nothing to add, so the caller keeps its
 * ordinary "Fråga X" / "Fortsätt med X" wording instead of this function
 * inventing a second copy of it.
 */
export function collapsedStatusLabel(status: AgentStatus, name: string): string | null {
  switch (status.activity) {
    case 'working':
    case 'detached':
      return status.step ? stripEllipsis(status.step) : `${name} arbetar`
    case 'done':
      return `${name} är klar`
    default:
      return null
  }
}

/**
 * Tool labels are written as live narration ("Bokar avskrivningar…") because
 * they sit in the message trace. On the pill the same text is a state, and the
 * trailing ellipsis reads as a second spinner next to the real one.
 */
function stripEllipsis(label: string): string {
  return label.replace(/[….]+$/, '').trim()
}
