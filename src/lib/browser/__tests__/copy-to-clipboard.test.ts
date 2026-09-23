import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { copyToClipboard } from '@/lib/browser/copy-to-clipboard'

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('copyToClipboard', () => {
  it('reports copied and forwards the exact text on success', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    await expect(copyToClipboard('gnubok_sk_live_abc123')).resolves.toBe('copied')
    expect(writeText).toHaveBeenCalledWith('gnubok_sk_live_abc123')
  })

  it('reports failed when the write is rejected, never copied', async () => {
    // The regression guard: the old call sites either swallowed this rejection
    // in an empty catch (no check mark, no message) or never awaited it at all
    // (check mark shown regardless). Both told the user the secret was on the
    // clipboard when it was not.
    const writeText = vi.fn(async () => {
      throw new DOMException('Write permission denied.', 'NotAllowedError')
    })
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    const result = await copyToClipboard('JBSWY3DPEHPK3PXP')
    expect(result).toBe('failed')
    expect(result).not.toBe('copied')
  })

  it('reports failed on a non-Error rejection', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(() => Promise.reject('nope')) },
    })

    await expect(copyToClipboard('secret')).resolves.toBe('failed')
  })

  it('reports unavailable when the Clipboard API is missing (insecure context)', async () => {
    vi.stubGlobal('navigator', {})

    await expect(copyToClipboard('secret')).resolves.toBe('unavailable')
  })

  it('reports unavailable when clipboard exists but writeText does not', async () => {
    vi.stubGlobal('navigator', { clipboard: { read: vi.fn() } })

    await expect(copyToClipboard('secret')).resolves.toBe('unavailable')
  })

  it('is SSR-safe: reports unavailable with no navigator, and does not throw', async () => {
    vi.stubGlobal('navigator', undefined)

    await expect(copyToClipboard('secret')).resolves.toBe('unavailable')
  })
})
