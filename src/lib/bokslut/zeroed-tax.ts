import type { BolagsskattBasis, DispositionKind } from './types'

/**
 * Dispositions the company may skip: överavskrivningar (IL 18 kap.) and the
 * avsättning to periodiseringsfond (IL 30 kap.) are maximums, not duties. An
 * återföring can be mandatory (the sixth year) and SLP is a tax owed on
 * pension costs, so neither is a way to pay bolagsskatt this year instead.
 */
export const OPTIONAL_DISPOSITIONS: ReadonlySet<DispositionKind> = new Set<DispositionKind>([
  'overavskrivningar',
  'periodiseringsfond_avsattning',
])

export interface ZeroedTaxExplanation {
  /** The proposals that take the tax to 0 kr, each with what it takes off the result. */
  zeroedBy: BolagsskattBasis['zeroedBy']
  /**
   * The tax with none of the pending proposals booked, or null when one of
   * them is not optional: the ledger's figure then is not what skipping the
   * optional ones gives.
   */
  taxWithout: number | null
  /** True when at least one of them is optional, so skipping it is a way to pay tax this year. */
  canSkip: boolean
}

/**
 * Why the previewed bolagsskatt is 0 kr when the ledger as it stands carries
 * tax (accounted#180), or null when no proposal is what zeroes it. Read by the
 * 0 kr card's description on the server and by the wizard, so both say the
 * same thing.
 */
export function explainZeroedTax(basis: BolagsskattBasis | undefined): ZeroedTaxExplanation | null {
  if (!basis || basis.zeroedBy.length === 0) return null
  return {
    zeroedBy: basis.zeroedBy,
    taxWithout: basis.pending.every((p) => OPTIONAL_DISPOSITIONS.has(p.kind)) ? basis.taxAsBooked : null,
    canSkip: basis.zeroedBy.some((p) => OPTIONAL_DISPOSITIONS.has(p.kind)),
  }
}
