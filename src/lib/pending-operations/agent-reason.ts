import { AsyncLocalStorage } from 'node:async_hooks'
import { globalSingleton } from '@/lib/global-singleton'

/**
 * The agent's reason on a staged write: one or two sentences on why it
 * proposes it. The person who approves it sees it (Att göra > Agentförslag),
 * and the decision receipt keeps it (suggestion_log.agent_reason, migration
 * 20261028210000).
 *
 * Every staging door accepts it as an optional `reason`, and none of them
 * hands it to the write itself:
 *   - MCP: every staging tool declares AGENT_REASON_PROPERTY (added where the
 *     tool list is assembled, server.ts) unless its own schema already has a
 *     `reason`. The callers of a tool's execute() (the dispatcher, the
 *     cross-company runner, the in-app chat) split it off with
 *     splitAgentReason and run the tool inside runWithAgentReason, so the
 *     staging helper finds it with currentAgentReason() and the tool's own
 *     validation never sees it.
 *   - REST v1 ?stage=true: a `reason` in the body, split off before the
 *     operation's input is parsed (lib/operations/v1.ts).
 * A tool or operation whose own input declares `reason` keeps it as its own
 * argument (a credit note's reason, a storno's review note); the same text
 * is taken as the agent's reason too, never removed.
 *
 * An optional note never fails the write: anything but a string is dropped,
 * whitespace is trimmed, an empty one is none, and a longer one is cut at a
 * word boundary to MAX_AGENT_REASON_CHARS.
 */

export const MAX_AGENT_REASON_CHARS = 500

/** The argument name, in a tool's input and in a v1 stage-mode body. */
export const AGENT_REASON_ARG = 'reason'

/** What a staging tool lists for the reason; the same object on every tool. */
export const AGENT_REASON_PROPERTY = Object.freeze({
  type: 'string',
  description: 'Why you propose this: the evidence and the pattern you followed.',
})

/**
 * How a tool takes the agent's reason: 'added' when it declares
 * AGENT_REASON_PROPERTY (split off before execute), 'own' when its own
 * input already has a `reason` (kept, and copied).
 */
export type AgentReasonArg = 'added' | 'own'

const ELLIPSIS = '…'

/** The reason as stored: trimmed, null when empty or not a string, at most MAX_AGENT_REASON_CHARS. */
export function normalizeAgentReason(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  // Code points, as char_length counts them: a cut never splits a surrogate pair.
  const chars = Array.from(trimmed)
  if (chars.length <= MAX_AGENT_REASON_CHARS) return trimmed
  const room = chars.slice(0, MAX_AGENT_REASON_CHARS - 1)
  let cut = room.length
  for (let i = room.length; i > 0; i--) {
    if (/\s/.test(room[i - 1]) || /\s/.test(chars[i])) {
      cut = i
      break
    }
  }
  // One word longer than the room: cut inside it rather than drop it all.
  const kept = room.slice(0, cut).join('').trimEnd()
  return `${kept || room.join('')}${ELLIPSIS}`
}

/**
 * Split the agent's reason off a tool's arguments. `added`: removed from
 * the arguments; `own`: left in place and read as well; neither: the
 * arguments are untouched and there is no reason.
 */
export function splitAgentReason<T extends Record<string, unknown>>(
  tool: { agentReason?: AgentReasonArg },
  args: T,
): { args: T; reason: string | null } {
  if (!tool.agentReason || !(AGENT_REASON_ARG in args)) return { args, reason: null }
  const reason = normalizeAgentReason(args[AGENT_REASON_ARG])
  if (tool.agentReason === 'own') return { args, reason }
  const { [AGENT_REASON_ARG]: _reason, ...rest } = args
  return { args: rest as T, reason }
}

// Request-local, like the staging batch (./batch-context.ts): one function
// instance serves concurrent requests, so a module variable could hand one
// request's reason to another's staging call. One scope per process
// (lib/global-singleton.ts): the MCP extension and core read the same one.
const agentReasonContext = globalSingleton(
  'stagingAgentReason',
  () => new AsyncLocalStorage<{ reason: string | null }>(),
)

/** Run `fn` with `reason` visible to the staging call it makes. */
export function runWithAgentReason<T>(reason: string | null, fn: () => Promise<T>): Promise<T> {
  return agentReasonContext.run({ reason }, fn)
}

/** The reason of the enclosing tool call, or null. */
export function currentAgentReason(): string | null {
  return agentReasonContext.getStore()?.reason ?? null
}

/**
 * True when PostgREST refused a column it does not know: PGRST204 on a
 * write, 42703 on a read. The code is live a few minutes before the
 * migration that adds agent_reason runs (it applies after the merge).
 */
export function isMissingColumnError(error: { code?: string } | null | undefined): boolean {
  return error?.code === 'PGRST204' || error?.code === '42703'
}

/**
 * The agent_reason column of a row, for a payload to spread: `{}` without a
 * reason, so a row with none never names the column. The schema guard
 * (tests/schema) reads the spread as this one column.
 */
export function agentReasonColumn(reason: string | null | undefined): { agent_reason?: string } {
  return reason ? { agent_reason: reason } : {}
}

/**
 * Write a row that may carry the agent's reason. `write` builds the payload
 * with agentReasonColumn(reason). When the column is not there yet, it is
 * written again without the reason, so the write itself never fails over it.
 */
export async function writeWithAgentReason<R extends { error: { code?: string } | null }>(
  reason: string | null | undefined,
  write: (reason: string | null) => PromiseLike<R>,
): Promise<R> {
  if (!reason) return write(null)
  const first = await write(reason)
  return isMissingColumnError(first.error) ? write(null) : first
}
