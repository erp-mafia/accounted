/**
 * AGENT_PICTURE_COMPANY_IDS: the picture of what a connected agent gets, on
 * the Kontext view of /wiki (what is connected, the company, the agents) and
 * its two routes under /api/wiki/picture. Unset = nobody: the Kontext view
 * keeps its graph for every company.
 *
 * It rolls out per company, like COMPANY_QUESTIONS_COMPANY_IDS: `*` opens it
 * for every company, a comma-separated list of company ids for those only.
 *
 * Read on the server only: the page hands the browser a boolean.
 */
type Env = Record<string, string | undefined>

export type AgentPictureRollout = 'all' | readonly string[]

/** The companies in the rollout: `'all'` for `*`, else the listed ids (lowercased, each once). */
export function agentPictureRollout(env: Env = process.env): AgentPictureRollout {
  const raw = env.AGENT_PICTURE_COMPANY_IDS?.trim()
  if (!raw) return []
  if (raw === '*') return 'all'
  return [...new Set(raw.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))]
}

/** Whether the picture is switched on for this company. */
export function isAgentPictureEnabled(companyId: string | null | undefined, env: Env = process.env): boolean {
  if (!companyId) return false
  const rollout = agentPictureRollout(env)
  return rollout === 'all' || rollout.includes(companyId.toLowerCase())
}
