import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/extensions/general/whatsapp-inbox/lib/graph-api', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/whatsapp-inbox/lib/graph-api')
  >('@/extensions/general/whatsapp-inbox/lib/graph-api')
  return {
    ...actual,
    sendText: vi.fn().mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null }),
    markReadWithTyping: vi.fn().mockResolvedValue(undefined),
    downloadMedia: vi.fn(),
  }
})

vi.mock('@/extensions/general/whatsapp-inbox/lib/company-question', async () => {
  const actual = await vi.importActual<
    typeof import('@/extensions/general/whatsapp-inbox/lib/company-question')
  >('@/extensions/general/whatsapp-inbox/lib/company-question')
  return {
    ...actual,
    askCompanyQuestion: vi.fn().mockResolvedValue('asked'),
  }
})

vi.mock('@/extensions/general/invoice-inbox/lib/upload-and-extract', () => ({
  uploadAndExtract: vi.fn(),
}))

vi.mock('@/lib/rate-limits/inbox', () => ({
  checkInboxUploadRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/rate-limits/agent', () => ({
  checkAgentRateLimit: vi.fn().mockResolvedValue({ ok: true }),
}))

vi.mock('@/lib/processing-history/append', () => ({
  appendProcessingHistory: vi.fn().mockResolvedValue('event-1'),
}))

vi.mock('@/lib/core/documents/document-service', () => ({
  computeSHA256: vi.fn().mockResolvedValue('sha-abc'),
}))

// The drain (#1589) re-kicks re-opened rows through the cookieless service
// client; route it to a per-test queued mock so the follow-up run is
// observable instead of hitting a real Supabase URL.
const kickClient = vi.hoisted(() => ({ current: null as unknown }))
vi.mock('@/lib/auth/api-keys', () => ({
  createServiceClientNoCookies: vi.fn(() => kickClient.current),
}))

import {
  sendText,
  markReadWithTyping,
  downloadMedia,
  GraphApiError,
} from '@/extensions/general/whatsapp-inbox/lib/graph-api'
import { askCompanyQuestion } from '@/extensions/general/whatsapp-inbox/lib/company-question'
import { uploadAndExtract } from '@/extensions/general/invoice-inbox/lib/upload-and-extract'
import { checkInboxUploadRateLimit } from '@/lib/rate-limits/inbox'
import { appendProcessingHistory } from '@/lib/processing-history/append'
import { processInboundMessage } from '@/extensions/general/whatsapp-inbox/lib/process-inbound'
import {
  STAGED_AWAITING_COMPANY,
} from '@/extensions/general/whatsapp-inbox/lib/conversation'
import { TEMPLATE } from '@/extensions/general/whatsapp-inbox/lib/messages'

const sendTextMock = vi.mocked(sendText)
const downloadMediaMock = vi.mocked(downloadMedia)
const uploadAndExtractMock = vi.mocked(uploadAndExtract)
const rateLimitMock = vi.mocked(checkInboxUploadRateLimit)
const appendHistoryMock = vi.mocked(appendProcessingHistory)
const askCompanyQuestionMock = vi.mocked(askCompanyQuestion)

function makeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    direction: 'inbound',
    wamid: 'wamid.IN1',
    sender_phone_hash: 'hash-1',
    phone_link_id: 'link-1',
    conversation_id: 'conv-1',
    message_type: 'image',
    body_text: 'lunch med kund',
    media_id: 'media-1',
    media_mime: 'image/jpeg',
    media_sha256: null,
    media_filename: null,
    raw_payload: { from: '46701234567' },
    processing_status: 'received',
    attempts: 0,
    error_message: null,
    inbox_item_id: null,
    delivery_status: null,
    correlation_id: 'corr-1',
    acked_at: null,
    created_at: '2026-08-01T10:00:00Z',
    updated_at: '2026-08-01T10:00:00Z',
    ...overrides,
  }
}

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
  }
}

