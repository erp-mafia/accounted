import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { copyInboxAddress } from '@/components/extensions/general/inbox-address-copy'

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('copyInboxAddress', () => {
  it('reports copied and forwards the exact address on success', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })

    await expect(copyInboxAddress('faktura-a1b2c3@inbox.gnubok.se')).resolves.toBe('copied')
    expect(writeText).toHaveBeenCalledWith('faktura-a1b2c3@inbox.gnubok.se')
  })

  it('reports failed when the write is rejected, never copied', async () => {
    // The regression guard. The old handler swallowed this rejection in an empty
    // catch and then showed "Adress kopierad" anyway, so the user walked away
    // believing they had the inbox address and waited for invoices at an address
    // they never captured.
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new DOMException('Write permission denied.', 'NotAllowedError')
        }),
      },
    })

    const state = await copyInboxAddress('faktura-a1b2c3@inbox.gnubok.se')
    expect(state).toBe('failed')
    expect(state).not.toBe('copied')
  })

  it('reports failed on a non-Error rejection', async () => {
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(() => Promise.reject('nope')) },
    })

    await expect(copyInboxAddress('faktura-a1b2c3@inbox.gnubok.se')).resolves.toBe('failed')
  })

  it('reports failed when the Clipboard API is missing (insecure context)', async () => {
    // No API means no programmatic fallback either: the header must keep the
    // address visible and selectable instead of claiming a copy.
    vi.stubGlobal('navigator', {})

    const state = await copyInboxAddress('faktura-a1b2c3@inbox.gnubok.se')
    expect(state).toBe('failed')
    expect(state).not.toBe('copied')
  })

  it('reports failed when clipboard exists but writeText does not', async () => {
    vi.stubGlobal('navigator', { clipboard: { read: vi.fn() } })

    await expect(copyInboxAddress('faktura-a1b2c3@inbox.gnubok.se')).resolves.toBe('failed')
  })

  it('does not throw when there is no navigator at all', async () => {
    vi.stubGlobal('navigator', undefined)

    await expect(copyInboxAddress('faktura-a1b2c3@inbox.gnubok.se')).resolves.toBe('failed')
  })
})
