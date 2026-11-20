import { createHash } from 'node:crypto'

/**
 * The fingerprint an approval pins: SHA-256 of the SKILL.md text, trimmed
 * the way the sync stores it. An Accounted reviewer approves one exact text;
 * any other text, however small the change, waits for a new approval.
 */
export function communityBodySha(text: string): string {
  return createHash('sha256').update(text.trim(), 'utf8').digest('hex')
}