function makeConversation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conv-1',
    phone_link_id: 'link-1',
    state: 'idle',
    context: {},
    company_id: null,
    service_window_expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    debounce_until: new Date().toISOString(),
    pending_ack: true,
    last_inbound_at: null,
    last_outbound_at: null,
    created_at: '2026-08-01T09:00:00Z',
    updated_at: '2026-08-01T09:00:00Z',
    ...overrides,
  }
}

function lastUpdate(findCalls: (table: string, method: string) => unknown[][]): Record<string, unknown> {
  const updates = findCalls('whatsapp_messages', 'update')
  return updates[updates.length - 1][0] as Record<string, unknown>
}

describe('processInboundMessage (media intake)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendTextMock.mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null })
    askCompanyQuestionMock.mockResolvedValue('asked')
    rateLimitMock.mockResolvedValue({ ok: true })
    downloadMediaMock.mockResolvedValue({
      buffer: new Uint8Array([1, 2, 3, 4]).buffer,
      mime: 'image/jpeg',
      fileSize: 4,
    })
    uploadAndExtractMock.mockResolvedValue({
      document_id: 'doc-1',
      inbox_item_id: 'item-1',
      status: 'received',
      extracted_data: {
        supplier: { name: 'Espresso House' },
        totals: { total: 450 },
        invoice: { invoiceDate: '2026-07-30' },
      },
      matched_supplier_id: null,
      matched_transaction_id: null,
      extraction_skipped: false,
      skip_reason: null,
      page_count: null,
    } as never)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('happy path: claims, ingests, marks done, and sends NO ack (the burst winner acks)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() }) // load row
    enqueue({ data: { id: 'msg-1' } }) // claim
    enqueue({ data: makeLink() }) // load link
    enqueue({ data: makeConversation() }) // load conversation
    enqueue({ data: [{ company_id: 'company-1' }] }) // sole membership
    enqueue({ data: [] }) // drain: nothing expired
    enqueue({ data: [] }) // drain: nothing parked behind an old company question
    enqueue({ data: null }) // sha256 dup check: none
    enqueue({ data: null }) // item channel_context load
    enqueue({ data: null }) // item channel_context update
    enqueue({ data: null }) // final markStatus done

    const outcome = await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(outcome).toEqual({ kind: 'media_processed', conversationId: 'conv-1' })
    expect(markReadWithTyping).toHaveBeenCalledWith('wamid.IN1')
    expect(downloadMediaMock).toHaveBeenCalledWith('media-1')
    expect(uploadAndExtractMock).toHaveBeenCalledWith(
      supabase,
      'user-1',
      'company-1',
      expect.objectContaining({ type: 'image/jpeg' }),
      'whatsapp',
      undefined,
      undefined,
      {
        channelMeta: { whatsappMessageId: 'msg-1', caption: 'lunch med kund' },
        actorId: 'whatsapp-inbound',
      },
    )

    // company_selected_via lands on the item.
    const itemUpdates = findCalls('invoice_inbox_items', 'update')
    expect(itemUpdates).toHaveLength(1)
    const contextArg = (itemUpdates[0][0] as { channel_context: Record<string, unknown> })
      .channel_context
    expect(contextArg.company_selected_via).toBe('single')

    // "Sole membership" means sole LIVE membership (#1589): an archived
    // same-named company must not turn this sender into a multi-company one.
    expect(findCalls('company_members', 'select')[0][0]).toContain('companies!inner(archived_at)')
    expect(findCalls('company_members', 'is')).toContainEqual(['companies.archived_at', null])

    const finalUpdate = lastUpdate(findCalls)
    expect(finalUpdate.processing_status).toBe('done')
    expect(finalUpdate.inbox_item_id).toBe('item-1')

    // The per-receipt ack is debounced: this worker never sends it.
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('drains receipts parked behind an unaskable company question when the sender resolves as single', async () => {
    const kick = createQueuedMockSupabase()
    kickClient.current = kick.supabase
    kick.enqueue({ data: null }) // follow-up loadRow for the re-opened row (gone: keep it inert)

    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() }) // load row
    enqueue({ data: { id: 'msg-1' } }) // claim
    enqueue({ data: makeLink() }) // load link
    enqueue({ data: makeConversation() }) // load conversation
    enqueue({ data: [{ company_id: 'company-1' }] }) // sole live membership
    enqueue({ data: [] }) // drain: nothing past the media window
    enqueue({ data: [{ id: 'stg-1' }, { id: 'stg-2' }] }) // drain: two rows were parked
    enqueue({ data: null }) // sha256 dup check: none
    enqueue({ data: null }) // item channel_context load
    enqueue({ data: null }) // item channel_context update
    enqueue({ data: null }) // final markStatus done

    const outcome = await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')
    expect(outcome).toEqual({ kind: 'media_processed', conversationId: 'conv-1' })

    // The guarded re-open targets exactly the staged marker on this conversation.
    const reopen = findCalls('whatsapp_messages', 'update').find(
      (args) =>
        (args[0] as Record<string, unknown>).processing_status === 'received' &&
        (args[0] as Record<string, unknown>).error_message === null,
    )
    expect(reopen).toBeTruthy()
    const eqs = findCalls('whatsapp_messages', 'eq')
    expect(eqs).toContainEqual(['error_message', STAGED_AWAITING_COMPANY])
    expect(eqs).toContainEqual(['conversation_id', 'conv-1'])

    // The re-opened rows were kicked: the follow-up run loaded the first one.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(kick.findCalls('whatsapp_messages', 'eq')).toContainEqual(['id', 'stg-1'])
    kickClient.current = null
  })

  it('single-company drain leaves month-old receipts expired and says so once', async () => {
    const kick = createQueuedMockSupabase()
    kickClient.current = kick.supabase
    kick.enqueue({ data: null })

    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() }) // load row
    enqueue({ data: { id: 'msg-1' } }) // claim
    enqueue({ data: makeLink() }) // load link
    enqueue({ data: makeConversation() }) // load conversation
    enqueue({ data: [{ company_id: 'company-1' }] }) // sole live membership
    enqueue({ data: [{ id: 'old-1' }] }) // drain: one row past the media window
    enqueue({ data: [{ id: 'stg-1' }] }) // drain: one row re-opened
    enqueue({ data: null }) // sha256 dup check: none
    enqueue({ data: null }) // item channel_context load
    enqueue({ data: null }) // item channel_context update
    enqueue({ data: null }) // final markStatus done

    const outcome = await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')
    expect(outcome).toEqual({ kind: 'media_processed', conversationId: 'conv-1' })

    const patches = findCalls('whatsapp_messages', 'update').map(
      (args) => args[0] as Record<string, unknown>,
    )
    expect(patches.some((p) => p.error_message === 'company_choice_expired')).toBe(true)
    const notice = sendTextMock.mock.calls.find((c) => c[1].template === TEMPLATE.m20ReceiptsExpired)
    expect(notice).toBeTruthy()
    expect(notice![1].body).toContain('30 dagar')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(kick.findCalls('whatsapp_messages', 'eq')).toContainEqual(['id', 'stg-1'])
    expect(kick.findCalls('whatsapp_messages', 'eq')).not.toContainEqual(['id', 'old-1'])
    kickClient.current = null
  })

  it('does not drain when the company came from a pin or a default (the question is not dead)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink({ default_company_id: 'company-7' }) })
    enqueue({ data: makeConversation() })
    enqueue({ data: { company_id: 'company-7' } }) // membership check for default
    enqueue({ data: null }) // dup check
    enqueue({ data: null }) // item context load
    enqueue({ data: null }) // item context update
    enqueue({ data: null }) // markStatus done

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    // The default-membership check is also a LIVE-membership check.
    expect(findCalls('company_members', 'is')).toContainEqual(['companies.archived_at', null])
    const reopen = findCalls('whatsapp_messages', 'update').find(
      (args) => (args[0] as Record<string, unknown>).processing_status === 'received',
    )
    expect(reopen).toBeUndefined()
  })

  it('clears the dead company question when the sender resolves as single (state, options, pending)', async () => {
    const kick = createQueuedMockSupabase()
    kickClient.current = kick.supabase
    kick.enqueue({ data: null })

    const deadQuestion = {
      company_options: [
        { id: 'company-1', name: 'Alpha AB' },
        { id: 'company-2', name: 'Alpha AB' },
      ],
      pending_question: { type: 'company', inbox_item_id: null, asked_at: '2026-08-01T09:30:00Z' },
      budget: { day_key: '2026-08-01', count: 1 },
    }
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() }) // load row
    enqueue({ data: { id: 'msg-1' } }) // claim
    enqueue({ data: makeLink() }) // load link
    enqueue({ data: makeConversation({ state: 'awaiting_company', context: deadQuestion }) })
    enqueue({ data: [{ company_id: 'company-1' }] }) // sole live membership (company-2 archived)
    enqueue({ data: [] }) // drain: nothing past the media window
    enqueue({ data: [{ id: 'stg-1' }] }) // drain: one row was parked
    enqueue({ data: [makeConversation({ state: 'idle', context: { budget: deadQuestion.budget } })] }) // guarded clear won
    enqueue({ data: null }) // sha256 dup check: none
    enqueue({ data: null }) // item channel_context load
    enqueue({ data: null }) // item channel_context update
    enqueue({ data: null }) // final markStatus done

    const outcome = await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')
    expect(outcome).toEqual({ kind: 'media_processed', conversationId: 'conv-1' })

    // The conversation is released: idle, no options to re-offer (one of
    // them is the archived company), no company pending_question, and the
    // rest of the context (budget) untouched.
    const clears = findCalls('whatsapp_conversations', 'update')
    expect(clears).toHaveLength(1)
    const patch = clears[0][0] as { state: string; context: Record<string, unknown> }
    expect(patch.state).toBe('idle')
    expect(patch.context).toEqual({ budget: deadQuestion.budget })
    // Guarded on the revision it read, same idiom as every context write.
    expect(findCalls('whatsapp_conversations', 'eq')).toContainEqual([
      'updated_at',
      '2026-08-01T09:00:00Z',
    ])
    kickClient.current = null
  })

  it('clears company_options kept past the 48h TTL (idle conversation) once the sender resolves as single', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({
      data: makeConversation({
        state: 'idle',
        context: { company_options: [{ id: 'company-1', name: 'A' }, { id: 'company-2', name: 'B' }] },
      }),
    })
    enqueue({ data: [{ company_id: 'company-1' }] }) // sole live membership
    enqueue({ data: [] }) // drain: nothing past the media window
    enqueue({ data: [] }) // drain: the parked rows already expired
    enqueue({ data: [makeConversation()] }) // guarded clear won
    enqueue({ data: null }) // dup check
    enqueue({ data: null }) // item context load
    enqueue({ data: null }) // item context update
    enqueue({ data: null }) // markStatus done

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    const clears = findCalls('whatsapp_conversations', 'update')
    expect(clears).toHaveLength(1)
    const patch = clears[0][0] as { state: string; context: Record<string, unknown> }
    expect(patch.state).toBe('idle')
    expect(patch.context).toEqual({})
  })

  it('leaves a representation question alone when the sender resolves as single', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({
      data: makeConversation({
        state: 'awaiting_representation',
        context: {
          pending_question: { type: 'representation', inbox_item_id: 'item-0', asked_at: '2026-08-01T09:30:00Z' },
        },
      }),
    })
    enqueue({ data: [{ company_id: 'company-1' }] }) // sole live membership
    enqueue({ data: [] }) // drain: nothing expired
    enqueue({ data: [] }) // drain: nothing parked
    enqueue({ data: null }) // dup check
    enqueue({ data: null }) // item context load
    enqueue({ data: null }) // item context update
    enqueue({ data: null }) // markStatus done

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    // Not a company question: nothing to clear, no conversation write.
    expect(findCalls('whatsapp_conversations', 'update')).toHaveLength(0)
  })

  it('does nothing when the claim is lost (already processing)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: null }) // claim matched no row

    const outcome = await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(outcome).toEqual({ kind: 'none' })
    expect(downloadMediaMock).not.toHaveBeenCalled()
    expect(uploadAndExtractMock).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('rejects disallowed MIME types with M15, skipped, and no download', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow({ media_mime: 'video/mp4', message_type: 'document' }) })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: makeConversation() })
    enqueue({ data: null }) // markStatus skipped

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(downloadMediaMock).not.toHaveBeenCalled()
    expect(uploadAndExtractMock).not.toHaveBeenCalled()
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m15Unsupported)
    expect(lastUpdate(findCalls).processing_status).toBe('skipped')
  })

  it('multi-company sender without pin/default: parks the row and asks the company question', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: makeConversation() })
    enqueue({ data: [{ company_id: 'company-1' }, { company_id: 'company-2' }] })
    enqueue({ data: null }) // markStatus skipped (staged)
    enqueue({ data: null, count: 1 }) // staged count

    const outcome = await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(outcome).toEqual({ kind: 'media_staged', conversationId: 'conv-1' })
    expect(uploadAndExtractMock).not.toHaveBeenCalled()
    expect(downloadMediaMock).not.toHaveBeenCalled()
    // Parked with the staged marker, not dropped.
    const staged = lastUpdate(findCalls)
    expect(staged.processing_status).toBe('skipped')
    expect(staged.error_message).toBe(STAGED_AWAITING_COMPANY)
    expect(askCompanyQuestionMock).toHaveBeenCalledTimes(1)
    expect(askCompanyQuestionMock.mock.calls[0][1]).toMatchObject({
      to: '46701234567',
      stagedCount: 1,
    })
  })

  it('releases the row for retry when the membership query fails (transient, never parked)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() }) // load row
    enqueue({ data: { id: 'msg-1' } }) // claim
    enqueue({ data: makeLink() }) // load link
    enqueue({ data: makeConversation() }) // load conversation
    enqueue({ error: { message: 'connection reset' } }) // memberships query fails
    enqueue({ data: null }) // release back to received

    const outcome = await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(outcome).toEqual({ kind: 'none' })
    expect(askCompanyQuestionMock).not.toHaveBeenCalled()
    expect(sendTextMock).not.toHaveBeenCalled()
    expect(downloadMediaMock).not.toHaveBeenCalled()
    expect(uploadAndExtractMock).not.toHaveBeenCalled()
    // The claim was released untouched: the sweep re-runs it within a minute
    // and gives up through the normal MAX_ATTEMPTS -> M18 path.
    const release = lastUpdate(findCalls)
    expect(release.processing_status).toBe('received')
  })

  it('un-parks the staged row when the company question hits a transient options failure', async () => {
    askCompanyQuestionMock.mockResolvedValue('transient_error')
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: makeConversation() })
    enqueue({ data: [{ company_id: 'company-1' }, { company_id: 'company-2' }] }) // ask path
    enqueue({ data: null }) // markStatus skipped (staged)
    enqueue({ data: null, count: 1 }) // staged count
    enqueue({ data: null }) // un-park release

    const outcome = await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(outcome).toEqual({ kind: 'none' })
    const release = lastUpdate(findCalls)
    expect(release.processing_status).toBe('received')
    expect(release.error_message).toBeNull()
  })

  it('uses a live conversation pin over everything and stamps via=pin', async () => {
    const pinExpiry = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString()
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink({ default_company_id: 'company-7' }) })
    enqueue({
      data: makeConversation({ company_id: 'company-9', context: { pin_expires_at: pinExpiry } }),
    })
    enqueue({ data: { company_id: 'company-9' } }) // pin membership check
    enqueue({ data: null }) // sliding pin refresh (context update)
    enqueue({ data: null }) // dup check
    enqueue({ data: null }) // item context load
    enqueue({ data: null }) // item context update
    enqueue({ data: null }) // markStatus done

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(uploadAndExtractMock).toHaveBeenCalledWith(
      supabase,
      'user-1',
      'company-9',
      expect.anything(),
      'whatsapp',
      undefined,
      undefined,
      expect.anything(),
    )
    // Sliding TTL: the pin refresh pushed pin_expires_at forward.
    const conversationUpdates = findCalls('whatsapp_conversations', 'update')
    const refresh = conversationUpdates.find((args) => {
      const patch = args[0] as { context?: { pin_expires_at?: string } }
      return patch.context?.pin_expires_at != null
    })
    expect(refresh).toBeTruthy()
    const refreshed = (refresh![0] as { context: { pin_expires_at: string } }).context
      .pin_expires_at
    expect(new Date(refreshed).getTime()).toBeGreaterThan(new Date(pinExpiry).getTime())
    // Item records that a pin resolved the company.
    const itemUpdate = findCalls('invoice_inbox_items', 'update')[0][0] as {
      channel_context: Record<string, unknown>
    }
    expect(itemUpdate.channel_context.company_selected_via).toBe('pin')
  })

  it('an EXPIRED pin no longer resolves: multi-company sender is asked again', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({
      data: makeConversation({
        company_id: 'company-9',
        context: { pin_expires_at: new Date(Date.now() - 1000).toISOString() },
      }),
    })
    enqueue({ data: [{ company_id: 'company-1' }, { company_id: 'company-2' }] })
    enqueue({ data: null }) // markStatus skipped
    enqueue({ data: null, count: 1 }) // staged count

    const outcome = await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(outcome.kind).toBe('media_staged')
    expect(uploadAndExtractMock).not.toHaveBeenCalled()
    expect(askCompanyQuestionMock).toHaveBeenCalledTimes(1)
  })

  it('uses the default company when set and still a member', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink({ default_company_id: 'company-7' }) })
    enqueue({ data: makeConversation() })
    enqueue({ data: { company_id: 'company-7' } }) // membership check for default
    enqueue({ data: null }) // dup check
    enqueue({ data: null }) // item context load
    enqueue({ data: null }) // item context update
    enqueue({ data: null }) // markStatus done

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(uploadAndExtractMock).toHaveBeenCalledWith(
      supabase,
      'user-1',
      'company-7',
      expect.anything(),
      'whatsapp',
      undefined,
      undefined,
      expect.anything(),
    )
  })

  it('rate limit: drops with M17 once, records RateLimitedDropped, never a retryable status', async () => {
    rateLimitMock.mockResolvedValue({ ok: false, scope: 'minute', retryAfterSec: 60 })
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: makeConversation() })
    enqueue({ data: [{ company_id: 'company-1' }] })
    enqueue({ data: [] }) // drain: nothing expired
    enqueue({ data: [] }) // drain: nothing parked behind an old company question
    enqueue({ data: null }) // M17 notice check: none sent yet
    enqueue({ data: null }) // markStatus skipped

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(appendHistoryMock).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'RateLimitedDropped', companyId: 'company-1' }),
    )
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m17RateLimited)
    expect(downloadMediaMock).not.toHaveBeenCalled()
    expect(uploadAndExtractMock).not.toHaveBeenCalled()
    expect(lastUpdate(findCalls).processing_status).toBe('skipped')
  })

  it('rate limit: stays silent when an M17 already went out inside the window', async () => {
    rateLimitMock.mockResolvedValue({ ok: false, scope: 'minute', retryAfterSec: 60 })
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: makeConversation() })
    enqueue({ data: [{ company_id: 'company-1' }] })
    enqueue({ data: [] }) // drain: nothing expired
    enqueue({ data: [] }) // drain: nothing parked behind an old company question
    enqueue({ data: { id: 'earlier-m17' } }) // notice already sent
    enqueue({ data: null }) // markStatus skipped

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('exact sha256 duplicate: M4-duplicate ack and no item created', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: makeConversation() })
    enqueue({ data: [{ company_id: 'company-1' }] })
    enqueue({ data: [] }) // drain: nothing expired
    enqueue({ data: [] }) // drain: nothing parked behind an old company question
    enqueue({ data: null }) // no inbox item for this message yet
    enqueue({ data: { id: 'existing-doc' } }) // dup found
    enqueue({ data: null }) // markStatus skipped

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(uploadAndExtractMock).not.toHaveBeenCalled()
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m4Duplicate)
    expect(lastUpdate(findCalls).processing_status).toBe('skipped')
  })

  it('a new file while awaiting_resend supersedes the old item and closes the question', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({
      data: makeConversation({
        state: 'awaiting_resend',
        context: {
          pending_question: {
            type: 'resend',
            inbox_item_id: 'item-old',
            asked_at: '2026-08-01T09:30:00Z',
          },
          recent_questions: [
            {
              type: 'resend',
              inbox_item_id: 'item-old',
              asked_at: '2026-08-01T09:30:00Z',
              status: 'open',
            },
          ],
        },
      }),
    })
    enqueue({ data: [{ company_id: 'company-1' }] })
    enqueue({ data: [] }) // drain: nothing expired
    enqueue({ data: [] }) // drain: nothing parked behind an old company question
    enqueue({ data: null }) // dup check
    enqueue({ data: null }) // new item context load
    enqueue({ data: null }) // new item context update
    enqueue({
      data: {
        channel_context: {
          channel: 'whatsapp',
          quality: { resend_requested_at: '2026-08-01T09:30:00Z' },
          pending_question: { type: 'resend', asked_at: '2026-08-01T09:30:00Z', status: 'open' },
        },
      },
    }) // old item context load
    enqueue({ data: null }) // old item context update
    enqueue({ data: null }) // conversation -> idle
    enqueue({ data: { company_id: 'company-1', correlation_id: null } }) // history item lookup
    enqueue({ data: null }) // markStatus done

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    const itemUpdates = findCalls('invoice_inbox_items', 'update')
    const oldItemPatch = itemUpdates[1][0] as { channel_context: Record<string, unknown> }
    expect(oldItemPatch.channel_context.quality).toMatchObject({
      resent: true,
      superseded: true,
    })
    expect(
      (oldItemPatch.channel_context.pending_question as { status: string }).status,
    ).toBe('answered')

    const conversationUpdates = findCalls('whatsapp_conversations', 'update')
    const idleUpdate = conversationUpdates.find(
      (args) => (args[0] as { state?: string }).state === 'idle',
    )
    expect(idleUpdate).toBeTruthy()
  })

  it('wraps failures: error status + error_message + a single M18', async () => {
    downloadMediaMock.mockRejectedValue(new GraphApiError('Media download failed (500)', 500))
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: makeConversation() })
    enqueue({ data: [{ company_id: 'company-1' }] })
    enqueue({ data: [] }) // drain: nothing expired
    enqueue({ data: [] }) // drain: nothing parked behind an old company question
    enqueue({ data: null }) // no inbox item yet
    enqueue({ data: null }) // markStatus error
    enqueue({ data: null }) // no M18 sent yet

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    const finalUpdate = lastUpdate(findCalls)
    expect(finalUpdate.processing_status).toBe('error')
    expect(String(finalUpdate.error_message)).toContain('download failed')
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m18Error)
  })

  it('still sends M18 on a re-claim when the first attempt died before the catch', async () => {
    // Gating M18 on `attempt <= 1` made it unreachable for exactly the crash
    // the sweep exists for: the dead first attempt already burned its
    // attempt, so the sender heard nothing about that receipt at all.
    downloadMediaMock.mockRejectedValue(new GraphApiError('still failing'))
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow({ attempts: 1 }) })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: makeConversation() })
    enqueue({ data: [{ company_id: 'company-1' }] })
    enqueue({ data: [] }) // drain: nothing expired
    enqueue({ data: [] }) // drain: nothing parked behind an old company question
    enqueue({ data: null }) // no inbox item yet
    enqueue({ data: null }) // markStatus error
    enqueue({ data: null }) // no M18 sent for this message yet

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(lastUpdate(findCalls).processing_status).toBe('error')
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    expect(sendTextMock.mock.calls[0][1].template).toBe(TEMPLATE.m18Error)
  })

  it('never repeats M18 when one already went out for the same message', async () => {
    downloadMediaMock.mockRejectedValue(new GraphApiError('still failing'))
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow({ attempts: 2 }) })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: makeConversation() })
    enqueue({ data: [{ company_id: 'company-1' }] })
    enqueue({ data: [] }) // drain: nothing expired
    enqueue({ data: [] }) // drain: nothing parked behind an old company question
    enqueue({ data: null }) // no inbox item yet
    enqueue({ data: null }) // markStatus error
    enqueue({ data: { id: 'out-1' } }) // an M18 for this correlation exists

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(lastUpdate(findCalls).processing_status).toBe('error')
    expect(sendTextMock).not.toHaveBeenCalled()
  })

  it('adopts an item a concurrent worker already created instead of ingesting twice', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink() })
    enqueue({ data: makeConversation() })
    enqueue({ data: [{ company_id: 'company-1' }] })
    enqueue({ data: [] }) // drain: nothing expired
    enqueue({ data: [] }) // drain: nothing parked behind an old company question
    enqueue({ data: { id: 'item-winner' } }) // the winner's item
    enqueue({ data: null }) // markStatus done

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(downloadMediaMock).not.toHaveBeenCalled()
    expect(uploadAndExtractMock).not.toHaveBeenCalled()
    const finalUpdate = lastUpdate(findCalls)
    expect(finalUpdate.processing_status).toBe('done')
    expect(finalUpdate.inbox_item_id).toBe('item-winner')
  })
})

