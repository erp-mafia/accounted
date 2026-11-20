/**
 * A PeppolTransportError is recognised by every copy of the port (the
 * crm#1282 mechanism, for Peppol).
 *
 * A production server holds one copy of lib/invoices/peppol-transport.ts per
 * bundler layer: lib/init registers the transports in the instrumentation
 * hook's copy, and the send, the registration and the delivery sync catch with
 * the route's (lib/global-singleton.ts). vi.resetModules() makes the second
 * copy here: whatever is imported before it plays the instrumentation graph,
 * whatever after it the route's. The transport map is process-wide, so the
 * route copy finds the transport the instrumentation copy registered, as
 * getPeppolTransport does in production.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { resetGlobalSingletons } from '@/lib/global-singleton'

const UPSTREAM = { baseUrl: 'https://connect.example.se/api/connect/peppol', key: 'gnubok_ck_secret' }

const OPEN_DELIVERY = {
  id: 'delivery-1',
  company_id: 'company-1',
  idempotency_key: '33333333-3333-4333-8333-333333333333',
  provider_submission_id: 'int-1',
  status: 'submission_accepted',
  status_at: '2026-10-20T10:00:00.000Z',
  submitted_at: '2026-10-20T10:00:00.000Z',
  evidence_retrieved_at: null,
}

/** What the connector service answers when this installation's Peppol budget is spent. */
const RATE_LIMITED = {
  error: 'Rate limit reached',
  code: 'CONNECTOR_RATE_LIMITED',
  retryable: true,
  detail: 'Try again later.',
}

beforeEach(() => {
  vi.resetModules()
  resetGlobalSingletons()
})

describe('PeppolTransportError across module copies', () => {
  it("is the route copy's PeppolTransportError when a transport lib/init registered throws it, code and all", async () => {
    // The instrumentation graph: lib/init registers the connector transport.
    const instrumentation = await import('@/lib/invoices/peppol-transport')
    const { createConnectorPeppolTransport } = await import('@/lib/invoices/transports/connector')
    const fetch = vi.fn().mockImplementation(
      async () => new Response(JSON.stringify(RATE_LIMITED), { status: 429, headers: { 'Content-Type': 'application/json' } }),
    )
    instrumentation.registerPeppolTransport(
      createConnectorPeppolTransport(UPSTREAM, { fetch, companyFor: async () => 'company-1' }),
    )

    // The route graph: the delivery sync's own copy of the port.
    vi.resetModules()
    const route = await import('@/lib/invoices/peppol-transport')
    const { pollOpenPeppolDeliveries } = await import('@/lib/invoices/peppol-delivery-sync')
    expect(route.PeppolTransportError).not.toBe(instrumentation.PeppolTransportError)

    const transport = await route.getPeppolTransport('connector')
    expect(transport).not.toBeNull()
    const thrown = await transport!.pollDeliveryStatus!('int-1').then(
      () => null,
      (error: unknown) => error,
    )
    expect(thrown instanceof route.PeppolTransportError).toBe(true)
    expect(thrown instanceof instrumentation.PeppolTransportError).toBe(true)
    expect(route.isPeppolTransportError(thrown)).toBe(true)
    expect(thrown).toMatchObject({ code: 'CONNECTOR_RATE_LIMITED', retryable: true, detail: 'Try again later.' })

    // The behaviour the check decides: a spent budget stops the pass and
    // defers the rest; read as an unknown failure it would ask about every
    // delivery again and count each one as failed.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [OPEN_DELIVERY, { ...OPEN_DELIVERY, id: 'delivery-2', provider_submission_id: 'int-2' }], error: null })
    const { createLogger } = await import('@/lib/logger')
    const result = await pollOpenPeppolDeliveries({
      service: supabase as unknown as SupabaseClient,
      transport: transport!,
      log: createLogger('test'),
    })
    expect(result).toMatchObject({ polled: 0, failed: 0, deferred: 2, errors: [] })
  })

  it("is the route copy's QvaliaApiError and PeppolTransportError when the Qvalia adapter's copy throws it", async () => {
    const instrumentation = await import('@/lib/invoices/transports/qvalia')
    const thrownAuth = new instrumentation.QvaliaApiError('auth', 'Qvalia refused the API credentials (401)', { httpStatus: 401 })
    const thrownPlain = new (await import('@/lib/invoices/peppol-transport')).PeppolTransportError('Connector: busy', {
      retryable: true,
      code: 'HTTP_429',
    })

    vi.resetModules()
    const route = await import('@/lib/invoices/transports/qvalia')
    const port = await import('@/lib/invoices/peppol-transport')
    expect(route.QvaliaApiError).not.toBe(instrumentation.QvaliaApiError)

    expect(thrownAuth instanceof route.QvaliaApiError).toBe(true)
    expect(thrownAuth instanceof port.PeppolTransportError).toBe(true)
    expect(thrownAuth).toMatchObject({ kind: 'auth', httpStatus: 401, retryable: true })
    // A transport error is not a Qvalia error just because Qvalia's class extends it.
    expect(thrownPlain instanceof port.PeppolTransportError).toBe(true)
    expect(thrownPlain instanceof route.QvaliaApiError).toBe(false)
  })

  it('is nothing else: a plain error, an error with the same name and fields, a plain object', async () => {
    const { PeppolTransportError, isPeppolTransportError } = await import('@/lib/invoices/peppol-transport')
    const lookalike = Object.assign(new Error('busy'), { name: 'PeppolTransportError', code: 'HTTP_429', retryable: true, detail: null })

    expect(new Error('busy') instanceof PeppolTransportError).toBe(false)
    expect(lookalike instanceof PeppolTransportError).toBe(false)
    expect(isPeppolTransportError(lookalike)).toBe(false)
    expect({ code: 'HTTP_429' } instanceof PeppolTransportError).toBe(false)
    expect((null as unknown) instanceof PeppolTransportError).toBe(false)
  })

  it('keeps the mark out of anything serialised from the error', async () => {
    const { PeppolTransportError } = await import('@/lib/invoices/peppol-transport')
    const error = new PeppolTransportError('Connector: busy', { retryable: true, code: 'HTTP_429', detail: 'later' })

    expect(Object.keys(error)).not.toContain('accounted.peppol.transportError')
    expect(JSON.parse(JSON.stringify(error))).toEqual({ name: 'PeppolTransportError', retryable: true, detail: 'later', code: 'HTTP_429' })
  })
})
