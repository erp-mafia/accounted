import { isAgentPictureEnabled } from '@/lib/env/agent-picture-switch'

/**
 * The Agenter page (/skills) is hidden in production while it is being
 * finished (2026-09-24). The agents themselves keep working over
 * MCP (list_skills, load_skill, get_task); only the page and its links are
 * gated.
 *
 * AGENTS_PAGE_COMPANY_IDS lists the companies that see it (comma-separated
 * ids, or `*` for everyone). Unset means: hidden on Vercel production, shown
 * everywhere else (local, preview deployments, self-hosted), so the page can
 * still be reviewed on a preview.
 */
export function isAgentsPageEnabled(companyId: string | null | undefined): boolean {
  const raw = process.env.AGENTS_PAGE_COMPANY_IDS?.trim()
  if (!raw) return process.env.VERCEL_ENV !== 'production'
  if (raw === '*') return true
  if (!companyId) return false
  return raw.split(',').map((s) => s.trim()).includes(companyId)
}

/**
 * Whether a segment of /skills/[id] is one of an own item's pages: the page
 * that adds an item (ny), an own flow (own-<id>), or own knowledge and an
 * own analysis (egen.<id>). The segments are the ones the links to an own
 * item are built with (components/skills/data.ts: createItemHref,
 * ownItemHref).
 */
export function isOwnItemSegment(segment: string): boolean {
  return segment === 'ny' || segment.startsWith('own-') || segment.startsWith('egen.')
}

/**
 * Whether the page at /skills/[id] answers for a company: the one rule for
 * a door that follows the Agenter page's switch.
 *
 * Where the Agenter page is on, every item's page answers. Where it is off
 * and the company has the agent picture (AGENT_PICTURE_COMPANY_IDS,
 * lib/env/agent-picture-switch.ts), an own item's pages answer
 * (isOwnItemSegment): the picture's Kunskap panel lists the company's own
 * items and links to each one and to the page that adds one. With neither
 * switch on, no page answers.
 */
export function isAgentItemPageEnabled(companyId: string | null | undefined, segment: string): boolean {
  if (isAgentsPageEnabled(companyId)) return true
  return isOwnItemSegment(segment) && isAgentPictureEnabled(companyId)
}
