/**
 * Who may start a new Gmail consent.
 *
 * While Google's restricted-scope review is open, every consent on the hosted
 * app shows "Google hasn't verified this app", and prospects bounce off it
 * (Lumaro AB, 2026-09-05). The connect button is therefore withheld on hosted
 * unless the company is on `GOOGLE_MAIL_CONNECT_COMPANY_IDS`:
 *
 *   unset or empty   nobody can start a consent (the default while in review)
 *   `*`              everybody (set this once Google has approved the scope)
 *   `id1,id2`        only those companies (the reviewer's demo company, the
 *                    company the demo video is recorded in)
 *
 * Existing connections are untouched: the hunt keeps searching mailboxes that
 * were connected before, and disconnecting still works. Self-hosted installs
 * run their own Google app with their own verification status, so the gate
 * does not apply there.
 */
import { isSelfHosted } from '@/lib/env/public-flags'

export const MAIL_CONNECT_ALLOWLIST_ENV = 'GOOGLE_MAIL_CONNECT_COMPANY_IDS'

function allowlist(raw: string | undefined): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
}

export function isMailConnectEnabled(
  companyId: string,
  raw: string | undefined = process.env[MAIL_CONNECT_ALLOWLIST_ENV],
): boolean {
  if (isSelfHosted()) return true
  const ids = allowlist(raw)
  if (ids.includes('*')) return true
  return ids.includes(companyId)
}
