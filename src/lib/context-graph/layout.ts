/**
 * Where the dots sit: a Fruchterman-Reingold spring layout with a pull to
 * the middle, run from a fixed seed.
 *
 * Deterministic: the same nodes and links give the same picture on every
 * run, on the server and in the browser alike. The only randomness is a
 * seeded generator for the starting points, and the maths is plus, minus,
 * times, divide and square root (all exactly specified), never Math.random
 * or a trig function. So the picture is stable between visits and hydration
 * cannot disagree.
 *
 * Units are the stage's own (STAGE_WIDE is 1000 by 460, STAGE_NARROW for a
 * phone); the component scales them to the pixels it has. Dot sizes and the
 * room a name needs are in the same units, counted as pixels at scale 1.
 *
 * Pure: no IO, no clock.
 */
import type { GraphEdge } from './types'

export interface Stage {
  width: number
  height: number
  /** Room at the sides for names, and at the top and bottom for the lowest names. */
  marginX: number
  marginY: number
}

export const STAGE_WIDE: Stage = { width: 1000, height: 460, marginX: 70, marginY: 34 }
/** Below 600px of room: nearly square, so the web fills a phone's width without growing tall. */
export const STAGE_NARROW: Stage = { width: 400, height: 340, marginX: 34, marginY: 26 }

export interface LayoutNode {
  id: string
  /** The name drawn under the dot; '' for none. Only its length matters here. */
  label: string
  /** A name that is the start of a sentence (a fact, a question): never drawn at rest, only on hover, when picked or zoomed in. */
  quiet?: boolean
}

export interface GraphLayout {
  stage: Stage
  /** Centre of each dot, in stage units, one decimal. */
  pos: Record<string, { x: number; y: number }>
  /** Diameter of each dot: more links, bigger dot. */
  size: Record<string, number>
  /** Whether the name fits at rest without covering a dot or another name. */
  labelShown: Record<string, boolean>
  neighbours: Record<string, string[]>
}

