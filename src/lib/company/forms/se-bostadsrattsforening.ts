import type { LegalFormProfile } from './types'
import { SE_EKONOMISK_FORENING } from './se-ekonomisk-forening'

/**
 * Bostadsrättsförening: an ekonomisk förening whose purpose is to grant its
 * members bostadsrätt (BRL 1 kap. 2 §), so the profile starts from the
 * ekonomisk förening's and states only what differs. Members, not owners;
 * the result closes to 2099 and carries to 2098; bundet eget kapital is the
 * members' insatser (2083) and the fond för yttre underhåll (2088), its own
 * post moved only by omföring (K3 38.14-38.15).
 *
 * K3 is the only framework for financial years starting after 2025-12-31
 * (BFNAR 2025:2, 1.1A e; K3 kapitel 38). The årsredovisning always holds a
 * kassaflödesanalys (ÅRL 2 kap. 1 § andra stycket) and the key ratios of
 * ÅRL 6 kap. 3 a § for four years; a revisor is required as in every
 * ekonomisk förening; filing is on paper.
 *
 * What the product does not model yet, and so answers conservatively:
 * - The income return. A privatbostadsföretag (äkta förening, IL 2 kap.
 *   17 §) is not taxed on its property income (IL 39 kap. 25 §), so the
 *   INK2 the product builds from the whole result would be wrong:
 *   `incomeReturn` is null and the year-end books no tax and proposes no
 *   periodiseringsfond. An oäkta förening is taxed like an ekonomisk
 *   förening; that branch waits for the äkta/oäkta profile.
 * - Upplåtelseavgifter have no BAS account and are not seeded.
 *
 * Behind NEXT_PUBLIC_BOSTADSRATTSFORENING_ENABLED (default off) until the
 * surfaces in docs/LEGAL-FORMS.md "What supported means" are green.
 */
export const SE_BOSTADSRATTSFORENING: LegalFormProfile = {
  ...SE_EKONOMISK_FORENING,
  code: 'bostadsrattsforening',
  label: 'Bostadsrättsförening',
  creationFlag: 'NEXT_PUBLIC_BOSTADSRATTSFORENING_ENABLED',
  equity: { ...SE_EKONOMISK_FORENING.equity, maintenanceFund: '2088' },
  filings: {
    ...SE_EKONOMISK_FORENING.filings,
    incomeReturn: null,
    booksCurrentTax: false,
    corporateTaxDispositions: false,
    frameworks: ['K3'],
    cashFlowStatement: 'always',
    housingKeyRatios: true,
  },
}
