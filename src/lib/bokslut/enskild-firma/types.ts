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

/**
 * NE-bilaga sida 2 (SKV 2161) as the preview fills it, whole kronor, one
 * definition per ruta. The sums follow the form: R29 = R12 + R13..R28,
 * R33 = R29 - R30 + R31 + R32, R35 = R33 - R34,
 * R42 = R35 - R36 + R37 - R38 - R39 + R40 - R41. R12-R28 and R38-R39 are
 * not computed, so R29 is the booked result (R11) and R38-R39 are 0.
 */
export interface EfNeRutor {
  R29: number
  R30: number
  R31: number
  R32: number
  R33: number
  R34: number
  R35: number
  R36: number
  R37: number
  R40: number
  R41: number
  R42: number
  R43: number
}

/**
 * A field under "Övriga uppgifter" on NE-bilagan. Named by its SRU fältkod,
 * which is the same in the 2025P4 and 2026P4 packages, while the punkt
 * number on the form shifts between years.
 */
export interface EfOvrigUppgift {
  faltkod: '8009' | '8010' | '8011' | '8012'
  label: string
  amount: number
}
