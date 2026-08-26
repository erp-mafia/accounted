import { describe, it, expect } from 'vitest'
import {
  computeDropdownPosition,
  isSameDropdownPosition,
  DROPDOWN_PREFERRED_WIDTH,
  DROPDOWN_VIEWPORT_MARGIN,
  DROPDOWN_ANCHOR_GAP,
  DROPDOWN_MAX_HEIGHT,
} from '../account-combobox-position'

const desktop = { width: 1440, height: 900 }

describe('computeDropdownPosition', () => {
  it('opens below the anchor at the preferred width when there is room', () => {
    const pos = computeDropdownPosition(
      { top: 200, bottom: 232, left: 300, width: 160 },
      desktop,
    )
    expect(pos.top).toBe(232 + DROPDOWN_ANCHOR_GAP)
    expect(pos.bottom).toBeUndefined()
    expect(pos.left).toBe(300)
    expect(pos.width).toBe(DROPDOWN_PREFERRED_WIDTH)
    expect(pos.maxHeight).toBe(DROPDOWN_MAX_HEIGHT)
  })

  it('keeps the anchor width when the trigger is wider than the preferred width', () => {
    const pos = computeDropdownPosition(
      { top: 200, bottom: 232, left: 100, width: 700 },
      desktop,
    )
    expect(pos.width).toBe(700)
  })

  it('clamps left so the panel never crosses the right viewport edge', () => {
    const pos = computeDropdownPosition(
      { top: 200, bottom: 232, left: 1200, width: 160 },
      desktop,
    )
    expect(pos.left + pos.width).toBe(desktop.width - DROPDOWN_VIEWPORT_MARGIN)
  })

  it('never puts the panel past the left margin', () => {
    const pos = computeDropdownPosition(
      { top: 200, bottom: 232, left: 2, width: 160 },
      desktop,
    )
    expect(pos.left).toBe(DROPDOWN_VIEWPORT_MARGIN)
  })

  it('shrinks to the viewport on a narrow (mobile) screen', () => {
    const mobile = { width: 375, height: 700 }
    const pos = computeDropdownPosition(
      { top: 100, bottom: 140, left: 16, width: 200 },
      mobile,
    )
    expect(pos.width).toBe(375 - DROPDOWN_VIEWPORT_MARGIN * 2)
    expect(pos.left).toBe(DROPDOWN_VIEWPORT_MARGIN)
  })

  it('caps maxHeight to the space below the anchor', () => {
    const pos = computeDropdownPosition(
      { top: 650, bottom: 682, left: 300, width: 160 },
      desktop,
    )
    expect(pos.top).toBe(682 + DROPDOWN_ANCHOR_GAP)
    expect(pos.maxHeight).toBe(
      desktop.height - 682 - DROPDOWN_ANCHOR_GAP - DROPDOWN_VIEWPORT_MARGIN,
    )
  })

  it('flips above the anchor when the space below is too small', () => {
    const pos = computeDropdownPosition(
      { top: 800, bottom: 832, left: 300, width: 160 },
      desktop,
    )
    expect(pos.top).toBeUndefined()
    expect(pos.bottom).toBe(desktop.height - 800 + DROPDOWN_ANCHOR_GAP)
    expect(pos.maxHeight).toBe(DROPDOWN_MAX_HEIGHT)
  })

  it('stays below when the space above is even smaller than below', () => {
    const shortViewport = { width: 1440, height: 220 }
    const pos = computeDropdownPosition(
      { top: 40, bottom: 72, left: 300, width: 160 },
      shortViewport,
    )
    expect(pos.top).toBe(72 + DROPDOWN_ANCHOR_GAP)
    // Cramped viewport: the height floor keeps the list usable and scrollable.
    expect(pos.maxHeight).toBeGreaterThanOrEqual(96)
  })
})

describe('isSameDropdownPosition', () => {
  const anchor = { top: 200, bottom: 232, left: 300, width: 160 }

  it('is false against null (no previous position)', () => {
    expect(isSameDropdownPosition(null, computeDropdownPosition(anchor, desktop))).toBe(false)
  })

  it('is true for two computations off an unmoved anchor', () => {
    const a = computeDropdownPosition(anchor, desktop)
    const b = computeDropdownPosition({ ...anchor }, desktop)
    expect(isSameDropdownPosition(a, b)).toBe(true)
  })

  it.each([
    ['left', { left: 301 }],
    ['width', { width: 545 }],
    ['maxHeight', { maxHeight: 299 }],
    ['top', { top: 237 }],
  ] as const)('is false when %s differs', (_field, patch) => {
    const a = computeDropdownPosition(anchor, desktop)
    expect(isSameDropdownPosition(a, { ...a, ...patch })).toBe(false)
  })

  it('distinguishes open-below from open-above at the same coordinates', () => {
    const below = computeDropdownPosition(anchor, desktop)
    const above = computeDropdownPosition({ top: 800, bottom: 832, left: 300, width: 160 }, desktop)
    expect(below.top).toBeDefined()
    expect(above.bottom).toBeDefined()
    expect(isSameDropdownPosition(below, above)).toBe(false)
    // Flipping sides toggles which of top/bottom is undefined: the guard must
    // compare both, not just the defined one.
    expect(
      isSameDropdownPosition(below, { ...below, top: undefined, bottom: 123 }),
    ).toBe(false)
  })
})
