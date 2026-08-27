import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/extensions/general/whatsapp-inbox/lib/graph-api', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/whatsapp-inbox/lib/graph-api')
  >('@/extensions/general/whatsapp-inbox/lib/graph-api')
  return {
    ...actual,
    sendText: vi.fn().mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null }),
    sendReplyButtons: vi.fn().mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null }),
    sendList: vi.fn().mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null }),
  }
})

import {
  sendText,
  sendReplyButtons,
  sendList,
  truncateTitle,
  uniqueTitles,
} from '@/extensions/general/whatsapp-inbox/lib/graph-api'
import {
  askCompanyQuestion,
  applyCompanyChoice,
} from '@/extensions/general/whatsapp-inbox/lib/company-question'
import {
  NO_COMPANY_OPTIONS,
  STAGED_AWAITING_COMPANY,
} from '@/extensions/general/whatsapp-inbox/lib/conversation'
import { TEMPLATE } from '@/extensions/general/whatsapp-inbox/lib/messages'

const sendTextMock = vi.mocked(sendText)
const sendButtonsMock = vi.mocked(sendReplyButtons)
const sendListMock = vi.mocked(sendList)

function makeLink(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    user_id: 'user-1',
    phone_hash: 'hash-1',
    phone_enc: 'enc',
    phone_masked: '+46 70 *** ** 67',
    wa_profile_name: null,
    default_company_id: null,
    last_company_id: null,
    verified_at: '2026-08-01T09:00:00Z',
    revoked_at: null,
    muted_at: null,
    last_message_at: null,
    created_at: '2026-08-01T09:00:00Z',
    updated_at: '2026-08-01T09:00:00Z',
    ...overrides,
  } as never
}

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    phone_link_id: 'link-1',
    state: 'idle',
    context: {},
    company_id: null,
    service_window_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    debounce_until: null,
    pending_ack: false,
    last_inbound_at: null,
    last_outbound_at: null,
    created_at: '2026-08-01T09:00:00Z',
    updated_at: '2026-08-01T09:00:00Z',
    ...overrides,
  } as never
}

function memberships(n: number) {
  return Array.from({ length: n }, (_, i) => ({ company_id: `company-${i + 1}` }))
}

function companies(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `company-${i + 1}`, name: `Bolag ${String.fromCharCode(65 + i)} AB` }))
}

const replyBase = {
  senderPhoneHash: 'hash-1',
  phoneLinkId: 'link-1',
  conversationId: 'conv-1',
  correlationId: 'corr-1',
}