describe('processInboundMessage: linked-sender silences become replies (#1552)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendTextMock.mockResolvedValue({ ok: true, wamid: 'wamid.OUT', errorDetail: null, failure: null })
  })

  it('missing media reference: marks error AND owns the failure with M18 via the link', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow({ media_id: null }) }) // load row
    enqueue({ data: { id: 'msg-1' } }) // claim
    enqueue({ data: null }) // markStatus error
    enqueue({ data: makeLink() }) // load link for the reply address
    enqueue({ data: null }) // errorNoticeAlreadySent: none

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(lastUpdate(findCalls).processing_status).toBe('error')
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    const args = sendTextMock.mock.calls[0][1]
    expect(args.template).toBe(TEMPLATE.m18Error)
    expect(args.to).toBe('46701234567')
  })

  it('link revoked before processing: marks skipped AND replies with the M1 unlinked copy', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() }) // load row
    enqueue({ data: { id: 'msg-1' } }) // claim
    enqueue({ data: makeLink({ revoked_at: '2026-08-01T09:30:00Z' }) }) // revoked link
    enqueue({ data: null }) // markStatus skipped
    enqueue({ data: [] }) // greeting throttle window: clear

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(lastUpdate(findCalls).processing_status).toBe('skipped')
    expect(sendTextMock).toHaveBeenCalledTimes(1)
    const args = sendTextMock.mock.calls[0][1]
    expect(args.template).toBe(TEMPLATE.m1Unlinked)
    expect(args.to).toBe('46701234567')
  })

  it('link revoked before processing: stays quiet when the M1 throttle is exhausted', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: makeRow() })
    enqueue({ data: { id: 'msg-1' } })
    enqueue({ data: makeLink({ revoked_at: '2026-08-01T09:30:00Z' }) })
    enqueue({ data: null }) // markStatus skipped
    enqueue({ data: [{ created_at: new Date().toISOString() }] }) // greeted within the hour

    await processInboundMessage(supabase as unknown as SupabaseClient, 'msg-1')

    expect(lastUpdate(findCalls).processing_status).toBe('skipped')
    expect(sendTextMock).not.toHaveBeenCalled()
  })
})
