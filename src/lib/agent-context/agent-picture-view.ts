/**
 * What the agent picture says, worked out from the picture's data: which
 * counts to name, what waits on the company's people, the sentence about the
 * checks, the memory's dots, when the company was last updated, how the
 * agents are named and grouped.
 *
 * Nothing here judges the books: the checks' own results are counted and
 * named, never weighed. Words stay with the screen: these helpers answer
 * with ids, numbers and message keys.
 *
 * Pure and browser-safe: no DOM, no IO.
 */
import { todayIsoStockholm } from '@/lib/dates/iso'
import { ISO_DATE_RE } from '@/lib/invariants'
import { AI_CLIENTS } from '@/lib/onboarding/ai-clients'
import type { PictureAgent, PictureChecks, PictureCounts, PictureSourceGroup, PictureWaiting } from './agent-picture'

// ---------------------------------------------------------------- times

/** How recently a source has to have delivered for its card to read as fresh. */
export const FRESH_SECONDS = 600

/** Whether an instant is within `windowSeconds` of `now`. Both come from the server, so the browser's clock never decides. */
export function isWithin(instant: string | null | undefined, now: string | Date, windowSeconds: number): boolean {
  if (!instant) return false
  const at = Date.parse(instant)
  const clock = typeof now === 'string' ? Date.parse(now) : now.getTime()
  if (Number.isNaN(at) || Number.isNaN(clock)) return false
  // The two clocks can differ by a moment: an instant stamped slightly ahead is still just now.
  return Math.abs(clock - at) / 1000 <= windowSeconds
}

/** A source that delivered in the last ten minutes. */
export function isFresh(lastDeliveredAt: string | null | undefined, now: string | Date): boolean {
  return isWithin(lastDeliveredAt, now, FRESH_SECONDS)
}

/** The newest time any connected source delivered: when the company was last updated. Null when no time is known. */
export function latestDelivery(groups: readonly PictureSourceGroup[]): string | null {
  let latest: string | null = null
  for (const item of groups.flatMap((group) => group.items)) {
    if (item.state !== 'connected' || !item.last_delivered_at) continue
    const at = Date.parse(item.last_delivered_at)
    if (Number.isNaN(at)) continue
    if (latest === null || at > Date.parse(latest)) latest = item.last_delivered_at
  }
  return latest
}

export interface InstantWords {
  /** The instant falls on the same Swedish calendar day as `now`. */
  today: boolean
  /** False for a bare date (YYYY-MM-DD), which names a day and no time of it. */
  hasTime: boolean
  /** The instant itself; for a bare date, noon of that day, which is that day wherever it is read. */
  date: Date
}

/**
 * How an instant is said: today (with its time when it has one), otherwise
 * by its date. The day is the Swedish calendar day, as everywhere else in
 * the books. Null for something that is no date.
 */
export function instantWords(instant: string, now: Date): InstantWords | null {
  const bare = ISO_DATE_RE.test(instant)
  const date = new Date(bare ? `${instant}T12:00:00Z` : instant)
  if (Number.isNaN(date.getTime())) return null
  const day = bare ? instant : todayIsoStockholm(date)
  return { today: day === todayIsoStockholm(now), hasTime: !bare, date }
}

// ---------------------------------------------------------------- counts

export type CountKind = keyof PictureCounts

const COUNT_ORDER: readonly CountKind[] = ['vouchers', 'bank_rows', 'documents', 'customers', 'suppliers']

/**
 * The counts the Kontext row names: every kind that was counted and holds
 * something. `unknown` when not one kind could be counted (an empty company
 * has every count at zero and is not unknown).
 */
export function countParts(counts: PictureCounts): { parts: Array<{ kind: CountKind; count: number }>; unknown: boolean } {
  const parts = COUNT_ORDER.flatMap((kind) => {
    const count = counts[kind]
    return count !== null && count > 0 ? [{ kind, count }] : []
  })
  return { parts, unknown: COUNT_ORDER.every((kind) => counts[kind] === null) }
}

// ---------------------------------------------------------------- what waits

/** What the company card's waiting line names: the questions and the proposals, or the one of them that waits. */
export type WaitingLine = { kind: 'both'; questions: number; proposals: number } | { kind: 'questions'; count: number } | { kind: 'proposals'; count: number }

/**
 * The line under the company's name: what waits on the company's people.
 * Null (no line) when nothing waits, and when it was not counted.
 */
export function waitingLine(waiting: PictureWaiting | null | undefined): WaitingLine | null {
  if (!waiting) return null
  const questions = Math.max(0, waiting.questions)
  const proposals = Math.max(0, waiting.proposals)
  if (questions > 0 && proposals > 0) return { kind: 'both', questions, proposals }
  if (questions > 0) return { kind: 'questions', count: questions }
  return proposals > 0 ? { kind: 'proposals', count: proposals } : null
}

// ---------------------------------------------------------------- memory dots

export const DOTS_PER_ROW = 12
export const MIN_DOTS = 36
export const MAX_DOTS = 72

/**
 * The memory's dot grid: rows of twelve, one filled dot per remembered
 * thing. Three rows at least; a full grid grows by a row, up to six rows,
 * where every dot is filled and the number beside it says the rest.
 */
export function memoryDots(count: number): { total: number; filled: number } {
  const things = Math.max(0, Math.floor(count))
  let total = MIN_DOTS
  while (things >= total && total < MAX_DOTS) total += DOTS_PER_ROW
  return { total, filled: Math.min(things, total) }
}

// ---------------------------------------------------------------- checks

