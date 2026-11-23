import type { KnowledgeOption } from '@/lib/agent-skills/knowledge-choices'
import { catalogueKnowledge } from '@/lib/agent-skills/knowledge-list'
import { rulesSegment } from './data'

/** One knowledge item as a row of the catalogue (a CatalogItem of the knowledge kind). */
export interface KnowledgeRow {
  key: string
  kind: 'rules'
  title: string
  desc: string
  href: string
  source: 'accounted'
  meta: null
  /** The industry or company-form item it is; none means it fits everyone. */
  categories: string[]
  popularity: number
  usedByFlows: number
}

/**
 * The catalogue's knowledge list as rows (lib/agent-skills/knowledge-list.ts
 * says which items it holds): each with its display name, its one line and
 * the page it opens. The Kunskap kind of the catalogue and the list in the
 * agent picture are both drawn from this.
 *
 * Pure: the names come in as functions, so it is tested without React.
 */
export function knowledgeRows(
  options: readonly KnowledgeOption[],
  hrefBase: string,
  label: { name: (id: string, title: string) => string; desc: (id: string, summary: string) => string },
  usedByFlows: (id: string) => number = () => 0,
): KnowledgeRow[] {
  return catalogueKnowledge(options).map((o) => ({
    key: o.id,
    kind: 'rules',
    title: label.name(o.id, o.title),
    desc: label.desc(o.id, o.summary),
    href: `${hrefBase}/${rulesSegment(o.id)}`,
    source: 'accounted',
    meta: null,
    categories: o.tier === 'vertical' || o.tier === 'modifier' ? [o.id] : [],
    popularity: usedByFlows(o.id),
    usedByFlows: usedByFlows(o.id),
  }))
}
