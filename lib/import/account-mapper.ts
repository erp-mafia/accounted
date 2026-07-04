/**
 * Account Mapping Engine
 *
 * Maps accounts from an imported SIE file to the user's BAS chart of accounts.
 * Uses exact account number matching against the BAS reference, with a fallback
 * for valid BAS-range sub-accounts (1000-8999) not in the reference.
 * This aligns with Swedish industry standard (e.g. Fortnox): exact match,
 * create new, or let the user map manually.
 */

import type {
  SIEAccount,
  AccountMapping,
  AccountMatchType,
  SIEAccountMappingRecord,
} from './types'

/**
 * Minimal account shape needed for mapping.
 * Both BASAccount (from user chart) and BASReferenceAccount (from reference data)
 * satisfy this interface.
 */
export type MappableAccount = {
  account_number: string
  account_name: string
}

// Group header accounts that should redirect to their posting sub-account.
// These are BAS group headers not meant for direct posting.
const GROUP_HEADER_REDIRECTS: Record<string, string> = {
  '2640': '2641', // Ingående moms → Debiterad ingående moms
}

/**
 * Check if an account is a source-system internal account that should be
 * excluded from import. BAS accounts use classes 1-8 (1000-8999). Account
 * numbers starting with 0 (e.g. Fortnox 0099) are internal system accounts
 * with no BAS equivalent: they should be silently filtered out rather than
 * forcing the user to map them.
 */
export function isSystemAccount(accountNumber: string): boolean {
  if (!/^\d{4}$/.test(accountNumber)) return false
  const num = parseInt(accountNumber, 10)
  return num < 1000
}

/**
 * Check if an account number is in the valid BAS range (1000-8999).
 * Standard Swedish BAS accounts are 4-digit numbers in classes 1-8.
 */
function isValidBASRange(accountNumber: string): boolean {
  if (!/^\d{4}$/.test(accountNumber)) return false
  const num = parseInt(accountNumber, 10)
  return num >= 1000 && num <= 8999
}

/**
 * Find the best matching BAS account for a source account.
 * First tries exact match against the reference, then falls back to
 * self-mapping for valid BAS-range accounts not in the reference
 * (common for sub-accounts like 1241 Personbilar under 1240).
 */
function findBestMatch(
  source: SIEAccount,
  basAccounts: MappableAccount[],
  existingOverride?: AccountMapping
): AccountMapping | null {
  // If there's a user override, use it
  if (existingOverride) {
    return {
      ...existingOverride,
      isOverride: true,
    }
  }

  // Exact account number match against reference
  const exactMatch = basAccounts.find(
    (target) => source.number === target.account_number
  )

  if (exactMatch) {
    // Redirect group header accounts to their posting sub-account
    const redirect = GROUP_HEADER_REDIRECTS[exactMatch.account_number]
    if (redirect) {
      const redirectTarget = basAccounts.find((a) => a.account_number === redirect)
      if (redirectTarget) {
        return {
          sourceAccount: source.number,
          sourceName: source.name,
          targetAccount: redirectTarget.account_number,
          targetName: redirectTarget.account_name,
          confidence: 1.0,
          matchType: 'exact',
          isOverride: false,
        }
      }
    }

    return {
      sourceAccount: source.number,
      sourceName: source.name,
      targetAccount: exactMatch.account_number,
      targetName: exactMatch.account_name,
      confidence: 1.0,
      matchType: 'exact',
      isOverride: false,
    }
  }

  // Fallback: if the account is a valid BAS-range number (1000-8999),
  // self-map it using the name from the SIE file. These are standard
  // BAS sub-accounts not in our reference (e.g. 1241 Personbilar).
  if (isValidBASRange(source.number) && source.name) {
    return {
      sourceAccount: source.number,
      sourceName: source.name,
      targetAccount: source.number,
      targetName: source.name,
      confidence: 0.7,
      matchType: 'bas_range',
      isOverride: false,
    }
  }

  // No match found
  return null
}

/**
 * Suggest mappings for all source accounts
 */
