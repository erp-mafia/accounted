import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { syncCommunityFromRepo } from '../community-sync'
import { toCommunitySkillMd } from '../community-repo'

const { supabase, enqueue, reset, findCall, findCalls } = createQueuedMockSupabase()
beforeEach(() => reset())

const file = (slug: string, extra: Partial<Parameters<typeof toCommunitySkillMd>[0]> = {}) => toCommunitySkillMd({
  slug, title: `Titel ${slug}`, description: 'Beskrivning.', kind: 'workflow', author: 'jakob', body: `# Titel ${slug}\n\n1. Gör något.\n`,
  submissionId: '00000000-0000-4000-8000-000000000009', ...extra,
})

function fakeGitHub(files: Record<string, string | null>, folders = Object.keys(files)): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.startsWith('https://api.github.com/')) return new Response(JSON.stringify(folders.map((name) => ({ type: 'dir', name }))), { status: 200 })
    const slug = /community\/([^/]+)\/SKILL\.md$/.exec(url)?.[1] ?? ''
    const text = files[slug]
    return text == null ? new Response('', { status: 404 }) : new Response(text, { status: 200 })
  }) as typeof fetch
}

describe('syncCommunityFromRepo', () => {
  it('publishes a new item, links the submission it came from, and switches off what was removed', async () => {
    enqueue({ data: [{ id: 'community/old', body: '# Old', version: 2, is_active: true, title: 'Old', description: 'Old', trigger_signals: {}, reviewed_at: null }] })
    enqueue({ data: null }) // upsert new
    enqueue({ data: [{ id: '00000000-0000-4000-8000-000000000009' }] }) // submission linked
    enqueue({ data: null }) // deactivate old
    const result = await syncCommunityFromRepo(supabase as never, fakeGitHub({ 'ny-rutin': file('ny-rutin') }))
    expect(result).toMatchObject({ published: ['community/ny-rutin'], updated: [], deactivated: ['community/old'], linked: ['00000000-0000-4000-8000-000000000009'], skipped: [] })
    const upsert = findCall('agent_atom_registry', 'upsert')?.[0] as Record<string, unknown>
    expect(upsert).toMatchObject({ id: 'community/ny-rutin', tier: 'community', version: 1, is_active: true, mcp_exposed: true, trigger_signals: { kind: 'workflow', author: 'jakob', industries: [] } })
    expect(upsert.reviewed_at).toEqual(expect.any(String))
    expect(findCall('company_skills', 'update')?.[0]).toMatchObject({ share_status: 'published', published_atom_id: 'community/ny-rutin' })
  })

  it('leaves an unchanged item alone and bumps the version when the text changes', async () => {
    const withoutSubmission = (slug: string) => file(slug).replace(/\nsubmission: .*\n/, '\n')
    enqueue({ data: [
      { id: 'community/same', body: withoutSubmission('same').trim(), version: 3, is_active: true, title: 'Titel same', description: 'Beskrivning.', trigger_signals: { kind: 'workflow', author: 'jakob', industries: [], source: 'https://github.com/erp-mafia/accounted-skills/tree/main/community/same' } },
      { id: 'community/edited', body: '# before', version: 1, is_active: true, title: 'Titel edited', description: 'Beskrivning.', trigger_signals: {} },
    ] })
    enqueue({ data: null }) // upsert edited
    const result = await syncCommunityFromRepo(supabase as never, fakeGitHub({ same: withoutSubmission('same'), edited: withoutSubmission('edited') }))
    expect(result.updated).toEqual(['community/edited'])
    expect(result.published).toEqual([])
    expect(findCalls('agent_atom_registry', 'upsert')).toHaveLength(1)
    expect((findCall('agent_atom_registry', 'upsert')?.[0] as { version: number }).version).toBe(2)
  })

  it('skips a broken folder without unpublishing what it held', async () => {
    enqueue({ data: [{ id: 'community/broken', body: '# ok', version: 1, is_active: true, title: 'x', description: 'x', trigger_signals: {} }] })
    const result = await syncCommunityFromRepo(supabase as never, fakeGitHub({ broken: '# no frontmatter' }))
    expect(result.skipped).toEqual([{ slug: 'broken', error: 'missing frontmatter' }])
    expect(result.deactivated).toEqual([])
    expect(findCall('agent_atom_registry', 'update')).toBeUndefined()
  })
})
