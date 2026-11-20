/**
 * The Bolaget rollout for commitments and holdings: the Avtal och åtaganden
 * page (manual agreements, ställda säkerheter and eventualförpliktelser, the
 * group structure), its session, v1 and MCP doors, the asset identification
 * fields, the daily refresh of manual agreements and the register's feed
 * into the årsredovisning notes.
 *
 * Reads BOLAGET_COMPANY_IDS, the one switch every Bolaget surface shares:
 * a comma-separated list of company ids, or `*` for every company; unset
 * means nobody, so a deploy never opens it at once.
 */
type Env = Record<string, string | undefined>

export type CommitmentsRollout = 'all' | readonly string[]

export function commitmentsRollout(env: Env = process.env): CommitmentsRollout {
  const raw = env.BOLAGET_COMPANY_IDS?.trim()
  if (!raw) return []
  if (raw === '*') return 'all'
  // Each company once: the daily job walks this list.
  return [...new Set(raw.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))]
}

/** Whether commitments and holdings are switched on for this company. */
export function commitmentsEnabledFor(companyId: string | null | undefined, env: Env = process.env): boolean {
  if (!companyId) return false
  const rollout = commitmentsRollout(env)
  return rollout === 'all' || rollout.includes(companyId.toLowerCase())
}

/** Whether any company has it: the MCP tools are discoverable only then. */
export function commitmentsRolloutConfigured(env: Env = process.env): boolean {
  const rollout = commitmentsRollout(env)
  return rollout === 'all' || rollout.length > 0
}
