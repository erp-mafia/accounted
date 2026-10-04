import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { CONTRACT_VERSION, DELIVERY_OPERATIONS, type DeliveryOperation } from '@accounted/connect-contract'
import { DELIVERY_FIXTURES, TEST_ORG_NUMBER } from '../../../../../packages/connect-contract/src/__tests__/fixtures'
import { createFakeCollectionsAdapter, createFakeCollectionsStore } from '@/lib/collections/adapters/fake'
import { deliveryAdapterFor } from '../adapters'
import { createConnectorDeliveryAdapter, DELIVERY_SEND_TIMEOUT_MS, deliveryTimeoutMs } from '../adapters/connector'
import { createFakeDeliveryAdapter, decodeFakeDeliveryRef } from '../adapters/fake'
import { __resetDeliveryAdaptersForTests, registerDeliveryAdapter, resolveDeliveryAdapter } from '../registry'

const UPSTREAM = { baseUrl: 'https://connect.example.se/api/connect/delivery', key: 'gnubok_ck_test' }
const CTX = { companyId: 'company-1', connectionHandle: 'handle-1' }
const MINUTE = 60_000
const SENT = Date.parse('2026-10-04T08:00:00Z')

describe('Connect delivery adapter', () => {
  it.each(Object.keys(DELIVERY_OPERATIONS) as DeliveryOperation[])('%s: method, path, headers and the parsed answer', async (operation) => {
    const def = DELIVERY_OPERATIONS[operation]
    const fixture = DELIVERY_FIXTURES[operation]
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(fixture.response), { status: 200 }))
    const adapter = createConnectorDeliveryAdapter(UPSTREAM, { fetch: fetchMock })
    const result = await (adapter[operation] as (ctx: typeof CTX, input: unknown) => Promise<unknown>)(CTX, fixture.request)
    expect(result).toEqual(def.response.parse(fixture.response))
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(`${UPSTREAM.baseUrl}${def.path}`)
    expect(init.method).toBe(def.method)
    expect(init.headers).toMatchObject({
      Authorization: 'Bearer gnubok_ck_test',
      'X-Connect-Contract-Version': CONTRACT_VERSION,
      'X-Connector-Company': 'company-1',
      'X-Connector-Connection': 'handle-1',
    })
  })

  it('waits longer than Connect for a send and maps refusals to CollectionsError', async () => {
    expect(deliveryTimeoutMs('send')).toBe(DELIVERY_SEND_TIMEOUT_MS)
    expect(deliveryTimeoutMs('status')).toBe(30_000)
    const adapter = createConnectorDeliveryAdapter(UPSTREAM, {
      fetch: vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: 'x', code: 'CONNECTOR_DELIVERY_METHOD_UNAVAILABLE' }), { status: 422 })),
    })
    await expect(adapter.send(CTX, DELIVERY_FIXTURES.send.request)).rejects.toMatchObject({
      name: 'CollectionsError',
      code: 'CONNECTOR_DELIVERY_METHOD_UNAVAILABLE',
      retryable: false,
    })
  })
})

describe('fake delivery adapter', () => {
  function setup() {
    const clock = { now: SENT }
    return { clock, adapter: createFakeDeliveryAdapter({ now: () => new Date(clock.now), minuteMs: MINUTE, sent: new Map() }) }
  }

  it('finds a debtor reachable unless its identifier ends in 0', async () => {
    const { adapter } = setup()
    expect(await adapter.methods(CTX, DELIVERY_FIXTURES.methods.request)).toMatchObject({ method: 'kivra', reachable: true, reasonCode: null })
    const unreachable = await adapter.methods(CTX, { method: 'einvoice_bank', debtor: { kind: 'business', orgNumber: '5561234560', personalNumber: null } })
    expect(unreachable).toMatchObject({ reachable: false, reasonCode: 'not_registered' })
    expect((await adapter.methods(CTX, { method: 'einvoice_bank', debtor: { kind: 'business', orgNumber: TEST_ORG_NUMBER, personalNumber: null } })).reachable).toBe(true)
  })

  it('sends, replays the same handle, and walks scheduled, sent, delivered', async () => {
    const { adapter, clock } = setup()
    const receipt = await adapter.send(CTX, DELIVERY_FIXTURES.send.request)
    expect(receipt.case).toBeNull()
    expect(decodeFakeDeliveryRef(receipt.deliveryRef)).toEqual({ method: 'kivra', sentAt: SENT })
    clock.now += 30_000
    expect((await adapter.send(CTX, DELIVERY_FIXTURES.send.request)).deliveryRef).toBe(receipt.deliveryRef)

    const states = async () => (await adapter.status(CTX, { deliveryRef: receipt.deliveryRef })).map((s) => s.state)
    expect(await states()).toEqual(['scheduled'])
    clock.now = SENT + MINUTE
    expect(await states()).toEqual(['scheduled', 'sent'])
    clock.now = SENT + 3 * MINUTE
    expect(await states()).toEqual(['scheduled', 'sent', 'delivered'])
    expect(DELIVERY_OPERATIONS.status.response.safeParse(await adapter.status(CTX, { deliveryRef: receipt.deliveryRef })).success).toBe(true)
  })

  it('answers a watching case when follow-up is asked for, which the collections fake can start', async () => {
    const { adapter } = setup()
    const receipt = await adapter.send(CTX, {
      ...DELIVERY_FIXTURES.send.request,
      idempotencyKey: 'delivery-2',
      followUp: { caseIdempotencyKey: 'case-9', reminderFeeAgreed: false },
    })
    expect(receipt.case).toMatchObject({ stage: 'invoice_sent', actions: ['start', 'withdraw'], isOpen: true })
    const collections = createFakeCollectionsAdapter({ now: () => new Date(SENT + MINUTE), minuteMs: MINUTE, store: createFakeCollectionsStore() })
    const started = await collections.caseAction(CTX, {
      idempotencyKey: 'start-1',
      caseRef: receipt.case!.caseRef,
      action: 'start',
      step: 'reminder',
      message: null,
      until: null,
    })
    expect(started.stage).toBe('reminder')
  })

  it('refuses an unknown delivery handle', async () => {
    const { adapter } = setup()
    await expect(adapter.status(CTX, { deliveryRef: 'nope' })).rejects.toMatchObject({ code: 'COLLECTIONS_NOT_FOUND' })
  })
})

describe('delivery registry', () => {
  beforeEach(() => {
    __resetDeliveryAdaptersForTests()
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', '')
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    __resetDeliveryAdaptersForTests()
  })

  it('resolves by route: the fake always, Connect only with a key, never a fallback', () => {
    expect(resolveDeliveryAdapter({ route: 'fake' })).toBeNull()
    expect(deliveryAdapterFor({ route: 'fake' })?.route).toBe('fake')
    expect(deliveryAdapterFor({ route: 'connect' })).toBeNull()
    __resetDeliveryAdaptersForTests()
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    expect(deliveryAdapterFor({ route: 'connect' })?.route).toBe('connect')
  })

  it('keeps an adapter registered earlier', () => {
    const double = { ...createFakeDeliveryAdapter(), route: 'connect' as const }
    registerDeliveryAdapter(double)
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    expect(deliveryAdapterFor({ route: 'connect' })).toBe(double)
  })
})
