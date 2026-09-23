import crypto from 'crypto'

const INVITE_PREFIX = 'gnubok_inv_'
const INVITE_TTL_DAYS = 7

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
 * Get the expiration date for a new invite.
 */
export function getInviteExpiry(): Date {
  const d = new Date()
  d.setDate(d.getDate() + INVITE_TTL_DAYS)
  return d
}
