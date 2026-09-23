import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { openDeferredTab } from '@/lib/browser/deferred-tab'

function makeFakeTab() {
  return {
    closed: false,
    opener: {} as unknown,
    close: vi.fn(),
    location: { href: '' },
    document: {
      title: '',
      body: { appendChild: vi.fn() },
      createElement: vi.fn(() => ({ textContent: '', style: { cssText: '' } })),
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openDeferredTab', () => {
  it('is SSR-safe: reports blocked when window is undefined', () => {
    const tab = openDeferredTab()
    expect(tab.blocked).toBe(true)
    expect(tab.navigate('https://example.com')).toBe(false)
    expect(() => tab.close()).not.toThrow()
  })

  it('reports blocked and refuses navigation when window.open returns null', () => {
    vi.stubGlobal('window', { open: vi.fn(() => null) })
    const tab = openDeferredTab('Laddar...')
    expect(tab.blocked).toBe(true)
    expect(tab.navigate('https://example.com')).toBe(false)
    expect(() => tab.close()).not.toThrow()
  })

  it('opens synchronously, severs opener, and navigates the pending tab', () => {
    const fake = makeFakeTab()
    const open = vi.fn(() => fake)
    vi.stubGlobal('window', { open })

    const tab = openDeferredTab('Genererar...')
    expect(open).toHaveBeenCalledWith('', '_blank')
    expect(tab.blocked).toBe(false)
    expect(fake.opener).toBeNull()
    expect(fake.document.title).toBe('Genererar...')
    expect(fake.document.body.appendChild).toHaveBeenCalledTimes(1)

    expect(tab.navigate('blob:https://app/abc')).toBe(true)
    expect(fake.location.href).toBe('blob:https://app/abc')
  })

  it('skips the placeholder when none is given', () => {
    const fake = makeFakeTab()
    vi.stubGlobal('window', { open: vi.fn(() => fake) })
    openDeferredTab()
    expect(fake.document.body.appendChild).not.toHaveBeenCalled()
    expect(fake.document.title).toBe('')
  })

  it('fails navigation once the user closed the pending tab', () => {
    const fake = makeFakeTab()
    vi.stubGlobal('window', { open: vi.fn(() => fake) })
    const tab = openDeferredTab()
    fake.closed = true
    expect(tab.navigate('https://example.com')).toBe(false)
  })

  it('close() closes an open tab and is a no-op afterwards', () => {
    const fake = makeFakeTab()
    vi.stubGlobal('window', { open: vi.fn(() => fake) })
    const tab = openDeferredTab()
    tab.close()
    expect(fake.close).toHaveBeenCalledTimes(1)
    fake.closed = true
    tab.close()
    expect(fake.close).toHaveBeenCalledTimes(1)
  })

  it('survives a placeholder document that throws', () => {
    const fake = makeFakeTab()
    fake.document.createElement = vi.fn(() => {
      throw new Error('detached')
    })
    vi.stubGlobal('window', { open: vi.fn(() => fake) })
    const tab = openDeferredTab('Laddar...')
    expect(tab.blocked).toBe(false)
    expect(tab.navigate('https://example.com')).toBe(true)
  })
})
