import { describe, it, expect } from 'vitest'
import { neighbourhoodOf } from '../neighbourhood'
import type { CompanyGraph } from '../types'

const graph: CompanyGraph = {
  company: { ref: 'company:c', name: 'X' },
  version: 2,
  computed_at: '2026-10-01T00:00:00Z',
  period: { from: '2025-10-01', to: '2026-10-01' },
  months: [],
  series: {},
  clusters: [],
  nodes: [
    { ref: 'agreement:a', cluster: 'agreement', kind: 'agreement', label: 'Låneavtal Almi', weight: 5, meta: {} },
    { ref: 'party:p', cluster: 'party', kind: 'party', label: 'Almi', weight: 3, meta: {} },
    { ref: 'account:2350', cluster: 'ledger', kind: 'account', label: '2350 Banklån', weight: 4, meta: {} },
    { ref: 'document:d', cluster: 'document', kind: 'document', label: 'Skuldebrev.pdf', weight: 2, meta: {} },
    { ref: 'authority:skatteverket', cluster: 'authority', kind: 'authority', label: 'Skatteverket', weight: 4, meta: {} },
    { ref: 'account:2610', cluster: 'ledger', kind: 'account', label: '2610 Moms', weight: 2, meta: {} },
  ],
  links: [
    { source: 'agreement:a', target: 'party:p', kind: 'party', evidence: { kind: 'fk' } },
    { source: 'agreement:a', target: 'account:2350', kind: 'matched', evidence: { kind: 'match', amount: 31251, payments: 3 } },
    { source: 'agreement:a', target: 'document:d', kind: 'source', evidence: { kind: 'fk' } },
    { source: 'authority:skatteverket', target: 'account:2610', kind: 'posting', evidence: { kind: 'derived' } },
  ],
  truncated: false,
}

describe('neighbourhoodOf', () => {
  it('walks the hops around one record and writes the adjacency in plain words', () => {
    const one = neighbourhoodOf(graph, 'agreement:a', 1)
    expect(one?.nodes.map((n) => n.ref).sort()).toEqual(['account:2350', 'agreement:a', 'document:d', 'party:p'])
    expect(one?.links).toHaveLength(3)
    expect(one?.text).toContain('Låneavtal Almi (agreement:a), agreement')
    expect(one?.text).toContain('Låneavtal Almi (agreement:a) was paid through 2350 Banklån (account:2350) [31 251 kr, 3 payments, match]')
    expect(one?.capped).toBe(false)
  })

  it('reaches further with depth, and answers null for a ref that is not in the graph', () => {
    const two = neighbourhoodOf(graph, 'party:p', 2)
    expect(two?.nodes.map((n) => n.ref).sort()).toEqual(['account:2350', 'agreement:a', 'document:d', 'party:p'])
    expect(neighbourhoodOf(graph, 'party:p', 1)?.nodes).toHaveLength(2)
    expect(neighbourhoodOf(graph, 'party:nope', 1)).toBeNull()
  })
})
