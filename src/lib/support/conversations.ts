import posthog from 'posthog-js'
import { isAnalyticsActive } from '@/lib/analytics/client'

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

/**
 * The ticket the customer can reply in: the SDK's current ticket when it is
 * still open, otherwise the most recently active unresolved one. Null means
 * there is nothing to reply to.
 */
export function pickActiveTicket(tickets: TicketSummary[], currentId?: string | null): TicketSummary | null {
  const open = tickets.filter((t) => !isResolved(t.status))
  const current = currentId ? open.find((t) => t.id === currentId) : undefined
  if (current) return current
  return [...open].sort((a, b) => lastActivity(b) - lastActivity(a))[0] ?? null
}

export function sortByActivity(tickets: TicketSummary[]): TicketSummary[] {
  return [...tickets].sort((a, b) => lastActivity(b) - lastActivity(a))
}

/**
 * reply  the ticket can be continued (it is the active ticket)
 * read   shown read-only, for an answer the customer has not seen yet
 */
export type OpenMode = 'reply' | 'read'

/**
 * The ticket the dialog opens on. An open ticket wins and opens for replying.
 * With nothing open, the most recently active ticket with unread support
 * messages opens read-only (every ticket is resolved by then): support often
 * answers and resolves in one go, the trigger shows the unread dot and the
 * nudge mail says there is an answer, so an empty composer reads as the
 * answer being gone. Null means there is nothing to reply to and nothing new
 * to read: the dialog starts with a composer.
 */
export function pickTicketToOpen(
  tickets: TicketSummary[],
  currentId?: string | null
): { ticket: TicketSummary; mode: OpenMode } | null {
  const active = pickActiveTicket(tickets, currentId)
  if (active) return { ticket: active, mode: 'reply' }
  const unread = sortByActivity(tickets).find((t) => t.unreadCount > 0)
  return unread ? { ticket: unread, mode: 'read' } : null
}

/**
 * The customer's tickets besides the one on screen. Open ones are always
 * listed, so it is visible what is still in progress and one click switches
 * to it; resolved ones are history and wait behind a toggle.
 */
export function otherTickets(
  tickets: TicketSummary[],
  viewingId: string | null
): { open: TicketSummary[]; resolved: TicketSummary[] } {
  const others = tickets.filter((t) => t.id !== viewingId)
  return {
    open: others.filter((t) => !isResolved(t.status)),
    resolved: others.filter((t) => isResolved(t.status)),
  }
}

export function conversationsAvailable(): boolean {
  if (!isAnalyticsActive()) return false
  try {
    return Boolean(posthog.conversations?.isAvailable?.())
  } catch {
    return false
  }
}

export function currentTicketId(): string | null {
  try {
    return posthog.conversations?.getCurrentTicketId?.() ?? null
  } catch {
    return null
  }
}

export async function listTickets(): Promise<TicketSummary[]> {
  try {
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
    const res = await posthog.conversations.sendMessage(text, undefined, true)
    return res ? { ticketId: res.ticket_id } : null
  } catch {
    return null
  }
}

export async function markThreadRead(ticketId: string): Promise<void> {
  try {
    await posthog.conversations.markAsRead(ticketId)
  } catch {
    // Unread state is a convenience; losing it must not surface.
  }
}

export function totalUnread(tickets: TicketSummary[]): number {
  return tickets.reduce((n, t) => n + t.unreadCount, 0)
}
