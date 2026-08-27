/**
 * Read-side payload guards for the member rosters
 * (CompanyMembersSection.tsx, TeamPanel.tsx).
 *
 * A 200 whose body does not carry the expected lists is a failed read, not an
 * empty roster: returning null forces the caller into its error state instead
 * of rendering an apparently member-less company or team. A consultant who
 * sees an empty list re-invites people who are already members, so "cannot
 * read the roster" must never render as "no members".
 *
 * The element types are the caller's own row interfaces; these guards verify
 * the envelope shape (lists are lists, flags are booleans), not the fields of
 * each row.
 */

export interface CompanyMembersPayload<M, I> {
  members: M[]
  invitations: I[]
  canInvite: boolean
}

export function parseCompanyMembersPayload<M, I>(body: unknown): CompanyMembersPayload<M, I> | null {
  if (typeof body !== 'object' || body === null) return null
  const data = (body as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return null
  const d = data as { members?: unknown; invitations?: unknown; canInvite?: unknown }
  if (!Array.isArray(d.members) || !Array.isArray(d.invitations)) return null
  return {
    members: d.members as M[],
    invitations: d.invitations as I[],
    // Only an explicit boolean true unlocks the invite form.
    canInvite: d.canInvite === true,
  }
}

export interface TeamMembersPayload<M, I> {
  members: M[]
  invitations: I[]
  teamName: string | null
  teamId: string | null
  teamKind: string | null
  isOwner: boolean
  canInvite: boolean
}

export function parseTeamMembersPayload<M, I>(body: unknown): TeamMembersPayload<M, I> | null {
  if (typeof body !== 'object' || body === null) return null
  const data = (body as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return null
  const d = data as {
    members?: unknown
    invitations?: unknown
    teamName?: unknown
    teamId?: unknown
    teamKind?: unknown
    isOwner?: unknown
    canInvite?: unknown
  }
  if (!Array.isArray(d.members)) return null
  return {
    members: d.members as M[],
    // Management-only extra, not roster state: a missing list means "none",
    // not a failed read (the strictness above protects the member roster).
    invitations: Array.isArray(d.invitations) ? (d.invitations as I[]) : [],
    teamName: typeof d.teamName === 'string' && d.teamName.length > 0 ? d.teamName : null,
    teamId: typeof d.teamId === 'string' && d.teamId.length > 0 ? d.teamId : null,
    teamKind: typeof d.teamKind === 'string' && d.teamKind.length > 0 ? d.teamKind : null,
    // Only explicit boolean true unlocks management affordances.
    isOwner: d.isOwner === true,
    canInvite: d.canInvite === true,
  }
}
