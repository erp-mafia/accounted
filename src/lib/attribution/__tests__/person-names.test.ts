import { describe, it, expect } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { resolvePersonNames } from '../person-names'

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
