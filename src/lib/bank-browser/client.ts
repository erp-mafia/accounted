import 'server-only'
import { request as httpRequest } from 'node:http'
import { getCanonicalAppOrigin } from '@/lib/domains/trusted-app-origin'

export function bankBrowserOriginAllowed(request: Request) {
  return request.headers.get('origin') === getCanonicalAppOrigin()
}

export function bankBrowserConfigured() {
  return Boolean(process.env.NORTHMILL_BROWSER_SOCKET && process.env.NORTHMILL_BROWSER_TOKEN)
}

/** Private Unix socket: no public browser-worker port and no browser-held worker token. */
export async function bankBrowserRequest(companyId: string, userId: string, path: string, method = 'GET', body?: unknown) {
  const socketPath = process.env.NORTHMILL_BROWSER_SOCKET
  const token = process.env.NORTHMILL_BROWSER_TOKEN
  if (!socketPath || !token) return Response.json({ error: 'NOT_CONFIGURED' }, { status: 503 })
  return new Promise<Response>(resolve => {
    const unavailable = () => resolve(Response.json({ error: 'BROWSER_UNAVAILABLE' }, { status: 502 }))
    const request = httpRequest({ socketPath, path, method,
      headers: { Authorization: `Bearer ${token}`, 'X-Session-Owner': `${companyId}:${userId}`, 'Content-Type': 'application/json' },
    }, response => {
      const chunks: Buffer[] = []
      let size = 0
      response.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > 10 * 1024 * 1024) { request.destroy(); unavailable(); return }
        chunks.push(chunk)
      })
      response.on('error', unavailable)
      response.on('aborted', unavailable)
      response.on('end', () => resolve(new Response(new Uint8Array(Buffer.concat(chunks)), {
        status: response.statusCode || 502,
        headers: {
          'Content-Type': response.headers['content-type'] || 'application/json',
          'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff',
          ...(path.endsWith('/file') && response.statusCode === 200 ? { 'Content-Disposition': 'attachment; filename="northmill.csv"' } : {}),
        },
      })))
    })
    const timeout = setTimeout(() => { request.destroy(); unavailable() }, 25_000)
    request.on('close', () => clearTimeout(timeout))
    request.on('error', unavailable)
    request.end(body === undefined ? undefined : JSON.stringify(body))
  })
}
