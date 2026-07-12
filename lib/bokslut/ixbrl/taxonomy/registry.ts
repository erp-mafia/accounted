/**
 * Typed access to the generated taxonomy concept registry.
 *
 * The registry JSON is generated from the official element lists by
 * scripts/generate-taxonomy-registry.ts: never edit it by hand. CI guards
 * staleness via `npm run taxonomy:check`.
 *
 * Taxonomy versions are data, not code: each version is its own generated
 * file selected through lib/bokslut/ixbrl/taxonomy/entry-points.ts, so the
 * September 2026 generation (dimensions instead of tuples) can ship as a new
 * registry + emitter without touching the K2 2024-09-12 path.
 */

import k2Ab20240912 from './generated/k2-ab-2024-09-12.json'

export interface TaxonomyConcept {
  /** Namespace prefix (e.g. "se-gen-base"); URI resolved per entry point. */
  ns: string
  /** Official Standardrubrik presentation label. */
  label: string
  abstract: boolean
  dataType: string | null
  balance: 'debit' | 'credit' | null
  periodType: 'duration' | 'instant' | null
  kind: 'item' | 'tuple'
  sections: string[]
}

export interface TaxonomyTupleMember {
  name: string
  ns: string
  required: boolean
}

export interface TaxonomyRegistry {
  _meta: {
    taxonomy: string
    version: string
    revision: string
    conceptCount: number
    tupleCount: number
  }
  concepts: Record<string, TaxonomyConcept>
  tuples: Record<string, { ns: string; members: TaxonomyTupleMember[] }>
}

const REGISTRIES: Record<string, TaxonomyRegistry> = {
  'k2-ab-2024-09-12': k2Ab20240912 as unknown as TaxonomyRegistry,
}

export function getRegistry(id: string): TaxonomyRegistry {
  const registry = REGISTRIES[id]
  if (!registry) {
    throw new Error(
      `Unknown taxonomy registry "${id}": known: ${Object.keys(REGISTRIES).join(', ')}`,
    )
  }
  return registry
}

export function getConcept(
  registry: TaxonomyRegistry,
  name: string,
): TaxonomyConcept | null {
  return registry.concepts[name] ?? null
}

/**
 * Lookup that throws on unknown concepts. The document builder uses this for
 * every fact it emits, so a typo'd element name fails generation instead of
 * producing an instance Bolagsverket rejects with 4001/4008.
 */
export function mustGetConcept(
  registry: TaxonomyRegistry,
  name: string,
): TaxonomyConcept {
  const concept = registry.concepts[name]
  if (!concept) {
    throw new Error(`Concept "${name}" not in taxonomy ${registry._meta.taxonomy} ${registry._meta.version}`)
  }
  return concept
}
