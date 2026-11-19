import { normalizeOrgNumber } from '@/lib/company-lookup/normalize-org-number'
import { looksLikeSwedishPersonalNumber } from '@/lib/invariants/personal-number-shape'
import { orderCompanyCopies } from '@/lib/company/company-copies'
import type { JourneyStep } from './reducer'

/** One company the caller already belongs to with the org number being set up. */
export interface ExistingCompany {
  id: string
  name: string
  /** The caller's role there (company_members.role). */
  role: string
  /** companies.created_at; null when the answer carried none. */
  createdAt: string | null
}

/** The companies the caller already belongs to with the org number being set up. */
export interface ExistingCompanyMatch {
  /** Canonical 10-digit org number the check ran for. */
  orgNumber: string
  /** At least one; oldest first (orderCompanyCopies). */
  companies: ExistingCompany[]
}

/**
 * The match in a POST /api/company/check-org-number answer (`data.companies`)
 * for the canonical org number the check ran for. Null when it names no
 * company. Entries without an id or a name are left out.
 */
export function existingCompanyMatch(orgNumber: string, answered: unknown): ExistingCompanyMatch | null {
  if (!Array.isArray(answered)) return null
  const companies = answered.flatMap((entry): ExistingCompany[] => {
    if (!entry || typeof entry !== 'object') return []
    const { id, name, role, created_at: createdAt } = entry as Record<string, unknown>
    if (typeof id !== 'string' || typeof name !== 'string') return []
    return [
      {
        id,
        name,
        role: typeof role === 'string' ? role : '',
        createdAt: typeof createdAt === 'string' ? createdAt : null,
      },
    ]
  })
  return companies.length > 0 ? { orgNumber, companies: orderCompanyCopies(companies) } : null
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
