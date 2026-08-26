import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/extensions/general/whatsapp-inbox/lib/process-inbound', () => ({
  processInboundMessage: vi.fn(),
  finalizeBurst: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue('event-1'),
}))

import {
  processInboundMessage,
  finalizeBurst,
} from '@/extensions/general/whatsapp-inbox/lib/process-inbound'
import { runSweep } from '@/extensions/general/whatsapp-inbox/lib/sweep'
import {
  COMPANY_CHOICE_EXPIRED,
  STAGED_AWAITING_COMPANY,
} from '@/extensions/general/whatsapp-inbox/lib/conversation'

const processMock = vi.mocked(processInboundMessage)
const finalizeMock = vi.mocked(finalizeBurst)

const HOURS = 60 * 60 * 1000

function expiredConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    phone_link_id: 'link-1',
    state: 'awaiting_representation',
    context: {
      pending_question: {
        type: 'representation',
        inbox_item_id: 'item-9',
        asked_at: new Date(Date.now() - 49 * HOURS).toISOString(),
      },
      recent_questions: [
        {
          type: 'representation',
          inbox_item_id: 'item-9',
          asked_at: new Date(Date.now() - 49 * HOURS).toISOString(),
          status: 'open',
        },
      ],
    },
    company_id: null,
    service_window_expires_at: new Date(Date.now() - 25 * HOURS).toISOString(),
    debounce_until: null,
    pending_ack: false,
    ...overrides,
  }
}

