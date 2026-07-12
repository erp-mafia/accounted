/**
 * EF tax mechanisms are declaration-only: they NEVER produce journal
 * entries. The shapes here are intentionally distinct from the AB
 * `ProposedDisposition` to make the booking distinction visible at the
 * type level: every EF calculator returns an `EfDeclarationItem` and the
 * UI / NE-bilaga consumes them, but the bokkeeping engine never sees them.
 */
export type EfDeclarationKind =
  | 'egenavgifter'
  | 'rantefordelning_positive'
  | 'rantefordelning_negative'
  | 'periodiseringsfond_avsattning'
  | 'periodiseringsfond_ateforing'
  | 'expansionsfond_avsattning'
  | 'expansionsfond_ateforing'

export interface EfDeclarationItem {
  kind: EfDeclarationKind
  /** Short Swedish label for UI cards. */
  label: string
  /** One-sentence Swedish explanation. */
  description: string
  /** SEK amount displayed. Always positive. */
  amount: number
  /** NE-bilaga ruta this affects (e.g. "R30", "R34", "R43"). Surfaced so
   *  users know where the number lands when they file. */
  ne_ruta: string
  /** Calculator-specific breakdown for the "Visa beräkning" panel. */
  computation: Record<string, unknown>
  /** Soft warnings. Never blockers. */
  warnings: string[]
}
