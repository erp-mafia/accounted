/**
 * The cards of the agent picture's agents column: which connections stand on
 * one card, which questions and proposals belong to a card, and what a
 * card's line says.
 *
 * One card per product: the connections the screen names by their kind
 * (Claude, ChatGPT, a local client, an MCP client whose client is not known)
 * are one card per kind. A connection with a name of its own (a hand-made
 * key, a partner's key) is a card of its own, and a service account's
 * connections are one card per account.
 *
 * A question or a proposal belongs to a card when its row names one of the
 * card's connections by id. A row that carries a label and no id belongs to
 * the card whose connections alone write that label; a label two cards can
 * write belongs to neither.
 *
 * Pure and browser-safe: no DOM, no IO.
 */
import type { ConnectionKind } from '@/lib/settings/mcp-connections'
import { isReadingNow } from './agent-picture-lines'
import type { PictureActivity, PictureAgentCard, PictureWork, PictureWorkCount } from './agent-picture'

// ---------------------------------------------------------------- cards

/** What a connection carries for it to be put on a card. */
export interface CardConnection {
  /** The connection's id (the api key's). */
  id: string
  kind: ConnectionKind
  /** A hand-made key's own name or a partner's name; null when the screen names the client by its kind. */
  name: string | null
  /** The service account the connection belongs to, by its name; null for a person's connection. */
  service_account: string | null
  /** That account's id; null for a person's connection. */
  service_account_id: string | null
  /** What the connection is called in the records it writes; null when that is not known. */
  label: string | null
}

export interface CardOf<T> {
  id: string
  kind: ConnectionKind
  name: string | null
  service_account: string | null
  /** The connections behind the card, in the order they were given. */
  connections: T[]
  /** The labels only this card's connections write in the records. */
  labels: string[]
}

/** A card's id in a form that names what it stands for. */
const ACCOUNT_CARD = 'account:'
const KEY_CARD = 'key:'

/**
 * The id of the card a connection stands on: its service account, itself
 * when it has a name of its own, otherwise its kind.
 */
export function agentCardId(connection: Pick<CardConnection, 'id' | 'kind' | 'name' | 'service_account_id'>): string {
  if (connection.service_account_id) return `${ACCOUNT_CARD}${connection.service_account_id}`
  if (connection.name !== null) return `${KEY_CARD}${connection.id}`
  return connection.kind
}

/** What a card's id looks like: a kind, or `account:` or `key:` and an id. A door that is handed one checks it against this. */
export const AGENT_CARD_ID_RE = /^(?:[a-z_]{1,40}|(?:account|key):[0-9A-Za-z-]{1,64})$/

/**
 * The connections as cards, in the order each card's first connection was
 * given (the loader gives the ones that worked last first). Each card knows
 * the labels it alone can have written: the ownership is worked out over
 * every card, so it is the same however many of them a screen lists.
 */
export function agentCards<T extends CardConnection>(connections: readonly T[]): Array<CardOf<T>> {
  const cards = new Map<string, CardOf<T>>()
  const writers = new Map<string, Set<string>>()
  for (const connection of connections) {
    const id = agentCardId(connection)
    const card = cards.get(id)
    if (card) card.connections.push(connection)
    else {
      cards.set(id, {
        id,
        kind: connection.kind,
        // A service account's card is the account: no key's name stands for it.
        name: connection.service_account_id ? null : connection.name,
        service_account: connection.service_account,
        connections: [connection],
        labels: [],
      })
    }
    if (connection.label) writers.set(connection.label, (writers.get(connection.label) ?? new Set<string>()).add(id))
  }
  for (const card of cards.values()) {
    const own = card.connections.map((connection) => connection.label).filter((label): label is string => !!label && writers.get(label)?.size === 1)
    card.labels = [...new Set(own)]
  }
  return [...cards.values()]
}

// ---------------------------------------------------------------- attribution

/** Who a question or a proposal says staged it. */
export interface StagerRef {
  actor_id: string | null
  actor_label: string | null
}

type OwningCard = { connections: ReadonlyArray<{ id: string }>; labels: readonly string[] }

/**
 * Whether a row belongs to a card: it names one of the card's connections by
 * id, or it carries a label and no id, and the card alone owns that label. A
 * row that names a connection by id is never read by its label.
 */
export function cardOwnsRow(card: OwningCard, row: StagerRef): boolean {
  if (row.actor_id) return card.connections.some((connection) => connection.id === row.actor_id)
  return !!row.actor_label && card.labels.includes(row.actor_label)
}

const NO_WORK: PictureWorkCount = { questions: 0, proposals: 0 }

