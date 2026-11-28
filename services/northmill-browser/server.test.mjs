import { test } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { Sessions } from './sessions.mjs'
import { createServer } from './server.mjs'

const token = 'a'.repeat(40)
const owner = '11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222'
test('HTTP contract authenticates all resources, scopes sessions and downloads before closing', async () => {
  let closes = 0
  const sessions = new Sessions({ open: async () => ({ status: async () => ({ state: 'accounts' }), screen: async () => Buffer.from('png'),
    action: async input => input.type === 'export' ? Buffer.from('csv') : null, close: async () => { closes++ } }) })
  const server = createServer(sessions, token)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const url = `http://127.0.0.1:${server.address().port}`
  const call = (path, method = 'GET', body, headers = {}) => fetch(url + path, { method,
    headers: { Authorization: `Bearer ${token}`, 'X-Session-Owner': owner, ...headers }, body: body ? JSON.stringify(body) : undefined })
  try {
    assert.equal((await fetch(url + '/health')).status, 401)
    assert.equal((await call('/sessions', 'POST', {})).status, 400)
    assert.equal((await call('/sessions', 'POST', { organizationNumber: '5566778899' }, { 'X-Session-Owner': 'bad' })).status, 400)
    const response = await call('/sessions', 'POST', { organizationNumber: '5566778899' })
    assert.equal(response.status, 201)
    const { id } = await response.json()
    await sessions.get(id, owner).opening
    const foreign = { 'X-Session-Owner': owner.replace('11111111', '33333333') }
    for (const resource of ['', '/screen', '/file']) assert.equal((await call(`/sessions/${id}${resource}`, 'GET', undefined, foreign)).status, 404)
    assert.equal((await call(`/sessions/${id}`, 'DELETE', undefined, foreign)).status, 404)
    assert.equal((await call(`/sessions/${id}/file`)).status, 409)
    assert.equal((await (await call(`/sessions/${id}/action`, 'POST', { type: 'export' })).json()).state, 'ready')
    assert.equal(closes, 1)
    assert.equal((await (await call(`/sessions/${id}`)).json()).state, 'ready')
    const file = await call(`/sessions/${id}/file`)
    assert.equal(file.headers.get('cache-control'), 'no-store, private')
    assert.equal(await file.text(), 'csv')
    assert.equal((await call(`/sessions/${id}`, 'DELETE')).status, 200)
    assert.equal((await call(`/sessions/${id}`)).status, 404)
  } finally { await sessions.close(); await new Promise(resolve => server.close(resolve)) }
})
