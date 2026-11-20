/**
 * Each floating button stores its own hide choice: hiding one must never
 * write the other's.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { saveFabHidden, storedFabHidden } from '../fab-preference'

afterEach(() => {
  vi.unstubAllGlobals()
})

function stubFetch() {
  const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response('{}'))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

describe('saveFabHidden', () => {
  it('writes the assistant button to the preferences endpoint', async () => {
    const fetchMock = stubFetch()
    await saveFabHidden('assistant', true)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/user/preferences')
    expect(init.method).toBe('PATCH')
    expect(JSON.parse(String(init.body))).toEqual({ hide_assistant_fab: true })
  })

  it('writes the support button to the ui state, and nothing about the assistant one', async () => {
    const fetchMock = stubFetch()
    await saveFabHidden('support', false)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('/api/user/ui-state')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ support_fab_hidden: false })
  })
})

describe('storedFabHidden', () => {
  const data = { hide_assistant_fab: true, support_fab_hidden: false }

  it('reads each button from its own field', () => {
    expect(storedFabHidden('assistant', data)).toBe(true)
    expect(storedFabHidden('support', data)).toBe(false)
    expect(storedFabHidden('support', { hide_assistant_fab: false, support_fab_hidden: true })).toBe(true)
  })

  it('is shown (not hidden) when nothing is stored', () => {
    expect(storedFabHidden('support', null)).toBe(false)
    expect(storedFabHidden('assistant', {})).toBe(false)
  })
})
