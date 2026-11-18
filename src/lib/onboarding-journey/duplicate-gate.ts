import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { looksLikeSwedishPersonalNumber } from '@/lib/invariants/personal-number-shape'
import type { JourneyStep } from './reducer'

/** A company the caller already belongs to with the org number being set up. */
export interface ExistingCompanyMatch {
  /** Canonical 10-digit org number the check ran for. */
  orgNumber: string
  companyId: string
  name: string
}

/**
 * Whether the journey must stop and ask before creating a second copy of a
 * company the user already has. A faint "you already have X" note let users
 * walk straight into a duplicate (one user in two or more copies of a
 * company, most of them an empty shell), so the
 * journey now pauses on the first step after the orgnr until the user either
 * opens the existing company or explicitly asks for a separate copy.
 *
 * Gates only while the match is for the org number currently in the
 * journey (a changed orgnr invalidates it), never on the orgnr step itself
 * (the user is still typing) and never after creation.
 */
export function shouldGateDuplicate(input: {
  match: ExistingCompanyMatch | null
  orgNumber: string | null | undefined
  acknowledgedOrgNumber: string | null
  step: JourneyStep
}): boolean {
  const { match, orgNumber, acknowledgedOrgNumber, step } = input
  if (!match) return false
  if (step === 'orgnr' || step === 'done') return false
  const current = normalizeOrgNumber(orgNumber ?? '')
  if (!current || current !== match.orgNumber) return false
  return acknowledgedOrgNumber !== match.orgNumber
}

/**
 * True when the company the user already has is a sole trader's firm: its
 * org number is the owner's personnummer. A person keeps one bookkeeping for
 * all their verksamheter (BFL 4 kap. 4 §), so a "second set of books" for
 * part of the firm, such as a property, is a project inside the same firm,
 * not a copy of it (PH 216). The gate says so for this match.
 */
export function isSoleTraderMatch(match: ExistingCompanyMatch): boolean {
  return looksLikeSwedishPersonalNumber(match.orgNumber)
}