/** The checks the sentence names when everything agrees, in this order. */
const NAMED_WHEN_AGREEING = ['bank_balance_vs_bank', 'skattekonto_vs_skatteverket'] as const
/** The bank feed's own line: its time is when the bank was last read. */
const BANK_FEED = 'bank_feed'
/** Names the sentence lists before it says how many more there are. */
const NAMES_SHOWN = 3

export type ChecksSummary =
  /** The checks could not be read at all. */
  | { kind: 'unreadable' }
  /** No check has a result to show. */
  | { kind: 'none' }
  /** Something needs a look: how many results, which checks (by id, the first few), how many more checks, and how many results agree. */
  | { kind: 'attention'; count: number; names: string[]; more: number; agrees: number }
  /** Nothing needs a look: the checks worth naming with the time each holds at, how many more results agree, how many could not run. */
  | { kind: 'agrees'; named: Array<{ check_id: string; as_of: string | null }>; more: number; agrees: number; unknown: number }
  /** Nothing agrees and nothing needs a look: only results that could not run. */
  | { kind: 'unknown'; count: number }

/**
 * What the Kontroller row says, from the check lines as they were read. It
 * counts the checks' own results and names them; it never decides whether a
 * difference matters.
 */
export function summarizeChecks(checks: PictureChecks | null): ChecksSummary {
  if (!checks) return { kind: 'unreadable' }
  const { counts, lines } = checks

  if (counts.attention > 0) {
    const ids = [...new Set(lines.filter((line) => line.status === 'attention').map((line) => line.check_id))]
    return { kind: 'attention', count: counts.attention, names: ids.slice(0, NAMES_SHOWN), more: Math.max(0, ids.length - NAMES_SHOWN), agrees: counts.agrees }
  }

  if (counts.agrees > 0) {
    const feed = lines.find((line) => line.check_id === BANK_FEED && line.status === 'agrees')
    const named: Array<{ check_id: string; as_of: string | null }> = []
    let covered = 0
    for (const id of NAMED_WHEN_AGREEING) {
      const own = lines.filter((line) => line.check_id === id)
      if (own.length === 0 || own.some((line) => line.status !== 'agrees')) continue
      covered += own.length
      // The bank agrees as of the last time the bank was read, when that is known.
      const fromFeed = id === 'bank_balance_vs_bank' && feed ? feed.as_of : null
      const newest = own.map((line) => line.as_of).filter((at): at is string => at !== null).sort().at(-1) ?? null
      named.push({ check_id: id, as_of: fromFeed ?? newest })
    }
    // The feed's line is said with the bank's when the bank is named.
    if (feed && named.some((entry) => entry.check_id === 'bank_balance_vs_bank')) covered += 1
    return { kind: 'agrees', named, more: Math.max(0, counts.agrees - covered), agrees: counts.agrees, unknown: counts.unknown }
  }

  return counts.unknown > 0 ? { kind: 'unknown', count: counts.unknown } : { kind: 'none' }
}

// ---------------------------------------------------------------- agents

type NamedAgent = Pick<PictureAgent, 'kind' | 'name' | 'service_account'>

/**
 * A connection's name, as the API settings page names its row: a service
 * account's connection by the account, a hand-made key by its own name, a
 * partner by the partner's name, Claude, ChatGPT and Grok by their product
 * names, and every other client by that page's own word for it (a message
 * key of settings_api_keys: a local client, an MCP client whose client is
 * not known, Cursor, ...).
 */
export function agentName(agent: NamedAgent): { text: string } | { message: string } {
  if (agent.service_account) return { text: agent.service_account }
  switch (agent.kind) {
    case 'key':
      return agent.name ? { text: agent.name } : { message: 'kind_mcp' }
    case 'partner':
      return agent.name ? { text: agent.name } : { message: 'kind_partner' }
    case 'claude':
    case 'chatgpt':
    case 'grok': {
      const client = AI_CLIENTS.find((entry) => entry.id === agent.kind)
      return client ? { text: client.name } : { message: 'kind_mcp' }
    }
    case 'gemini':
    case 'copilot':
      return { message: `target_${agent.kind}` }
    default:
      return { message: `kind_${agent.kind}` }
  }
}

/** Whether a name starts with the host's brand name, whatever the case. */
export function startsWithBrand(name: string, brandName: string): boolean {
  const brand = brandName.trim().toLocaleLowerCase()
  return brand !== '' && name.trim().toLocaleLowerCase().startsWith(brand)
}

/**
 * The groups of the agents column: the clients a person signed in with, the
 * host's own service accounts (an account whose name starts with the brand
 * name), the company's other service accounts, and hand-made keys.
 */
export type AgentGroupId = 'clients' | 'brand' | 'service_accounts' | 'keys'

const GROUP_ORDER: readonly AgentGroupId[] = ['clients', 'brand', 'service_accounts', 'keys']

export function agentGroupOf(agent: Pick<PictureAgent, 'kind' | 'service_account'>, brandName: string): AgentGroupId {
  if (agent.service_account) return startsWithBrand(agent.service_account, brandName) ? 'brand' : 'service_accounts'
  return agent.kind === 'key' ? 'keys' : 'clients'
}

/** The agents by group, in the column's order; a group with nobody in it is left out. */
export function groupAgents<T extends Pick<PictureAgent, 'kind' | 'service_account'>>(agents: readonly T[], brandName: string): Array<{ id: AgentGroupId; agents: T[] }> {
  return GROUP_ORDER.map((id) => ({ id, agents: agents.filter((agent) => agentGroupOf(agent, brandName) === id) })).filter((group) => group.agents.length > 0)
}
