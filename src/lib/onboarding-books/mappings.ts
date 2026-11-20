import { isValidBASRange } from '@/lib/import/account-mapper'
import type { AccountMapping, SIEAccount } from '@/lib/import/types'

/** The fields this needs: the SIE job's mapping, or the provider flow's mirror of it. */
type Mapping = Pick<AccountMapping, 'sourceAccount' | 'sourceName' | 'targetAccount' | 'targetName' | 'confidence' | 'isOverride'> & { matchType: string }

export interface OnboardingMappings<M extends Mapping> {
  /** The mappings to submit: the server's, plus each created account mapped onto itself. */
  mappings: M[]
  /** Source accounts in 1000-8999 the chart lacks: created before the import. */
  create: SIEAccount[]
  /** Source accounts no target was found for and none can be created (class 0 or 9, not four digits). */
  unresolved: string[]
}

/**
 * What the onboarding books flow, which has no mapping page, does with the
 * server's mapping decision (suggestSIEMappings).
 *
 * The server has already sent class 9 amounts to 2999 and kept unused
 * definitions under their own number. A target it left blank is either a
 * 1000-8999 account the chart lacks, which the flow creates and maps onto
 * itself, or an account the ledger cannot carry. The second kind must stay
 * unresolved: mapped onto itself it became a 9xxx target the job's class
 * check refused one call later, on every retry (#3312).
 */
export function resolveOnboardingMappings<M extends Mapping>(
  mappings: M[],
  accounts: SIEAccount[] = [],
): OnboardingMappings<M> {
  const names = new Map(accounts.map((account) => [account.number, account.name]))
  const create: SIEAccount[] = []
  const unresolved: string[] = []
  const resolved = mappings.map((mapping): M => {
    if (mapping.targetAccount) return mapping
    if (!isValidBASRange(mapping.sourceAccount)) {
      unresolved.push(mapping.sourceAccount)
      return mapping
    }
    create.push({ number: mapping.sourceAccount, name: names.get(mapping.sourceAccount) ?? mapping.sourceName })
    return {
      ...mapping,
      targetAccount: mapping.sourceAccount,
      targetName: mapping.sourceName,
      matchType: 'exact',
      confidence: 1,
      isOverride: true,
    } as M
  })
  return { mappings: resolved, create, unresolved }
}
