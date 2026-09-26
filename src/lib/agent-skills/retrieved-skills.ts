import { REGISTRY_SKILLS, type RegistrySkillId } from './registry'

/**
 * One thing an agent retrieved before it staged an operation, named the way
 * the Instruktioner page names it: an Accounted flow, a knowledge pack, one
 * of Accounted's analyses, or the company's own item. Anything else (an older
 * workflow skill, a community item) keeps its slug.
 */
export type RetrievedSkill =
  | { kind: 'workflow'; id: RegistrySkillId }
  | { kind: 'knowledge'; id: string }
  | { kind: 'analysis'; slug: string }
  | { kind: 'own' }
  | { kind: 'other'; slug: string }

const REGISTRY_IDS = new Set<string>(REGISTRY_SKILLS.map((s) => s.id))
const PACK_TIERS = new Set(['horizontal', 'vertical', 'modifier'])

function describe(slug: string): RetrievedSkill {
  // Kvittojakten is served as one body per client (kvittojakten-claude), shown as one flow.
  const flow = slug.startsWith('kvittojakten-') ? 'kvittojakten' : slug
  if (REGISTRY_IDS.has(flow)) return { kind: 'workflow', id: flow as RegistrySkillId }
  const [tier, pack] = slug.split('/')
  // A reference (horizontal/swedish-vat/vat-compliance-reference) counts as its pack.
  if (PACK_TIERS.has(tier) && pack) return { kind: 'knowledge', id: `${tier}/${pack}` }
  if (tier === 'own' && pack) return { kind: 'own' }
  if (tier === 'community' && pack) return { kind: 'other', slug: pack }
  if (slug.startsWith('analys-')) return { kind: 'analysis', slug }
  return { kind: 'other', slug }
}

/**
 * The retrieval evidence on a pending operation (agent_metadata.skills_loaded)
 * as people-facing items, first seen first. A flow and its references, or the
 * same pack loaded twice, read once; the company's own items read as one
 * "own instruction" so no uuid reaches the page.
 */
export function describeRetrievedSkills(slugs: readonly string[]): RetrievedSkill[] {
  const seen = new Set<string>()
  const out: RetrievedSkill[] = []
  for (const slug of slugs) {
    const item = describe(slug)
    const key = JSON.stringify(item)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(item)
  }
  return out
}
