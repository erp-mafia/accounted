import { describe, it, expect, vi, beforeEach } from 'vitest'
import { displayStatus, listTickets, loadThread, replyInThread, splitByStatus, startThread, startView, toSummary, toThreadMessage, totalUnread } from '@/lib/support/conversations'

const getTicketsMock = vi.fn()
const getMessagesMock = vi.fn()
const sendMessageMock = vi.fn()
vi.mock('posthog-js', () => ({
  default: {
    conversations: {
      isAvailable: () => true,
      getCurrentTicketId: () => 'cur',
      getTickets: (...a: unknown[]) => getTicketsMock(...a),
      getMessages: (...a: unknown[]) => getMessagesMock(...a),
      sendMessage: (...a: unknown[]) => sendMessageMock(...a),
      markAsRead: vi.fn(),
    },
  },
}))

const t = (id: string, status: string, at: string, unread = 0) => toSummary({ id, status, created_at: at, last_message_at: at, unread_count: unread })

describe('startView', () => {
  it('opens the composer when there are no tickets', () => {
    expect(startView([])).toEqual({ view: 'compose' })
  })
  it('opens a single open ticket straight away', () => {
    expect(startView([t('a', 'pending', '2026-10-08')])).toEqual({ view: 'thread', ticketId: 'a' })
  })
  it('opens a single resolved ticket with an unread answer straight away', () => {
    expect(startView([t('done', 'resolved', '2026-10-08', 1)])).toEqual({ view: 'thread', ticketId: 'done' })
  })
  it('lists a single resolved, read ticket instead of an empty composer', () => {
    expect(startView([t('done', 'resolved', '2026-10-08')])).toEqual({ view: 'list' })
  })
  it('lists two or more tickets, so every open one is in sight (crm#1138)', () => {
    expect(startView([t('b', 'new', '2026-10-10'), t('a', 'open', '2026-10-08')])).toEqual({ view: 'list' })
    expect(startView([t('b', 'open', '2026-10-10'), t('done', 'resolved', '2026-10-01', 1)])).toEqual({ view: 'list' })
  })
})

describe('splitByStatus', () => {
  it('puts open tickets first and resolved ones apart, keeping their order', () => {
    const tickets = [t('b', 'new', '2026-10-10'), t('old', 'resolved', '2026-09-01'), t('a', 'on_hold', '2026-10-08')]
    expect(splitByStatus(tickets)).toEqual({ open: [tickets[0], tickets[2]], resolved: [tickets[1]] })
  })
})

describe('displayStatus', () => {
  const me = { from: 'me' as const }
  const support = { from: 'support' as const }
  it('reads pending as open when the customer wrote last', () => {
    expect(displayStatus('pending', [support, me])).toBe('open')
    expect(displayStatus('pending', [support, me, me])).toBe('open')
  })
  it('keeps pending when support wrote last', () => {
    expect(displayStatus('pending', [me, support])).toBe('pending')
  })
  it('keeps pending when there are no visible messages', () => {
    expect(displayStatus('pending', [])).toBe('pending')
  })
  it('passes every other status through', () => {
    for (const s of ['new', 'open', 'on_hold', 'resolved'] as const) {
      expect(displayStatus(s, [support, me])).toBe(s)
    }
  })
})

describe('mapping', () => {
  it('drops private notes and tells customer from support', () => {
    expect(toThreadMessage({ id: '1', content: 'x', author_type: 'human', author_name: 'Jakob', created_at: 'd', is_private: true })).toBeNull()
    expect(toThreadMessage({ id: '2', content: 'x', author_type: 'customer', created_at: 'd' })).toMatchObject({ from: 'me', authorName: null })
    expect(toThreadMessage({ id: '3', content: 'y', author_type: 'human', author_name: 'Jakob', created_at: 'd' })).toMatchObject({ from: 'support', authorName: 'Jakob' })
  })
  it('normalises unknown statuses and counts unread', () => {
    expect(toSummary({ id: 'a', status: 'weird', created_at: 'd' }).status).toBe('open')
    expect(totalUnread([t('a', 'open', 'd', 2), t('b', 'open', 'd', 1)])).toBe(3)
  })
})

describe('SDK wrappers', () => {
  beforeEach(() => {
    getTicketsMock.mockReset()
    getMessagesMock.mockReset()
    sendMessageMock.mockReset()
  })
  it('listTickets maps results and never throws', async () => {
    getTicketsMock.mockResolvedValue({ count: 1, results: [{ id: 'a', status: 'open', created_at: 'd', unread_count: 1 }] })
    expect(await listTickets()).toEqual([t('a', 'open', 'd', 1)].map((x) => ({ ...x, lastMessageAt: null })))
    getTicketsMock.mockRejectedValue(new Error('boom'))
    expect(await listTickets()).toEqual([])
  })
  it('loadThread filters private notes', async () => {
    getMessagesMock.mockResolvedValue({
      ticket_id: 'a',
      ticket_status: 'open',
      unread_count: 0,
      has_more: false,
      messages: [
        { id: '1', content: 'hej', author_type: 'customer', created_at: 'd' },
        { id: '2', content: 'intern', author_type: 'human', created_at: 'd', is_private: true },
        { id: '3', content: 'svar', author_type: 'human', author_name: 'Jakob', created_at: 'd' },
      ],
    })
    const thread = await loadThread('a')
    expect(thread?.messages.map((m) => m.id)).toEqual(['1', '3'])
  })
  it('reply continues the current ticket, start opens a new one', async () => {
    sendMessageMock.mockResolvedValue({ ticket_id: 'x' })
    await replyInThread('hej')
    expect(sendMessageMock).toHaveBeenLastCalledWith('hej')
    await startThread('ny')
    expect(sendMessageMock).toHaveBeenLastCalledWith('ny', undefined, true)
  })
})
