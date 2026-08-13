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
    markReadWithTyping: vi.fn().mockResolvedValue(undefined),
    downloadMedia: vi.fn(),
  }
})

vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue('event-1'),
}))

import { sendText } from '@/extensions/general/whatsapp-inbox/lib/graph-api'
import { finalizeBurst } from '@/extensions/general/whatsapp-inbox/lib/process-inbound'
import { stockholmDayKey } from '@/extensions/general/whatsapp-inbox/lib/conversation'
import { TEMPLATE } from '@/extensions/general/whatsapp-inbox/lib/messages'

const sendTextMock = vi.mocked(sendText)

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    phone_link_id: 'link-1',
    state: 'idle',
    context: {},
    company_id: 'company-1',
    service_window_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    debounce_until: new Date(Date.now() - 1000).toISOString(),
    pending_ack: true,
    last_inbound_at: null,
    last_outbound_at: null,
    created_at: '2026-08-01T09:00:00Z',
    updated_at: '2026-08-01T09:00:00Z',
    ...overrides,
  }
}

function makeDoneRow(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `msg-${n}`,
    direction: 'inbound',
    wamid: `wamid.IN${n}`,
    sender_phone_hash: 'hash-1',
    phone_link_id: 'link-1',
    conversation_id: 'conv-1',
    message_type: 'image',
    body_text: null,
    media_id: `media-${n}`,
    media_mime: 'image/jpeg',
    media_sha256: null,
    media_filename: `kvitto-${n}.jpg`,
    raw_payload: { from: '46701234567' },
    processing_status: 'done',
    attempts: 1,
    error_message: null,
    inbox_item_id: `item-${n}`,
    delivery_status: null,
    correlation_id: `corr-${n}`,
    acked_at: null,
    created_at: `2026-08-01T10:0${n}:00Z`,
    updated_at: `2026-08-01T10:0${n}:00Z`,
    ...overrides,
  }
}

function makeItem(n: number, extracted: Record<string, unknown>, overrides: Record<string, unknown> = {}) {
  return {
    id: `item-${n}`,
    company_id: 'company-1',
    extracted_data: extracted,
    channel_context: { channel: 'whatsapp' },
    document_id: `doc-${n}`,
    ...overrides,
  }
}

const CLEAN_RECEIPT = {
  documentKind: 'receipt',
  merchantCategory: 'grocery',
  legibility: 'good',
  supplier: { name: 'ICA Maxi' },
  invoice: { invoiceDate: '2026-07-30' },
  totals: { total: 234 },
  lineItems: [],
}

const RESTAURANT_RECEIPT = {
  documentKind: 'receipt',
  merchantCategory: 'restaurant',
  legibility: 'good',
  supplier: { name: 'Prinsen' },
  invoice: { invoiceDate: '2026-07-30' },
  totals: { total: 890 },
  lineItems: [],
}

