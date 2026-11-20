import { describe, expect, it } from 'vitest'
import { DOT_GAP, dotSize, layoutGraph, STAGE_NARROW, STAGE_WIDE, type LayoutNode } from '../layout'
import type { GraphEdge } from '../types'

/** A web shaped like the real one: a hub, clusters hanging off second hubs, and cross links. */
function web(n: number): { nodes: LayoutNode[]; edges: GraphEdge[] } {
  const nodes: LayoutNode[] = Array.from({ length: n }, (_, i) => ({ id: `n${i}`, label: i % 3 === 0 ? `Namn ${i}` : '', quiet: i > 0 && i % 9 === 0 }))
  const edges: GraphEdge[] = []
  for (let i = 1; i < n; i++) {
    if (i % 4 === 0) edges.push([`n${i}`, `n${Math.max(1, i - 3)}`])
    else edges.push(['n0', `n${i}`])
    if (i % 7 === 0 && i > 8) edges.push([`n${i}`, `n${i - 8}`])
  }
  return { nodes, edges }
}

describe('layoutGraph', () => {
  it('gives the same picture for the same input, every time', () => {
    const { nodes, edges } = web(48)
    const a = layoutGraph(nodes, edges)
    const b = layoutGraph(nodes, edges)
    expect(b).toEqual(a)
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })

  it('changes with the seed, so the seed is what fixes the picture', () => {
    const { nodes, edges } = web(24)
    expect(layoutGraph(nodes, edges, STAGE_WIDE, 11).pos).not.toEqual(layoutGraph(nodes, edges, STAGE_WIDE, 12).pos)
  })

  it.each([
    ['wide', STAGE_WIDE, 80],
    ['wide', STAGE_WIDE, 46],
    ['narrow', STAGE_NARROW, 66],
    ['narrow', STAGE_NARROW, 20],
  ] as const)('puts no dot on top of another (%s stage, %i dots)', (_name, stage, n) => {
    const { nodes, edges } = web(n)
    const layout = layoutGraph(nodes, edges, stage)
    const ids = nodes.map((node) => node.id)
    // Tolerance: positions are rounded to one decimal, so a pair may sit a fraction inside its gap, never inside each other.
    const tolerance = DOT_GAP - 0.5
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const pa = layout.pos[ids[a]]
        const pb = layout.pos[ids[b]]
        const distance = Math.hypot(pa.x - pb.x, pa.y - pb.y)
        const touching = (layout.size[ids[a]] + layout.size[ids[b]]) / 2
        expect(distance, `${ids[a]} and ${ids[b]}`).toBeGreaterThanOrEqual(touching + DOT_GAP - tolerance)
      }
    }
  })

  it('keeps every dot on the stage', () => {
    for (const stage of [STAGE_WIDE, STAGE_NARROW]) {
      const { nodes, edges } = web(60)
      const layout = layoutGraph(nodes, edges, stage)
      for (const { x, y } of Object.values(layout.pos)) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true)
        expect(x).toBeGreaterThanOrEqual(0)
        expect(x).toBeLessThanOrEqual(stage.width)
        expect(y).toBeGreaterThanOrEqual(0)
        expect(y).toBeLessThanOrEqual(stage.height)
      }
    }
  })

  it('sizes a dot by its links and lists its neighbours', () => {
    const layout = layoutGraph([{ id: 'a', label: 'A' }, { id: 'b', label: '' }, { id: 'c', label: '' }], [['a', 'b'], ['a', 'c']])
    expect(layout.size.a).toBe(dotSize(2))
    expect(layout.size.b).toBe(dotSize(1))
    expect(layout.size.a).toBeGreaterThan(layout.size.b)
    expect(layout.neighbours.a).toEqual(['b', 'c'])
    expect(layout.neighbours.b).toEqual(['a'])
  })

  it('always names the first dot, never a quiet one, and never lets two names collide', () => {
    const { nodes, edges } = web(48)
    const layout = layoutGraph(nodes, edges)
    expect(layout.labelShown.n0).toBe(true)
    for (const node of nodes) {
      if (node.quiet) expect(layout.labelShown[node.id]).toBe(false)
      if (!node.label) expect(layout.labelShown[node.id]).toBe(false)
    }
    const shown = nodes.filter((node) => layout.labelShown[node.id] && node.id !== 'n0')
    const box = (node: LayoutNode) => {
      const w = 6.1 * node.label.length + 6
      const top = layout.pos[node.id].y + layout.size[node.id] / 2 + 3
      return [layout.pos[node.id].x - w / 2, top, layout.pos[node.id].x + w / 2, top + 14]
    }
    for (let a = 0; a < shown.length; a++) {
      for (let b = a + 1; b < shown.length; b++) {
        const p = box(shown[a])
        const q = box(shown[b])
        expect(p[2] < q[0] || p[0] > q[2] || p[3] < q[1] || p[1] > q[3], `${shown[a].id} and ${shown[b].id}`).toBe(true)
      }
    }
  })

  it('keeps a small web to the middle of the stage instead of its corners', () => {
    const layout = layoutGraph([{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }, { id: 'c', label: 'C' }], [['a', 'b'], ['a', 'c']])
    for (const { x, y } of Object.values(layout.pos)) {
      expect(Math.abs(x - STAGE_WIDE.width / 2)).toBeLessThan(STAGE_WIDE.width * 0.3)
      expect(Math.abs(y - STAGE_WIDE.height / 2)).toBeLessThan(STAGE_WIDE.height * 0.35)
    }
  })

  it('handles one dot, no dots and links to dots that do not exist', () => {
    expect(layoutGraph([], []).pos).toEqual({})
    const one = layoutGraph([{ id: 'a', label: 'A' }], [['a', 'ghost']])
    expect(one.pos.a.x).toBe(STAGE_WIDE.width / 2)
    expect(one.neighbours.a).toEqual([])
    expect(one.labelShown.a).toBe(true)
  })
})
