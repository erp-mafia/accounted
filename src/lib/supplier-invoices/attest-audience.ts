/**
 * The people a mail about a company's attest can reach: its members who keep
 * the books (with their roles), its byrå team, and the names and addresses
 * of those people and of the registrants and attesters a mail names. The
 * recipient rule itself is decisionRecipients (attest-decision-notify.ts):
 * the registrant while they keep the books and have an address, else the
 * company's owners and admins, those on the byrå team first.
 *
 * Read as the service role: profiles are private to their owner under RLS.
 */

import type { SupabaseClient } from '@supabase/supabase-js'
import { isBookkeepingWriterRole } from '@/lib/auth/invoicer-role'

export interface AttestPersonContact {
  email: string | null
  name: string | null
}

export interface AttestAudience {
  companyName: string
  /** The company's members who keep the books (owner, admin, member), by user id, with their role. */
  writers: ReadonlyMap<string, string>
  /** Byrå team members of the company's byrå; empty without one. */
  byraTeam: ReadonlySet<string>
  people: ReadonlyMap<string, AttestPersonContact>
  /** User ids with an address. */
  reachable: ReadonlySet<string>
}

export async function loadAttestAudience(service: SupabaseClient, companyId: string, userIds: readonly string[]): Promise<AttestAudience> {
  const [{ data: companyRow, error: companyError }, { data: memberRows, error: memberError }] = await Promise.all([
    service.from('companies').select('name, team_id').eq('id', companyId).maybeSingle(),
    service.from('company_members').select('user_id, role').eq('company_id', companyId),
  ])
  if (companyError) throw companyError
  if (memberError) throw memberError
  const company = companyRow as { name: string | null; team_id: string | null } | null
  const writers = new Map(
    ((memberRows ?? []) as Array<{ user_id: string; role: string }>)
      .filter((m) => isBookkeepingWriterRole(m.role))
      .map((m) => [m.user_id, m.role] as const),
  )
  const byraTeam = new Set<string>()
  if (company?.team_id) {
    const { data: team, error: teamError } = await service.from('teams').select('kind').eq('id', company.team_id).maybeSingle()
    if (teamError) throw teamError
    if ((team as { kind?: string } | null)?.kind === 'byra') {
      const { data: teamRows, error: teamMembersError } = await service.from('team_members').select('user_id').eq('team_id', company.team_id)
      if (teamMembersError) throw teamMembersError
      for (const row of (teamRows ?? []) as Array<{ user_id: string }>) byraTeam.add(row.user_id)
    }
  }
  const ids = [...new Set([...userIds, ...writers.keys()])].filter(Boolean)
  const people = new Map<string, AttestPersonContact>()
  if (ids.length > 0) {
    const { data: profileRows, error: profileError } = await service.from('profiles').select('id, email, full_name').in('id', ids)
    if (profileError) throw profileError
    for (const p of (profileRows ?? []) as Array<{ id: string; email: string | null; full_name: string | null }>) {
      people.set(p.id, { email: p.email?.trim() || null, name: p.full_name?.trim() || null })
    }
  }
  const reachable = new Set([...people].filter(([, p]) => p.email).map(([id]) => id))
  return { companyName: company?.name?.trim() || 'Företaget', writers, byraTeam, people, reachable }
}

/** A person's name for a mail line, else their address, else null. */
export function contactName(people: ReadonlyMap<string, AttestPersonContact>, userId: string): string | null {
  const person = people.get(userId)
  return person?.name ?? person?.email ?? null
}
