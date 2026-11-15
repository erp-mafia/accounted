import { analyticsLoadFailed, analyticsReady, isAnalyticsActive, loadedAnalytics } from '@/lib/analytics/client'
import { isAnalyticsEnabled } from '@/lib/analytics/enabled'

/**
 * PostHog Support (Conversations) as the in-app support channel.
 *
 * The person is verified with the identity hash set in AnalyticsIdentify, so a
 * ticket follows the user across devices and the founders answer in PostHog's
 * inbox. This module is the only place the SDK's conversation methods are
 * called from; everything here returns null or [] instead of throwing, because
 * the dialog must degrade to the email form, never to an error screen.
 */
export type TicketStatus = 'new' | 'open' | 'pending' | 'on_hold' | 'resolved'

export interface TicketSummary {
  id: string
  status: TicketStatus
  lastMessage: string | null
  lastMessageAt: string | null
  createdAt: string
  messageCount: number
  unreadCount: number
}

export interface ThreadMessage {
  id: string
  text: string
  from: 'me' | 'support'
  authorName: string | null
  createdAt: string
}

export interface Thread {
  ticketId: string
  status: TicketStatus
  messages: ThreadMessage[]
  unreadCount: number
}

interface RawTicket {
  id: string
  status: string
  last_message?: string
  last_message_at?: string
  message_count?: number
  created_at: string
  unread_count?: number
}

interface RawMessage {
  id: string
  content: string
  author_type: string
  author_name?: string
  created_at: string
  is_private?: boolean
}

const STATUSES: TicketStatus[] = ['new', 'open', 'pending', 'on_hold', 'resolved']

function toStatus(s: string): TicketStatus {
  return (STATUSES as string[]).includes(s) ? (s as TicketStatus) : 'open'
}

export function isResolved(status: TicketStatus): boolean {
  return status === 'resolved'
}

export function toSummary(t: RawTicket): TicketSummary {
  return {
    id: t.id,
    status: toStatus(t.status),
    lastMessage: t.last_message ?? null,
    lastMessageAt: t.last_message_at ?? null,
    createdAt: t.created_at,
    messageCount: t.message_count ?? 0,
    unreadCount: t.unread_count ?? 0,
  }
}

/** Private notes are the founders' own; they never reach the customer view. */
export function toThreadMessage(m: RawMessage): ThreadMessage | null {
  if (m.is_private) return null
  return {
    id: m.id,
    text: m.content,
    from: m.author_type === 'customer' ? 'me' : 'support',
    authorName: m.author_type === 'customer' ? null : (m.author_name ?? null),
    createdAt: m.created_at,
  }
}

/**
 * The status the customer sees, which is not always the one PostHog stores.
 * Support sets a ticket to `pending` ("waiting for you") after answering, and
 * a later customer message does not move it back. Shown verbatim, the customer
 * keeps reading "waiting for you" under their own latest message. So a pending
 * ticket whose last visible message is the customer's own reads as `open`:
 * the ball is with support again. Every other status passes through.
 */
export function displayStatus(status: TicketStatus, messages: readonly Pick<ThreadMessage, 'from'>[]): TicketStatus {
  if (status !== 'pending') return status
  const last = messages[messages.length - 1]
  return last?.from === 'me' ? 'open' : status
}

function lastActivity(t: TicketSummary): number {
  return new Date(t.lastMessageAt ?? t.createdAt).getTime()
}

export function sortByActivity(tickets: TicketSummary[]): TicketSummary[] {
  return [...tickets].sort((a, b) => lastActivity(b) - lastActivity(a))
}

export type StartView = { view: 'compose' } | { view: 'list' } | { view: 'thread'; ticketId: string }

/**
 * Where the dialog opens. With no tickets, on the composer. With one ticket
 * that is still open or has an unread answer, straight in that thread: a list
 * of one is a detour. Otherwise on the list, so every open ticket and every
 * new answer is in sight at once (crm#1138). The list also covers a single
 * resolved ticket: an empty composer would read as the answer being gone.
 */
export function startView(tickets: TicketSummary[]): StartView {
  if (tickets.length === 0) return { view: 'compose' }
  const [only] = tickets
  if (tickets.length === 1 && (!isResolved(only.status) || only.unreadCount > 0)) {
    return { view: 'thread', ticketId: only.id }
  }
  return { view: 'list' }
}

/** Open tickets first in the list, resolved ones below as history. */
export function splitByStatus(tickets: TicketSummary[]): { open: TicketSummary[]; resolved: TicketSummary[] } {
  return {
    open: tickets.filter((t) => !isResolved(t.status)),
    resolved: tickets.filter((t) => isResolved(t.status)),
  }
}

export function conversationsAvailable(): boolean {
  // Null while the SDK loads after the page (lib/analytics/client.ts):
  // whenConversationsReady() below waits for it like for the remote config.
  const posthog = loadedAnalytics()
  if (!posthog) return false
  try {
    return Boolean(posthog.conversations?.isAvailable?.())
  } catch {
    return false
  }
}

