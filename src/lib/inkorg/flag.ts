/**
 * The new Inkorg page (/inkorg) rolls out per company (founder decision
 * 2026-10-16). With the flag on, the sidebar shows Inkorg as a top-level
 * entry under Att göra and Inköp no longer lists Underlag; with it off,
 * nothing changes and the workspace under Inköp (/e/general/invoice-inbox)
 * stays the inbox. The old workspace keeps working for everyone either way,
 * so a flagged company can always fall back to it.
 *
 * INKORG_V2_COMPANY_IDS lists the companies (comma-separated ids, or `*`
 * for everyone); unset means nobody, so a deploy never moves anyone's inbox.
 */
export function inkorgV2Rollout(): 'all' | string[] {
  const raw = process.env.INKORG_V2_COMPANY_IDS?.trim()
  if (!raw) return []
  if (raw === '*') return 'all'
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
}

/** Whether this company sees the new Inkorg page and its place in the sidebar. */
export function isInkorgV2Enabled(companyId: string | null | undefined): boolean {
  if (!companyId) return false
  const rollout = inkorgV2Rollout()
  return rollout === 'all' || rollout.includes(companyId)
}

/** Where the inbox lives without the flag: the workspace under Inköp. */
export const LEGACY_INBOX_HREF = '/e/general/invoice-inbox'

/** The new page. */
export const INKORG_HREF = '/inkorg'

/**
 * Where the inbox lives for a company, for anything that links to it
 * outside the menu (the command palette): the new page in the rollout,
 * else the workspace under Inköp, the same split the menu makes.
 */
export function inboxHref(inkorgV2Enabled: boolean): string {
  return inkorgV2Enabled ? INKORG_HREF : LEGACY_INBOX_HREF
}
