import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
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
 * walk straight into a duplicate (prod 2026-09-23: 72 org numbers where one
 * user belonged to two or more copies, most of them an empty shell), so the
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
