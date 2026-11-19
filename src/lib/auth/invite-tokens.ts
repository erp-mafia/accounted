import crypto from 'crypto'
import { INVITE_TTL_HOURS } from '@/lib/auth/invite-ttl'

const INVITE_PREFIX = 'gnubok_inv_'

/**
 * Generate an invite token and its SHA-256 hash.
 * The raw token is sent via email; only the hash is stored in DB.
 */
export function generateInviteToken(): { token: string; hash: string } {
  const raw = crypto.randomBytes(32).toString('base64url')
  const token = `${INVITE_PREFIX}${raw}`
  const hash = crypto.createHash('sha256').update(token).digest('hex')
  return { token, hash }
}

/**
 * Hash a raw invite token for lookup.
 */
export function hashInviteToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex')
}

/**
 * Get the expiration date for a new or re-sent invite: INVITE_TTL_HOURS from
 * now (lib/auth/invite-ttl.ts). Every route that issues an invitation link
 * stamps `expires_at` through this function, so the lifetime has one source.
 */
export function getInviteExpiry(): Date {
  return new Date(Date.now() + INVITE_TTL_HOURS * 60 * 60 * 1000)
}
