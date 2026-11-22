/**
 * BOLAGET_COMPANY_IDS: the Bolaget registers (aktiebok, roles over time,
 * firmateckning, verkliga huvudmän) and their pages, API and MCP doors.
 * Unset = nobody, until the operators flip it.
 *
 * It rolls out per company, like SIGNING_ENABLED and ARKIV_COMPANY_IDS:
 * `*` opens it for every company, a comma-separated list of company ids for
 * those only. Every Bolaget wave reads this one variable, so the registers,
 * the meetings and the capital events switch on together.
 *
 * BOLAGET_REGISTERS_COMPANY_IDS, read the same way, opens the registers
 * alone (aktiebok, styrelse och firmateckning, verkliga huvudmän) for the
 * companies it names: the meetings, the capital events and the owner tax
 * stay on BOLAGET_COMPANY_IDS. A company in either list has the registers.
 *
 * What the switch never stops: the rows already written. The aktiebok is a
 * statutory register (ABL 5:3): switching the surfaces off hides them, it
 * does not delete or change an entry.
 */
type Env = Record<string, string | undefined>

export type BolagetRollout = 'all' | readonly string[]

function readRollout(value: string | undefined): BolagetRollout {
  const raw = value?.trim()
  if (!raw) return []
  if (raw === '*') return 'all'
  return [...new Set(raw.toLowerCase().split(',').map((s) => s.trim()).filter(Boolean))]
}

function inRollout(rollout: BolagetRollout, companyId: string): boolean {
  return rollout === 'all' || rollout.includes(companyId.toLowerCase())
}

/** The companies in the rollout: `'all'` for `*`, else the listed ids (lowercased, each once). */
export function bolagetRollout(env: Env = process.env): BolagetRollout {
  return readRollout(env.BOLAGET_COMPANY_IDS)
}

/** The companies that have the registers alone (BOLAGET_REGISTERS_COMPANY_IDS), read like the rollout. */
export function bolagetRegistersRollout(env: Env = process.env): BolagetRollout {
  return readRollout(env.BOLAGET_REGISTERS_COMPANY_IDS)
}

/** Whether the Bolaget registers are switched on for this company. */
export function isBolagetEnabled(companyId: string | null | undefined, env: Env = process.env): boolean {
  if (!companyId) return false
  return inRollout(bolagetRollout(env), companyId)
}

/**
 * Whether the registers (aktiebok, styrelse och firmateckning, verkliga
 * huvudmän) are switched on for this company: by the registers' own list or
 * by the whole rollout.
 */
export function isBolagetRegistersEnabled(companyId: string | null | undefined, env: Env = process.env): boolean {
  if (!companyId) return false
  return inRollout(bolagetRegistersRollout(env), companyId) || inRollout(bolagetRollout(env), companyId)
}

/** Whether either list names any company: the register operations exist only then. */
export function bolagetRegistersConfigured(env: Env = process.env): boolean {
  const named = (rollout: BolagetRollout) => rollout === 'all' || rollout.length > 0
  return named(bolagetRegistersRollout(env)) || named(bolagetRollout(env))
}
