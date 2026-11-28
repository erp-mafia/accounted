import http from 'node:http'
import { authenticated, Refusal, validateOwner } from './policy.mjs'

async function readJson(req) {
  const parts = []; let size = 0
  for await (const part of req) {
    size += part.length
    if (size > 4096) throw new Refusal('BODY_TOO_LARGE', 413)
    parts.push(part)
  }
  try { return JSON.parse(Buffer.concat(parts).toString() || '{}') }
  catch { throw new Refusal('INVALID_JSON') }
}
export function createServer(sessions, token) {
  if (!token || token.length < 32) throw new Error('NORTHMILL_BROWSER_TOKEN must contain at least 32 characters')
  return http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, private')
    res.setHeader('X-Content-Type-Options', 'nosniff')
    const json = (data, status = 200) => {
      res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data))
    }
    try {
      if (!authenticated(req.headers.authorization, token)) throw new Refusal('UNAUTHORIZED', 401)
      if (req.url === '/health' && req.method === 'GET') return json({ ok: true })
      const owner = validateOwner(req.headers['x-session-owner'])
      if (req.url === '/sessions' && req.method === 'POST') {
        const body = await readJson(req)
        if (typeof body.organizationNumber !== 'string' || !/^\d{10}$/.test(body.organizationNumber)) throw new Refusal('COMPANY_NUMBER_REQUIRED')
        return json(await sessions.create(owner, body.organizationNumber), 201)
      }
      const match = /^\/sessions\/([0-9a-f-]{36})(?:\/(screen|file|action))?$/.exec(req.url)
      if (!match) throw new Refusal('NOT_FOUND', 404)
      const [, id, resource] = match
      if (!resource && req.method === 'DELETE') { await sessions.remove(id, owner); return json({ ok: true }) }
      const row = sessions.get(id, owner)
      if (!resource && req.method === 'GET') {
        if (row.state === 'starting' || row.state === 'failed' || row.state === 'ready') return json(sessions.public(row))
        return json(await sessions.use(id, owner, async active => ({ ...sessions.public(active), ...await active.browser.status() })))
      }
      if (resource === 'screen' && req.method === 'GET') {
        const png = await sessions.use(id, owner, active => active.browser.screen())
        res.writeHead(200, { 'Content-Type': 'image/png' }); return res.end(png)
      }
      if (resource === 'file' && req.method === 'GET') {
        if (!row.file) throw new Refusal('FILE_NOT_READY', 409)
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="northmill.csv"' })
        return res.end(row.file)
      }
      if (resource === 'action' && req.method === 'POST') {
        const input = await readJson(req)
        const result = await sessions.use(id, owner, async active => {
          const file = await active.browser.action(input)
          if (file) { active.file = file; active.state = 'ready'; await active.browser.close() }
          return { ...sessions.public(active), ...(file ? {} : await active.browser.status()) }
        })
        return json(result)
      }
      throw new Refusal('NOT_FOUND', 404)
    } catch (error) {
      // Do not return page text, URLs, tokens or Playwright exceptions.
      json({ error: error instanceof Refusal ? error.code : 'BROWSER_FAILED' }, error instanceof Refusal ? error.status : 502)
    }
  })
}
