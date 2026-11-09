import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { REMEMBERED_FACTS_CHAR_BUDGET, lastSessionSync, loadRememberedFacts, type RememberedFact } from '../remembered-facts'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()

const row = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
  id, kind: 'fact', content, relevance_score: 0.8, created_at: '2026-10-01T08:00:00Z', ...extra,
})

beforeEach(() => reset())

describe('loadRememberedFacts', () => {
  it('returns every active fact of the company in query order (newest first), with who taught it', async () => {
    enqueue({ data: [
      row('m-2', 'Två anställda sedan september.', { created_at: '2026-10-02T08:00:00Z', created_by_user_id: 'u-1', origin: 'session_sync', client: 'chatgpt' }),
      row('m-1', 'Hyresavtal löper till 2027.', { created_at: '2026-06-01T08:00:00Z', origin: null, client: null }),
    ] })
    enqueue({ data: [{ id: 'u-1', full_name: 'Anna Andersson', deleted_at: null, anonymized_at: null }] })
    const result = await loadRememberedFacts(supabase as never, 'company-a')

    expect(result.truncated).toBe(false)
    expect(result.facts).toEqual([
      { fact_id: 'm-2', kind: 'fact', content: 'Två anställda sedan september.', relevance_score: 0.8, saved_at: '2026-10-02T08:00:00Z', origin: 'session_sync', client: 'chatgpt', created_by: { name: 'Anna Andersson', deleted: false } },
      { fact_id: 'm-1', kind: 'fact', content: 'Hyresavtal löper till 2027.', relevance_score: 0.8, saved_at: '2026-06-01T08:00:00Z', origin: null, client: null, created_by: null },
    ])
    expect(findCalls('agent_memory', 'eq')).toEqual([['company_id', 'company-a'], ['is_active', true]])
    expect(findCalls('agent_memory', 'is')).toEqual([['superseded_by', null]])
    expect(findCalls('agent_memory', 'order')).toEqual([['created_at', { ascending: false, nullsFirst: false }]])
    // The name only: the e-mail is never read.
    expect(findCalls('profiles', 'select')).toEqual([['id, full_name, deleted_at, anonymized_at']])
    expect(findCalls('profiles', 'in')).toEqual([['id', ['u-1']]])
  })

  it('marks a deleted account as deleted, and a profile it could not read as unnamed', async () => {
    enqueue({ data: [
      row('m-2', 'Två anställda.', { created_by_user_id: 'u-gone' }),
      row('m-1', 'Hyresavtal.', { created_by_user_id: 'u-unread' }),
    ] })
    enqueue({ data: [{ id: 'u-gone', full_name: null, deleted_at: '2026-10-01T00:00:00Z', anonymized_at: '2026-10-01T00:00:00Z' }] })
    const result = await loadRememberedFacts(supabase as never, 'company-a')
    expect(result.facts.map((f) => f.created_by)).toEqual([{ name: null, deleted: true }, { name: null, deleted: false }])
  })

  it('reads no creator beyond the facts that fit the budget', async () => {
    const half = Math.ceil(REMEMBERED_FACTS_CHAR_BUDGET / 2) + 1
    enqueue({ data: [row('m-2', 'a'.repeat(half), { created_by_user_id: 'u-kept' }), row('m-1', 'b'.repeat(half), { created_by_user_id: 'u-cut' })] })
    enqueue({ data: [] })
    await loadRememberedFacts(supabase as never, 'company-a')
    expect(findCalls('profiles', 'in')).toEqual([['id', ['u-kept']]])
  })

  it('reads without origin and client while the migration that adds them has not run', async () => {
    enqueue({ data: null, error: { code: '42703', message: 'column agent_memory.origin does not exist' } })
    enqueue({ data: [row('m-1', 'Hyresavtal löper till 2027.')] })
    const result = await loadRememberedFacts(supabase as never, 'company-a')

    expect(result.facts).toHaveLength(1)
    expect(result.facts[0]).toMatchObject({ fact_id: 'm-1', origin: null, client: null })
    const selects = findCalls('agent_memory', 'select').map((args) => args[0])
    expect(selects).toEqual([
      'id, kind, content, relevance_score, created_at, created_by_user_id, origin, client',
      'id, kind, content, relevance_score, created_at, created_by_user_id',
    ])
  })

  it('keeps the newest facts that fit the character budget and says it cut', async () => {
    const third = Math.floor(REMEMBERED_FACTS_CHAR_BUDGET / 2.5)
    enqueue({ data: [row('m-3', 'a'.repeat(third)), row('m-2', 'b'.repeat(third)), row('m-1', 'c'.repeat(third))] })
    const result = await loadRememberedFacts(supabase as never, 'company-a')

    expect(result.facts.map((f) => f.fact_id)).toEqual(['m-3', 'm-2'])
    expect(result.truncated).toBe(true)
  })

  it('throws when the read fails for another reason', async () => {
    enqueue({ data: null, error: { code: '42501', message: 'rls-denied' } })
    await expect(loadRememberedFacts(supabase as never, 'company-a')).rejects.toThrow(/Failed to load agent memory: rls-denied/)
  })
})

describe('lastSessionSync', () => {
  const fact = (saved_at: string | null, origin: string | null): RememberedFact => ({
    fact_id: 'f', kind: 'fact', content: 'x', relevance_score: null, saved_at, origin, client: null, created_by: null,
  })

  it('is the newest session_sync fact, whatever order the facts come in', () => {
    expect(lastSessionSync([
      fact('2026-10-01T08:00:00Z', 'session_sync'),
      fact('2026-10-20T08:00:00Z', 'conversation'),
      fact('2026-10-09T08:00:00Z', 'session_sync'),
    ])).toBe('2026-10-09T08:00:00Z')
  })

  it('is null without one', () => {
    expect(lastSessionSync([fact('2026-10-20T08:00:00Z', 'conversation'), fact(null, 'session_sync')])).toBeNull()
  })
})
