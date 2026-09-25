/**
 * The areas of work a knowledge section can serve. An industry or company-form
 * pack's reference file declares `areas: [..]` in its frontmatter; a curated
 * flow declares the areas it works in (agents.ts). When the flow starts, the
 * company's sections whose areas meet the flow's are inlined; the rest of the
 * pack stays loadable on demand.
 *
 * Browser-safe and dependency-free: the Agenter page and the atom generator
 * (scripts/lib/atom-discovery.ts) both import it.
 */
export const AREAS = ['lopande', 'moms', 'lon', 'fakturering', 'bokslut'] as const
export type Area = (typeof AREAS)[number]

export function isArea(value: unknown): value is Area {
  return typeof value === 'string' && (AREAS as readonly string[]).includes(value)
}

/** The areas an atom row carries in trigger_signals, ignoring anything malformed. */
export function areasOf(triggerSignals: unknown): Area[] {
  if (!triggerSignals || typeof triggerSignals !== 'object') return []
  const areas = (triggerSignals as { areas?: unknown }).areas
  return Array.isArray(areas) ? areas.filter(isArea) : []
}
