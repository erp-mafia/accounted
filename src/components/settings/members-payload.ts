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
import { isProfileId, type ProfileId } from '@/lib/modules/profiles'

/** The byrå's profile choice for a client company (lib/company/client-profile.ts). */
export interface MembersProfileChoice {
  current: ProfileId | null
  preselected: ProfileId
}

export interface CompanyMembersPayload<M, I> {
  members: M[]
  invitations: I[]
  canInvite: boolean
  /** Multi-user seat gate: swap the invite form for the paid-plan upsell. */
  inviteRequiresUpgrade: boolean
  /** Present for the byrå of a client company: the invite form then requires a profile. */
  profileChoice: MembersProfileChoice | null
}

export function parseCompanyMembersPayload<M, I>(body: unknown): CompanyMembersPayload<M, I> | null {
  if (typeof body !== 'object' || body === null) return null
  const data = (body as { data?: unknown }).data
  if (typeof data !== 'object' || data === null) return null
  const d = data as {
    members?: unknown
    invitations?: unknown
    canInvite?: unknown
    inviteRequiresUpgrade?: unknown
    profileChoice?: unknown
  }
  if (!Array.isArray(d.members) || !Array.isArray(d.invitations)) return null
  const choice = d.profileChoice as { current?: unknown; preselected?: unknown } | null | undefined
  return {
    members: d.members as M[],
    invitations: d.invitations as I[],
    // Only an explicit boolean true unlocks the invite form.
    canInvite: d.canInvite === true,
    // Only an explicit true swaps the form for the upsell: an older server
    // without the field keeps the form, and the POST's own 403 still guards.
    inviteRequiresUpgrade: d.inviteRequiresUpgrade === true,
    // Only a well-formed choice adds the profile field: an older server, or
    // a company that is not a byrå client, keeps the form as it was.
    profileChoice:
      choice && typeof choice === 'object' && isProfileId(choice.preselected)
        ? { current: isProfileId(choice.current) ? choice.current : null, preselected: choice.preselected }
        : null,
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
  /** The team's client companies, for choosing which ones a member reaches. */
  companies: { id: string; name: string }[]
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
    companies?: unknown
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
    // Management-only extra like invitations: a missing list hides the
    // access choice instead of failing the roster.
    companies: Array.isArray(d.companies)
      ? (d.companies as unknown[]).filter(
          (c): c is { id: string; name: string } =>
            typeof c === 'object' &&
            c !== null &&
            typeof (c as { id?: unknown }).id === 'string' &&
            typeof (c as { name?: unknown }).name === 'string',
        )
      : [],
  }
}