describe('finalizeBurst', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendTextMock.mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null })
  })

  it('a lost pending_ack claim sends nothing (single-winner semantics)', async () => {
    const { supabase, enqueue, calls } = createQueuedMockSupabase()
    enqueue({ data: [] }) // claim: no row matched

    await finalizeBurst(supabase as unknown as SupabaseClient, 'conv-1')

    expect(sendTextMock).not.toHaveBeenCalled()
    // The claim must be exactly the atomic pending_ack/debounce filter.
    const claimEq = calls.find((c) => c.method === 'eq' && c.args[0] === 'pending_ack')
    expect(claimEq?.args).toEqual(['pending_ack', true])
    const claimLte = calls.find((c) => c.method === 'lte' && c.args[0] === 'debounce_until')
    expect(claimLte).toBeTruthy()
  })

  it('winner sends ONE numbered M5 for >=2 receipts and stamps acked_at on all rows', async () => {
    const { supabase, enqueue, findCalls, calls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'conv-1' }] }) // claim won
    enqueue({ data: makeConversation() })
    enqueue({ data: [makeDoneRow(1), makeDoneRow(2)] })
    enqueue({
      data: [
        makeItem(1, CLEAN_RECEIPT),
        makeItem(2, { ...CLEAN_RECEIPT, supplier: { name: 'SJ' }, totals: { total: 456 } }),
      ],
    })
    enqueue({ data: [{ id: 'doc-1', file_size_bytes: 500_000 }, { id: 'doc-2', file_size_bytes: 500_000 }] })
    enqueue({ data: null }) // conversation update
    enqueue({ data: null }) // acked_at stamp

    await finalizeBurst(supabase as unknown as SupabaseClient, 'conv-1')

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    const message = sendTextMock.mock.calls[0][1]
    expect(message.template).toBe(TEMPLATE.m5BurstAck)
    expect(message.body).toContain('*2* kvitton')
    expect(message.body).toContain('1. ICA Maxi, 234 kr')
    expect(message.body).toContain('2. SJ, 456 kr')

    // acked_at stamped on exactly the covered rows.
    const stamp = findCalls('whatsapp_messages', 'update').at(-1)![0] as Record<string, unknown>
    expect(stamp.acked_at).toBeTruthy()
    const inFilter = calls.find((c) => c.table === 'whatsapp_messages' && c.method === 'in')
    expect(inFilter?.args).toEqual(['id', ['msg-1', 'msg-2']])
  })

  it('single receipt: M4 ack with merchant, amount and date', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'conv-1' }] })
    enqueue({ data: makeConversation() })
    enqueue({ data: [makeDoneRow(1)] })
    enqueue({ data: [makeItem(1, CLEAN_RECEIPT)] })
    enqueue({ data: [{ id: 'doc-1', file_size_bytes: 500_000 }] })
    enqueue({ data: null }) // conversation update
    enqueue({ data: null }) // acked stamp

    await finalizeBurst(supabase as unknown as SupabaseClient, 'conv-1')

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    const message = sendTextMock.mock.calls[0][1]
    expect(message.template).toBe(TEMPLATE.m4Ack)
    expect(message.body).toContain('ICA Maxi')
    expect(message.body).toContain('234 kr')
    expect(message.body).toContain('2026-07-30')
    expect(message.inboxItemId).toBe('item-1')
  })

  it('merges the representation question (M7) into the single ack send', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'conv-1' }] })
    enqueue({ data: makeConversation() })
    enqueue({ data: [makeDoneRow(1)] })
    enqueue({ data: [makeItem(1, RESTAURANT_RECEIPT)] })
    enqueue({ data: [{ id: 'doc-1', file_size_bytes: 500_000 }] })
    enqueue({ data: null }) // conversation update
    enqueue({ data: { channel_context: { channel: 'whatsapp' } } }) // item context load
    enqueue({ data: null }) // item context update
    enqueue({ data: { company_id: 'company-1', correlation_id: null } }) // history lookup
    enqueue({ data: null }) // acked stamp

    await finalizeBurst(supabase as unknown as SupabaseClient, 'conv-1')

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    const message = sendTextMock.mock.calls[0][1]
    expect(message.template).toBe(TEMPLATE.m7Representation)
    expect(message.body).toContain('*Kvitto mottaget:*')
    expect(message.body).toContain('vilka som deltog')
    expect(message.body).not.toMatch(/[–—]/) // no em/en dashes

    const conversationPatch = findCalls('whatsapp_conversations', 'update').at(-1)![0] as {
      state: string
      context: Record<string, unknown>
    }
    expect(conversationPatch.state).toBe('awaiting_representation')
    expect(conversationPatch.context.pending_question).toMatchObject({
      type: 'representation',
      inbox_item_id: 'item-1',
    })
    expect(conversationPatch.context.budget).toMatchObject({ count: 1 })

    const itemPatch = findCalls('invoice_inbox_items', 'update').at(-1)![0] as {
      channel_context: Record<string, unknown>
    }
    expect(itemPatch.channel_context.pending_question).toMatchObject({
      type: 'representation',
      status: 'open',
    })
  })

  it('single unreadable receipt: M9 re-send ask stands alone and opens awaiting_resend', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'conv-1' }] })
    enqueue({ data: makeConversation() })
    enqueue({ data: [makeDoneRow(1)] })
    enqueue({
      data: [
        makeItem(1, {
          ...CLEAN_RECEIPT,
          legibility: 'unreadable',
          supplier: { name: null },
          totals: { total: null },
        }),
      ],
    })
    enqueue({ data: [{ id: 'doc-1', file_size_bytes: 500_000 }] })
    enqueue({ data: null }) // conversation update
    enqueue({ data: { channel_context: { channel: 'whatsapp' } } })
    enqueue({ data: null }) // item update
    enqueue({ data: { company_id: 'company-1', correlation_id: null } })
    enqueue({ data: null }) // acked stamp

    await finalizeBurst(supabase as unknown as SupabaseClient, 'conv-1')

    const message = sendTextMock.mock.calls[0][1]
    expect(message.template).toBe(TEMPLATE.m9Resend)
    expect(message.body).toContain('dokument')
    const conversationPatch = findCalls('whatsapp_conversations', 'update').at(-1)![0] as {
      state: string
    }
    expect(conversationPatch.state).toBe('awaiting_resend')
    const itemPatch = findCalls('invoice_inbox_items', 'update').at(-1)![0] as {
      channel_context: { quality?: { resend_requested_at?: string } }
    }
    expect(itemPatch.channel_context.quality?.resend_requested_at).toBeTruthy()
  })

  it('daily budget exhausted: ack only, question moved_to_app', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'conv-1' }] })
    enqueue({
      data: makeConversation({
        context: { budget: { day_key: stockholmDayKey(), count: 6 } },
      }),
    })
    enqueue({ data: [makeDoneRow(1)] })
    enqueue({ data: [makeItem(1, RESTAURANT_RECEIPT)] })
    enqueue({ data: [{ id: 'doc-1', file_size_bytes: 500_000 }] })
    enqueue({ data: null }) // conversation update
    enqueue({ data: { channel_context: { channel: 'whatsapp' } } }) // moved item load
    enqueue({ data: null }) // moved item update
    enqueue({ data: null }) // acked stamp

    await finalizeBurst(supabase as unknown as SupabaseClient, 'conv-1')

    const message = sendTextMock.mock.calls[0][1]
    expect(message.template).toBe(TEMPLATE.m4Ack) // plain ack, no question
    expect(message.body).not.toContain('deltog')

    const conversationPatch = findCalls('whatsapp_conversations', 'update').at(-1)![0] as {
      state: string
    }
    expect(conversationPatch.state).toBe('idle')

    const itemPatch = findCalls('invoice_inbox_items', 'update').at(-1)![0] as {
      channel_context: { pending_question: { status: string } }
    }
    expect(itemPatch.channel_context.pending_question.status).toBe('moved_to_app')
  })

  it('burst budget: 3 candidates -> 1 asked, 1 queued, 1 moved_to_app', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'conv-1' }] })
    enqueue({ data: makeConversation() })
    enqueue({ data: [makeDoneRow(1), makeDoneRow(2), makeDoneRow(3)] })
    enqueue({
      data: [
        makeItem(1, RESTAURANT_RECEIPT),
        makeItem(2, { ...RESTAURANT_RECEIPT, supplier: { name: 'Krogen' } }),
        makeItem(3, { ...RESTAURANT_RECEIPT, supplier: { name: 'Baren' } }),
      ],
    })
    enqueue({
      data: [
        { id: 'doc-1', file_size_bytes: 500_000 },
        { id: 'doc-2', file_size_bytes: 500_000 },
        { id: 'doc-3', file_size_bytes: 500_000 },
      ],
    })
    enqueue({ data: null }) // conversation update
    enqueue({ data: { channel_context: { channel: 'whatsapp' } } }) // asked item load
    enqueue({ data: null }) // asked item update
    enqueue({ data: { company_id: 'company-1', correlation_id: null } }) // history
    enqueue({ data: { channel_context: { channel: 'whatsapp' } } }) // moved item load
    enqueue({ data: null }) // moved item update
    enqueue({ data: null }) // acked stamp

    await finalizeBurst(supabase as unknown as SupabaseClient, 'conv-1')

    expect(sendTextMock).toHaveBeenCalledTimes(1)
    const conversationPatch = findCalls('whatsapp_conversations', 'update').at(-1)![0] as {
      state: string
      context: {
        pending_question: { inbox_item_id: string }
        question_queue: { inbox_item_id: string }[]
        budget: { count: number }
      }
    }
    expect(conversationPatch.state).toBe('awaiting_representation')
    expect(conversationPatch.context.pending_question.inbox_item_id).toBe('item-1')
    expect(conversationPatch.context.question_queue).toHaveLength(1)
    expect(conversationPatch.context.question_queue[0].inbox_item_id).toBe('item-2')
    // Only the ASKED question consumes daily budget now.
    expect(conversationPatch.context.budget.count).toBe(1)

    // The third candidate went straight to the app.
    const movedPatch = findCalls('invoice_inbox_items', 'update').at(-1)![0] as {
      channel_context: { pending_question: { status: string } }
    }
    expect(movedPatch.channel_context.pending_question.status).toBe('moved_to_app')
  })

  it('closed service window: no send, rows still marked covered', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'conv-1' }] })
    enqueue({
      data: makeConversation({
        service_window_expires_at: new Date(Date.now() - 1000).toISOString(),
      }),
    })
    enqueue({ data: [makeDoneRow(1)] })
    enqueue({ data: null }) // acked stamp

    await finalizeBurst(supabase as unknown as SupabaseClient, 'conv-1')

    expect(sendTextMock).not.toHaveBeenCalled()
    const stamp = findCalls('whatsapp_messages', 'update').at(-1)![0] as Record<string, unknown>
    expect(stamp.acked_at).toBeTruthy()
  })
})
