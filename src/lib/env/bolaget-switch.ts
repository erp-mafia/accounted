/**
 * BOLAGET_COMPANY_IDS: the Bolaget registers (aktiebok, roles over time,
 * firmateckning, verkliga huvudmän) and their pages, API and MCP doors.
 * Unset = nobody, until the founders flip it.
 *
 * It rolls out per company, like SIGNING_ENABLED and ARKIV_COMPANY_IDS:
 * `*` opens it for every company, a comma-separated list of company ids for
 * those only. Every Bolaget wave reads this one variable, so the registers,
 * the meetings and the capital events switch on together.
 *
 * What the switch never stops: the rows already written. The aktiebok is a
 * statutory register (ABL 5:3): switching the surfaces off hides them, it
 * does not delete or change an entry.
 */
type Env = Record<string, string | undefined>

export type BolagetRollout = 'all' | readonly string[]

/** The companies in the rollout: `'all'` for `*`, else the listed ids (lowercased, each once). */
export function bolagetRollout(env: Env = process.env): BolagetRollout {
  const raw = env.BOLAGET_COMPANY_IDS?.trim()
  if (!raw) return []
  if (raw === '*') return 'all'
  return [...new Set(raw.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))]
}

/** Whether the Bolaget registers are switched on for this company. */
export function isBolagetEnabled(companyId: string | null | undefined, env: Env = process.env): boolean {
  if (!companyId) return false
  const rollout = bolagetRollout(env)
  return rollout === 'all' || rollout.includes(companyId.toLowerCase())
}
