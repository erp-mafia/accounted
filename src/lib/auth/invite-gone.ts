/**
 * Why an invitation that is no longer pending cannot be accepted. GET
 * /api/team/accept answers 410 with one of these as `reason`, and the invite
 * page (app/invite/[token]/page.tsx) picks its sentence and the next step
 * from it. Client-safe: no server imports.
 *
 * - `used`: accepted, and the caller is not signed in, so it may be theirs.
 * - `used_other_account`: accepted, and the signed-in caller is not the
 *   member it made.
 * - `revoked`: withdrawn by the inviter.
 * - `expired`: its time ran out.
 */
export const INVITE_GONE_REASONS = ['used', 'used_other_account', 'revoked', 'expired'] as const

export type InviteGoneReason = (typeof INVITE_GONE_REASONS)[number]

/** The `reason` of a 410 body, or null for an answer that carries none. */
export function inviteGoneReason(body: unknown): InviteGoneReason | null {
  const reason = (body as { reason?: unknown } | null)?.reason
  return (INVITE_GONE_REASONS as readonly unknown[]).includes(reason) ? (reason as InviteGoneReason) : null
}
