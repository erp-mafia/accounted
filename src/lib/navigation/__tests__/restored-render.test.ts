import { describe, expect, it } from 'vitest'
import { createRenderTracker } from '../restored-render'

describe('createRenderTracker', () => {
  it('treats the first mount of a render as fresh', () => {
    const tracker = createRenderTracker()
    expect(tracker.isRestored('render-1', {})).toBe(false)
  })

  it('treats the same mount asking again (StrictMode effect re-run) as fresh', () => {
    const tracker = createRenderTracker()
    const mount = {}
    tracker.isRestored('render-1', mount)
    expect(tracker.isRestored('render-1', mount)).toBe(false)
  })

  it('treats a second mount of the same render as restored from the router cache', () => {
    const tracker = createRenderTracker()
    tracker.isRestored('render-1', {})
    expect(tracker.isRestored('render-1', {})).toBe(true)
  })

  it('treats the refreshed render a restored mount receives as fresh', () => {
    const tracker = createRenderTracker()
    tracker.isRestored('render-1', {})
    const restored = {}
    expect(tracker.isRestored('render-1', restored)).toBe(true)
    expect(tracker.isRestored('render-2', restored)).toBe(false)
  })

  it('treats a back navigation onto the refreshed render as restored again', () => {
    const tracker = createRenderTracker()
    const restored = {}
    tracker.isRestored('render-1', {})
    tracker.isRestored('render-1', restored)
    tracker.isRestored('render-2', restored)
    expect(tracker.isRestored('render-2', {})).toBe(true)
  })
})
