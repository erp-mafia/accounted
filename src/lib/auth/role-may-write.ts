/**
 * Whether a member with this role may write in the company: every role but
 * the read-only one. No role (no active company, not a member) may not.
 * What a page shows follows this; the API (requireWritePermission) and the
 * database (current_user_can_write) remain what enforces it.
 */
export function roleMayWrite(role: string | null | undefined): boolean {
  return role != null && role !== 'viewer'
}
