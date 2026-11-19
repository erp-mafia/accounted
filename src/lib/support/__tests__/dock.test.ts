/**
 * The docked support panel's state: who may open it, when a door falls back
 * to its own dialog, and that it never outlives the dock that draws it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { closeSupportDock, mountSupportDock, openSupportDock, supportDockState } from '../dock'

const releases: Array<() => void> = []
function mount() {
  const release = mountSupportDock()
  releases.push(release)
  return release
}

afterEach(() => {
  while (releases.length) releases.pop()?.()
  closeSupportDock()
  vi.unstubAllGlobals()
})

describe('openSupportDock', () => {
  it('answers false with no dock on the page, so the door opens its dialog', () => {
    expect(openSupportDock({}, true)).toBe(false)
    expect(supportDockState().open).toBe(false)
  })

  it('answers false on a screen with no room beside the page', () => {
    mount()
    expect(openSupportDock({}, false)).toBe(false)
    expect(supportDockState().open).toBe(false)
  })

  it('opens the dock with the subject of the door', () => {
    mount()
    expect(openSupportDock({ subject: 'Fråga från hjälpsidan' }, true)).toBe(true)
    expect(supportDockState()).toEqual({ open: true, subject: 'Fråga från hjälpsidan' })
  })

  it('leaves an open dock as it is when a second door asks', () => {
    mount()
    openSupportDock({ subject: 'first' }, true)
    const before = supportDockState()
    expect(openSupportDock({ subject: 'second' }, true)).toBe(true)
    expect(supportDockState()).toBe(before)
  })

  it('reads the room from the window when not told: md and up', () => {
    mount()
    const matchMedia = vi.fn((query: string) => ({ matches: query === '(min-width: 768px)' }))
    vi.stubGlobal('window', { matchMedia })
    expect(openSupportDock()).toBe(true)
    closeSupportDock()
    matchMedia.mockReturnValue({ matches: false })
    expect(openSupportDock()).toBe(false)
  })

  it('has no room where there is no window (the server)', () => {
    mount()
    expect(openSupportDock()).toBe(false)
  })
})

describe('closing', () => {
  it('closeSupportDock closes it', () => {
    mount()
    openSupportDock({}, true)
    closeSupportDock()
    expect(supportDockState()).toEqual({ open: false })
  })

  it('the dock leaving the page closes it, so a later page without one opens dialogs', () => {
    const release = mount()
    openSupportDock({}, true)
    release()
    releases.length = 0
    expect(supportDockState().open).toBe(false)
    expect(openSupportDock({}, true)).toBe(false)
  })

  it('a second mount (strict mode) keeps it open until the last one leaves', () => {
    const first = mount()
    mount()
    openSupportDock({}, true)
    first()
    expect(supportDockState().open).toBe(true)
  })
})
