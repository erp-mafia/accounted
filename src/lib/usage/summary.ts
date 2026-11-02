/**
 * A company's usage this month (or another), kind by kind: what the billing
 * page's "Användning" tab shows, with whether more than the included amount
 * is on offer and accepted. Read with the service role and an explicit
 * company filter: the counts must not depend on which tables the viewer's
 * role can read (payslip deliveries are salary data).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { currentUsagePeriod, includedBankPayments } from '@/lib/payments/usage'
import { consentCovers, readOpenConsents } from './consent'
import { countCompanyUsage } from './counters'
import { billedUsageKinds, USAGE_GATED_KINDS, USAGE_KINDS, usageLine, type UsageKind, type UsageLine } from './kinds'
import { readCompanyPays } from './paying'

export interface CompanyUsageLine extends UsageLine {
  /** Whether more than the included amount can be accepted: the kind is billed, priced and stops at the limit. */
  offered: boolean
  /** Whether an admin has accepted the charge at today's price. */
  accepted: boolean
  accepted_at: string | null
  /** Whether units above the included amount are billed: offered, accepted, and the company pays. */
  billed: boolean
}

export interface CompanyUsage {
  /** YYYY-MM in Stockholm time. */
  period: string
  /** Whether the company has a subscription of its own: without one, nothing above the included amount can be accepted (paying.ts). */
  paying: boolean
  lines: CompanyUsageLine[]
}

/** The included amount for one company where it differs from the registry: the bank payments allowance. */
export async function includedOverrideFor(service: SupabaseClient, companyId: string, kind: UsageKind): Promise<number | null> {
  return kind === 'bank_payment' ? includedBankPayments(service, companyId) : null
}

export async function getCompanyUsage(
  service: SupabaseClient,
  companyId: string,
  period: string = currentUsagePeriod(),
  env: Record<string, string | undefined> = process.env,
): Promise<CompanyUsage> {
  const billedKinds = billedUsageKinds(env)
  const [consents, paying] = await Promise.all([readOpenConsents(service, companyId), readCompanyPays(service, companyId)])
  const lines = await Promise.all(
    USAGE_KINDS.map(async (kind): Promise<CompanyUsageLine> => {
      const [used, included] = await Promise.all([
        countCompanyUsage(service, companyId, kind, period),
        includedOverrideFor(service, companyId, kind),
      ])
      const offered = billedKinds.has(kind) && USAGE_GATED_KINDS.has(kind)
      const consent = consents.get(kind)
      const accepted = consentCovers(consent, kind)
      return {
        ...usageLine(kind, used, included),
        offered,
        accepted,
        accepted_at: accepted ? consent!.accepted_at : null,
        billed: offered && accepted && paying,
      }
    }),
  )
  return { period, paying, lines }
}
