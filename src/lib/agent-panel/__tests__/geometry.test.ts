import { describe, it, expect } from 'vitest'
import {
  DOCK_WIDTH_DEFAULT,
  DOCK_WIDTH_MIN,
  DOCK_WIDTH_MAX,
  DOCK_GUTTER,
  MIN_PAGE_WIDTH,
  EXPANDED_WIDTH_MAX,
  FLOAT_MIN_W,
  FLOAT_MIN_H,
  FLOAT_KEEP_ON_SCREEN,
  clampDockWidth,
  clampFloatRect,
  containFloatRect,
  defaultFloatRect,
  expandedDockWidth,
  resizeFloatRect,
  resolveAgentPanelPrefs,
  serializeAgentPanelPrefs,
} from '../geometry'

const WIDE = 1920
const TALL = 1080
const NAV = 248

describe('resolveAgentPanelPrefs', () => {
  it('defaults on absent input', () => {
    expect(resolveAgentPanelPrefs(undefined)).toEqual({
      mode: 'docked',
      dockWidth: DOCK_WIDTH_DEFAULT,
      float: null,
    })
  })

  it('keeps a valid persisted state', () => {
    const prefs = resolveAgentPanelPrefs({
      mode: 'floating',
      dock_width: 600,
      float: { x: 100, y: 50, w: 500, h: 700 },
    })
    expect(prefs).toEqual({
      mode: 'floating',
      dockWidth: 600,
      float: { x: 100, y: 50, w: 500, h: 700 },
    })
  })

  it('discards garbage values instead of propagating them', () => {
    const prefs = resolveAgentPanelPrefs({
      mode: 'floating',
      dock_width: Number.NaN,
      // Partial/garbage rect: one bad member invalidates the whole rect.
      float: { x: 10, y: 10, w: Number.POSITIVE_INFINITY, h: 400 },
    })
    expect(prefs.dockWidth).toBe(DOCK_WIDTH_DEFAULT)
    expect(prefs.float).toBeNull()
  })

  it('hard-clamps a persisted dock width to the fixed bounds', () => {
    expect(resolveAgentPanelPrefs({ dock_width: 40 }).dockWidth).toBe(DOCK_WIDTH_MIN)
    expect(resolveAgentPanelPrefs({ dock_width: 4000 }).dockWidth).toBe(DOCK_WIDTH_MAX)
  })
})

describe('serializeAgentPanelPrefs', () => {
  it('rounds pixels to integers (the API schema rejects fractions)', () => {
    expect(
      serializeAgentPanelPrefs({
        mode: 'floating',
        dockWidth: 480.6,
        float: { x: 10.4, y: 20.5, w: 400.2, h: 500.9 },
      }),
    ).toEqual({
      mode: 'floating',
      dock_width: 481,
      float: { x: 10, y: 21, w: 400, h: 501 },
    })
  })

  it('omits float when there is none', () => {
    expect(serializeAgentPanelPrefs({ mode: 'docked', dockWidth: 480, float: null })).toEqual({
      mode: 'docked',
      dock_width: 480,
    })
  })
})

describe('clampDockWidth', () => {
  it('passes through a width the viewport can afford', () => {
    expect(clampDockWidth(600, WIDE, NAV)).toBe(600)
  })

  it('caps at the fixed maximum on huge viewports', () => {
    expect(clampDockWidth(5000, 3840, NAV)).toBe(DOCK_WIDTH_MAX)
  })

  it('never lets the page drop below its minimum readable width', () => {
    const viewport = 1280
    const clamped = clampDockWidth(DOCK_WIDTH_MAX, viewport, NAV)
    expect(viewport - NAV - clamped - DOCK_GUTTER).toBeGreaterThanOrEqual(MIN_PAGE_WIDTH)
  })

  it('floors at the panel minimum even when the viewport is too small for both', () => {
    expect(clampDockWidth(100, 900, NAV)).toBe(DOCK_WIDTH_MIN)
  })
})

describe('expandedDockWidth', () => {
  it('caps at the fixed expanded maximum on huge viewports', () => {
    expect(expandedDockWidth(3840, NAV)).toBe(EXPANDED_WIDTH_MAX)
  })

  it('reserves the minimum page width on mid-size viewports', () => {
    const viewport = 1440
    expect(expandedDockWidth(viewport, NAV)).toBe(viewport - NAV - MIN_PAGE_WIDTH - DOCK_GUTTER)
  })

  it('floors at the default compact width', () => {
    expect(expandedDockWidth(1000, NAV)).toBe(DOCK_WIDTH_DEFAULT)
  })
})

