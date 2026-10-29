/**
 * Where the books were kept before ("Var fanns bokföringen innan?"): the
 * accounting providers the onboarding books steps offer, with their logos.
 */
export type BranchChoice =
  | 'fortnox'
  | 'visma'
  | 'bokio'
  | 'bjornlunden'
  | 'briox'
  | 'sie'
  | 'fresh'
  | 'skip'

/** Visma has no logo on purpose (founder, 2026-10-29): it shows by name with a letter mark. */
export const BRANCH_PROVIDERS: { id: BranchChoice; name: string; logo?: string; mark?: string }[] = [
  { id: 'fortnox', name: 'Fortnox', logo: '/logos/fortnox.svg' },
  { id: 'visma', name: 'Visma', mark: 'V' },
  { id: 'bokio', name: 'Bokio', logo: '/logos/bokio.png' },
  { id: 'bjornlunden', name: 'Björn Lundén', logo: '/logos/bjornlunden.png' },
  { id: 'briox', name: 'Briox', logo: '/logos/Briox_logo.png' },
]
