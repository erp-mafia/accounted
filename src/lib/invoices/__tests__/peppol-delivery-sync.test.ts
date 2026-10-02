import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { createLogger } from '@/lib/logger'
import { pollOpenPeppolDeliveries } from '@/lib/invoices/peppol-delivery-sync'
import { PeppolTransportError, type PeppolTransport, type PeppolVerifiedEvent } from '@/lib/invoices/peppol-transport'

const { supabase: mockService, enqueue, reset, findCall } = createQueuedMockSupabase()
const service = mockService as unknown as SupabaseClient
const log = createLogger('test')
/** The queued mock records rpc() invocations on the vi.fn itself. */
const rpcCalls = () => (mockService.rpc as unknown as { mock: { calls: unknown[][] } }).mock.calls

const openDelivery = {
  id: 'delivery-1',
  company_id: 'company-1',
  idempotency_key: '33333333-3333-4333-8333-333333333333',
  provider_submission_id: 'int-1',
  status: 'submission_accepted',
  status_at: '2026-08-21T10:00:00.000Z',
  submitted_at: '2026-08-21T10:00:00.000Z',
  evidence_retrieved_at: null,
}

function event(status: PeppolVerifiedEvent['normalizedStatus'], terminal = false): PeppolVerifiedEvent {
  return {
    provider: 'qvalia',
    providerTenantId: 'SE5595386219',
    providerSubmissionId: 'int-1',
    providerEventId: `document_delivery:int-1:${status}`,
    idempotencyKey: null,
    eventCode: 'status_poll',
    normalizedStatus: status,
    isTerminal: terminal,
    detail: status,
    occurredAt: '2026-08-21T11:00:00.000Z',
    rawPayload: {},
    eventSha256: 'b'.repeat(64),
    verificationMethod: 'provider_poll',
  }
}

function makeTransport(overrides: Partial<PeppolTransport> = {}): PeppolTransport {
  return {
    provider: 'qvalia',
    tenantId: 'SE5595386219',
    lookupRecipient: vi.fn(),
    submit: vi.fn(),
    verifyWebhook: vi.fn(),
    retrieveEvidence: vi.fn().mockResolvedValue([{
      provider: 'qvalia',
      evidenceType: 'qvalia_message_record',
      payload: {},
      exactDocument: null,
      exactDocumentSha256: null,
      evidenceSha256: 'c'.repeat(64),
      retrievedAt: '2026-08-21T11:00:01.000Z',
    }]),
    pollDeliveryStatus: vi.fn().mockResolvedValue([event('transport_succeeded')]),
    ...overrides,
  }
}

