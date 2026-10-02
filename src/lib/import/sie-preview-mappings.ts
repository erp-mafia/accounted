import { isAccountNumber } from '@/lib/invariants/account-number'
import { isSystemAccount, isValidBASRange, suggestMappings, type MappableAccount } from './account-mapper'
import type { AccountMapping, ParsedSIEFile, SIEAccount, SIEAccountMappingRecord } from './types'

/** BAS 2999 OBS-konto: where a source system's class 9 observation postings land. */
const OBS_ACCOUNT = '2999'
const OBS_ACCOUNT_NAME = 'OBS-konto'
const isClass9Account = (account: string) => /^9\d{3}$/.test(account)

/**
 * The one mapping decision every SIE entry runs: the file upload
 * (/api/import/sie/parse), the provider fetch (arcim-migration /sie-data),
 * execute without supplied mappings, the v1 API and the MCP preflight.
 *
 * Stored mappings and the target list only suggest. The file's own usage then
 * decides, so a class 9 account carrying amounts lands on 2999 even when a
 * previous import stored a 9xxx target for it or the company's chart already
 * holds that 9xxx row. Only the upload ran this second half before (#3312):
 * every provider fetch rebuilt the 9xxx target the job's class check refuses.
 *
 * `accounts` narrows which source accounts get a mapping (a caller that
 * filters out system accounts); usage is always read from the whole parse.
 */
export function suggestSIEMappings(parsed: ParsedSIEFile, targets: MappableAccount[],
  stored?: SIEAccountMappingRecord[], accounts: SIEAccount[] = parsed.accounts) {
  return prepareSIEPreviewMappings(parsed, suggestMappings(accounts, targets, stored))
}

/**
 * The class 9 source accounts the rule below sent to 2999 OBS-konto. A flow
 * with a mapping page shows them there for review; a flow without one names
 * them. A 2999 target chosen by hand (matchType 'manual') is not listed.
 */
export function obsAccountsOf(
  mappings: ReadonlyArray<Pick<AccountMapping, 'sourceAccount' | 'targetAccount'> & { matchType: string }>,
): string[] {
  const accounts = new Set<string>()
  for (const mapping of mappings) {
    if (mapping.targetAccount === OBS_ACCOUNT && mapping.matchType === 'class' && isClass9Account(mapping.sourceAccount)) {
      accounts.add(mapping.sourceAccount)
    }
  }
  return [...accounts].sort()
}

/** Preview evidence only. Execution revalidates the original file independently. */
export function prepareSIEPreviewMappings(parsed: ParsedSIEFile, suggested: AccountMapping[]) {
  const referenced = new Set<string>()
  const financial = new Set<string>()
  for (const voucher of parsed.vouchers) {
    for (const line of voucher.lines) {
      referenced.add(line.account)
      if (line.amount !== 0) financial.add(line.account)
    }
    for (const line of voucher.corrections?.struck ?? []) referenced.add(line.account)
    for (const line of voucher.corrections?.added ?? []) referenced.add(line.account)
  }
  for (const balance of [...parsed.openingBalances, ...parsed.closingBalances, ...parsed.resultBalances]) {
    referenced.add(balance.account)
    if (balance.amount !== 0) financial.add(balance.account)
  }
  for (const issue of parsed.issues) if (issue.account) referenced.add(issue.account)

  const archivedOnlyAccounts: SIEAccount[] = []
  const excludedSystemAccounts: SIEAccount[] = []
  for (const account of parsed.accounts) {
    if (referenced.has(account.number)) continue
    if (!isAccountNumber(account.number)) archivedOnlyAccounts.push(account)
    else if (isSystemAccount(account.number)) excludedSystemAccounts.push(account)
  }
  const excluded = new Set([...archivedOnlyAccounts, ...excludedSystemAccounts].map(a => a.number))
  const mappings = suggested.filter(m => !excluded.has(m.sourceAccount)).map(mapping => {
    const used = financial.has(mapping.sourceAccount)
    if (isAccountNumber(mapping.targetAccount) && (!used || isValidBASRange(mapping.targetAccount))) return mapping
    // Keep unused custom four-digit definitions, as in #2605. A source with
    // financial data must instead be explicitly mapped to a reportable target.
    if (!used && isAccountNumber(mapping.sourceAccount) && !mapping.targetAccount) {
      return { ...mapping, targetAccount: mapping.sourceAccount, targetName: mapping.sourceName }
    }
    // A class 9 account carrying amounts is the source system's OBS-konto or
    // internal account (Fortnox and Visma 9999, 9xxx). BAS keeps 2999
    // OBS-konto for exactly that: the postings follow, the vouchers balance,
    // and the balance stays visible for sorting out afterwards. Suggested at
    // low confidence so the mapping step shows it for review; the onboarding
    // books flow, which has no mapping page, applies it as is instead of
    // creating 9999 and failing at the job's class check (desk crm#63).
    if (used && isClass9Account(mapping.sourceAccount)) {
      return { ...mapping, targetAccount: OBS_ACCOUNT, targetName: OBS_ACCOUNT_NAME, confidence: 0.5, matchType: 'class' as const, isOverride: false }
    }
    return { ...mapping, targetAccount: '', targetName: '', confidence: 0, matchType: 'manual' as const }
  })
  return { mappings, archivedOnlyAccounts, excludedSystemAccounts }
}
