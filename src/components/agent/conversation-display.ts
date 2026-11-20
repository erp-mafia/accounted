// Shared display helpers for the agent conversation list: used by both the
// full-page /chat sidebar (ChatSidebar) and the in-sheet "resume conversation"
// list (AgentSessionList). Pure functions; no React. Keeping them in one place
// means the Idag / Igår / Denna vecka / Äldre grouping and the relative-time
// labels stay identical across both surfaces.
//
// Both read the clock, so both take `now` and count days in Swedish time
// (APP_TIME_ZONE). The /chat sidebar is rendered on the server and hydrated in
// the browser: counted in each runtime's own zone (UTC on Vercel, the
// visitor's in the browser) a conversation from just after midnight read Igår
// on the server and Idag in the browser, React threw error #418 and replaced
// the server HTML. ChatSidebar passes the server's render instant during
// hydration (useRenderedNow), so the two renders agree.

import { APP_TIME_ZONE } from '@/i18n/config'

export interface ConversationRow {
  id: string
  intent_id: string
  context_ref: string | null
  title: string | null
  pinned: boolean
  archived: boolean
  last_message_at: string | null
  last_message_preview: string | null
  created_at: string
}

// Time buckets for date grouping, counted in Swedish calendar days from `now`.
// Mirrors the Idag / Igår / Denna vecka / Äldre pattern users know from
// Mail and iMessage.
export type DateBucket = 'pinned' | 'today' | 'yesterday' | 'thisWeek' | 'older'

export const BUCKET_LABELS: Record<DateBucket, string> = {
  pinned: 'Fästade',
  today: 'Idag',
  yesterday: 'Igår',
  thisWeek: 'Denna vecka',
  older: 'Äldre',
}

export const BUCKET_ORDER: DateBucket[] = ['pinned', 'today', 'yesterday', 'thisWeek', 'older']

const SWEDISH_DAY = new Intl.DateTimeFormat('en-GB', {
  timeZone: APP_TIME_ZONE,
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
})

/** The Swedish calendar day of `ms`, as a day count from 1970-01-01. */
function swedishDayNumber(ms: number): number {
  const parts = SWEDISH_DAY.formatToParts(ms)
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value)
  return Date.UTC(part('year'), part('month') - 1, part('day')) / 86_400_000
}

export function bucketFor(c: ConversationRow, now: number = Date.now()): DateBucket {
  if (c.pinned) return 'pinned'
  const when = c.last_message_at ?? c.created_at
  if (!when) return 'older'
  const t = new Date(when).getTime()
  if (Number.isNaN(t)) return 'older'
  const daysAgo = swedishDayNumber(now) - swedishDayNumber(t)
  if (daysAgo <= 0) return 'today'
  if (daysAgo === 1) return 'yesterday'
  if (daysAgo <= 6) return 'thisWeek'
  return 'older'
}

// Compact relative-time label shown to the right of each row. Locale-tuned
// to feel native in Swedish without going full date-fns.
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  const diffMin = Math.round((now - t) / 60000)
  if (diffMin < 1) return 'nu'
  if (diffMin < 60) return `${diffMin} min`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr} h`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 7) return `${diffDay} d`
  return new Date(iso).toLocaleDateString('sv-SE', { month: 'short', day: 'numeric', timeZone: APP_TIME_ZONE })
}

/**
 * One label per intent, for every surface that names a conversation.
 *
 * There were two of these: this map and an intentToTitle in AgentSheet. They
 * had already drifted, so the panel opened on the bokslut wizard titled
 * "Fråga Anna" while the same thread in the history list read "Hjälp med
 * bokslut", and this one's fallback returned the raw intent id, putting
 * "bokslut.step" in front of the user as the name of their own conversation.
 */
// Null-prototype: a plain literal inherits from Object.prototype, so
// intentLabel('toString') would resolve to a FUNCTION, pass the truthiness
// check, and be handed to React as a title. intent_id comes from the database.
const INTENT_LABELS: Record<string, string> = Object.assign(Object.create(null), {
  'transaction.categorization': 'Hjälp med transaktion',
  'invoice.draft': 'Hjälp med faktura',
  'supplier_invoice.review': 'Granska leverantörsfaktura',
  'vat.review': 'Granska moms\u00addeklaration',
  'bokslut.step': 'Hjälp med bokslut',
  'verifikation.draft': 'Hjälp med verifikation',
  'kpi.explain': 'Förklara nyckeltal',
  'settings.help': 'Hjälp med inställningar',
  'inbox.bulk-book': 'Bokför från inkorgen',
})

/**
 * `agentName` personalises the general-help and unknown cases ("Fråga Anna").
 * Omit it where the agent's name is not to hand: the wording stays correct,
 * just less personal. An unknown intent NEVER falls through to its id.
 */
export function intentLabel(intentId: string, agentName?: string | null): string {
  const known = INTENT_LABELS[intentId]
  if (known) return known
  const name = agentName?.trim()
  return name ? `Fråga ${name}` : 'Fråga din assistent'
}

// Group a flat (already server-sorted: pinned first, then last_message_at desc)
// list into ordered, non-empty buckets. Shared so both list surfaces render
// the same section order.
export function groupConversations(
  rows: ConversationRow[],
  now: number = Date.now(),
): { bucket: DateBucket; rows: ConversationRow[] }[] {
  const buckets: Record<DateBucket, ConversationRow[]> = {
    pinned: [],
    today: [],
    yesterday: [],
    thisWeek: [],
    older: [],
  }
  for (const c of rows) buckets[bucketFor(c, now)].push(c)
  return BUCKET_ORDER.map((b) => ({ bucket: b, rows: buckets[b] })).filter((g) => g.rows.length > 0)
}