describe('pollOpenPeppolDeliveries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    reset()
  })

  it('records the provider status through the lifecycle RPC with the delivery identity and fetches evidence', async () => {
    const transport = makeTransport()
    enqueue({ data: [openDelivery], error: null })                                       // open deliveries
    enqueue({ data: { ...openDelivery, status: 'transport_succeeded', status_at: '2026-08-21T11:00:00.000Z' }, error: null }) // event rpc
    enqueue({ data: 'evidence-1', error: null })                                        // evidence rpc

    const result = await pollOpenPeppolDeliveries({ service, transport, log })

    expect(result).toMatchObject({ polled: 1, advanced: 1, unchanged: 0, failed: 0, deferred: 0 })
    const eventCall = rpcCalls().find((c) => c[0] === 'record_peppol_delivery_event')
    expect(eventCall?.[1]).toMatchObject({
      p_company_id: 'company-1',
      p_idempotency_key: '33333333-3333-4333-8333-333333333333',
      p_provider_tenant_id: 'SE5595386219',
      p_provider_submission_id: 'int-1',
      p_provider_event_id: 'document_delivery:int-1:transport_succeeded',
      p_normalized_status: 'transport_succeeded',
      p_verification_method: 'provider_poll',
    })
    expect(transport.retrieveEvidence).toHaveBeenCalledWith('int-1')
    const evidenceCall = rpcCalls().find((c) => c[0] === 'record_peppol_delivery_evidence')
    expect(evidenceCall?.[1]).toMatchObject({ p_company_id: 'company-1', p_evidence_type: 'qvalia_message_record' })
  })

  it('counts a delivery the provider has nothing new about as unchanged', async () => {
    const transport = makeTransport({ pollDeliveryStatus: vi.fn().mockResolvedValue([]) })
    enqueue({ data: [openDelivery], error: null })
    const result = await pollOpenPeppolDeliveries({ service, transport, log })
    expect(result).toMatchObject({ polled: 1, advanced: 0, unchanged: 1 })
    expect(rpcCalls()).toHaveLength(0)
  })

  it('isolates a failing poll and keeps the pass going', async () => {
    const transport = makeTransport({
      pollDeliveryStatus: vi.fn()
        .mockRejectedValueOnce(new Error('Qvalia answered 503'))
        .mockResolvedValueOnce([]),
    })
    enqueue({ data: [openDelivery, { ...openDelivery, id: 'delivery-2', provider_submission_id: 'int-2' }], error: null })
    const result = await pollOpenPeppolDeliveries({ service, transport, log })
    expect(result).toMatchObject({ polled: 2, failed: 1, unchanged: 1 })
    expect(result.errors).toEqual([{ providerSubmissionId: 'int-1', reason: 'Qvalia answered 503' }])
  })

  it('asks only about deliveries the access point may still move: submitting and submission_accepted', async () => {
    enqueue({ data: [], error: null })
    await pollOpenPeppolDeliveries({ service, transport: makeTransport(), log })
    // transport_succeeded is final for our purposes: Qvalia's status carries no business responses.
    expect(findCall('peppol_deliveries', 'in')).toEqual(['status', ['submitting', 'submission_accepted']])
    expect(findCall('peppol_deliveries', 'eq')).toEqual(['provider', 'qvalia'])
    expect(findCall('peppol_deliveries', 'is')).toEqual(['terminal_at', null])
  })

  it.each([
    ['the connector service budget', 'CONNECTOR_RATE_LIMITED'],
    ['a bare 429', 'HTTP_429'],
  ])('stops the pass at %s and defers the rest to the next run', async (_label, code) => {
    const pollDeliveryStatus = vi.fn()
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new PeppolTransportError('Connector: busy', { retryable: true, code }))
      .mockResolvedValue([event('transport_succeeded')])
    const transport = makeTransport({ pollDeliveryStatus })
    enqueue({
      data: [
        openDelivery,
        { ...openDelivery, id: 'delivery-2', provider_submission_id: 'int-2' },
        { ...openDelivery, id: 'delivery-3', provider_submission_id: 'int-3' },
        { ...openDelivery, id: 'delivery-4', provider_submission_id: 'int-4' },
      ],
      error: null,
    })

    const result = await pollOpenPeppolDeliveries({ service, transport, log })

    expect(result).toEqual({ polled: 1, advanced: 0, unchanged: 1, failed: 0, deferred: 3, errors: [] })
    expect(pollDeliveryStatus.mock.calls.map((c) => c[0])).toEqual(['int-1', 'int-2'])
    expect(rpcCalls()).toHaveLength(0)
  })

  it('keeps the pass going after a transport failure that is not the budget', async () => {
    const transport = makeTransport({
      pollDeliveryStatus: vi.fn()
        .mockRejectedValueOnce(new PeppolTransportError('Connector: upstream', { retryable: false, code: 'CONNECTOR_UPSTREAM_SHAPE' }))
        .mockResolvedValueOnce([]),
    })
    enqueue({ data: [openDelivery, { ...openDelivery, id: 'delivery-2', provider_submission_id: 'int-2' }], error: null })
    const result = await pollOpenPeppolDeliveries({ service, transport, log })
    expect(result).toMatchObject({ polled: 2, failed: 1, unchanged: 1, deferred: 0 })
    expect(result.errors).toEqual([{ providerSubmissionId: 'int-1', reason: 'Connector: upstream' }])
  })

  it('is a no-op for a transport without polling', async () => {
    const result = await pollOpenPeppolDeliveries({ service, transport: makeTransport({ pollDeliveryStatus: undefined }), log })
    expect(result.polled).toBe(0)
    expect(rpcCalls()).toHaveLength(0)
  })
})
