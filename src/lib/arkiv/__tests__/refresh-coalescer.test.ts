import { readFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRefreshCoalescer } from '../refresh-coalescer'

describe('createRefreshCoalescer', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('turns a batch of ten landings within two seconds into one reload', () => {
    const run = vi.fn()
    const c = createRefreshCoalescer(run, { wait: 1500, maxWait: 8000 })
    for (let i = 0; i < 10; i++) {
      c.trigger()
      vi.advanceTimersByTime(200)
    }
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1500)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('reloads once after a single landing', () => {
    const run = vi.fn()
    const c = createRefreshCoalescer(run, { wait: 1500, maxWait: 8000 })
    c.trigger()
    vi.advanceTimersByTime(1499)
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not let a steady trickle hold the reload back past maxWait', () => {
    const run = vi.fn()
    const c = createRefreshCoalescer(run, { wait: 1500, maxWait: 4000 })
    for (let i = 0; i < 8; i++) {
      c.trigger()
      vi.advanceTimersByTime(1000)
    }
    // Landings every second for 8 s: the first reload is forced at 4 s, the next at 8 s.
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('starts a new batch after a reload', () => {
    const run = vi.fn()
    const c = createRefreshCoalescer(run, { wait: 1500, maxWait: 8000 })
    c.trigger()
    vi.advanceTimersByTime(1500)
    c.trigger()
    vi.advanceTimersByTime(1500)
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('cancel drops a pending reload', () => {
    const run = vi.fn()
    const c = createRefreshCoalescer(run, { wait: 1500, maxWait: 8000 })
    c.trigger()
    c.cancel()
    vi.advanceTimersByTime(10_000)
    expect(run).not.toHaveBeenCalled()
  })
})

describe('ArkivHome wiring', () => {
  it('routes upload landings through the coalescer instead of bumping the tree per file', () => {
    const src = readFileSync(path.resolve(__dirname, '../../../components/arkiv/ArkivHome.tsx'), 'utf8')
    expect(src).toContain('createRefreshCoalescer')
    expect(src).not.toMatch(/onLanded=\{\(\) => setRefreshKey/)
  })
})
