import { describe, expect, it } from 'vitest'
import { customerExclusionOffered, customerExclusionPath } from '../customer-exclusion'
import {
  collectionsGate,
  collectionsStartState,
  NO_COLLECTION_OBLIGATIONS,
  readCollectionsEnv,
  type CollectionsConnectionFacts,
  type CollectionsEnv,
  type CollectionsGateFacts,
} from '../flags'

const COMPANY = '11111111-1111-4111-8111-111111111111'

function connection(overrides: Partial<CollectionsConnectionFacts> = {}): CollectionsConnectionFacts {
  return { route: 'connect', state: 'active', subStatus: null, health: 'ok', distributionEnabled: false, ladderMode: 'off', displayName: 'Acme Inkasso', ...overrides }
}

function facts(overrides: Partial<CollectionsGateFacts> = {}): CollectionsGateFacts {
  return { companyId: COMPANY, capability: true, sandbox: false, connection: null, obligations: NO_COLLECTION_OBLIGATIONS, ...overrides }
}

const on = (overrides: Partial<CollectionsEnv> = {}): CollectionsEnv => ({ ...readCollectionsEnv({ COLLECTIONS_ENABLED: '1', COLLECTIONS_PILOT_COMPANIES: COMPANY }), ...overrides })

describe('customerExclusionOffered', () => {
  it('shows the flag while collections is offered, connected or not', () => {
    expect(customerExclusionOffered('activate')).toBe(true)
    expect(customerExclusionOffered('ready')).toBe(true)
    expect(customerExclusionOffered('hidden')).toBe(false)
    expect(customerExclusionOffered('upgrade')).toBe(false)
    expect(customerExclusionOffered(null)).toBe(false)
    expect(customerExclusionOffered(undefined)).toBe(false)
  })

  it('agrees with the route gate (the customer_exclusion start path) in every state', () => {
    const envs = [readCollectionsEnv({}), on(), on({ pilot: new Set(['other']) }), on({ ladderEnabled: true })]
    const factsList = [
      facts(),
      facts({ capability: false }),
      facts({ connection: connection() }),
      facts({ connection: connection({ state: 'needs_setup' }) }),
      facts({ capability: false, sandbox: true, connection: connection({ route: 'fake' }) }),
    ]
    for (const env of envs) {
      for (const f of factsList) {
        expect(collectionsGate('customer_exclusion', f, env).allowed).toBe(customerExclusionOffered(collectionsStartState(f, env)))
      }
    }
  })
})

describe('customerExclusionPath', () => {
  it('is the session route', () => {
    expect(customerExclusionPath('abc')).toBe('/api/customers/abc/collections-exclusion')
  })
})
