import type { AccountingFramework, CompanyRole, EntityType } from '@/types'

/**
 * Property builders for PostHog identify + group calls.
 *
 * Pure functions on purpose: the repo's Vitest runs in a `node` environment
 * and `vitest.config.ts` only matches `*.test.ts`, so component JSX is
 * untestable by convention. Keeping the property shaping here means the part
 * that can actually be wrong (what we send about a person and a company) is
 * covered by unit tests, while the mounting component stays trivial.
 *
 * Two rules encoded here, both from PostHog's framework guidance:
 *
 * 1. PII belongs in identify() PERSON properties, never in capture() event
 *    properties. Only `buildPersonProperties` carries email/name.
 * 2. `org_number` is deliberately NEVER sent. For an enskild firma the
 *    organisationsnummer IS the owner's personnummer, so it is not a company
 *    identifier at all: it is a national identity number for a natural
 *    person. `company_id` is the group key and is already unique.
 */

export interface AnalyticsUserInput {
  userId: string
  email?: string | null
  fullName?: string | null
  role?: CompanyRole | null
}

export interface AnalyticsCompanyInput {
  id: string
  name: string
  entityType?: EntityType | null
  accountingFramework?: AccountingFramework | null
  paysSalaries?: boolean | null
  trialEndsAt?: string | null
  capabilities?: readonly string[]
}

/** Drop null/undefined so PostHog person properties don't fill with empties. */
function compact(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== null && value !== undefined)
  )
}

/**
 * Person properties for `posthog.identify(userId, props)`.
 *
 * Matches what the privacy policy discloses is transferred: user id, email
 * address and company name. Do not widen this without updating
 * app/(public)/privacy/page.tsx and .compliance/ropa.yaml.
 */
export function buildPersonProperties(user: AnalyticsUserInput): Record<string, unknown> {
  return compact({
    email: user.email,
    name: user.fullName,
    role: user.role,
  })
}

/**
 * Group properties for `posthog.group('company', companyId, props)`.
 *
 * Company-shaped facts only: anything that varies per user (role) belongs on
 * the person, not the group. No org_number, see the file header.
 */
export function buildGroupProperties(company: AnalyticsCompanyInput): Record<string, unknown> {
  return compact({
    name: company.name,
    entity_type: company.entityType,
    accounting_framework: company.accountingFramework,
    pays_salaries: company.paysSalaries,
    trial_ends_at: company.trialEndsAt,
    // Sorted so the same entitlement set doesn't look like a change every
    // time the underlying query returns a different order.
    capabilities: company.capabilities ? [...company.capabilities].sort() : undefined,
  })
}
