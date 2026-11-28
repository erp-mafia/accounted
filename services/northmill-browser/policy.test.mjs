import { test } from 'node:test'
import assert from 'node:assert/strict'
import { authenticated, allowedBankUrl, validCsv } from './policy.mjs'
import { readOnlyLink } from './northmill.mjs'
import { Sessions } from './sessions.mjs'

test('worker token is mandatory and compared exactly', () => {
  const token = 'a'.repeat(40)
  assert.equal(authenticated(`Bearer ${token}`, token), true)
  for (const header of [undefined, '', 'Bearer wrong', `Bearer ${token}a`]) assert.equal(authenticated(header, token), false)
  assert.equal(authenticated('Bearer abc', 'abc'), false)
})
test('bank navigation stays HTTPS and on Northmill domains', () => {
  assert.equal(allowedBankUrl('https://www.northmill.com/se/foretag/app/portal/login'), true)
  for (const url of ['http://northmill.com', 'https://northmill.com.evil.test', 'https://northmill.com:8443', 'file:///etc/passwd', 'https://a@northmill.com']) assert.equal(allowedBankUrl(url), false)
  assert.equal(readOnlyLink('https://www.northmill.com/se/foretag/app/portal/transactional/account-dashboard?accountId=test'), true)
  assert.equal(readOnlyLink('https://www.northmill.com/se/foretag/app/portal/transactional/account/pay-and-transfer'), false)
})
test('only Northmill statement CSV is accepted', () => {
  assert.equal(validCsv(Buffer.from('Kontonummer,123\nBokföringsdag,Beskrivning,Belopp\n2026-11-28,Test,10')), true)
  for (const value of ['<html>bank error</html>', 'Bokföringsdag,Beskrivning,Belopp', 'Kontonummer,123\nnot a statement']) assert.equal(validCsv(Buffer.from(value)), false)
})
test('sessions bind owner, expire and close browsers', async () => {
  let now = 0, closed = 0
  const sessions = new Sessions({ open: async () => ({ close: async () => { closed++ } }) }, { ttl: 100, now: () => now })
  const first = await sessions.create('owner-a')
  await sessions.get(first.id, 'owner-a').opening
  assert.throws(() => sessions.get(first.id, 'owner-b'), /NOT_FOUND/)
  assert.equal((await sessions.create('owner-a')).id, first.id)
  now = 100
  await sessions.sweep()
  assert.throws(() => sessions.get(first.id, 'owner-a'), /NOT_FOUND/)
  assert.equal(closed, 1)
})
test('capacity includes browsers still opening; cancellation closes a late browser', async () => {
  let finish, closed = 0
  const sessions = new Sessions({ open: () => new Promise(resolve => { finish = resolve }) }, { max: 1 })
  const first = await sessions.create('a')
  const opening = sessions.get(first.id, 'a').opening
  await assert.rejects(sessions.create('b'), /CAPACITY/)
  await sessions.remove(first.id, 'a')
  finish({ close: async () => { closed++ } })
  await opening
  assert.equal(closed, 1)
})
test('simultaneous actions are serialized', async () => {
  const sessions = new Sessions({ open: async () => ({ close: async () => {} }) })
  const row = await sessions.create('a'); await sessions.get(row.id, 'a').opening
  let finish
  const action = sessions.use(row.id, 'a', () => new Promise(resolve => { finish = resolve }))
  await assert.rejects(sessions.use(row.id, 'a', () => {}), /BUSY/)
  finish(); await action; await sessions.close()
})