describe('askCompanyQuestion', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('uses reply buttons for <=3 companies, ids = company ids', async () => {
    const { supabase, enqueue, findCalls, calls } = createQueuedMockSupabase()
    enqueue({ data: memberships(3) })
    enqueue({ data: companies(3) })
    enqueue({ data: [{ id: 'conv-1' }] }) // guarded transition won

    const asked = await askCompanyQuestion(supabase as unknown as SupabaseClient, {
      conversation: makeConversation(),
      link: makeLink(),
      to: '46701234567',
      replyBase,
      stagedCount: 1,
    })

    expect(asked).toBe('asked')
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    const args = sendButtonsMock.mock.calls[0][1]
    expect(args.buttons).toHaveLength(3)
    expect(args.buttons[0]).toEqual({ id: 'company-1', title: 'Bolag A AB' })
    expect(args.body).toContain('Vilket företag')
    // The interactive send succeeded: no numbered fallback, no duplicate question.
    expect(sendTextMock).not.toHaveBeenCalled()
    // Archived companies are never offered (#1589).
    expect(
      calls.some(
        (c) =>
          c.table === 'companies' &&
          c.method === 'is' &&
          c.args[0] === 'archived_at' &&
          c.args[1] === null,
      ),
    ).toBe(true)
    // State transition stored the options for digit replies too.
    const patch = findCalls('whatsapp_conversations', 'update')[0][0] as {
      state: string
      context: { company_options: unknown[]; pending_question: { type: string } }
    }
    expect(patch.state).toBe('awaiting_company')
    expect(patch.context.company_options).toHaveLength(3)
    expect(patch.context.pending_question.type).toBe('company')
  })

  it('falls back to the numbered text question when the reply-button send is rejected', async () => {
    sendButtonsMock.mockResolvedValueOnce({
      ok: false,
      wamid: null,
      errorDetail:
        'Send failed (HTTP 400): {"error":{"message":"(#131009) Parameter value is not valid","error_data":{"details":"Duplicate button title"}}}',
    })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: memberships(3) })
    enqueue({ data: companies(3) })
    enqueue({ data: [{ id: 'conv-1' }] })

    const asked = await askCompanyQuestion(supabase as unknown as SupabaseClient, {
      conversation: makeConversation(),
      link: makeLink(),
      to: '46701234567',
      replyBase,
      stagedCount: 1,
    })

    expect(asked).toBe('asked')
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    const fallback = sendTextMock.mock.calls[0][1]
    expect(fallback.template).toBe(TEMPLATE.m6CompanyQuestion)
    expect(fallback.to).toBe('46701234567')
    expect(fallback.body).toContain('1. Bolag A AB')
    expect(fallback.body).toContain('3. Bolag C AB')
    expect(fallback.body).toContain('Svara med en siffra')
    // The question stays armed: exactly one conversation write, no rollback.
    expect(findCalls('whatsapp_conversations', 'update')).toHaveLength(1)
  })

  it('falls back to the numbered text question when the list send is rejected', async () => {
    sendListMock.mockResolvedValueOnce({ ok: false, wamid: null, errorDetail: 'Send failed (HTTP 400)' })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: memberships(5) })
    enqueue({ data: companies(5) })
    enqueue({ data: [{ id: 'conv-1' }] })

    const asked = await askCompanyQuestion(supabase as unknown as SupabaseClient, {
      conversation: makeConversation(),
      link: makeLink(),
      to: '46701234567',
      replyBase,
      stagedCount: 2,
    })

    expect(asked).toBe('asked')
    expect(sendListMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    const body = sendTextMock.mock.calls[0][1].body
    expect(body).toContain('kvittona')
    expect(body).toContain('5. Bolag E AB')
    expect(findCalls('whatsapp_conversations', 'update')).toHaveLength(1)
  })

  it('rolls back only when the numbered fallback also fails', async () => {
    sendButtonsMock.mockResolvedValueOnce({ ok: false, wamid: null, errorDetail: 'Send failed (HTTP 400)' })
    sendTextMock.mockResolvedValueOnce({ ok: false, wamid: null, errorDetail: 'Send failed (HTTP 500)' })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: memberships(3) })
    enqueue({ data: companies(3) })
    enqueue({ data: [{ id: 'conv-1' }] }) // guarded transition won
    enqueue({
      data: [
        {
          ...(makeConversation() as Record<string, unknown>),
          state: 'awaiting_company',
          context: { company_options: [{ id: 'company-1', name: 'Bolag A AB' }] },
        },
      ],
    }) // rollback echo

    const asked = await askCompanyQuestion(supabase as unknown as SupabaseClient, {
      conversation: makeConversation(),
      link: makeLink(),
      to: '46701234567',
      replyBase,
      stagedCount: 1,
    })

    expect(asked).toBe('not_asked')
    expect(sendButtonsMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    const updates = findCalls('whatsapp_conversations', 'update').map(
      (args) => args[0] as { state?: string; context?: Record<string, unknown> },
    )
    expect(updates).toHaveLength(2)
    expect(updates[0].state).toBe('awaiting_company')
    expect(updates[1].state).toBe('idle')
    expect(updates[1].context?.company_options).toBeUndefined()
    expect(updates[1].context?.pending_question).toBeUndefined()
  })

  it('uses a list message for 4-10 companies', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: memberships(5) })
    enqueue({ data: companies(5) })
    enqueue({ data: [{ id: 'conv-1' }] })

    await askCompanyQuestion(supabase as unknown as SupabaseClient, {
      conversation: makeConversation(),
      link: makeLink(),
      to: '46701234567',
      replyBase,
      stagedCount: 2,
    })

    expect(sendListMock).toHaveBeenCalledTimes(1)
    const args = sendListMock.mock.calls[0][1]
    expect(args.rows).toHaveLength(5)
    expect(args.buttonLabel).toBe('Välj företag')
    expect(args.body).toContain('kvittona')
  })

  it('falls back to a numbered text list for >10 companies', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: memberships(11) })
    enqueue({ data: companies(11) })
    enqueue({ data: [{ id: 'conv-1' }] })

    await askCompanyQuestion(supabase as unknown as SupabaseClient, {
      conversation: makeConversation(),
      link: makeLink(),
      to: '46701234567',
      replyBase,
      stagedCount: 1,
    })

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    const body = sendTextMock.mock.calls[0][1].body
    expect(body).toContain('1. ')
    expect(body).toContain('11. ')
    expect(body).toContain('Svara med en siffra')
  })

  it('asks EXACTLY once: a lost guarded transition sends nothing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: memberships(3) })
    enqueue({ data: companies(3) })
    enqueue({ data: [] }) // another worker already moved to awaiting_company

    const asked = await askCompanyQuestion(supabase as unknown as SupabaseClient, {
      conversation: makeConversation(),
      link: makeLink(),
      to: '46701234567',
      replyBase,
      stagedCount: 1,
    })

    expect(asked).toBe('not_asked')
    expect(sendButtonsMock).not.toHaveBeenCalled()
    expect(sendListMock).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('treats a failed membership query as transient: nothing sent, nothing marked', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ error: { message: 'connection reset' } }) // memberships query fails

    const asked = await askCompanyQuestion(supabase as unknown as SupabaseClient, {
      conversation: makeConversation(),
      link: makeLink(),
      to: '46701234567',
      replyBase,
      stagedCount: 1,
    })

    expect(asked).toBe('transient_error')
    expect(sendButtonsMock).not.toHaveBeenCalled()
    expect(sendListMock).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
    // Neither the question state nor the staged rows were touched: the
    // CALLER releases its row for retry.
    expect(findCalls('whatsapp_conversations', 'update')).toHaveLength(0)
    expect(findCalls('whatsapp_messages', 'update')).toHaveLength(0)
  })

  it('genuinely zero options: re-marks the staged rows and sends ONE actionable M19', async () => {
    const { supabase, enqueue, findCalls, calls } = createQueuedMockSupabase()
    enqueue({ data: [] }) // memberships: really none
    enqueue({ data: null }) // staged rows re-marked no_company_options
    enqueue({ data: null }) // M19 burst dedupe: none sent yet

    const asked = await askCompanyQuestion(supabase as unknown as SupabaseClient, {
      conversation: makeConversation(),
      link: makeLink(),
      to: '46701234567',
      replyBase,
      stagedCount: 1,
    })

    expect(asked).toBe('no_options')
    const marker = findCalls('whatsapp_messages', 'update')[0][0] as Record<string, unknown>
    expect(marker.error_message).toBe(NO_COMPANY_OPTIONS)
    // The re-mark targets exactly the rows parked behind this episode.
    expect(
      calls.some(
        (c) =>
          c.table === 'whatsapp_messages' &&
          c.method === 'eq' &&
          c.args[0] === 'error_message' &&
          c.args[1] === STAGED_AWAITING_COMPANY,
      ),
    ).toBe(true)
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m19NoCompany)
    // No question is ever parked: there is nothing to answer.
    expect(findCalls('whatsapp_conversations', 'update')).toHaveLength(0)
  })

  it('suppresses a repeat M19 inside the burst window', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] }) // memberships: none
    enqueue({ data: null }) // staged rows re-mark
    enqueue({ data: { id: 'm19-earlier' } }) // an M19 already went out

    const asked = await askCompanyQuestion(supabase as unknown as SupabaseClient, {
      conversation: makeConversation(),
      link: makeLink(),
      to: '46701234567',
      replyBase,
      stagedCount: 2,
    })

    expect(asked).toBe('no_options')
    expect(sendTextMock).not.toHaveBeenCalled()
  })
})