describe('clampFloatRect', () => {
  it('keeps a legal rect unchanged', () => {
    const rect = { x: 200, y: 100, w: 420, h: 640 }
    expect(clampFloatRect(rect, WIDE, TALL)).toEqual(rect)
  })

  it('enforces minimum size', () => {
    const r = clampFloatRect({ x: 0, y: 0, w: 10, h: 10 }, WIDE, TALL)
    expect(r.w).toBe(FLOAT_MIN_W)
    expect(r.h).toBe(FLOAT_MIN_H)
  })

  it('keeps the panel reachable when dragged off the right edge', () => {
    const r = clampFloatRect({ x: 99999, y: 100, w: 420, h: 640 }, WIDE, TALL)
    expect(r.x).toBe(WIDE - FLOAT_KEEP_ON_SCREEN)
  })

  it('never lets the header go above the top edge', () => {
    const r = clampFloatRect({ x: 100, y: -500, w: 420, h: 640 }, WIDE, TALL)
    expect(r.y).toBe(0)
  })

  it('keeps the header reachable at the bottom', () => {
    const r = clampFloatRect({ x: 100, y: 99999, w: 420, h: 640 }, WIDE, TALL)
    expect(r.y).toBe(TALL - FLOAT_KEEP_ON_SCREEN)
  })
})

describe('containFloatRect', () => {
  it('keeps a fully visible rect unchanged', () => {
    const rect = { x: 200, y: 100, w: 420, h: 640 }
    expect(containFloatRect(rect, WIDE, TALL)).toEqual(rect)
  })

  it('pulls a right-edge sliver fully inside the viewport', () => {
    // x = 1392 is legal for clampFloatRect (48px visible) but renders as a
    // sliver; contain pulls the whole window on screen.
    const r = containFloatRect({ x: 1392, y: 100, w: 420, h: 640 }, 1440, 900)
    expect(r).toEqual({ x: 1440 - 420, y: 100, w: 420, h: 640 })
  })

  it('pulls a left-hanging rect back to the left edge', () => {
    const r = containFloatRect({ x: -372, y: 100, w: 420, h: 640 }, 1440, 900)
    expect(r).toEqual({ x: 0, y: 100, w: 420, h: 640 })
  })

  it('migrates a rect persisted on a larger screen fully on screen', () => {
    // Saved bottom-right on a 2560x1440 external monitor, reopened on a
    // 1440x900 laptop: both axes end flush with the smaller viewport.
    const r = containFloatRect({ x: 2116, y: 776, w: 420, h: 640 }, 1440, 900)
    expect(r).toEqual({ x: 1020, y: 260, w: 420, h: 640 })
  })

  it('enforces the minimum size before containing', () => {
    const r = containFloatRect({ x: 99999, y: 99999, w: 10, h: 10 }, WIDE, TALL)
    expect(r.w).toBe(FLOAT_MIN_W)
    expect(r.h).toBe(FLOAT_MIN_H)
    expect(r.x).toBe(WIDE - FLOAT_MIN_W)
    expect(r.y).toBe(TALL - FLOAT_MIN_H)
  })

  it('output is a fixpoint of clampFloatRect and of itself', () => {
    // Pins the render-clamp no-op invariant: the contained rect passed
    // through clampFloatRect (what AgentSheet renders) must not move again.
    const cases = [
      { x: 2116, y: 776, w: 420, h: 640 },
      { x: -372, y: -50, w: 420, h: 640 },
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 500, y: 300, w: 5000, h: 5000 },
    ]
    for (const rect of cases) {
      const contained = containFloatRect(rect, 1440, 900)
      expect(clampFloatRect(contained, 1440, 900)).toEqual(contained)
      expect(containFloatRect(contained, 1440, 900)).toEqual(contained)
    }
  })
})

describe('defaultFloatRect', () => {
  it('spawns bottom-right and fully on screen', () => {
    const r = defaultFloatRect(WIDE, TALL)
    expect(r.x + r.w).toBeLessThanOrEqual(WIDE)
    expect(r.y + r.h).toBeLessThanOrEqual(TALL)
    expect(r.x).toBeGreaterThan(WIDE / 2)
  })

  it('shrinks to fit a small desktop viewport', () => {
    const r = defaultFloatRect(800, 500)
    expect(r.w).toBeLessThanOrEqual(800)
    expect(r.h).toBeLessThanOrEqual(500)
    expect(r.y).toBeGreaterThanOrEqual(0)
  })
})

describe('resizeFloatRect', () => {
  const base = { x: 400, y: 200, w: 500, h: 600 }

  it('grows from the right edge without moving x', () => {
    const r = resizeFloatRect(base, 80, 0, { right: true }, WIDE, TALL)
    expect(r).toEqual({ ...base, w: 580 })
  })

  it('grows from the bottom edge', () => {
    const r = resizeFloatRect(base, 0, 50, { bottom: true }, WIDE, TALL)
    expect(r).toEqual({ ...base, h: 650 })
  })

  it('anchors the right edge on a left-edge drag', () => {
    const r = resizeFloatRect(base, -60, 0, { left: true }, WIDE, TALL)
    expect(r.x).toBe(base.x - 60)
    expect(r.x + r.w).toBe(base.x + base.w)
  })

  it('keeps the right edge anchored when the minimum width clamp kicks in', () => {
    const r = resizeFloatRect(base, 400, 0, { left: true }, WIDE, TALL)
    expect(r.w).toBe(FLOAT_MIN_W)
    expect(r.x + r.w).toBe(base.x + base.w)
  })

  it('resizes both axes from a corner', () => {
    const r = resizeFloatRect(base, 40, 30, { right: true, bottom: true }, WIDE, TALL)
    expect(r).toEqual({ ...base, w: 540, h: 630 })
  })
})
