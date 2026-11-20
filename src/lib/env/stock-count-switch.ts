/**
 * BOLAGET_COMPANY_IDS: the Bolaget surfaces, here the year-end stock count
 * (inventeringslista, LIV 1955:257): its page under bokslut, its routes and
 * its MCP tools. Comma-separated company ids, or `*` for every company;
 * unset means nobody, so the feature ships dark.
 *
 * The same variable gates every Bolaget wave; this file reads it for the
 * stock count only, parsed the way lib/env/signing-switch.ts parses its own.
 */
type Env = Record<string, string | undefined>

export type StockCountRollout = 'all' | readonly string[]

export function stockCountRollout(env: Env = process.env): StockCountRollout {
  const value = env.BOLAGET_COMPANY_IDS?.trim()
  if (!value) return []
  if (value === '*') return 'all'
  return [...new Set(value.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))]
}

/** Whether any company has the stock count: the MCP tools are listed only then. */
export function stockCountConfigured(env: Env = process.env): boolean {
  const rollout = stockCountRollout(env)
  return rollout === 'all' || rollout.length > 0
}

/** Whether the stock count is switched on for this company. */
export function stockCountEnabledFor(companyId: string | null | undefined, env: Env = process.env): boolean {
  if (!companyId) return false
  const rollout = stockCountRollout(env)
  return rollout === 'all' || rollout.includes(companyId.toLowerCase())
}
