import type { InitialSetupPath } from '@/types'

/**
 * The done-screen branch question ("Var fanns bokföringen innan?"): the one
 * routing decision made at peak motivation, right after the company exists.
 * Providers deep-link into the migration wizard; the SIE file goes straight
 * to the upload step; a new business skips the import entirely and starts
 * on Hem where the checklist points at the bank next.
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

export const BRANCH_PROVIDERS: { id: BranchChoice; name: string; logo: string }[] = [
  { id: 'fortnox', name: 'Fortnox', logo: '/logos/fortnox.svg' },
  { id: 'visma', name: 'Visma', logo: '/logos/visma.jpeg' },
  { id: 'bokio', name: 'Bokio', logo: '/logos/bokio.png' },
  { id: 'bjornlunden', name: 'Björn Lundén', logo: '/logos/bjornlunden.png' },
  { id: 'briox', name: 'Briox', logo: '/logos/Briox_logo.png' },
]

export function branchDestination(choice: BranchChoice): {
  /** initial_setup_path to persist; null = persist nothing (pure skip). */
  path: InitialSetupPath | null
  href: string
} {
  switch (choice) {
    case 'fortnox':
    case 'visma':
    case 'bokio':
    case 'bjornlunden':
    case 'briox':
      return { path: 'migration', href: `/import?mode=migration&provider=${choice}` }
    case 'sie':
      return { path: 'migration', href: '/import?mode=sie' }
    case 'fresh':
      return { path: 'fresh', href: '/' }
    case 'skip':
      return { path: null, href: '/' }
  }
}
