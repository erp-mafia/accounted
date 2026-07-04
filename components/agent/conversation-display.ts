// Shared display helpers for the agent conversation list: used by both the
// full-page /chat sidebar (ChatSidebar) and the in-sheet "resume conversation"
// list (AgentSessionList). Pure functions; no React. Keeping them in one place
// means the Idag / Igår / Denna vecka / Äldre grouping and the relative-time
// labels stay identical across both surfaces.

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

// Time buckets for date grouping. Computed once per render against now().
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

export function bucketFor(c: ConversationRow): DateBucket {
  if (c.pinned) return 'pinned'
  const when = c.last_message_at ?? c.created_at
  if (!when) return 'older'
  const t = new Date(when)
  const now = new Date()
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const yesterdayStart = new Date(todayStart.getTime() - 24 * 60 * 60 * 1000)
  const weekStart = new Date(todayStart.getTime() - 6 * 24 * 60 * 60 * 1000)
  if (t >= todayStart) return 'today'
  if (t >= yesterdayStart) return 'yesterday'
  if (t >= weekStart) return 'thisWeek'
  return 'older'
}

// Compact relative-time label shown to the right of each row. Locale-tuned
// to feel native in Swedish without going full date-fns.
export function relativeTime(iso: string | null | undefined): string {
  if (!iso) return ''
  const t = new Date(iso).getTime()
  const now = Date.now()
  const diffMin = Math.round((now - t) / 60000)
  if (diffMin < 1) return 'nu'
  if (diffMin < 60) return `${diffMin} min`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr} h`
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 7) return `${diffDay} d`
  return new Date(iso).toLocaleDateString('sv-SE', { month: 'short', day: 'numeric' })
}

export function intentLabel(intentId: string): string {
  switch (intentId) {
    case 'general.help':
      return 'Fråga din assistent'
    case 'transaction.categorization':
      return 'Hjälp med transaktion'
    case 'invoice.draft':
      return 'Hjälp med faktura'
    case 'supplier_invoice.review':
      return 'Granska leverantörsfaktura'
    case 'vat.review':
      return 'Granska moms­deklaration'
    case 'bokslut.step':
      return 'Hjälp med bokslut'
    case 'verifikation.draft':
      return 'Hjälp med verifikation'
    case 'kpi.explain':
      return 'Förklara nyckeltal'
    default:
      return intentId
  }
}

// Group a flat (already server-sorted: pinned first, then last_message_at desc)
// list into ordered, non-empty buckets. Shared so both list surfaces render
// the same section order.
export function groupConversations(
  rows: ConversationRow[],
): { bucket: DateBucket; rows: ConversationRow[] }[] {
  const buckets: Record<DateBucket, ConversationRow[]> = {
    pinned: [],
    today: [],
    yesterday: [],
    thisWeek: [],
    older: [],
  }
  for (const c of rows) buckets[bucketFor(c)].push(c)
  return BUCKET_ORDER.map((b) => ({ bucket: b, rows: buckets[b] })).filter((g) => g.rows.length > 0)
}
