import { describe, expect, it } from 'vitest'
import { flowLayout, isReadingNow, type FlowCard, type FlowRect } from '../agent-picture-lines'

const rect = (left: number, top: number, width: number, height: number): FlowRect => ({ left, top, width, height })

// A map at (100, 50), 900 wide: sources on the left, the company's card in the middle, agents on the right.
const MAP = rect(100, 50, 900, 400)
const CORE = rect(400, 150, 300, 200)
const card = (id: string, side: FlowCard['side'], r: FlowRect, over: Partial<FlowCard> = {}): FlowCard => ({
  id,
  side,
  rect: r,
  connected: true,
  active: false,
  ...over,
})

describe('flowLayout', () => {
  it('draws nothing without cards or before the map has a width', () => {
    expect(flowLayout({ map: MAP, core: CORE, cards: [], inColumn: null, outColumn: null })).toBeNull()
    expect(
      flowLayout({ map: rect(0, 0, 0, 0), core: CORE, cards: [card('a', 'in', rect(100, 60, 200, 52))], inColumn: null, outColumn: null }),
    ).toBeNull()
  })

  it('joins every source to one point on the left edge of the company card, relative to the map', () => {
    const layout = flowLayout({
      map: MAP,
      core: CORE,
      cards: [card('bank', 'in', rect(100, 60, 200, 52)), card('skv', 'in', rect(100, 130, 200, 52))],
      inColumn: rect(100, 60, 200, 122),
      outColumn: null,
    })!
    expect(layout.stacked).toBe(false)
    expect(layout.width).toBe(900)
    expect(layout.height).toBe(400)
    // The company card's left edge is at x 300 in the map, its middle at y 200.
    expect(layout.lines.map((l) => l.id)).toEqual(['bank', 'skv'])
    expect(layout.lines[0].d).toBe('M200.0 36.0 C250.0 36.0,250.0 200.0,300.0 200.0')
    expect(layout.lines[1].d).toBe('M200.0 106.0 C250.0 106.0,250.0 200.0,300.0 200.0')
    // One socket per card and one where they meet; none on the right with no agents.
    expect(layout.sockets).toEqual([
      { x: 200, y: 36 },
      { x: 200, y: 106 },
      { x: 300, y: 200 },
    ])
  })

  it('leaves the right edge of the company card for every agent', () => {
    const layout = flowLayout({
      map: MAP,
      core: CORE,
      cards: [card('bank', 'in', rect(100, 60, 200, 52)), card('claude', 'out', rect(800, 100, 200, 52))],
      inColumn: null,
      outColumn: null,
    })!
    const out = layout.lines.find((l) => l.id === 'claude')!
    // From (600, 200), the right edge, to the agent card's left edge at (700, 76).
    expect(out.d).toBe('M600.0 200.0 C650.0 200.0,650.0 76.0,700.0 76.0')
    expect(layout.sockets).toContainEqual({ x: 600, y: 200 })
    expect(layout.sockets).toContainEqual({ x: 700, y: 76 })
  })

  it('reads the layout off the agents when there are no sources', () => {
    const side = flowLayout({ map: MAP, core: CORE, cards: [card('claude', 'out', rect(800, 100, 200, 52))], inColumn: null, outColumn: null })!
    expect(side.stacked).toBe(false)
    expect(side.lines.map((l) => l.id)).toEqual(['claude'])
    const below = flowLayout({
      map: rect(0, 0, 332, 700),
      core: rect(16, 300, 300, 200),
      cards: [card('claude', 'out', rect(16, 560, 300, 52))],
      inColumn: null,
      outColumn: rect(16, 540, 300, 100),
    })!
    expect(below.stacked).toBe(true)
    expect(below.lines.map((l) => l.id)).toEqual(['out'])
  })

  it('dashes the line of a card that is not connected and marks an active one', () => {
    const layout = flowLayout({
      map: MAP,
      core: CORE,
      cards: [
        card('stripe', 'in', rect(100, 60, 200, 52), { connected: false }),
        card('claude', 'out', rect(800, 100, 200, 52), { active: true }),
      ],
      inColumn: null,
      outColumn: null,
    })!
    expect(layout.lines.find((l) => l.id === 'stripe')).toMatchObject({ dashed: true, active: false })
    expect(layout.lines.find((l) => l.id === 'claude')).toMatchObject({ dashed: false, active: true })
  })

  it('joins stacked columns with one straight connector each way', () => {
    // A narrow screen: every card is as wide as the company card and above or below it.
    const core = rect(16, 300, 300, 200)
    const layout = flowLayout({
      map: rect(0, 0, 332, 700),
      core,
      cards: [
        card('bank', 'in', rect(16, 20, 300, 52)),
        card('skv', 'in', rect(16, 80, 300, 52), { connected: false }),
        card('claude', 'out', rect(16, 560, 300, 52), { active: true }),
      ],
      inColumn: rect(16, 20, 300, 240),
      outColumn: rect(16, 540, 300, 100),
    })!
    expect(layout.stacked).toBe(true)
    expect(layout.sockets).toEqual([])
    expect(layout.lines).toEqual([
      { id: 'in', d: 'M166.0 260.0 L166.0 300.0', dashed: false, active: false },
      { id: 'out', d: 'M166.0 500.0 L166.0 540.0', dashed: false, active: true },
    ])
  })

  it('draws no connector to a column that has no cards', () => {
    const layout = flowLayout({
      map: rect(0, 0, 332, 700),
      core: rect(16, 300, 300, 200),
      cards: [card('bank', 'in', rect(16, 20, 300, 52))],
      inColumn: rect(16, 20, 300, 240),
      outColumn: rect(16, 540, 300, 100),
    })!
    expect(layout.lines.map((l) => l.id)).toEqual(['in'])
  })
})

describe('isReadingNow', () => {
  const now = '2026-03-02T10:00:00.000Z'

  it('is true for a call within the last minute', () => {
    expect(isReadingNow('2026-03-02T09:59:10.000Z', now)).toBe(true)
    expect(isReadingNow('2026-03-02T09:59:00.000Z', now)).toBe(true)
  })

  it('is false for an older call, no call or an unreadable time', () => {
    expect(isReadingNow('2026-03-02T09:58:59.000Z', now)).toBe(false)
    expect(isReadingNow(null, now)).toBe(false)
    expect(isReadingNow('not a time', now)).toBe(false)
    expect(isReadingNow('2026-03-02T09:59:30.000Z', 'not a time')).toBe(false)
  })

  it('takes a call stamped a moment ahead of the server clock as made now', () => {
    expect(isReadingNow('2026-03-02T10:00:02.000Z', new Date(now))).toBe(true)
  })
})
