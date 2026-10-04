import { describe, it, expect, vi } from 'vitest'
import { COLLECTIONS_OPERATIONS, CONTRACT_VERSION, type CollectionsOperation } from '@accounted/connect-contract'
import { COLLECTIONS_FIXTURES } from '../../../../packages/connect-contract/src/__tests__/fixtures'
import {
  COLLECTIONS_DEFAULT_TIMEOUT_MS,
  COLLECTIONS_LONG_TIMEOUT_MS,
  collectionsTimeoutMs,
  createConnectorCollectionsAdapter,
} from '../adapters/connector'
import { CollectionsError } from '../errors'
import type { CollectionsAdapter, CollectionsCallContext } from '../port'

const UPSTREAM = { baseUrl: 'https://connect.example.se/api/connect/collections', key: 'gnubok_ck_test' }
const CTX: CollectionsCallContext = { companyId: 'company-1', connectionHandle: 'handle-1' }

/** How each contract operation is reached through the port. */
const CALLS: Record<CollectionsOperation, (a: CollectionsAdapter, ctx: CollectionsCallContext, req: never) => Promise<unknown>> = {
  connection: (a, ctx) => a.connection(ctx),
  onboard: (a, ctx, r) => a.onboard(ctx, r),
  cancelOnboarding: (a, ctx, r) => a.cancelOnboarding(ctx, r),
  acceptTerms: (a, ctx, r) => a.acceptTerms(ctx, r),
  startSignature: (a, ctx, r) => a.startSignature(ctx, r),
  updateSettings: (a, ctx, r) => a.updateSettings(ctx, r),
  disconnect: (a, ctx, r) => a.disconnect(ctx, r),
  openCase: (a, ctx, r) => a.openCase(ctx, r),
  getCase: (a, ctx, r) => a.getCase(ctx, r),
  caseAction: (a, ctx, r) => a.caseAction(ctx, r),
  caseDocument: (a, ctx, r) => a.caseDocument(ctx, r),
  registerPayment: (a, ctx, r) => a.registerPayment(ctx, r),
  revertPayment: (a, ctx, r) => a.revertPayment(ctx, r),
  registerCreditNote: (a, ctx, r) => a.registerCreditNote(ctx, r),
  changes: (a, _ctx, r) => a.changes(r),
  settlements: (a, ctx, r) => a.settlements(ctx, r),
  settlement: (a, ctx, r) => a.settlement(ctx, r),
  settlementDocument: (a, ctx, r) => a.settlementDocument(ctx, r),
  settlementBooked: (a, ctx, r) => a.markSettlementBooked(ctx, r),
}

function respond(status: number, body: unknown) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }))
}

