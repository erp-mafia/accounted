/**
 * How long a company or byrå-team invitation link is valid: the one
 * definition of the invitation lifetime.
 *
 * Everything that enforces or states the lifetime reads it from here:
 * `getInviteExpiry()` (lib/auth/invite-tokens.ts) stamps `expires_at` with it
 * on issue and on re-send, the invitation mails print it
 * (lib/email/invite-templates.ts), and the pre-auth invite cookie lives
 * exactly as long (app/invite/[token]/page.tsx, the auth callback).
 *
 * 24 hours, down from 7 days: an invitation link is an activation code, and
 * CASA 1.1.2 requires those to expire after a short period. An expired
 * invitation is not lost: the inviter re-sends it from the members list,
 * which issues a fresh link with a fresh expiry.
 *
 * This file imports nothing on purpose. The invite page is a client
 * component, and invite-tokens.ts imports Node's `crypto`, which must stay
 * out of the browser bundle.
 */
export const INVITE_TTL_HOURS = 24

/** The same lifetime in seconds: what a cookie `max-age` takes. */
export const INVITE_TTL_SECONDS = INVITE_TTL_HOURS * 60 * 60
