import posthog from 'posthog-js'
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

/**
 * The thread the dialog opens on: the SDK's current ticket when it is still
 * open, otherwise the most recently active unresolved one. Null means the
 * dialog starts with a composer.
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

export function conversationsAvailable(): boolean {
  if (!isAnalyticsEnabled()) return false
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

/** Continues the SDK's current ticket. The response says which ticket it landed in. */
export async function replyInThread(text: string): Promise<{ ticketId: string } | null> {
  try {
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