/**
 * Questions and proposals counted by who staged them: by connection for the
 * rows that name one, by label for the rows that carry a label alone. A row
 * with neither is counted nowhere.
 */
export function tallyWork(questions: readonly StagerRef[], proposals: readonly StagerRef[]): PictureWork {
  const work: PictureWork = { by_connection: {}, by_label: {} }
  const add = (row: StagerRef, what: keyof PictureWorkCount) => {
    const bucket = row.actor_id ? work.by_connection : work.by_label
    const key = row.actor_id || row.actor_label
    if (!key) return
    const count = (bucket[key] ??= { questions: 0, proposals: 0 })
    count[what] += 1
  }
  for (const row of questions) add(row, 'questions')
  for (const row of proposals) add(row, 'proposals')
  return work
}

/** What a card did, from the counts by stager: its connections' own, and the labels it alone owns. */
export function cardWork(card: OwningCard, work: PictureWork | null | undefined): PictureWorkCount {
  if (!work) return NO_WORK
  const parts = [
    ...card.connections.map((connection) => work.by_connection[connection.id]),
    ...card.labels.map((label) => work.by_label[label]),
  ].filter((part): part is PictureWorkCount => part !== undefined)
  return parts.reduce((sum, part) => ({ questions: sum.questions + part.questions, proposals: sum.proposals + part.proposals }), NO_WORK)
}

// ---------------------------------------------------------------- the card's panel

/** Questions, and proposals, a card's panel lists at most; the counts carry the rest. */
export const AGENT_WORK_SHOWN = 10
/** How many days back a card's approved and rejected proposals are counted. */
export const AGENT_RESOLVED_DAYS = 30

// ---------------------------------------------------------------- the card's line

/**
 * What a card's line says, the first that holds: a call in the last minute,
 * what it did for the company today (questions asked, proposals prepared),
 * the calls it made today, when it was last used, or that it never was.
 */
export type AgentCardLine =
  | { kind: 'reading' }
  | { kind: 'work'; questions: number; proposals: number }
  | { kind: 'calls'; count: number; last_call_at: string; capped: boolean }
  | { kind: 'last_used'; at: string }
  | { kind: 'never_used' }

export interface AgentCardState {
  line: AgentCardLine
  /** A call in the last minute, by any of the card's connections. */
  active: boolean
  /** Tool calls today, over the card's connections. */
  calls: number
  /** The newest call of any of them; null when the log holds none. */
  last_call_at: string | null
  /** True when the day held more calls than were read: `calls` is then a lower bound. */
  capped: boolean
  /** How many connections the card stands for. */
  connections: number
}

const newest = (instants: ReadonlyArray<string | null | undefined>): string | null => {
  let latest: string | null = null
  for (const instant of instants) {
    if (!instant || Number.isNaN(Date.parse(instant))) continue
    if (latest === null || Date.parse(instant) > Date.parse(latest)) latest = instant
  }
  return latest
}

/**
 * A card's state from its connections and the newest activity answer. The
 * activity wins over what the picture came with; without one (the log could
 * not be read) nothing is said about today, only when the card was last used.
 */
export function agentCardState(card: Pick<PictureAgentCard, 'connections' | 'labels'>, activity: PictureActivity | null): AgentCardState {
  const seen = card.connections.map((connection) => {
    const logged = activity ? activity.actors[connection.id] : undefined
    return {
      calls: activity ? (logged?.calls_today ?? 0) : connection.calls_today,
      last_call_at: activity ? (logged?.last_call_at ?? null) : connection.last_call_at,
      last_used_at: connection.last_used_at,
    }
  })
  const calls = seen.reduce((sum, connection) => sum + connection.calls, 0)
  const lastCall = newest(seen.map((connection) => connection.last_call_at))
  const active = activity ? isReadingNow(lastCall, activity.now) : false
  const capped = activity?.capped ?? false
  // A connection's last call when the log holds one, else when its key was last used.
  const lastUsed = newest(seen.map((connection) => connection.last_call_at ?? connection.last_used_at))
  const work = cardWork(card, activity?.work)

  let line: AgentCardLine
  if (active) line = { kind: 'reading' }
  else if (work.questions > 0 || work.proposals > 0) line = { kind: 'work', questions: work.questions, proposals: work.proposals }
  else if (activity && calls > 0 && lastCall) line = { kind: 'calls', count: calls, last_call_at: lastCall, capped }
  else if (lastUsed) line = { kind: 'last_used', at: lastUsed }
  else line = { kind: 'never_used' }

  return { line, active, calls, last_call_at: lastCall, capped, connections: card.connections.length }
}
