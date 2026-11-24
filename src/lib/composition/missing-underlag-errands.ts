/**
 * The receipt hunt's answer to the ledger's "of these verifikat without an
 * underlag, what does each one need?" (contract:
 * lib/reports/missing-underlag-errands.ts). Written out by hand and imported
 * statically by the ledger: no lazy loading, no lib/init, no event bus.
 *
 * One answer, the receipt hunt's errand per verifikat, called with exactly
 * the arguments the ledger passes.
 */
import type { MissingUnderlagErrands } from '@/lib/reports/missing-underlag-errands'
import { VERIFIKAT_WINDOW, verifikatNextStepKinds } from '@/lib/receipt-hunt/agent-worklist'

export const MISSING_UNDERLAG_ERRANDS: MissingUnderlagErrands = Object.freeze<MissingUnderlagErrands>({
  module: 'inbox',
  maxRows: VERIFIKAT_WINDOW,
  kinds: (...args) => verifikatNextStepKinds(...args),
})