export function suggestMappings(
  sourceAccounts: SIEAccount[],
  basAccounts: MappableAccount[],
  existingMappings?: SIEAccountMappingRecord[]
): AccountMapping[] {
  // Convert existing mappings to a lookup map
  const overrideMap = new Map<string, AccountMapping>()
  if (existingMappings) {
    for (const mapping of existingMappings) {
      const basAccount = basAccounts.find((a) => a.account_number === mapping.target_account)
      overrideMap.set(mapping.source_account, {
        sourceAccount: mapping.source_account,
        sourceName: mapping.source_name || '',
        targetAccount: mapping.target_account,
        targetName: basAccount?.account_name || mapping.target_account,
        confidence: mapping.confidence,
        matchType: mapping.match_type,
        isOverride: true,
      })
    }
  }

  const mappings: AccountMapping[] = []

  for (const source of sourceAccounts) {
    const existingOverride = overrideMap.get(source.number)
    const mapping = findBestMatch(source, basAccounts, existingOverride)

    if (mapping) {
      mappings.push(mapping)
    } else {
      // No match found - add with null target
      mappings.push({
        sourceAccount: source.number,
        sourceName: source.name,
        targetAccount: '',
        targetName: '',
        confidence: 0,
        matchType: 'manual',
        isOverride: false,
      })
    }
  }

  // Sort by confidence (low to high) so users see problematic mappings first
  mappings.sort((a, b) => a.confidence - b.confidence)

  return mappings
}

/**
 * Validate that all accounts are mapped
 */
export function validateMappings(mappings: AccountMapping[]): {
  valid: boolean
  unmappedAccounts: string[]
  lowConfidenceAccounts: string[]
} {
  const unmapped = mappings.filter((m) => !m.targetAccount)
  const lowConfidence = mappings.filter((m) => m.targetAccount && m.confidence < 0.5)

  return {
    valid: unmapped.length === 0,
    unmappedAccounts: unmapped.map((m) => m.sourceAccount),
    lowConfidenceAccounts: lowConfidence.map((m) => m.sourceAccount),
  }
}

/**
 * Get mapping statistics
 */
export function getMappingStats(mappings: AccountMapping[]): {
  total: number
  mapped: number
  unmapped: number
  exact: number
  basRange: number
  name: number
  class: number
  manual: number
  lowConfidence: number
  averageConfidence: number
} {
  const total = mappings.length
  const mapped = mappings.filter((m) => m.targetAccount).length
  const unmapped = total - mapped

  const exact = mappings.filter((m) => m.matchType === 'exact').length
  const basRange = mappings.filter((m) => m.matchType === 'bas_range').length
  const name = mappings.filter((m) => m.matchType === 'name').length
  const classMatch = mappings.filter((m) => m.matchType === 'class').length
  const manual = mappings.filter((m) => m.matchType === 'manual').length

  const lowConfidence = mappings.filter((m) => m.targetAccount && m.confidence < 0.5).length

  const confidenceSum = mappings
    .filter((m) => m.targetAccount)
    .reduce((sum, m) => sum + m.confidence, 0)
  const averageConfidence = mapped > 0 ? confidenceSum / mapped : 0

  return {
    total,
    mapped,
    unmapped,
    exact,
    basRange,
    name,
    class: classMatch,
    manual,
    lowConfidence,
    averageConfidence,
  }
}

/**
 * Apply a user override to the mappings
 */
export function applyMappingOverride(
  mappings: AccountMapping[],
  sourceAccount: string,
  targetAccount: string,
  targetName: string
): AccountMapping[] {
  return mappings.map((m) => {
    if (m.sourceAccount === sourceAccount) {
      return {
        ...m,
        targetAccount,
        targetName,
        confidence: 1.0,
        matchType: 'manual' as AccountMatchType,
        isOverride: true,
      }
    }
    return m
  })
}

/**
 * Convert mappings to a lookup map for quick access during import
 */
export function mappingsToMap(mappings: AccountMapping[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const mapping of mappings) {
    if (mapping.targetAccount) {
      map.set(mapping.sourceAccount, mapping.targetAccount)
    }
  }
  return map
}