/** mulberry32: a small seeded generator, the same sequence everywhere. */
function seeded(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const round1 = (v: number) => Math.round(v * 10) / 10

/** The diameter of a dot with `degree` links. */
export function dotSize(degree: number): number {
  return Math.round(2 * (3 + 1.9 * Math.sqrt(degree)))
}

/** The space kept clear between two dots' edges. */
export const DOT_GAP = 5
/** Width of one character of a 12px Inter name, and the name's line height. */
const CHAR_W = 6.1
const LABEL_H = 14

export function layoutGraph(nodes: readonly LayoutNode[], edges: readonly GraphEdge[], stage: Stage = STAGE_WIDE, seed = 11, iterations = 420): GraphLayout {
  const { width: W, height: H, marginX, marginY } = stage
  const ids = nodes.map((n) => n.id)
  const n = ids.length
  const index = new Map(ids.map((id, i) => [id, i]))
  const links = edges
    .map(([a, b]) => [index.get(a), index.get(b)] as const)
    .filter((e): e is readonly [number, number] => e[0] !== undefined && e[1] !== undefined && e[0] !== e[1])

  const degree = new Array<number>(n).fill(0)
  const neighbourSets = ids.map(() => new Set<number>())
  for (const [a, b] of links) {
    degree[a]++
    degree[b]++
    neighbourSets[a].add(b)
    neighbourSets[b].add(a)
  }
  const size = degree.map(dotSize)

  const x = new Array<number>(n)
  const y = new Array<number>(n)
  const random = seeded(seed)
  for (let i = 0; i < n; i++) {
    x[i] = (0.25 + 0.5 * random()) * W
    y[i] = (0.25 + 0.5 * random()) * H
  }

  if (n > 1) {
    const k = 0.95 * Math.sqrt((W * H) / n)
    // A wide stage pushes harder up and down, so the web spreads sideways.
    const stretch = Math.min(2, Math.max(1, (W / H) * 0.875))
    const pullY = 0.1 + 0.06 * ((stretch - 1) / 0.9)
    let t = W / 8
    const dx = new Array<number>(n)
    const dy = new Array<number>(n)
    for (let it = 0; it < iterations; it++) {
      dx.fill(0)
      dy.fill(0)
      for (let a = 0; a < n; a++) {
        for (let b = a + 1; b < n; b++) {
          const ex = x[a] - x[b]
          const ey = (y[a] - y[b]) * stretch
          const d = Math.sqrt(ex * ex + ey * ey) || 0.01
          const f = (k * k) / d
          dx[a] += (ex / d) * f
          dy[a] += (ey / d) * f
          dx[b] -= (ex / d) * f
          dy[b] -= (ey / d) * f
        }
      }
      for (const [a, b] of links) {
        const ex = x[a] - x[b]
        const ey = y[a] - y[b]
        const d = Math.sqrt(ex * ex + ey * ey) || 0.01
        // A busy dot pulls each neighbour less, so its ring opens up.
        const f = (d * d) / k / (1 + 0.16 * Math.max(degree[a], degree[b]))
        dx[a] -= (ex / d) * f
        dy[a] -= (ey / d) * f
        dx[b] += (ex / d) * f
        dy[b] += (ey / d) * f
      }
      for (let i = 0; i < n; i++) {
        dx[i] += (W / 2 - x[i]) * 0.1
        dy[i] += (H / 2 - y[i]) * pullY
        const d = Math.sqrt(dx[i] * dx[i] + dy[i] * dy[i]) || 0.01
        const step = Math.min(d, t)
        x[i] += (dx[i] / d) * step
        y[i] += (dy[i] / d) * step
      }
      t *= 0.985
    }
  }

  // Fit the settled web to the stage. A small web keeps to the middle: a few dots spread to the corners read as an accident.
  const fill = Math.min(1, Math.sqrt(n / 14))
  const boxW = (W - 2 * marginX) * fill
  const boxH = (H - 2 * marginY - 18) * fill
  const left = (W - boxW) / 2
  const top = marginY + (H - 2 * marginY - 18 - boxH) / 2
  let x0 = Infinity
  let x1 = -Infinity
  let y0 = Infinity
  let y1 = -Infinity
  for (let i = 0; i < n; i++) {
    x0 = Math.min(x0, x[i])
    x1 = Math.max(x1, x[i])
    y0 = Math.min(y0, y[i])
    y1 = Math.max(y1, y[i])
  }
  for (let i = 0; i < n; i++) {
    x[i] = x1 > x0 ? left + ((x[i] - x0) / (x1 - x0)) * boxW : W / 2
    y[i] = y1 > y0 ? top + ((y[i] - y0) / (y1 - y0)) * boxH : top + boxH / 2
  }

  // No dot on top of another: push apart any pair closer than their radii plus the gap.
  for (let pass = 0; pass < 80; pass++) {
    let moved = false
    for (let a = 0; a < n; a++) {
      for (let b = a + 1; b < n; b++) {
        const need = (size[a] + size[b]) / 2 + DOT_GAP
        let ex = x[b] - x[a]
        let ey = y[b] - y[a]
        let d = Math.sqrt(ex * ex + ey * ey)
        if (d >= need) continue
        if (d < 0.01) {
          // Exactly on top of each other: part them along a direction the pair's own numbers pick.
          ex = ((a * 7 + b * 3) % 5) - 2 || 1
          ey = ((a * 3 + b * 7) % 5) - 2
          d = Math.sqrt(ex * ex + ey * ey)
        }
        const push = (need - d) / 2 + 0.05
        x[a] -= (ex / d) * push
        y[a] -= (ey / d) * push
        x[b] += (ex / d) * push
        y[b] += (ey / d) * push
        moved = true
      }
    }
    if (!moved) break
  }

  const pos: GraphLayout['pos'] = {}
  const sizes: GraphLayout['size'] = {}
  const neighbours: GraphLayout['neighbours'] = {}
  ids.forEach((id, i) => {
    pos[id] = { x: round1(x[i]), y: round1(y[i]) }
    sizes[id] = size[i]
    neighbours[id] = [...neighbourSets[i]].sort((p, q) => p - q).map((j) => ids[j])
  })

  // Names at rest: the best connected dots first, each name only where it covers no dot and no earlier name.
  type Box = [number, number, number, number]
  const boxes: Box[] = ids.map((id, i) => [pos[id].x - size[i] / 2 - 2, pos[id].y - size[i] / 2 - 2, pos[id].x + size[i] / 2 + 2, pos[id].y + size[i] / 2 + 2])
  const labelShown: GraphLayout['labelShown'] = {}
  const order = ids.map((_, i) => i).sort((a, b) => (a === 0 ? -1 : b === 0 ? 1 : degree[b] - degree[a] || a - b))
  for (const i of order) {
    const id = ids[i]
    const label = nodes[i].label
    labelShown[id] = false
    if (!label || nodes[i].quiet) continue
    const w = CHAR_W * label.length + 6
    const box: Box = [pos[id].x - w / 2, pos[id].y + size[i] / 2 + 3, pos[id].x + w / 2, pos[id].y + size[i] / 2 + 3 + LABEL_H]
    if (i !== 0 && (box[0] < 4 || box[2] > W - 4)) continue
    // The first node (the agent) always carries its name.
    if (i === 0 || boxes.every((o) => box[2] < o[0] || box[0] > o[2] || box[3] < o[1] || box[1] > o[3])) {
      labelShown[id] = true
      boxes.push(box)
    }
  }

  return { stage, pos, size: sizes, labelShown, neighbours }
}
