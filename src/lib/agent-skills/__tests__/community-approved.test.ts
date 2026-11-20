import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { loadApprovedCommunityItems } from '../community-approved'
import { communityBodySha } from '../community-approval'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
beforeEach(() => reset())

const body = (title: string) => `---\nname: x\n---\n\n# ${title}\n\n1. Gör något.`

describe('loadApprovedCommunityItems', () => {
  it('lists exposed community items with the hash of their approved text', async () => {
    enqueue({ data: [{ id: 'community/manadsavstamning', body: body('Månadsavstämning'), trigger_signals: { approved_sha: communityBodySha(body('Månadsavstämning')) } }] })
    expect(await loadApprovedCommunityItems(supabase as never)).toEqual([{ slug: 'manadsavstamning', sha: communityBodySha(body('Månadsavstämning')) }])
    const eqs = findCalls('agent_atom_registry', 'eq')
    expect(eqs).toEqual(expect.arrayContaining([['tier', 'community'], ['is_active', true], ['mcp_exposed', true]]))
  })

  it('leaves out a row whose stored text is not the approved one, or has no approval or no text', async () => {
    enqueue({ data: [
      { id: 'community/andrad', body: body('Ändrad'), trigger_signals: { approved_sha: communityBodySha(body('Original')) } },
      { id: 'community/ingen', body: body('Ingen'), trigger_signals: {} },
      { id: 'community/tom', body: null, trigger_signals: { approved_sha: communityBodySha('') } },
    ] })
    expect(await loadApprovedCommunityItems(supabase as never)).toEqual([])
  })

  it('hashes the text the way the website does: the trimmed SKILL.md', async () => {
    const text = body('Kant')
    enqueue({ data: [{ id: 'community/kant', body: text, trigger_signals: { approved_sha: communityBodySha(`\n${text}\n\n`) } }] })
    expect((await loadApprovedCommunityItems(supabase as never))[0]?.sha).toBe(communityBodySha(text))
  })

  it('throws when the registry cannot be read', async () => {
    enqueue({ error: { message: 'boom', code: '57014' } })
    await expect(loadApprovedCommunityItems(supabase as never)).rejects.toThrow()
  })
})
