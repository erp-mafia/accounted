/**
 * Who pays for a company's use above what a month includes: the condition
 * for more than the included amount, and where it is billed.
 *
 *   subscription  the company's own active Stripe subscription, outside a
 *                 sandbox: billed as lines on that subscription
 *   byra          a byrå client covered by its byrå team's agreement (an
 *                 active manual team grant, lib/entitlements/team-agreement.ts):
 *                 billed to the byrå by hand, never through Stripe
 *
 * A trial (trialing, or a trial grant without a subscription), a free period
 * granted by hand, a lapsed subscription and a sandbox have no payer: such a
 * company stops at what is included until it subscribes, and is never billed
 * for more.
 *
 * Imports nothing that reads the payments cap, so the cap
 * (lib/payments/usage.ts) can read it without a cycle.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { getTeamAgreement } from '@/lib/entitlements/team-agreement'

export interface SubscriptionFacts {
  isSandbox: boolean
  status: string | null
  customerId: string | null
  subscriptionId: string | null
}

export type CompanyPayer = { kind: 'subscription' } | { kind: 'byra'; teamName: string }

export function subscriptionPays(facts: SubscriptionFacts): boolean {
  return !facts.isSandbox && facts.status === 'active' && !!facts.customerId && !!facts.subscriptionId
}

/** One company's payer, or null. Throws on a failed read. */
export async function readCompanyPayer(db: SupabaseClient, companyId: string): Promise<CompanyPayer | null> {
  const [subscription, settings] = await Promise.all([
    db.from('company_subscriptions').select('status, stripe_customer_id, stripe_subscription_id').eq('company_id', companyId).maybeSingle(),
    db.from('company_settings').select('is_sandbox').eq('company_id', companyId).maybeSingle(),
  ])
  if (subscription.error) throw new Error(`company_subscriptions read failed: ${subscription.error.message}`)
  if (settings.error) throw new Error(`company_settings read failed: ${settings.error.message}`)
  const isSandbox = (settings.data as { is_sandbox: boolean | null } | null)?.is_sandbox === true
  const sub = subscription.data as { status: string | null; stripe_customer_id: string | null; stripe_subscription_id: string | null } | null
  const pays = subscriptionPays({
    isSandbox,
    status: sub?.status ?? null,
    customerId: sub?.stripe_customer_id ?? null,
    subscriptionId: sub?.stripe_subscription_id ?? null,
  })
  if (pays) return { kind: 'subscription' }
  if (isSandbox) return null
  const agreement = await getTeamAgreement(db, companyId)
  return agreement ? { kind: 'byra', teamName: agreement.teamName } : null
}

/** Whether the company has a payer. Throws on a failed read. */
export async function readCompanyPays(db: SupabaseClient, companyId: string): Promise<boolean> {
  return (await readCompanyPayer(db, companyId)) !== null
}

/**
 * The companies among `companyIds` covered by a byrå team's agreement, with
 * the byrå's name: the monthly statements' batch read of getTeamAgreement.
 * Throws on a failed read (the close then stops rather than bill a byrå
 * client to nobody).
 */
export async function readByraAgreements(service: SupabaseClient, companyIds: string[]): Promise<Map<string, { teamId: string; teamName: string }>> {
  const companies: Array<{ id: string; team_id: string | null }> = []
  for (let i = 0; i < companyIds.length; i += 100) {
    const { data, error } = await service.from('companies').select('id, team_id').in('id', companyIds.slice(i, i + 100))
    if (error) throw new Error(`companies read failed: ${error.message}`)
    companies.push(...((data ?? []) as typeof companies))
  }
  const teamIds = [...new Set(companies.map((c) => c.team_id).filter((id): id is string => !!id))]
  const out = new Map<string, { teamId: string; teamName: string }>()
  if (teamIds.length === 0) return out

  const byraTeams = new Map<string, string>()
  const covered = new Set<string>()
  const now = Date.now()
  for (let i = 0; i < teamIds.length; i += 100) {
    const ids = teamIds.slice(i, i + 100)
    const [teams, grants] = await Promise.all([
      service.from('teams').select('id, name, kind').in('id', ids),
      // The same rule as getTeamAgreement: a manual team grant, not a seat grant alone, not expired.
      service.from('capability_grants').select('team_id, expires_at').in('team_id', ids).eq('source', 'manual').neq('capability_key', 'multi_user'),
    ])
    if (teams.error) throw new Error(`teams read failed: ${teams.error.message}`)
    if (grants.error) throw new Error(`capability_grants read failed: ${grants.error.message}`)
    for (const team of (teams.data ?? []) as Array<{ id: string; name: string; kind: string }>) {
      if (team.kind === 'byra') byraTeams.set(team.id, team.name)
    }
    for (const grant of (grants.data ?? []) as Array<{ team_id: string; expires_at: string | null }>) {
      if (grant.expires_at === null || new Date(grant.expires_at).getTime() > now) covered.add(grant.team_id)
    }
  }
  for (const company of companies) {
    const teamId = company.team_id
    if (!teamId || !covered.has(teamId)) continue
    const teamName = byraTeams.get(teamId)
    if (teamName !== undefined) out.set(company.id, { teamId, teamName })
  }
  return out
}
