import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { collectionsFeatures, providerProfile } from '../../../../packages/connect-contract/src/__tests__/fixtures'
import { buildCollectionsAvailability, getCollectionsAvailability } from '../availability'
import { NO_COLLECTION_OBLIGATIONS, readCollectionsEnv, type CollectionsGateFacts } from '../flags'

const COMPANY = 'company-1'
const supabase = {} as SupabaseClient
const ON = readCollectionsEnv({ COLLECTIONS_ENABLED: '1', COLLECTIONS_PILOT_COMPANIES: COMPANY })
const ENTRY = { provider: providerProfile, features: collectionsFeatures }

function facts(overrides: Partial<CollectionsGateFacts> = {}): CollectionsGateFacts {
  return { companyId: COMPANY, capability: true, connection: null, obligations: NO_COLLECTION_OBLIGATIONS, ...overrides }
}

const ACTIVE = {
  route: 'connect' as const,
  state: 'active' as const,
  subStatus: null,
  health: 'ok' as const,
  distributionEnabled: false,
  ladderMode: null,
  displayName: 'Persisted Name',
}

describe('buildCollectionsAvailability', () => {
  it('reports everything off on a dark installation', () => {
    const a = buildCollectionsAvailability({ env: readCollectionsEnv({}), facts: facts({ capability: false }), sandbox: false, provider: null })
    expect(a).toMatchObject({ enabled: false, pilot: false, capability: false, obligations: false, start: 'hidden', connection: null, provider: null, displayName: null })
  })

  it('names the provider from the catalogue first', () => {
    const a = buildCollectionsAvailability({ env: ON, facts: facts({ connection: ACTIVE }), sandbox: false, provider: ENTRY })
    expect(a.displayName).toBe('Acme Inkasso')
    expect(a.provider).toEqual({
      displayName: 'Acme Inkasso',
      termsUrl: providerProfile.termsUrl,
      feeSummarySv: providerProfile.feeSummarySv,
      portalUrl: providerProfile.portalUrl,
      features: collectionsFeatures,
    })
    expect(a.start).toBe('ready')
  })

  it('falls back to the name persisted on the connection when the catalogue is down', () => {
    const a = buildCollectionsAvailability({ env: ON, facts: facts({ connection: ACTIVE }), sandbox: false, provider: null })
    expect(a.provider).toBeNull()
    expect(a.displayName).toBe('Persisted Name')
    expect(a.connection).toEqual({ state: 'active', subStatus: null, health: 'ok', distributionEnabled: false, ladderMode: null, displayName: 'Persisted Name' })
  })

  it('keeps showing an open case with every start gate closed', () => {
    const a = buildCollectionsAvailability({
      env: readCollectionsEnv({}),
      facts: facts({ capability: false, connection: ACTIVE, obligations: { ...NO_COLLECTION_OBLIGATIONS, openCases: 1 } }),
      sandbox: false,
      provider: null,
    })
    expect(a).toMatchObject({ start: 'hidden', obligations: true, displayName: 'Persisted Name' })
  })
})

describe('getCollectionsAvailability', () => {
  it('makes no Connect call on a dark installation', async () => {
    vi.stubEnv('GNUBOK_CONNECTOR_KEY', 'gnubok_ck_x')
    const fetchMock = vi.fn()
    const a = await getCollectionsAvailability(supabase, COMPANY, {
      env: readCollectionsEnv({}),
      loadFacts: async () => facts(),
      isSandbox: async () => false,
      fetch: fetchMock,
    })
    expect(a.start).toBe('hidden')
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllEnvs()
  })

  it('shows the fake provider to a sandbox company', async () => {
    const a = await getCollectionsAvailability(supabase, COMPANY, {
      env: ON,
      loadFacts: async () => facts(),
      isSandbox: async () => true,
    })
    expect(a).toMatchObject({ sandbox: true, start: 'activate', displayName: 'Acme Inkasso' })
  })
})
