import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { renderFinalizeRedirect } from '../finalize-page'

describe('bank popup completion', () => {
  it.each(['/settings/banking?select_accounts=connection-1', 'https://app.example/settings/banking?select_accounts=connection-1'])('posts %s to the opener and closes the popup', (url) => {
    const postMessage = vi.fn()
    const close = vi.fn()
    const replace = vi.fn()
    const html = renderFinalizeRedirect(url, 'test-nonce')
    const script = html.match(/<script[^>]*>([\s\S]*?)<\/script>/)?.[1]
    expect(script).toBeTruthy()
    runInNewContext(script!, { URL, window: { opener: { closed: false, postMessage }, close, location: { origin: 'https://app.example', replace } } })
    expect(postMessage).toHaveBeenCalledWith({ type: 'enable-banking-connected', url }, 'https://app.example')
    expect(close).toHaveBeenCalledOnce()
    expect(replace).not.toHaveBeenCalled()
  })
})
