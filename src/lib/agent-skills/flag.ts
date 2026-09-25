/**
 * The Agenter page (/skills) is hidden in production while it is being
 * finished (founder, 2026-09-24). The agents themselves keep working over
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
