import type { VatDeclarationRutor } from '@/types'

/** A period whose declaration has no amount in any ruta: nothing to book or pay. */
export function isNilVatDeclaration(rutor: VatDeclarationRutor): boolean {
  return Object.values(rutor).every((value) => !value)
}

/**
 * The step the moms page opens on. Presentation only: every step stays
 * reachable from the stepper whatever this returns.
 *
 * - 1 (Kontrollera) while a check blocks filing, and for a period with no
 *   amount in any ruta: opening that on Granska put "Nästa: Bokför momsen"
 *   in front of someone with nothing to book.
 * - 2 (Granska) otherwise.
 */
export function vatLandingStep(input: { checksBlocked: boolean; rutor: VatDeclarationRutor }): 1 | 2 {
  return input.checksBlocked || isNilVatDeclaration(input.rutor) ? 1 : 2
}
