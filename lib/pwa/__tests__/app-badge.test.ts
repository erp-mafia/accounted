import { afterEach, describe, expect, it, vi } from 'vitest'
import { canSetAppBadge, syncAppBadge } from '@/lib/pwa/app-badge'

describe('syncAppBadge', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('no-ops when the Badging API is missing', async () => {
    vi.stubGlobal('navigator', {})
    await expect(syncAppBadge(3)).resolves.toBeUndefined()
    expect(canSetAppBadge()).toBe(false)
  })

  it('sets a positive count and clears zero', async () => {
    const setAppBadge = vi.fn().mockResolvedValue(undefined)
    const clearAppBadge = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { setAppBadge, clearAppBadge })

    await syncAppBadge(4)
    expect(setAppBadge).toHaveBeenCalledWith(4)
    expect(clearAppBadge).not.toHaveBeenCalled()

    await syncAppBadge(0)
    expect(clearAppBadge).toHaveBeenCalledTimes(1)
  })

  it('swallows OS / permission errors', async () => {
    vi.stubGlobal('navigator', {
      setAppBadge: vi.fn().mockRejectedValue(new Error('denied')),
    })
    await expect(syncAppBadge(1)).resolves.toBeUndefined()
  })
})
