import { describe, expect, it, vi } from 'vitest'
import { loadSkillProvenance, oauthActorLabel, skillBodyHash } from '../provenance'
import { createMockSupabase } from '@/tests/helpers'

describe('skill retrieval provenance', () => {
  it('does not invent evidence without a session', async () => {
    const { supabase: db } = createMockSupabase()
    expect(await loadSkillProvenance(db as never, 'company', 'user', { id: 'key' })).toEqual({ skills_loaded: [], skills_provenance: 'no_session' })
    expect(db.from).not.toHaveBeenCalled()
  })
  it('queries durable evidence scoped to company, user, key and session', async () => {
    const chain = { select: vi.fn(), eq: vi.fn(), gte: vi.fn(), order: vi.fn(), limit: vi.fn() }
    for (const key of ['select', 'eq', 'gte', 'order'] as const) chain[key].mockReturnValue(chain)
    chain.limit.mockResolvedValue({ data: [
      { data: { slug: 'bookkeep', bodyHash: skillBodyHash('new'), version: 2 }, created_at: '2026-09-17T12:00:00Z' },
      { data: { slug: 'bookkeep', bodyHash: skillBodyHash('old') }, created_at: '2026-09-17T11:00:00Z' },
    ], error: null })
    const result = await loadSkillProvenance({ from: () => chain } as never, 'company', 'user', { id: 'key', sessionId: 'session' })
    expect(chain.eq.mock.calls).toEqual(expect.arrayContaining([['company_id', 'company'], ['user_id', 'user'], ['data->>actorId', 'key'], ['data->>sessionId', 'session']]))
    expect(result.skills_loaded).toEqual(['bookkeep'])
    expect(result.skill_retrievals?.[0]).toMatchObject({ body_hash: skillBodyHash('new'), version: 2 })
  })
  it('derives display identity from stored provider while preserving unknown names', () => {
    expect(oauthActorLabel('chatgpt', 'MCP-klient (OAuth)')).toBe('ChatGPT (OpenAI)')
    expect(oauthActorLabel(null, 'My integration')).toBe('My integration')
  })
})
