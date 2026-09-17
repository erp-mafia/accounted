import { isAccountNumber } from '@/lib/invariants/account-number'
import { isSystemAccount, isValidBASRange } from './account-mapper'
import type { AccountMapping, ParsedSIEFile, SIEAccount } from './types'

/** BAS 2999 OBS-konto: where a source system's class 9 observation postings land. */
const OBS_ACCOUNT = '2999'
const OBS_ACCOUNT_NAME = 'OBS-konto'
const isClass9Account = (account: string) => /^9\d{3}$/.test(account)

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
