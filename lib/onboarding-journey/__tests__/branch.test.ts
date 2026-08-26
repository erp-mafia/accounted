import { describe, expect, it } from 'vitest'
import { BRANCH_PROVIDERS, branchDestination, type BranchChoice } from '../branch'

describe('branchDestination', () => {
  it.each(['fortnox', 'visma', 'bokio', 'bjornlunden', 'briox'] as const)(
    'routes %s into the migration wizard with the provider preselected',
    (provider) => {
      expect(branchDestination(provider)).toEqual({
        path: 'migration',
        href: `/import?mode=migration&provider=${provider}`,
      })
    }
  )

  it('routes the SIE file straight to the upload step', () => {
    expect(branchDestination('sie')).toEqual({ path: 'migration', href: '/import?mode=sie' })
  })

  it('marks a new business as fresh and lands on Hem', () => {
    expect(branchDestination('fresh')).toEqual({ path: 'fresh', href: '/' })
  })

  it('persists nothing on a pure skip', () => {
    expect(branchDestination('skip')).toEqual({ path: null, href: '/' })
  })

  it('keeps provider chips aligned with the routable choices', () => {
    const choices = new Set<BranchChoice>(BRANCH_PROVIDERS.map((p) => p.id))
    for (const id of choices) {
      expect(branchDestination(id).path).toBe('migration')
    }
    // Every provider entry carries a real logo path under /logos/.
    for (const p of BRANCH_PROVIDERS) {
      expect(p.logo.startsWith('/logos/')).toBe(true)
    }
  })
})
