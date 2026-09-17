/**
 * Arkiv phase 9b: the graph read model. One picture of everything Accounted
 * knows about a company, for the page and for agents alike.
 *
 * The one rule: the graph is never a second truth. Every node is a row that
 * exists, every link is a foreign key, a match the pipeline made, or an
 * aggregate of those. A node's `ref` is the record reference the MCP tools
 * already take (agreement:<id>, party:<id>, document:<id>, fact:<id>), plus
 * the ledger and derived kinds this model adds.
 */
export type ClusterId = 'ledger' | 'party' | 'agreement' | 'document' | 'fact' | 'person' | 'authority' | 'upcoming'

export type NodeKind =
  | 'account'
  | 'party'
  | 'parties_folded'
  | 'agreement'
  | 'expected'
  | 'document'
  | 'documents_folded'
  | 'fact'
  | 'person'
  | 'authority'
  | 'obligation'
  | 'deadline'

export type LinkKind = 'posting' | 'source' | 'party' | 'matched' | 'upcoming' | 'authority' | 'link' | 'role' | 'expected'

export interface GraphNode {
  ref: string
  cluster: ClusterId
  kind: NodeKind
  label: string
  /** Relative size for a renderer: money moved, balance, or a count. Never a currency amount by itself. */
  weight: number
  /** Small, typed facts about the node: amount, ends_on, doc_type, count, since. */
  meta: Record<string, unknown>
}

export interface GraphLink {
  source: string
  target: string
  kind: LinkKind
  /** Why this link exists: a foreign key, a match, or an aggregate with counts and amounts. */
  evidence: Record<string, unknown>
}

export interface CompanyGraph {
  company: { ref: string; name: string }
  computed_at: string
  /** The twelve months the ledger side covers. */
  period: { from: string; to: string }
  /** Month keys (YYYY-MM) and per-account movement, so time is a filter over the same snapshot. */
  months: string[]
  series: Record<string, number[]>
  clusters: Array<{ id: ClusterId; label: string; count: number }>
  nodes: GraphNode[]
  links: GraphLink[]
  /** True when a source table was cut at its read limit; the picture is then a sample, and says so. */
  truncated: boolean
}

export const CLUSTER_LABELS: Record<ClusterId, string> = {
  ledger: 'Bokföring',
  party: 'Motparter',
  agreement: 'Avtal',
  document: 'Dokument',
  fact: 'Företagsfakta',
  person: 'Personer',
  authority: 'Myndigheter',
  upcoming: 'Kommande',
}
