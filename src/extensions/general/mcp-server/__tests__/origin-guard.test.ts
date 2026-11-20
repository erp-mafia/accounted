import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest'
import { isForbiddenOrigin, forbiddenOriginResponse } from '../origin-guard'
import type { mcpServerExtension as McpServerExtension } from '../index'
import { testRoutes } from '@/tests/helpers'
import { FLYTT_EXTENSION_ID, FLYTT_EXTENSION_ORIGIN } from '@/lib/auth/flytt-extension'

const ENDPOINT = 'https://app.gnubok.se/api/extensions/ext/mcp-server/mcp'

function makeRequest(headers: Record<string, string> = {}, url = ENDPOINT): Request {
  return new Request(url, { method: 'POST', headers })
}

describe('isForbiddenOrigin', () => {
  const originalAppUrl = process.env.NEXT_PUBLIC_APP_URL

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL
  })

  afterEach(() => {
    if (originalAppUrl === undefined) {
      delete process.env.NEXT_PUBLIC_APP_URL
    } else {
      process.env.NEXT_PUBLIC_APP_URL = originalAppUrl
    }
  })

  it('allows requests without an Origin header (server-to-server clients)', () => {
    // claude.ai backend, Claude Desktop, npx gnubok-mcp, Claude Code: none
    // send Origin. This is the path every known MCP client takes.
    expect(isForbiddenOrigin(makeRequest())).toBe(false)
  })

  it('allows a same-origin browser request (Origin host matches Host header)', () => {
    expect(
      isForbiddenOrigin(
        makeRequest({ origin: 'https://app.gnubok.se', host: 'app.gnubok.se' }),
      ),
    ).toBe(false)
  })

  it('allows same-origin on a Vercel preview host', () => {
    expect(
      isForbiddenOrigin(
        makeRequest(
          { origin: 'https://erp-base-abc123.vercel.app', host: 'erp-base-abc123.vercel.app' },
          'https://erp-base-abc123.vercel.app/api/extensions/ext/mcp-server/mcp',
        ),
      ),
    ).toBe(false)
  })

  it('allows an Origin matching NEXT_PUBLIC_APP_URL even when Host was rewritten by a proxy', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.gnubok.se'
    expect(
      isForbiddenOrigin(
        makeRequest(
          { origin: 'https://app.gnubok.se', host: 'internal-proxy.local' },
          'https://internal-proxy.local/api/extensions/ext/mcp-server/mcp',
        ),
      ),
    ).toBe(false)
  })

  it('rejects a foreign Origin (DNS-rebinding / cross-site browser request)', () => {
    expect(
      isForbiddenOrigin(
        makeRequest({ origin: 'https://evil.example.com', host: 'app.gnubok.se' }),
      ),
    ).toBe(true)
  })

  it('rejects a foreign Origin that only differs by port', () => {
    expect(
      isForbiddenOrigin(
        makeRequest({ origin: 'https://app.gnubok.se:8443', host: 'app.gnubok.se' }),
      ),
    ).toBe(true)
  })

  it('rejects an opaque "null" Origin', () => {
    expect(isForbiddenOrigin(makeRequest({ origin: 'null', host: 'app.gnubok.se' }))).toBe(true)
  })

  it('rejects a malformed Origin header', () => {
    expect(
      isForbiddenOrigin(makeRequest({ origin: 'not a url', host: 'app.gnubok.se' })),
    ).toBe(true)
  })

  it("allows Accounted's own browser extension, by its whole origin", () => {
    expect(
      isForbiddenOrigin(makeRequest({ origin: FLYTT_EXTENSION_ORIGIN, host: 'app.gnubok.se' })),
    ).toBe(false)
  })

  it('rejects every other extension origin', () => {
    for (const origin of [
      'chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      `${FLYTT_EXTENSION_ORIGIN}x`,
      `${FLYTT_EXTENSION_ORIGIN}/`,
      `moz-extension://${FLYTT_EXTENSION_ID}`,
      `https://${FLYTT_EXTENSION_ID}`,
    ]) {
      expect(isForbiddenOrigin(makeRequest({ origin, host: 'app.gnubok.se' }))).toBe(true)
    }
  })
})

describe('forbiddenOriginResponse', () => {
  it('returns a 403 JSON-RPC error envelope', async () => {
    const res = forbiddenOriginResponse()
    expect(res.status).toBe(403)
    const body = await res.json()
    expect(body).toEqual({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32600, message: 'Origin not allowed' },
    })
  })
})

describe('mcp-server apiRoutes origin enforcement', () => {
  // The extension entry no longer loads ./server (a POST loads it lazily, after
  // the origin check), so these foreign-Origin requests never parse it. The
  // import still runs once in beforeAll with headroom so a slow cold import
  // under full-suite parallel load cannot eat an individual test's clock.
  let mcpServerExtension: typeof McpServerExtension
  beforeAll(async () => {
    ;({ mcpServerExtension } = await import('../index'))
  }, 60_000)

  it('rejects foreign-Origin requests on every /mcp method before dispatch', async () => {
    const routes = testRoutes(mcpServerExtension).filter((r) => r.path === '/mcp')
    expect(routes.map((r) => r.method).sort()).toEqual(['DELETE', 'GET', 'POST'])

    for (const route of routes) {
      const res = await route.handler(
        new Request(ENDPOINT, {
          method: route.method,
          headers: { origin: 'https://evil.example.com', host: 'app.gnubok.se' },
        }),
      )
      expect(res.status, `${route.method} /mcp`).toBe(403)
    }
  })
})
