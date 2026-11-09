import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { UNNAMED_CREATOR, creatorFields, creatorOf, resolveCreators, resolvePersonNames } from '../person-names'

describe('resolvePersonNames', () => {
  it('names a person by full name, else e-mail, reading only the distinct ids given', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'u1', email: 'jonas@example.com', full_name: ' Jonas Ek ' },
        { id: 'u2', email: 'anna@example.com', full_name: null },
        { id: 'u3', email: null, full_name: null },
      ],
    })
    const names = await resolvePersonNames(supabase as never, ['u1', 'u2', 'u1', null, undefined, 'u3', ''])
    expect([...names]).toEqual([['u1', 'Jonas Ek'], ['u2', 'anna@example.com']])
    expect(findCalls('profiles', 'in')).toEqual([['id', ['u1', 'u2', 'u3']]])
  })

  it('reads nothing without an id', async () => {
    const { supabase, findCalls } = createQueuedMockSupabase()
    expect((await resolvePersonNames(supabase as never, [null, undefined])).size).toBe(0)
    expect(findCalls('profiles', 'select')).toEqual([])
  })

  it('leaves names out when the read fails, instead of failing the caller', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    expect((await resolvePersonNames(supabase as never, ['u1'])).size).toBe(0)
  })

  it('reads in chunks of at most 100 ids', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [] })
    enqueue({ data: [{ id: 'u-150', email: 'x@example.com', full_name: null }] })
    const ids = Array.from({ length: 150 }, (_, i) => `u-${i + 1}`)
    const names = await resolvePersonNames(supabase as never, ids)
    expect(findCalls('profiles', 'in').map((c) => (c[1] as string[]).length)).toEqual([100, 50])
    expect(names.get('u-150')).toBe('x@example.com')
  })
})

describe('resolveCreators', () => {
  it('names a creator by full name only, never reading the e-mail', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: 'u1', full_name: ' Jonas Ek ', deleted_at: null, anonymized_at: null },
        { id: 'u2', full_name: null, deleted_at: null, anonymized_at: null, email: 'anna@example.com' },
        { id: 'u3', full_name: null, deleted_at: '2026-10-01T00:00:00Z', anonymized_at: '2026-10-01T00:00:00Z' },
      ],
    })
    const creators = await resolveCreators(supabase as never, ['u1', 'u2', 'u1', null, 'u3', 'u4'])
    expect([...creators]).toEqual([
      ['u1', { name: 'Jonas Ek', deleted: false }],
      ['u2', { name: null, deleted: false }],
      ['u3', { name: null, deleted: true }],
    ])
    expect(findCalls('profiles', 'select')).toEqual([['id, full_name, deleted_at, anonymized_at']])
    expect(findCalls('profiles', 'in')).toEqual([['id', ['u1', 'u2', 'u3', 'u4']]])
    expect(JSON.stringify([...creators])).not.toContain('@')
  })

  it('reads an unread profile as unnamed, not deleted, and a row without a creator as no one', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { message: 'boom' } })
    const creators = await resolveCreators(supabase as never, ['u1'])
    expect(creators.size).toBe(0)
    expect(creatorOf(creators, 'u1')).toEqual(UNNAMED_CREATOR)
    expect(creatorOf(creators, null)).toBeNull()
  })

  it('treats a tombstone with a leftover name as deleted', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: 'u1', full_name: 'Kvar', deleted_at: null, anonymized_at: '2026-10-01T00:00:00Z' }] })
    expect((await resolveCreators(supabase as never, ['u1'])).get('u1')).toEqual({ name: null, deleted: true })
  })
})

describe('creatorFields', () => {
  it('carries the name, or that the account is deleted, and nothing else', () => {
    expect(creatorFields({ name: 'Jonas Ek', deleted: false })).toEqual({ created_by: 'Jonas Ek' })
    expect(creatorFields({ name: null, deleted: true })).toEqual({ created_by_deleted: true })
    expect(creatorFields(UNNAMED_CREATOR)).toEqual({})
    expect(creatorFields(null)).toEqual({})
  })
})
