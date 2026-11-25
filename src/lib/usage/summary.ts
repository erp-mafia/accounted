/**
 * A company's usage this month (or another), kind by kind: what the billing
 * page's "Användning" tab shows, with whether the kind stops at the included
 * amount and whether the charge for more is open for the company. Read with the service role and an explicit
 * company filter: the counts must not depend on which tables the viewer's
 * role can read (payslip deliveries are salary data).
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { currentUsagePeriod, includedBankPayments } from '@/lib/payments/usage'
import { consentCovers, readOpenConsents } from './consent'
import { countCompanyUsage } from './counters'
import { billedUsageKinds, includedThisMonth, USAGE_GATED_KINDS, USAGE_KINDS, USAGE_PRICES, usageLine, type UsageKind, type UsageLine } from './kinds'
import { readCompanyPayerState } from './paying'

export interface CompanyUsageLine extends UsageLine {
  /** For a kind included once (signed documents), what the company's first units include in all; else null. */
  included_once: number | null
  /** Whether the kind stops at the included amount and more can be asked for: it is billed, priced and gated. */
  offered: boolean
  /** Whether an operator opened the charge for the company at today's price (consent.ts). */
  accepted: boolean
  accepted_at: string | null
  /** Whether units above the included amount are billed: offered, open, and someone pays (paying.ts). */
  billed: boolean
}

export interface CompanyUsage {
  /** YYYY-MM in Stockholm time. */
  period: string
  /** Whether someone pays for the company (its own subscription, or its byrå's agreement): without that, nothing above the included amount can be opened (paying.ts). */
  paying: boolean
  /** Nobody pays yet, but the company's subscription, started during the trial, waits for its first charge (subscriptionStarting). */
  subscription_starting: boolean
  lines: CompanyUsageLine[]
}

/**
 * The month's included amount for one company where it differs from the
 * registry: the bank payments allowance, or what earlier months left of an
 * amount included once.
 */
export async function includedOverrideFor(service: SupabaseClient, companyId: string, kind: UsageKind, period: string): Promise<number | null> {
  if (kind === 'bank_payment') return includedBankPayments(service, companyId)
  if (USAGE_PRICES[kind].includedOnce !== undefined) {
    return includedThisMonth(kind, await countCompanyUsage(service, companyId, kind, period, { before: true }))
  }
  return null
}

export async function getCompanyUsage(
  service: SupabaseClient,
  companyId: string,
  period: string = currentUsagePeriod(),
  env: Record<string, string | undefined> = process.env,
): Promise<CompanyUsage> {
  const billedKinds = billedUsageKinds(env)
  const [consents, payer] = await Promise.all([readOpenConsents(service, companyId), readCompanyPayerState(service, companyId)])
  const paying = payer.payer !== null
  const lines = await Promise.all(
    USAGE_KINDS.map(async (kind): Promise<CompanyUsageLine> => {
      const [used, included] = await Promise.all([
        countCompanyUsage(service, companyId, kind, period),
        includedOverrideFor(service, companyId, kind, period),
      ])
      const offered = billedKinds.has(kind) && USAGE_GATED_KINDS.has(kind)
      const consent = consents.get(kind)
      const accepted = consentCovers(consent, kind)
      return {
        ...usageLine(kind, used, included),
        included_once: USAGE_PRICES[kind].includedOnce ?? null,
        offered,
        accepted,
        accepted_at: accepted ? consent!.accepted_at : null,
        billed: offered && accepted && paying,
      }
    }),
  )
  return { period, paying, subscription_starting: !paying && payer.subscriptionStarting, lines }
}
