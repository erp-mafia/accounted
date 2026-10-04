import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { CONTRACT_VERSION } from '@accounted/connect-contract'
import { catalogueResponse, collectionsFeatures, providerProfile } from '../../../../packages/connect-contract/src/__tests__/fixtures'
import { FAKE_PROVIDER_PROFILE } from '../adapters/fake'
import {
  __resetCatalogueCacheForTests,
  CATALOGUE_FAILURE_TTL_MS,
  CATALOGUE_TTL_MS,
  getCollectionsProvider,
  getConnectCatalogue,
  getDeliveryProvider,
  parseCatalogueEntries,
} from '../catalogue'

function okFetch(body: unknown = catalogueResponse) {
  return vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 200 }))
}

beforeEach(() => {
  __resetCatalogueCacheForTests()
  vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
  vi.stubEnv('GNUBOK_CONNECT_URL', 'https://connect.example.se')
})
afterEach(() => {
  vi.unstubAllEnvs()
  __resetCatalogueCacheForTests()
})

describe('parseCatalogueEntries', () => {
  it('keeps the first valid entry per known capability and skips unknown or broken ones', () => {
    const parsed = parseCatalogueEntries([
      { capability: 'payroll', provider: providerProfile, features: {} },
      { capability: 'collections', provider: providerProfile, features: { startSteps: 'nope' } },
      { capability: 'collections', provider: { ...providerProfile, displayName: 'Second' }, features: { ...collectionsFeatures } },
      { capability: 'collections', provider: { ...providerProfile, displayName: 'Third' }, features: { ...collectionsFeatures } },
    ])
    expect(parsed.collections?.provider.displayName).toBe('Second')
    expect(parsed.delivery).toBeNull()
  })
})

describe('getConnectCatalogue', () => {
  it('reads the catalogue with the connector key and the contract version', async () => {
    const fetchMock = okFetch()
    const catalogue = await getConnectCatalogue({ fetch: fetchMock })
    expect(catalogue?.collections?.provider.displayName).toBe('Acme Inkasso')
    expect(catalogue?.delivery?.features.followUp).toBe('optional')
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('https://connect.example.se/api/connect/catalogue')
    expect(init.method).toBe('GET')
    expect(init.headers).toMatchObject({ Authorization: 'Bearer gnubok_ck_x', 'X-Connect-Contract-Version': CONTRACT_VERSION })
    expect(init.headers['X-Connector-Company']).toBeUndefined()
  })

  it('is null without a connector key, and calls nothing', async () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', '')
    const fetchMock = okFetch()
    expect(await getConnectCatalogue({ fetch: fetchMock })).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('caches a good answer for five minutes', async () => {
    let now = 1_000_000
    const fetchMock = okFetch()
    await getConnectCatalogue({ fetch: fetchMock, now: () => now })
    now += CATALOGUE_TTL_MS - 1
    await getConnectCatalogue({ fetch: fetchMock, now: () => now })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    now += 2
    await getConnectCatalogue({ fetch: fetchMock, now: () => now })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('answers null when Connect is down or answers garbage, and asks again after a minute', async () => {
    let now = 1_000_000
    const down = vi.fn().mockRejectedValue(new TypeError('fetch failed'))
    expect(await getConnectCatalogue({ fetch: down, now: () => now })).toBeNull()
    expect(await getConnectCatalogue({ fetch: down, now: () => now })).toBeNull()
    expect(down).toHaveBeenCalledTimes(1)
    now += CATALOGUE_FAILURE_TTL_MS + 1
    expect(await getConnectCatalogue({ fetch: okFetch({ entries: 'x' }), now: () => now })).toBeNull()
  })

  it('shares one request between concurrent readers', async () => {
    const fetchMock = okFetch()
    await Promise.all([getConnectCatalogue({ fetch: fetchMock }), getConnectCatalogue({ fetch: fetchMock })])
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('provider by route', () => {
  it('answers the fake profile for the fake route without reading Connect', async () => {
    const fetchMock = okFetch()
    expect((await getCollectionsProvider('fake', { fetch: fetchMock }))?.provider).toEqual(FAKE_PROVIDER_PROFILE)
    expect((await getDeliveryProvider('fake', { fetch: fetchMock }))?.features.methods).toEqual(['post', 'kivra', 'einvoice_bank'])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('answers the catalogue entry for the connect route', async () => {
    expect((await getCollectionsProvider('connect', { fetch: okFetch() }))?.provider.ref).toBe('acme-inkasso')
  })
})
