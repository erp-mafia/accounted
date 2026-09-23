import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  PROCESSING_EVENT_TYPES,
  appendProcessingHistoryWithClient,
  type ProcessingHistoryEventType,
} from '@/lib/processing-history/append'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

/** Minimal service-role stand-in: records the inserted row, resolves clean. */
function createInsertSpy(error: { message: string } | null = null) {
  const insert = vi.fn().mockResolvedValue({ error })
  const from = vi.fn().mockReturnValue({ insert })
  return { supabase: { from } as never, from, insert }
}

const baseInput = {
  companyId: '11111111-1111-4111-8111-111111111111',
  correlationId: '22222222-2222-4222-8222-222222222222',
  aggregateType: 'System' as const,
  aggregateId: '22222222-2222-4222-8222-222222222222',
  eventType: 'OAuthClientRevoked' as const,
  payload: { client_id: '33333333-3333-4333-8333-333333333333' },
  actor: { type: 'user' as const, id: '44444444-4444-4444-8444-444444444444' },
  occurredAt: new Date('2026-09-01T10:00:00Z'),
}

describe('PROCESSING_EVENT_TYPES', () => {
  it('is sorted and free of duplicates', () => {
    // The list is read row-by-row against the migration that registers the same
    // strings; keeping it sorted and unique is what makes that diff readable.
    const sorted = [...PROCESSING_EVENT_TYPES].sort()
    expect([...PROCESSING_EVENT_TYPES]).toEqual(sorted)
    expect(new Set(PROCESSING_EVENT_TYPES).size).toBe(PROCESSING_EVENT_TYPES.length)
  })

  it('rejects an event type no migration registers', () => {
    // The real guard is the compiler: processing_history.event_type has an FK
    // to processing_event_types and every append is best-effort try/catch, so
    // an unregistered literal is an audit record silently lost at runtime.
    // If this @ts-expect-error ever goes unused, the union stopped enforcing.
    const registered: ProcessingHistoryEventType = 'TransactionDocumentReplaced'
    // @ts-expect-error not a member of PROCESSING_EVENT_TYPES
    const unregistered: ProcessingHistoryEventType = 'SomethingNobodyRegistered'

    expect(registered).toBe('TransactionDocumentReplaced')
    expect(unregistered).toBe('SomethingNobodyRegistered')
  })
})

describe('appendProcessingHistoryWithClient', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes the event row and returns the generated event id', async () => {
    const { supabase, from, insert } = createInsertSpy()

    const eventId = await appendProcessingHistoryWithClient(supabase, baseInput)

    expect(from).toHaveBeenCalledWith('processing_history')
    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_id: eventId,
        company_id: baseInput.companyId,
        correlation_id: baseInput.correlationId,
        causation_id: null,
        aggregate_type: 'System',
        aggregate_id: baseInput.aggregateId,
        event_type: 'OAuthClientRevoked',
        payload: baseInput.payload,
        payload_schema_version: 1,
        occurred_at: '2026-09-01T10:00:00.000Z',
      })
    )
  })

  it('throws with the event type when the insert fails', async () => {
    // The FK violation on an unregistered event type arrives here. Every call
    // site swallows it, so the message is the only trace: it must name the type.
    const { supabase } = createInsertSpy({
      message: 'insert or update on table "processing_history" violates foreign key constraint',
    })

    await expect(appendProcessingHistoryWithClient(supabase, baseInput)).rejects.toThrow(
      /OAuthClientRevoked/
    )
  })

  it('rejects a payload carrying a personnummer', async () => {
    const { supabase, insert } = createInsertSpy()

    await expect(
      appendProcessingHistoryWithClient(supabase, {
        ...baseInput,
        payload: { note: '900101-1234' },
      })
    ).rejects.toThrow()
    expect(insert).not.toHaveBeenCalled()
  })

  it('accepts a payload of UUIDs, counts and booleans', async () => {
    const { supabase, insert } = createInsertSpy()

    await appendProcessingHistoryWithClient(supabase, {
      ...baseInput,
      eventType: 'AttachmentsTruncated',
      payload: { total: 24, processed: 20, dropped: 4 },
    })

    expect(insert).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'AttachmentsTruncated',
        payload: { total: 24, processed: 20, dropped: 4 },
      })
    )
  })
})