describe('applyCompanyChoice', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const awaitingConversation = () =>
    makeConversation({
      state: 'awaiting_company',
      context: {
        company_options: [
          { id: 'company-1', name: 'Bolag A AB' },
          { id: 'company-2', name: 'Bolag B AB' },
        ],
        pending_question: { type: 'company', inbox_item_id: null, asked_at: new Date().toISOString() },
      },
    })

  it('digit answer pins the company for 8h, confirms, and re-opens the parked rows', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { company_id: 'company-2' } }) // membership check
    enqueue({ data: null }) // conversation update
    enqueue({ data: null }) // link last_company_id update
    enqueue({ data: [{ id: 'stg-1' }, { id: 'stg-2' }] }) // staged reopen

    const before = Date.now()
    const applied = await applyCompanyChoice(supabase as unknown as SupabaseClient, {
      conversation: awaitingConversation(),
      link: makeLink(),
      choice: { digit: 2 },
      via: 'numbered',
      to: '46701234567',
      replyBase,
    })

    expect(applied).toEqual({
      ok: true,
      companyId: 'company-2',
      companyName: 'Bolag B AB',
      stagedMessageIds: ['stg-1', 'stg-2'],
    })

    // The membership check is a LIVE-membership check: a tap or digit for a
    // company archived since the question was asked is rejected (#1589).
    expect(findCalls('company_members', 'select')[0][0]).toContain('companies!inner(archived_at)')
    expect(findCalls('company_members', 'is')).toContainEqual(['companies.archived_at', null])

    const patch = findCalls('whatsapp_conversations', 'update')[0][0] as {
      state: string
      company_id: string
      pending_ack: boolean
      context: { pin_expires_at: string; pin_source: string; company_options?: unknown }
    }
    expect(patch.state).toBe('idle')
    expect(patch.company_id).toBe('company-2')
    expect(patch.pending_ack).toBe(true)
    expect(patch.context.pin_source).toBe('numbered')
    expect(patch.context.company_options).toBeUndefined()
    const pinMs = new Date(patch.context.pin_expires_at).getTime() - before
    expect(pinMs).toBeGreaterThan(7.9 * 60 * 60 * 1000)
    expect(pinMs).toBeLessThan(8.1 * 60 * 60 * 1000)

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    const confirm = sendTextMock.mock.calls[0][1]
    expect(confirm.template).toBe(TEMPLATE.m6CompanyConfirm)
    expect(confirm.body).toContain('Bolag B AB')
    expect(confirm.body).toContain('byt')

    // Reopen targeted exactly the staged marker.
    const reopenPatch = findCalls('whatsapp_messages', 'update')[0][0] as Record<string, unknown>
    expect(reopenPatch.processing_status).toBe('received')
    const { calls } = { calls: findCalls('whatsapp_messages', 'eq') }
    expect(calls.some((args) => args[0] === 'error_message' && args[1] === STAGED_AWAITING_COMPANY)).toBe(true)
  })

  it('interactive answer maps the payload id directly', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { company_id: 'company-1' } })
    enqueue({ data: null })
    enqueue({ data: null })
    enqueue({ data: [] })

    const applied = await applyCompanyChoice(supabase as unknown as SupabaseClient, {
      conversation: awaitingConversation(),
      link: makeLink(),
      choice: { companyId: 'company-1' },
      via: 'button',
      to: '46701234567',
      replyBase,
    })

    expect(applied.ok).toBe(true)
    if (!applied.ok) throw new Error('expected the choice to apply')
    expect(applied.companyId).toBe('company-1')
    expect(applied.stagedMessageIds).toEqual([])
  })

  it('rejects a company the sender is not a member of (forged/stale payload)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: null }) // membership check: none

    const applied = await applyCompanyChoice(supabase as unknown as SupabaseClient, {
      conversation: awaitingConversation(),
      link: makeLink(),
      choice: { companyId: 'company-elsewhere' },
      via: 'button',
      to: '46701234567',
      replyBase,
    })

    expect(applied).toEqual({ ok: false, reason: 'not_member' })
    expect(sendTextMock).not.toHaveBeenCalled()
    expect(findCalls('whatsapp_conversations', 'update')).toHaveLength(0)
  })

  it('rejects an out-of-range digit', async () => {
    const { supabase } = createQueuedMockSupabase()
    const applied = await applyCompanyChoice(supabase as unknown as SupabaseClient, {
      conversation: awaitingConversation(),
      link: makeLink(),
      choice: { digit: 9 },
      via: 'numbered',
      to: '46701234567',
      replyBase,
    })
    // Ordinary user input (a typo), so the CALLER re-prompts the options
    // rather than the silence reserved for forged payloads.
    expect(applied).toEqual({ ok: false, reason: 'invalid_option' })
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('treats a transient membership-query error as unresolved, not as "not a member"', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ error: { message: 'connection reset' } })

    const applied = await applyCompanyChoice(supabase as unknown as SupabaseClient, {
      conversation: awaitingConversation(),
      link: makeLink(),
      choice: { companyId: 'company-1' },
      via: 'button',
      to: '46701234567',
      replyBase,
    })

    expect(applied).toEqual({ ok: false, reason: 'lookup_failed' })
    expect(findCalls('whatsapp_conversations', 'update')).toHaveLength(0)
  })

  it('a second tap after the choice was applied confirms nothing (options are gone)', async () => {
    const { supabase, findCalls } = createQueuedMockSupabase()

    const applied = await applyCompanyChoice(supabase as unknown as SupabaseClient, {
      conversation: makeConversation({ state: 'idle', context: {} }),
      link: makeLink(),
      choice: { companyId: 'company-1' },
      via: 'button',
      to: '46701234567',
      replyBase,
    })

    expect(applied).toEqual({ ok: false, reason: 'already_applied' })
    expect(sendTextMock).not.toHaveBeenCalled()
    expect(findCalls('whatsapp_conversations', 'update')).toHaveLength(0)
  })
})

