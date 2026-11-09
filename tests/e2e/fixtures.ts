import { test as base, expect } from '@playwright/test'

export const test = base.extend<{ browserHealth: void }>({
  browserHealth: [async ({ page }, use, info) => {
    const failures: string[] = []
    const responseChecks: Promise<void>[] = []
    const disabledIntegrationReads = new Set([
      '/api/extensions/ext/skatteverket/status',
      '/api/extensions/ext/skatteverket/skattekonto/transaktioner',
    ])
    page.on('pageerror', error => failures.push(error.message))
    page.on('response', response => {
      const pathname = new URL(response.url()).pathname
      if ((pathname.startsWith('/api/') || pathname.startsWith('/rest/v1/')) && response.status() >= 500) {
        responseChecks.push((async () => {
          if (response.status() === 503 && disabledIntegrationReads.has(pathname)) {
            const body = await response.json().catch(() => null)
            if (body?.code === 'EXTENSION_DISABLED') {
              info.annotations.push({ type: 'integration', description: `Expected disabled test integration ${pathname}` })
              return
            }
          }
          failures.push(`HTTP ${response.status()} ${pathname}`)
        })())
      }
    })
    page.on('requestfailed', request => {
      const pathname = new URL(request.url()).pathname
      if ((pathname.startsWith('/rest/v1/') || pathname.startsWith('/auth/v1/'))
        && request.failure()?.errorText !== 'net::ERR_ABORTED') failures.push(`Failed request ${pathname}`)
    })
    page.on('websocket', socket => socket.on('socketerror', () => failures.push('Realtime WebSocket connection failed')))
    await use()
    await Promise.all(responseChecks)
    expect(failures, 'Uncaught browser errors or failed application APIs').toEqual([])
  }, { auto: true }],
})
