/**
 * The årsredovisning's signer roster from the roles: every ordinarie
 * styrelseledamot (the chair included) in office, plus the VD when the VD
 * is not already a board member (ÅRL 2:7: the board and the VD sign; a
 * suppleant does not). A person who is both signs once, as board member.
 * Pure.
 */
import type { RolesView } from './roles'

export type RosterRole = 'Styrelseledamot' | 'Styrelseordförande' | 'Verkställande direktör'

export interface RosterCandidate {
  role: RosterRole
  signer_name: string
}

export function rosterFromRoles(roles: Pick<RolesView, 'roles'>, existing: ReadonlyArray<{ signer_name: string }> = []): RosterCandidate[] {
  const taken = new Set(existing.map((e) => e.signer_name.trim().toLowerCase()))
  const out: RosterCandidate[] = []
  const add = (name: string | undefined, role: RosterRole) => {
    const clean = name?.trim()
    if (!clean || taken.has(clean.toLowerCase())) return
    taken.add(clean.toLowerCase())
    out.push({ role, signer_name: clean })
  }
  const active = roles.roles.filter((r) => r.active && r.party?.kind !== 'company')
  for (const r of active.filter((x) => x.role === 'styrelseordforande')) add(r.party?.name, 'Styrelseordförande')
  for (const r of active.filter((x) => x.role === 'styrelseledamot')) add(r.party?.name, 'Styrelseledamot')
  for (const r of active.filter((x) => x.role === 'vd')) add(r.party?.name, 'Verkställande direktör')
  return out
}