const READY_TIMEOUT_MS = 5_000
const START_GRACE_MS = 1_000
const READY_POLL_MS = 100

/**
 * Whether the Conversations API can be used, waiting for it while it loads.
 *
 * isAvailable() turns true only after PostHog's remote config and the
 * conversations bundle have loaded, some 50 to 1000 ms after the page. A
 * dialog that asked once, at open, read a still-loading SDK as "no
 * conversations" and showed the empty mail form instead of the thread: the
 * customer who followed "we have answered" to the app found no answer
 * (crm#1393). So this waits, bounded. It answers false at once on an install
 * without PostHog, after START_GRACE_MS when PostHog has not started in this
 * browser (analytics switched off), and after READY_TIMEOUT_MS when Support
 * never comes up; the dialog then falls back to the mail form as before.
 *
 * The SDK itself loads after the page (lib/analytics/client.ts), so the
 * READY_TIMEOUT_MS for Support counts from when it has loaded: a slow
 * download must not eat the time the remote config and the conversations
 * bundle need. A failed load answers false at once, as no PostHog does.
 */
export async function whenConversationsReady({
  timeoutMs = READY_TIMEOUT_MS,
  startGraceMs = START_GRACE_MS,
  pollMs = READY_POLL_MS,
}: { timeoutMs?: number; startGraceMs?: number; pollMs?: number } = {}): Promise<boolean> {
  if (conversationsAvailable()) return true
  if (!isAnalyticsEnabled()) return false
  const startedAt = Date.now()
  // When the Support timeout starts: at the call, and again once the SDK has
  // loaded, so its download does not count against Support.
  let clockFrom = startedAt
  let sdkLoaded = loadedAnalytics() !== null
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, pollMs))
    if (conversationsAvailable()) return true
    if (analyticsLoadFailed()) return false
    const now = Date.now()
    if (!sdkLoaded && loadedAnalytics() !== null) {
      sdkLoaded = true
      clockFrom = now
    }
    if (now - clockFrom >= timeoutMs) return false
    if (!isAnalyticsActive() && now - startedAt >= startGraceMs) return false
  }
}

export function currentTicketId(): string | null {
  try {
    return loadedAnalytics()?.conversations?.getCurrentTicketId?.() ?? null
  } catch {
    return null
  }
}

export async function listTickets(): Promise<TicketSummary[]> {
  try {
    const posthog = await analyticsReady()
    if (!posthog) return []
    const res = await posthog.conversations.getTickets({ limit: 20 })
    return (res?.results ?? []).map((t) => toSummary(t as RawTicket))
  } catch {
    return []
  }
}

/**
 * Loading a thread also makes it the SDK's current ticket (getMessages
 * switches to it). That is not enough to route a reply: see replyInThread.
 */
export async function loadThread(ticketId: string): Promise<Thread | null> {
  try {
    const posthog = await analyticsReady()
    if (!posthog) return null
    const res = await posthog.conversations.getMessages(ticketId)
    if (!res) return null
    return {
      ticketId: res.ticket_id,
      status: toStatus(res.ticket_status),
      messages: res.messages.map((m) => toThreadMessage(m as RawMessage)).filter((m): m is ThreadMessage => m !== null),
      unreadCount: res.unread_count,
    }
  } catch {
    return null
  }
}

/**
 * Replies in `ticketId`, the thread on screen. sendMessage takes no ticket: it
 * continues the SDK's current ticket, which moves on its own as well (a
 * background reload of the thread shown before a click, an identity reset
 * that clears it so the reply would open a new ticket). So the SDK is pointed
 * at the ticket first, and the check and the send run in the same tick:
 * sendMessage reads the current ticket synchronously. Null when it cannot be
 * pointed there; a reply never goes to another ticket instead (crm#1311).
 * The response says which ticket it landed in.
 */
export async function replyInThread(ticketId: string, text: string): Promise<{ ticketId: string } | null> {
  try {
    const posthog = await analyticsReady()
    if (!posthog) return null
    if (currentTicketId() !== ticketId) await posthog.conversations.getMessages(ticketId).catch(() => null)
    if (currentTicketId() !== ticketId) return null
    const res = await posthog.conversations.sendMessage(text)
    return res ? { ticketId: res.ticket_id } : null
  } catch {
    return null
  }
}

export async function startThread(text: string): Promise<{ ticketId: string } | null> {
  try {
    const posthog = await analyticsReady()
    if (!posthog) return null
    const res = await posthog.conversations.sendMessage(text, undefined, true)
    return res ? { ticketId: res.ticket_id } : null
  } catch {
    return null
  }
}

export async function markThreadRead(ticketId: string): Promise<void> {
  try {
    const posthog = await analyticsReady()
    if (!posthog) return
    await posthog.conversations.markAsRead(ticketId)
  } catch {
    // Unread state is a convenience; losing it must not surface.
  }
}

export function totalUnread(tickets: TicketSummary[]): number {
  return tickets.reduce((n, t) => n + t.unreadCount, 0)
}
