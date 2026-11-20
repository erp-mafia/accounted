/**
 * A PaymentProviderError is recognised by every copy of the port (crm#1282).
 *
 * A production server holds one copy of lib/payments/initiation/provider.ts
 * per bundler layer: lib/init builds the Connect adapter in the
 * instrumentation hook's copy, and a route catches with its own
 * (lib/global-singleton.ts). vi.resetModules() makes the second copy here:
 * whatever is imported before it plays the instrumentation graph, whatever
 * after it the route's.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { resetGlobalSingletons } from '@/lib/global-singleton'
import type { PaymentPartyContext } from '../provider'

const UPSTREAM = { baseUrl: 'https://connect.example.se/api/connect/payments', key: 'gnubok_ck_secret' }

const CTX: PaymentPartyContext = {
  companyId: 'co-1',
  companyOrgNumber: '559538-6219',
  accountContext: 'corporate',
  debtorBic: 'DABASESX',
  affiliatedAspspId: null,
  redirectPreferred: true,
  signerPersonalNumber: '199001011239',
  psuIpAddress: '203.0.113.10',
  psuUserAgent: 'UA',
}

/** What Connect answers when the bank will not start a second authorisation on a basket. */
const SECOND_AUTHORISATION_REFUSED = {
  error: 'The bank or the payments provider refused the request',
  code: 'CONNECTOR_PAYMENTS_REFUSED',
  retryable: false,
  detail: 'FORMAT_ERROR: Signing basket authorisation auth-1 already exists.',
  providerCode: 'FORMAT_ERROR',
}

beforeEach(() => {
  vi.resetModules()
  resetGlobalSingletons()
})

describe('PaymentProviderError across module copies', () => {
  it("is the route copy's PaymentProviderError when the adapter of the instrumentation copy throws it, code and all", async () => {
    // The instrumentation graph: lib/init's adapter and the class it throws.
    const instrumentation = await import('../provider')
    const { createConnectPaymentsProvider } = await import('../connect')
    const fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(SECOND_AUTHORISATION_REFUSED), { status: 422, headers: { 'Content-Type': 'application/json' } }),
    )
    const adapter = createConnectPaymentsProvider(UPSTREAM, { fetch, timeoutMs: 1000 })

    // The route graph: the signing's own copy of the port.
    vi.resetModules()
    const route = await import('../provider')
    expect(route.PaymentProviderError).not.toBe(instrumentation.PaymentProviderError)

    const thrown = await adapter
      .startSigning(CTX, { kind: 'basket', providerBasketId: 'basket-1' }, 'redirect', {
        returnUrl: 'https://app.accounted.se/payments?signing=batch-1',
        returnState: 'batch-1',
      })
      .then(
        () => null,
        (error: unknown) => error,
      )

    expect(thrown instanceof route.PaymentProviderError).toBe(true)
    expect(thrown instanceof instrumentation.PaymentProviderError).toBe(true)
    expect(thrown).toMatchObject({ code: 'FORMAT_ERROR', httpStatus: 422, retryable: false, outcomeUnknown: false })
    // A refusal, never an unknown outcome that would hold the order.
    expect(route.providerWriteOutcome(thrown)).toBe('refused')
    expect(route.providerWriteOutcome(new instrumentation.PaymentProviderError('down', 'CONNECTOR_UNREACHABLE', true))).toBe('not_sent')
  })

  it('is nothing else: a plain error, an error with the same name and code, a plain object', async () => {
    const { PaymentProviderError, providerWriteOutcome } = await import('../provider')
    const lookalike = Object.assign(new Error('format'), { name: 'PaymentProviderError', code: 'FORMAT_ERROR', retryable: false })

    expect(new Error('format') instanceof PaymentProviderError).toBe(false)
    expect(lookalike instanceof PaymentProviderError).toBe(false)
    expect({ code: 'FORMAT_ERROR' } instanceof PaymentProviderError).toBe(false)
    expect((null as unknown) instanceof PaymentProviderError).toBe(false)
    expect(('FORMAT_ERROR' as unknown) instanceof PaymentProviderError).toBe(false)
    expect(providerWriteOutcome(lookalike)).toBe('unknown')
  })

  it('keeps the mark out of anything serialised from the error', async () => {
    const { PaymentProviderError } = await import('../provider')
    const error = new PaymentProviderError('refused', 'FORMAT_ERROR', false, 422)

    expect(Object.keys(error)).not.toContain('accounted.payments.providerError')
    expect(JSON.parse(JSON.stringify(error))).toEqual({ name: 'PaymentProviderError', code: 'FORMAT_ERROR', retryable: false, httpStatus: 422, outcomeUnknown: false })
  })
})
