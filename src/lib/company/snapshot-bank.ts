import { validateBankgiroNumber } from '@/lib/bankgiro/luhn'
import { sameOrgNumber } from '@/lib/invariants/org-number'

/**
 * Extract the company's bankgiro number from the cached TIC company snapshot
 * (companies.tic_snapshot). The snapshot's BANKUPPGIFTER rows are registry
 * display data from Bolagsverket and are never read by the payment-file
 * generators; those read company_settings.bankgiro. This helper bridges the
 * two as a suggestion only: the user still confirms and saves the value.
 *
 * The snapshot must prove it describes THIS company: older snapshots were
 * fetched via fuzzy search and can hold a different entity's whole profile
 * (see lib/company/tic-refresh.ts), and this field ends up as the payee
 * account on invoices. A suggestion is only returned when the snapshot's
 * orgNumber matches the company's org_number; no match, no suggestion.
 *
 * Returns the raw digits (no hyphen) of the first bankgiro-typed account that
 * passes the Luhn check, or null. The snapshot is unvalidated registry JSON,
 * so every level is checked defensively.
 */
export function bankgiroFromTicSnapshot(
  snapshot: unknown,
  companyOrgNumber: string | null | undefined,
): string | null {
  if (!snapshot || typeof snapshot !== 'object') return null

  const snapshotOrg = (snapshot as { orgNumber?: unknown }).orgNumber
  if (typeof snapshotOrg !== 'string' || !sameOrgNumber(snapshotOrg, companyOrgNumber)) {
    return null
  }

  const accounts = (snapshot as { bankAccounts?: unknown }).bankAccounts
  if (!Array.isArray(accounts)) return null
  for (const entry of accounts) {
    if (!entry || typeof entry !== 'object') continue
    const { type, accountNumber } = entry as { type?: unknown; accountNumber?: unknown }
    if (type !== 'bankgiro' || typeof accountNumber !== 'string') continue
    const digits = accountNumber.replace(/[-\s]/g, '')
    if (validateBankgiroNumber(digits)) return digits
  }
  return null
}

