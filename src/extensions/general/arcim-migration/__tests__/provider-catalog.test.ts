import { describe, it, expect } from 'vitest'
import { MIGRATION_PROVIDERS, MIGRATION_PROVIDER_IDS } from '@/lib/providers/catalog'
import { ARCIM_PROVIDERS } from '../types'

describe('migration provider catalog', () => {
  it('is the one list the migration extension reads', () => {
    expect(ARCIM_PROVIDERS).toBe(MIGRATION_PROVIDERS)
  })

  it('names each provider once, with its auth and whether SIE comes over the API', () => {
    expect(MIGRATION_PROVIDER_IDS).toEqual(['fortnox', 'visma', 'bokio', 'bjornlunden', 'briox', 'wint'])
    expect(new Set(MIGRATION_PROVIDER_IDS).size).toBe(MIGRATION_PROVIDER_IDS.length)
    // The workspace's two copies disagreed on Visma's name; the label users saw stays.
    expect(MIGRATION_PROVIDERS.find((p) => p.id === 'visma')).toEqual({ id: 'visma', name: 'Visma', authType: 'oauth', sieViaApi: false })
    expect(MIGRATION_PROVIDERS.filter((p) => p.sieViaApi).map((p) => p.id)).toEqual(['fortnox', 'bokio', 'bjornlunden', 'briox', 'wint'])
  })
})
