/**
 * Arkiv phase 6: the autonomy ladder. A document type earns a lower audit
 * rate per company by having its audited records confirmed unchanged; a
 * person changing an audited field pulls the type back down. Levels are
 * recomputed nightly from the review activities of the last 90 days.
 */
export const AUDIT_WINDOW_DAYS = 90

/** Audits needed before a type can leave level 0. */
export const MIN_AUDITED = 10

export type AutonomyLevel = 0 | 1 | 2 | 3

/** One settled record in `oneIn` goes to a person at each level. */
export const AUDIT_ONE_IN_BY_LEVEL: Record<AutonomyLevel, number> = { 0: 20, 1: 40, 2: 80, 3: 160 }

export interface AuditTally {
  audited: number
  changed: number
}

export function autonomyLevel(tally: AuditTally): AutonomyLevel {
  if (tally.audited < MIN_AUDITED) return 0
  const rate = tally.changed / tally.audited
  if (rate <= 0.02) return 3
  if (rate <= 0.05) return 2
  if (rate <= 0.1) return 1
  return 0
}

export function auditOneIn(level: number | null | undefined): number {
  return AUDIT_ONE_IN_BY_LEVEL[(level ?? 0) as AutonomyLevel] ?? AUDIT_ONE_IN_BY_LEVEL[0]
}

/** Tallies review activities per schema type: an audit is a review whose detail carries `audit`. */
export function tallyAudits(activities: Array<{ schema_type: string | null; detail: unknown }>): Map<string, AuditTally> {
  const out = new Map<string, AuditTally>()
  for (const a of activities) {
    if (!a.schema_type || !a.detail || typeof a.detail !== 'object') continue
    const audit = (a.detail as { audit?: { changed?: boolean } }).audit
    if (!audit) continue
    const tally = out.get(a.schema_type) ?? { audited: 0, changed: 0 }
    tally.audited += 1
    if (audit.changed) tally.changed += 1
    out.set(a.schema_type, tally)
  }
  return out
}