describe('runSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    processMock.mockResolvedValue({ kind: 'media_processed', conversationId: 'conv-1' })
    finalizeMock.mockResolvedValue(undefined)
  })

  it('re-claims stuck received rows, errors out max-attempts rows, finalizes touched bursts', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'm-fresh', attempts: 1, conversation_id: 'conv-1' },
        { id: 'm-dead', attempts: 3, conversation_id: 'conv-1' },
      ],
    }) // stuck received
    enqueue({ data: null }) // m-dead -> error update
    enqueue({ data: [] }) // stuck processing
    enqueue({ data: [] }) // stale pending_ack
    enqueue({ data: [] }) // unacked re-arm
    enqueue({ data: [] }) // TTL scan
    enqueue({ data: [] }) // pin scan
    enqueue({ count: 2 }) // outbound failures, last 24h

    const summary = await runSweep(supabase as unknown as SupabaseClient)

    expect(processMock).toHaveBeenCalledTimes(1)
    expect(processMock).toHaveBeenCalledWith(supabase, 'm-fresh')
    expect(finalizeMock).toHaveBeenCalledWith(supabase, 'conv-1')
    expect(summary.reclaimedReceived).toBe(1)
    expect(summary.erroredMaxAttempts).toBe(1)
    expect(summary.finalizedAcks).toBe(1)
    expect(summary.outboundFailed24h).toBe(2)

    const errorPatch = findCalls('whatsapp_messages', 'update')[0][0] as Record<string, unknown>
    expect(errorPatch.processing_status).toBe('error')
    expect(errorPatch.error_message).toBe('Max attempts exceeded')
  })

  it('resets stuck processing rows back to received before re-running them', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] }) // stuck received
    enqueue({ data: [{ id: 'm-stuck', attempts: 1, conversation_id: 'conv-2' }] })
    enqueue({ data: { id: 'm-stuck' } }) // guarded reset won
    enqueue({ data: [] }) // stale pending_ack
    enqueue({ data: [] }) // unacked re-arm
    enqueue({ data: [] }) // TTL scan
    enqueue({ data: [] }) // pin scan

    const summary = await runSweep(supabase as unknown as SupabaseClient)

    const resetPatch = findCalls('whatsapp_messages', 'update')[0][0] as Record<string, unknown>
    expect(resetPatch.processing_status).toBe('received')
    expect(processMock).toHaveBeenCalledWith(supabase, 'm-stuck')
    expect(summary.reclaimedProcessing).toBe(1)
  })

  it('claims stale pending_ack conversations through finalizeBurst', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [] }) // stuck received
    enqueue({ data: [] }) // stuck processing
    enqueue({ data: [{ id: 'conv-7' }] }) // stale pending_ack
    enqueue({ data: [] }) // unacked re-arm
    enqueue({ data: [] }) // TTL scan
    enqueue({ data: [] }) // pin scan

    await runSweep(supabase as unknown as SupabaseClient)

    expect(finalizeMock).toHaveBeenCalledWith(supabase, 'conv-7')
  })

  it('expires a 48h-old question: item moved_to_app, conversation back to idle, NOTHING sent', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] }) // stuck received
    enqueue({ data: [] }) // stuck processing
    enqueue({ data: [] }) // stale pending_ack
    enqueue({ data: [] }) // unacked re-arm
    enqueue({ data: [expiredConversation()] }) // TTL scan
    enqueue({
      data: {
        channel_context: {
          channel: 'whatsapp',
          pending_question: {
            type: 'representation',
            asked_at: new Date(Date.now() - 49 * HOURS).toISOString(),
            status: 'open',
          },
        },
      },
    }) // item context load
    enqueue({ data: null }) // item context update
    enqueue({ data: { company_id: 'company-1', correlation_id: null } }) // history lookup
    enqueue({ data: null }) // conversation -> idle
    enqueue({ data: [] }) // pin scan

    const summary = await runSweep(supabase as unknown as SupabaseClient)

    expect(summary.expiredQuestions).toBe(1)
    const itemPatch = findCalls('invoice_inbox_items', 'update')[0][0] as {
      channel_context: { pending_question: { status: string } }
    }
    expect(itemPatch.channel_context.pending_question.status).toBe('moved_to_app')

    const conversationPatch = findCalls('whatsapp_conversations', 'update')[0][0] as {
      state: string
      context: { pending_question?: unknown; recent_questions: { status: string }[] }
    }
    expect(conversationPatch.state).toBe('idle')
    expect(conversationPatch.context.pending_question).toBeUndefined()
    expect(conversationPatch.context.recent_questions[0].status).toBe('moved_to_app')
    // Expiry is a silent hand-off: the service window is long gone.
    expect(finalizeMock).not.toHaveBeenCalled()
  })

  it('expires an abandoned company question: parked rows get the expired marker', async () => {
    const { supabase, enqueue, findCalls, calls } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({
      data: [
        expiredConversation({
          state: 'awaiting_company',
          context: {
            company_options: [{ id: 'company-1', name: 'A AB' }],
            pending_question: {
              type: 'company',
              inbox_item_id: null,
              asked_at: new Date(Date.now() - 49 * HOURS).toISOString(),
            },
          },
        }),
      ],
    })
    enqueue({ data: null }) // staged rows marker update
    enqueue({ data: null }) // conversation -> idle
    enqueue({ data: [] }) // pin scan

    await runSweep(supabase as unknown as SupabaseClient)

    const markerPatch = findCalls('whatsapp_messages', 'update')[0][0] as Record<string, unknown>
    expect(markerPatch.error_message).toBe(COMPANY_CHOICE_EXPIRED)
    expect(
      calls.some(
        (c) =>
          c.table === 'whatsapp_messages' &&
          c.method === 'eq' &&
          c.args[0] === 'error_message' &&
          c.args[1] === STAGED_AWAITING_COMPANY,
      ),
    ).toBe(true)

    const conversationPatch = findCalls('whatsapp_conversations', 'update')[0][0] as {
      state: string
      context: { company_options?: unknown }
    }
    expect(conversationPatch.state).toBe('idle')
    expect(conversationPatch.context.company_options).toBeUndefined()
  })

  it('clears expired 8h company pins', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] })
    enqueue({ data: [] }) // TTL scan
    enqueue({
      data: [
        expiredConversation({
          state: 'idle',
          company_id: 'company-1',
          context: { pin_expires_at: new Date(Date.now() - 1000).toISOString(), pin_source: 'button' },
        }),
      ],
    }) // pin scan

    const summary = await runSweep(supabase as unknown as SupabaseClient)

    expect(summary.clearedPins).toBe(1)
    const patch = findCalls('whatsapp_conversations', 'update')[0][0] as {
      company_id: string | null
      context: { pin_expires_at?: string; pin_source?: string }
    }
    expect(patch.company_id).toBeNull()
    expect(patch.context.pin_expires_at).toBeUndefined()
    expect(patch.context.pin_source).toBeUndefined()
  })
})
