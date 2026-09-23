import type { CompanyGraph, GraphLink, GraphNode } from './types'

/**
 * The subgraph around one record: every node within `depth` hops, with the
 * links between them, plus a plain-text adjacency list. The JSON is what a
 * page draws; the text is what a model reads best.
 */
export interface Neighbourhood {
  center: string
  depth: number
  nodes: GraphNode[]
  links: GraphLink[]
  /** True when the walk stopped at the node cap; the picture is then partial and says so. */
  capped: boolean
  text: string
}

const NODE_CAP = 150

export function neighbourhoodOf(graph: CompanyGraph, ref: string, depth: number): Neighbourhood | null {
  const byRef = new Map(graph.nodes.map((n) => [n.ref, n]))
  if (!byRef.has(ref)) return null
  const adjacency = new Map<string, GraphLink[]>()
  for (const l of graph.links) {
    if (!adjacency.has(l.source)) adjacency.set(l.source, [])
    if (!adjacency.has(l.target)) adjacency.set(l.target, [])
    ;(adjacency.get(l.source) as GraphLink[]).push(l)
    ;(adjacency.get(l.target) as GraphLink[]).push(l)
  }
  const seen = new Map<string, number>([[ref, 0]])
  const queue = [ref]
  let capped = false
  while (queue.length) {
    const cur = queue.shift() as string
    const d = seen.get(cur) as number
    if (d >= depth) continue
    for (const l of adjacency.get(cur) ?? []) {
      const other = l.source === cur ? l.target : l.source
      if (seen.has(other)) continue
      if (seen.size >= NODE_CAP) {
        capped = true
        break
      }
      seen.set(other, d + 1)
      queue.push(other)
    }
  }
  const nodes = [...seen.keys()].map((r) => byRef.get(r)).filter((n): n is GraphNode => !!n)
  const links = graph.links.filter((l) => seen.has(l.source) && seen.has(l.target))
  return { center: ref, depth, nodes, links, capped, text: render(byRef.get(ref) as GraphNode, nodes, links, seen) }
}

const VERB: Record<GraphLink['kind'], string> = {
  posting: 'books against',
  source: 'has its source in',
  party: 'is with',
  matched: 'was paid through',
  upcoming: 'produces',
  authority: 'is behind',
  link: 'is linked to',
  role: 'is paid through',
  expected: 'is missing, judged from',
}

function evidenceText(e: Record<string, unknown>): string {
  const parts: string[] = []
  if (typeof e.amount === 'number') parts.push(`${Math.round(e.amount).toLocaleString('sv-SE').replace(/\u00a0/g, ' ')} kr`)
  if (typeof e.payments === 'number') parts.push(`${e.payments} payments`)
  if (typeof e.entries === 'number') parts.push(`${e.entries} entries`)
  if (typeof e.documents === 'number') parts.push(`${e.documents} documents`)
  if (typeof e.kind === 'string') parts.push(String(e.kind))
  return parts.length ? ` [${parts.join(', ')}]` : ''
}

function render(center: GraphNode, nodes: GraphNode[], links: GraphLink[], distance: Map<string, number>): string {
  const label = new Map(nodes.map((n) => [n.ref, n.label]))
  const lines = [`${center.label} (${center.ref}), ${center.cluster}`]
  const sorted = [...links].sort((a, b) => Math.min(distance.get(a.source) ?? 9, distance.get(a.target) ?? 9) - Math.min(distance.get(b.source) ?? 9, distance.get(b.target) ?? 9))
  for (const l of sorted) {
    lines.push(`${label.get(l.source)} (${l.source}) ${VERB[l.kind]} ${label.get(l.target)} (${l.target})${evidenceText(l.evidence)}`)
  }
  return lines.join('\n')
}
