/**
 * BOLAGET_COMPANY_IDS: the Bolaget surfaces, here the register of prior
 * years' tax losses (underskottsregistret, IL 40 kap.): its section in the
 * year-end step, its routes, its operations and MCP tools, and the 4.14 a
 * prefill it gives the tax adjustments. Unset = off for every company.
 *
 * It rolls out per company, like SIGNING_ENABLED: `1`, `true` or `*` opens
 * it for every company, a comma-separated list of company ids for those
 * only. Every Bolaget wave reads the same variable; this file is the loss
 * register's own reader of it.
 *
 * With the switch off for a company, its tax adjustments behave exactly as
 * before the register existed (the manual 4.14 a entry), whatever rows the
 * register holds.
 */
type Env = Record<string, string | undefined>

export type LossCarryforwardRollout = 'all' | readonly string[]

function rollout(raw: string | undefined): LossCarryforwardRollout {
  const value = raw?.trim()
  if (!value) return []
  const lower = value.toLowerCase()
  if (lower === '1' || lower === 'true' || lower === '*') return 'all'
  return [...new Set(lower.split(',').map((s) => s.trim()).filter(Boolean))]
}

export function lossCarryforwardRollout(env: Env = process.env): LossCarryforwardRollout {
  return rollout(env.BOLAGET_COMPANY_IDS)
}

/** Whether the register is switched on for this company. */
export function lossCarryforwardEnabledFor(
  companyId: string | null | undefined,
  env: Env = process.env,
): boolean {
  const scope = lossCarryforwardRollout(env)
  if (scope === 'all') return true
  return Boolean(companyId) && scope.includes(companyId!.toLowerCase())
}

/**
 * Whether the register is open for any company at all: its operations are
 * discoverable (MCP search, the doors' listings) only then. Each run still
 * checks the company.
 */
export function lossCarryforwardDiscoverable(env: Env = process.env): boolean {
  const scope = lossCarryforwardRollout(env)
  return scope === 'all' || scope.length > 0
}
