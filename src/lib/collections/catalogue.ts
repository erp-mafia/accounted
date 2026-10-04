import {
  CATALOGUE_FEATURE_SCHEMAS,
  CATALOGUE_OPERATIONS,
  CATALOGUE_PATH,
  type CollectionsFeatures,
  type DeliveryFeatures,
  type ProviderProfile,
} from '@accounted/connect-contract'
import { getConnectorConfig } from '@/lib/connect/instance/config'
import { callConnectorOperation } from '@/lib/connect/instance/connector-fetch'
import { createLogger } from '@/lib/logger'
import { FAKE_COLLECTIONS_FEATURES, FAKE_DELIVERY_FEATURES, FAKE_PROVIDER_PROFILE } from './adapters/fake'
import type { CollectionsRoute } from './port'

const log = createLogger('collections/catalogue')

/**
 * The provider behind each capability, read from Connect's catalogue
 * (GET /api/connect/catalogue). This is where the provider's name, legal
 * identity, terms, data processing terms and fee wording reach the ledger:
 * nothing about the provider is hard-coded here.
 *
 * Cached in memory for 5 minutes per process; a failed read answers null and
 * is retried after a minute. Callers fall back to the name stored on the
 * company's connection row, then to the neutral word (errors.ts
 * providerDisplayName), and never hide an open case because the catalogue is
 * down.
 */

export interface CatalogueCapabilityEntry<F> {
  provider: ProviderProfile
  features: F
}

export interface ConnectCatalogue {
  collections: CatalogueCapabilityEntry<CollectionsFeatures> | null
  delivery: CatalogueCapabilityEntry<DeliveryFeatures> | null
}

export const CATALOGUE_TTL_MS = 5 * 60_000
export const CATALOGUE_FAILURE_TTL_MS = 60_000
/** The catalogue is on the render path of the settings and invoice pages: answer fast or not at all. */
export const CATALOGUE_TIMEOUT_MS = 5_000

let cached: { value: ConnectCatalogue | null; expiresAt: number } | null = null
let inFlight: Promise<ConnectCatalogue | null> | null = null

export interface CatalogueDeps {
  fetch?: typeof fetch
  now?: () => number
}

/** Pick the first valid entry per known capability; skip unknown capabilities and entries that do not parse. */
export function parseCatalogueEntries(entries: readonly { capability: string; provider: ProviderProfile; features: Record<string, unknown> }[]): ConnectCatalogue {
  const result: ConnectCatalogue = { collections: null, delivery: null }
  for (const entry of entries) {
    if (entry.capability === 'collections' && !result.collections) {
      const features = CATALOGUE_FEATURE_SCHEMAS.collections.safeParse(entry.features)
      if (features.success) result.collections = { provider: entry.provider, features: features.data }
    } else if (entry.capability === 'delivery' && !result.delivery) {
      const features = CATALOGUE_FEATURE_SCHEMAS.delivery.safeParse(entry.features)
      if (features.success) result.delivery = { provider: entry.provider, features: features.data }
    }
  }
  return result
}

async function fetchCatalogue(deps: CatalogueDeps): Promise<ConnectCatalogue | null> {
  const config = getConnectorConfig()
  if (!config) return null
  try {
    const response = await callConnectorOperation({
      upstream: { baseUrl: `${config.baseUrl}${CATALOGUE_PATH}`, key: config.key },
      operation: 'catalogue.list',
      def: CATALOGUE_OPERATIONS.list,
      body: null,
      timeoutMs: CATALOGUE_TIMEOUT_MS,
      fetch: deps.fetch,
    })
    return parseCatalogueEntries(response.entries)
  } catch (error) {
    log.warn('connect catalogue unavailable', {
      code: (error as { code?: string }).code ?? null,
      message: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/** The whole catalogue for this installation's key, or null when there is no key or Connect does not answer. */
export async function getConnectCatalogue(deps: CatalogueDeps = {}): Promise<ConnectCatalogue | null> {
  const now = deps.now ?? Date.now
  if (cached && cached.expiresAt > now()) return cached.value
  if (!inFlight) {
    inFlight = fetchCatalogue(deps)
      .then((value) => {
        cached = { value, expiresAt: now() + (value ? CATALOGUE_TTL_MS : CATALOGUE_FAILURE_TTL_MS) }
        return value
      })
      .finally(() => {
        inFlight = null
      })
  }
  return inFlight
}

/**
 * The collections provider for a connection route: the fake's own profile for
 * route 'fake' (sandbox and local development never read Connect), the
 * catalogue's collections entry otherwise.
 */
export async function getCollectionsProvider(
  route: CollectionsRoute = 'connect',
  deps: CatalogueDeps = {},
): Promise<CatalogueCapabilityEntry<CollectionsFeatures> | null> {
  if (route === 'fake') return { provider: FAKE_PROVIDER_PROFILE, features: FAKE_COLLECTIONS_FEATURES }
  return (await getConnectCatalogue(deps))?.collections ?? null
}

/** Same for delivery. */
export async function getDeliveryProvider(
  route: CollectionsRoute = 'connect',
  deps: CatalogueDeps = {},
): Promise<CatalogueCapabilityEntry<DeliveryFeatures> | null> {
  if (route === 'fake') return { provider: FAKE_PROVIDER_PROFILE, features: FAKE_DELIVERY_FEATURES }
  return (await getConnectCatalogue(deps))?.delivery ?? null
}

/** Test seam: drop the cached catalogue. */
export function __resetCatalogueCacheForTests(): void {
  cached = null
  inFlight = null
}