describe('Connect collections adapter', () => {
  it('is the connect route', () => {
    expect(createConnectorCollectionsAdapter(UPSTREAM).route).toBe('connect')
  })

  it.each(Object.keys(COLLECTIONS_OPERATIONS) as CollectionsOperation[])(
    '%s: right method and path, contract headers, the fixture answer parsed',
    async (operation) => {
      const def = COLLECTIONS_OPERATIONS[operation]
      const fixture = COLLECTIONS_FIXTURES[operation]
      const fetchMock = respond(200, fixture.response)
      const adapter = createConnectorCollectionsAdapter(UPSTREAM, { fetch: fetchMock })

      const result = await CALLS[operation](adapter, CTX, fixture.request as never)

      expect(result).toEqual(def.response.parse(fixture.response))
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe(`${UPSTREAM.baseUrl}${def.path}`)
      expect(init.method).toBe(def.method)
      expect(init.headers['X-Connect-Contract-Version']).toBe(CONTRACT_VERSION)
      expect(init.headers.Authorization).toBe('Bearer gnubok_ck_test')
      // Every company operation names the company and the connection; the key-wide feed names neither company.
      if (def.company) {
        expect(init.headers['X-Connector-Company']).toBe('company-1')
        expect(init.headers['X-Connector-Connection']).toBe('handle-1')
      } else {
        expect(init.headers['X-Connector-Company']).toBeUndefined()
      }
      expect(JSON.parse(init.body)).toEqual(def.request.parse(fixture.request))
    },
  )

  it('sends no connection header before onboarding', async () => {
    const fetchMock = respond(200, COLLECTIONS_FIXTURES.connection.response)
    await createConnectorCollectionsAdapter(UPSTREAM, { fetch: fetchMock }).connection({ companyId: 'company-1', connectionHandle: null })
    expect(fetchMock.mock.calls[0][1].headers['X-Connector-Connection']).toBeUndefined()
  })

  it('waits longer than Connect for the resumable writes and 30 s for the rest', () => {
    expect(collectionsTimeoutMs('onboard')).toBe(COLLECTIONS_LONG_TIMEOUT_MS)
    expect(collectionsTimeoutMs('openCase')).toBe(COLLECTIONS_LONG_TIMEOUT_MS)
    expect(COLLECTIONS_LONG_TIMEOUT_MS).toBeGreaterThan(120_000)
    expect(collectionsTimeoutMs('getCase')).toBe(COLLECTIONS_DEFAULT_TIMEOUT_MS)
    expect(collectionsTimeoutMs('registerPayment')).toBe(COLLECTIONS_DEFAULT_TIMEOUT_MS)
  })

  it('throws CollectionsError with the envelope code on a refusal', async () => {
    const adapter = createConnectorCollectionsAdapter(UPSTREAM, {
      fetch: respond(422, { error: 'debtor', code: 'CONNECTOR_COLLECTIONS_DEBTOR_INVALID', retryable: false, detail: 'address.postalCode' }),
    })
    await expect(adapter.openCase(CTX, COLLECTIONS_FIXTURES.openCase.request)).rejects.toMatchObject({
      name: 'CollectionsError',
      code: 'CONNECTOR_COLLECTIONS_DEBTOR_INVALID',
      retryable: false,
      detail: 'address.postalCode',
      status: 422,
    })
  })

  it('throws a protocol error on an answer that breaks the contract, and unreachable on a network failure', async () => {
    const shape = createConnectorCollectionsAdapter(UPSTREAM, { fetch: respond(200, { state: 'weird' }) })
    const protocol = await shape.connection(CTX).catch((e) => e)
    expect(protocol).toBeInstanceOf(CollectionsError)
    expect(protocol).toMatchObject({ code: 'CONNECTOR_PROTOCOL_ERROR', retryable: false })

    const down = createConnectorCollectionsAdapter(UPSTREAM, { fetch: vi.fn().mockRejectedValue(new TypeError('fetch failed')) })
    await expect(down.getCase(CTX, { caseRef: 'c-1' })).rejects.toMatchObject({ code: 'CONNECTOR_UNREACHABLE', retryable: true })
  })

  it('never sends a request that breaks the contract', async () => {
    const fetchMock = vi.fn()
    const adapter = createConnectorCollectionsAdapter(UPSTREAM, { fetch: fetchMock })
    const bad = { ...COLLECTIONS_FIXTURES.openCase.request, invoice: { ...COLLECTIONS_FIXTURES.openCase.request.invoice, claimAmount: 0.1 + 0.2 } }
    await expect(adapter.openCase(CTX, bad)).rejects.toMatchObject({ code: 'CONNECTOR_REQUEST_INVALID' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a plain-http Connect origin before any call', async () => {
    const fetchMock = vi.fn()
    const adapter = createConnectorCollectionsAdapter({ ...UPSTREAM, baseUrl: 'http://connect.example.se/api/connect/collections' }, { fetch: fetchMock })
    await expect(adapter.connection(CTX)).rejects.toMatchObject({ code: 'CONNECTOR_INSECURE_URL', retryable: false })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
