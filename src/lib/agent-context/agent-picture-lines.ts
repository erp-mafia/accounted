/**
 * The lines of the agent picture, from where its cards ended up.
 *
 * The picture has three columns: what is connected, one card for the company
 * and the agents. Every card on the left is joined to one point on the
 * company's card, and that card to every agent. The page measures the cards
 * after layout and hands the rectangles here; this module only turns them
 * into SVG paths.
 *
 * Pure and browser-safe: no DOM, no IO.
 */

/** A measured rectangle, in viewport coordinates (a DOMRect's own fields). */
export interface FlowRect {
  left: number
  top: number
  width: number
  height: number
}

export interface FlowCard {
  id: string
  /** `in`: a source, left of the company's card. `out`: an agent, right of it. */
  side: 'in' | 'out'
  rect: FlowRect
  /** A connected card gets a solid line, any other a dashed one. */
  connected: boolean
  /** Something is passing along the line right now. */
  active: boolean
}

export interface FlowInput {
  /** The element the lines are drawn over: every coordinate is made relative to it. */
  map: FlowRect
  /** The company's card. */
  core: FlowRect
  cards: FlowCard[]
  /** The whole left and right columns: where the one connector meets them when the columns are stacked. */
  inColumn: FlowRect | null
  outColumn: FlowRect | null
}

export interface FlowLine {
  id: string
  d: string
  dashed: boolean
  active: boolean
}

export interface FlowLayout {
  width: number
  height: number
  /** True when the columns are stacked and one straight connector joins the groups. */
  stacked: boolean
  lines: FlowLine[]
  /** Where a line meets a card: a small ring is drawn there. */
  sockets: Array<{ x: number; y: number }>
}

const n = (v: number): string => v.toFixed(1)

const right = (r: FlowRect): number => r.left + r.width
const bottom = (r: FlowRect): number => r.top + r.height
const middleY = (r: FlowRect): number => r.top + r.height / 2

/** A curve that leaves and arrives horizontally. */
function curve(a: readonly [number, number], b: readonly [number, number]): string {
  const mid = (a[0] + b[0]) / 2
  return `M${n(a[0])} ${n(a[1])} C${n(mid)} ${n(a[1])},${n(mid)} ${n(b[1])},${n(b[0])} ${n(b[1])}`
}

function straight(a: readonly [number, number], b: readonly [number, number]): string {
  return `M${n(a[0])} ${n(a[1])} L${n(b[0])} ${n(b[1])}`
}

/**
 * The lines for a measured picture, or null when there is nothing to draw
 * (no cards, or a map with no width yet).
 *
 * Side by side (the first card ends left of the company's card): one curve
 * per card, into the middle of the company card's left edge and out of the
 * middle of its right edge. Stacked: one straight connector from the left
 * column down into the company's card and one from it down to the agents.
 */
export function flowLayout(input: FlowInput): FlowLayout | null {
  const { map, core, cards } = input
  if (cards.length === 0 || !(map.width > 0)) return null
  const x = (v: number) => v - map.left
  const y = (v: number) => v - map.top

  const lines: FlowLine[] = []
  const sockets: Array<{ x: number; y: number }> = []
  const stacked = right(cards[0].rect) > core.left

  if (!stacked) {
    const inPoint = [x(core.left), y(middleY(core))] as const
    const outPoint = [x(right(core)), y(middleY(core))] as const
    for (const card of cards) {
      const cy = y(middleY(card.rect))
      if (card.side === 'in') {
        const from = [x(right(card.rect)), cy] as const
        lines.push({ id: card.id, d: curve(from, inPoint), dashed: !card.connected, active: card.active })
        sockets.push({ x: from[0], y: from[1] })
      } else {
        const to = [x(card.rect.left), cy] as const
        lines.push({ id: card.id, d: curve(outPoint, to), dashed: !card.connected, active: card.active })
        sockets.push({ x: to[0], y: to[1] })
      }
    }
    if (cards.some((card) => card.side === 'in')) sockets.push({ x: inPoint[0], y: inPoint[1] })
    if (cards.some((card) => card.side === 'out')) sockets.push({ x: outPoint[0], y: outPoint[1] })
  } else {
    const cx = x(core.left + core.width / 2)
    const activeOn = (side: FlowCard['side']) => cards.some((card) => card.side === side && card.active)
    if (input.inColumn && cards.some((card) => card.side === 'in')) {
      lines.push({ id: 'in', d: straight([cx, y(bottom(input.inColumn))], [cx, y(core.top)]), dashed: false, active: activeOn('in') })
    }
    if (input.outColumn && cards.some((card) => card.side === 'out')) {
      lines.push({ id: 'out', d: straight([cx, y(bottom(core))], [cx, y(input.outColumn.top)]), dashed: false, active: activeOn('out') })
    }
  }

  return { width: map.width, height: map.height, stacked, lines, sockets }
}

/** How recent a call has to be for its connection to read as working right now. */
export const READING_NOW_SECONDS = 60

/**
 * Whether a connection's last call is recent enough to say it is reading
 * now. Both instants come from the server (the activity answer carries its
 * own clock), so the browser's clock never decides.
 */
export function isReadingNow(lastCallAt: string | null | undefined, now: string | Date, windowSeconds = READING_NOW_SECONDS): boolean {
  if (!lastCallAt) return false
  const last = Date.parse(lastCallAt)
  const at = typeof now === 'string' ? Date.parse(now) : now.getTime()
  if (Number.isNaN(last) || Number.isNaN(at)) return false
  // The log's clock and the server's can differ by a moment: a call stamped
  // slightly ahead is still a call made just now.
  return Math.abs(at - last) / 1000 <= windowSeconds
}
