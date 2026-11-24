import { beforeEach, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
vi.mock('../voucher-delete-guard', () => ({ readSieDeleteBlock: vi.fn().mockResolvedValue(null) }))
import { getJournalEntryChain } from '../journal-entry-chain'

const db = createQueuedMockSupabase()
const entry = { id: 'entry', status: 'draft', reverses_id: 'parent' }
const parent = { id: 'parent', status: 'posted' }
const outage = { data: null, error: { code: 'XX000', message: 'Connection lost' } }
const data = (value: unknown) => ({ data: value, error: null })
const read = () => getJournalEntryChain(db.supabase as never, 'company', 'entry')
beforeEach(() => db.reset())

it('returns null for a genuinely missing or foreign voucher', async () => {
  db.enqueue(data(null))
  expect(await read()).toBeNull()
  expect(db.findCalls('journal_entries', 'eq')).toContainEqual(['company_id', 'company'])
})
it('reads the complete company-scoped correction chain', async () => {
  db.enqueueMany([data(entry), data([]), data([parent]), data([]), data([parent])])
  expect(await read()).toMatchObject({ entry, chain: [parent] })
  expect(db.findCalls('journal_entries', 'eq').filter(args => args[0] === 'company_id')).toHaveLength(5)
})
it.each([
  ['entry lookup', []],
  ['initial reverse lookup', [data(entry)]],
  ['forward traversal', [data(entry), data([])]],
  ['reverse traversal', [data(entry), data([]), data([parent])]],
  ['final chain read', [data(entry), data([]), data([parent]), data([])]],
])('propagates a database error during %s without returning partial history', async (_phase, preceding) => {
  db.enqueueMany([...preceding, outage])
  await expect(read()).rejects.toMatchObject({ code: 'XX000' })
})
it('does not silently guess the last-in-series status after a failed series read', async () => {
  db.enqueueMany([data({ id: 'entry', status: 'posted' }), data([]), outage])
  await expect(read()).rejects.toMatchObject({ code: 'XX000' })
})
