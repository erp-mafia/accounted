/**
 * Helpers for the posting port's engine-input parity tests (step 2i): a
 * recorded engine call and the event links the port adds to it.
 *
 * A recorded call is [arity, ...arguments] with the client as '<supabase>',
 * an absent argument as '<undefined>' and trailing undefined arguments
 * dropped (the ledger adapter always passes createJournalEntry's commitMethod
 * and rubricVersion positions). With POSTING_EVENTS shadow or strict the port
 * adds only the event link: `businessEvent` in the engine's options (a
 * posting, a draft, a storno) or `businessEvents` in the storno service's
 * (a correction's two verifikat).
 */

export const RECORDED_SUPABASE = '<supabase>'

export interface RecordedEventLink {
  id: string
  role: string
  onFailure: string
}

/** One engine call as an engine-input fixture records it. */
export function recordEngineCall(args: unknown[]): unknown[] {
  const recorded = args.map((a, i) => (i === 0 ? RECORDED_SUPABASE : a === undefined ? '<undefined>' : a))
  while (recorded.length > 0 && recorded[recorded.length - 1] === '<undefined>') recorded.pop()
  return [recorded.length, ...recorded]
}

function linkOptions(call: unknown[]): Record<string, unknown> | null {
  const last = call[call.length - 1]
  if (call.length < 2 || !last || typeof last !== 'object' || Array.isArray(last)) return null
  const options = last as Record<string, unknown>
  return 'businessEvent' in options || 'businessEvents' in options ? options : null
}

/** A recorded call without the event links the port added: the call it made with the port off. */
export function withoutEventLinks(call: unknown[]): unknown[] {
  const options = linkOptions(call)
  if (!options) return call
  const { businessEvent: _link, businessEvents: _links, ...rest } = options
  const args = [...call.slice(1, -1), ...(Object.keys(rest).length > 0 ? [rest] : [])]
  while (args.length > 0 && args[args.length - 1] === '<undefined>') args.pop()
  return [args.length, ...args]
}

/** The event links a recorded call carries, in the order of the verifikat they link (storno before correction). */
export function eventLinksOf(call: unknown[]): RecordedEventLink[] {
  const options = linkOptions(call)
  if (!options) return []
  if (options.businessEvent) return [options.businessEvent as RecordedEventLink]
  const links = options.businessEvents as { reversal?: RecordedEventLink; correction?: RecordedEventLink }
  return [links.reversal, links.correction].filter((l): l is RecordedEventLink => Boolean(l))
}

/** Every call of a run without its event links, per engine function. */
export function callsWithoutEventLinks(calls: Record<string, unknown[][]>): Record<string, unknown[][]> {
  return Object.fromEntries(Object.entries(calls).map(([name, list]) => [name, list.map(withoutEventLinks)]))
}

/** The role a link of an event of this kind carries. */
export function roleForKind(kind: unknown): string {
  return kind === 'ledger.storno' ? 'reversal' : kind === 'ledger.correction' ? 'correction' : 'produced'
}