describe('truncateTitle', () => {
  it('keeps short titles untouched and cuts long ones cleanly at a word boundary', () => {
    expect(truncateTitle('Bolag AB', 20)).toBe('Bolag AB')
    const cut = truncateTitle('Wennberg Fastighetsförvaltning i Stockholm AB', 20)
    expect(cut.length).toBeLessThanOrEqual(20)
    expect(cut.endsWith('…')).toBe(true)
    expect(cut).not.toMatch(/\s…$/) // no dangling space before the ellipsis
  })
})

describe('uniqueTitles', () => {
  it('passes distinct short names through untouched', () => {
    expect(uniqueTitles(['Bolag A AB', 'Bolag B AB', 'Bolag C AB'], 20)).toEqual([
      'Bolag A AB',
      'Bolag B AB',
      'Bolag C AB',
    ])
  })

  it('disambiguates identical names with their 1-based position (Meta #131009)', () => {
    const titles = uniqueTitles(['Capelix AB', 'Capelix AB'], 20)
    expect(new Set(titles).size).toBe(2)
    expect(titles[0]).toBe('Capelix AB 1')
    expect(titles[1]).toBe('Capelix AB 2')
    for (const t of titles) expect(t.length).toBeLessThanOrEqual(20)
  })

  it('disambiguates names that only collide after truncation, within the limit', () => {
    const titles = uniqueTitles(
      ['Wennberg Fastighetsförvaltning AB', 'Wennberg Fastighetsförvaltning Holding AB'],
      20,
    )
    expect(new Set(titles.map((t) => t.toLowerCase())).size).toBe(2)
    for (const t of titles) {
      expect(t.length).toBeLessThanOrEqual(20)
      expect(t.startsWith('Wennberg')).toBe(true)
    }
    expect(titles[0].endsWith(' 1')).toBe(true)
    expect(titles[1].endsWith(' 2')).toBe(true)
  })

  it('treats a case-only difference as a collision', () => {
    const titles = uniqueTitles(['Bolag AB', 'bolag ab', 'Annat AB'], 24)
    expect(titles).toEqual(['Bolag AB 1', 'bolag ab 2', 'Annat AB'])
  })
})
