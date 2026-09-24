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

/** next-intl translator for the `agent_conversation_display` namespace. */
export type ConversationDisplayTranslate = (
  key: string,
  values?: Record<string, string | number>,
) => string

export function bucketLabel(bucket: DateBucket, t: ConversationDisplayTranslate): string {
  switch (bucket) {
    case 'pinned':
      return t('bucket_pinned')
    case 'today':
      return t('bucket_today')
    case 'yesterday':
      return t('bucket_yesterday')
    case 'thisWeek':
      return t('bucket_this_week')
    case 'older':
      return t('bucket_older')
  }
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

// Compact relative-time label shown to the right of each row, in the
// viewer's locale without going full date-fns.
export function relativeTime(
  iso: string | null | undefined,
  t: ConversationDisplayTranslate,
  locale = 'sv-SE',
): string {
  if (!iso) return ''
  const then = new Date(iso).getTime()
  const now = Date.now()
  const diffMin = Math.round((now - then) / 60000)
  if (diffMin < 1) return t('relative_now')
  if (diffMin < 60) return t('relative_minutes', { count: diffMin })
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return t('relative_hours', { count: diffHr })
  const diffDay = Math.round(diffHr / 24)
  if (diffDay < 7) return t('relative_days', { count: diffDay })
  return new Date(iso).toLocaleDateString(locale, { month: 'short', day: 'numeric' })
}

/**
 * One label per intent, for every surface that names a conversation.
 *
 * There were two of these: a map here and an intentToTitle in AgentSheet. They
 * had already drifted, so the panel opened on the bokslut wizard titled
 * "Fråga Anna" while the same thread in the history list read "Hjälp med
 * bokslut", and this one's fallback returned the raw intent id, putting
 * "bokslut.step" in front of the user as the name of their own conversation.
 *
 * `agentName` personalises the general-help and unknown cases ("Fråga Anna").
 * Omit it where the agent's name is not to hand: the wording stays correct,
 * just less personal. An unknown intent NEVER falls through to its id. A
 * switch rather than a lookup object: intent_id comes from the database, and
 * an object literal would resolve inherited keys such as 'toString'.
 */
export function intentLabel(
  intentId: string,
  t: ConversationDisplayTranslate,
  agentName?: string | null,
): string {
  switch (intentId) {
    case 'transaction.categorization':
      return t('intent_transaction_categorization')
    case 'invoice.draft':
      return t('intent_invoice_draft')
    case 'supplier_invoice.review':
      return t('intent_supplier_invoice_review')
    case 'vat.review':
      return t('intent_vat_review')
    case 'bokslut.step':
      return t('intent_bokslut_step')
    case 'verifikation.draft':
      return t('intent_verifikation_draft')
    case 'kpi.explain':
      return t('intent_kpi_explain')
    case 'settings.help':
      return t('intent_settings_help')
    case 'inbox.bulk-book':
      return t('intent_inbox_bulk_book')
  }
  const name = agentName?.trim()
  return name ? t('ask_named', { name }) : t('ask_assistant')
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
