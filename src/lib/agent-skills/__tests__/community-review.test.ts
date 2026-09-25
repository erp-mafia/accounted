import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { approvePendingItem, approveSubmission, loadPendingItems, loadSubmissionsForReview, sendBackSubmission } from '../community-review'
import { communityBodySha } from '../community-approval'

const { supabase, enqueue, reset, findCall } = createQueuedMockSupabase()
beforeEach(() => reset())

const row = (id: string, name: string, body = '# Rutin\n\n1. Gör det.\n') => ({ id, name, description: 'Kort.', body, kind: 'workflow', author_handle: 'jakob', share_confirmed_at: '2026-09-25T10:00:00Z' })

describe('community review', () => {
  it('shows each submission as the file to publish, with a free folder name and a privacy screen', async () => {
    enqueue({ data: [row('00000000-0000-4000-8000-000000000001', 'Bankkoll'), row('00000000-0000-4000-8000-000000000002', 'Bankkoll', '# Bankkoll\n\nRing 070-123 45 67.\n')] })
    enqueue({ data: [{ id: 'community/bankkoll' }] })
    const list = await loadSubmissionsForReview(supabase as never)
    expect(list.map((s) => s.slug)).toEqual(['bankkoll-2', 'bankkoll-3'])
    expect(list[0].skill_md).toContain('name: bankkoll-2')
    expect(list[0].skill_md).toContain('submission: 00000000-0000-4000-8000-000000000001')
    expect(list[0].github_url).toContain('filename=community%2Fbankkoll-2%2FSKILL.md')
    expect(list[0].privacy).toEqual([])
    expect(list[1].privacy.map((p) => p.kind)).toEqual(['phone'])
  })

  it('sends a submission back to private with the reason', async () => {
    enqueue({ data: [{ id: 'x' }] })
    expect(await sendBackSubmission(supabase as never, 'x', 'Ta bort telefonnumret')).toBe(true)
    expect(findCall('company_skills', 'update')?.[0]).toEqual({ share_status: 'private', review_note: 'Ta bort telefonnumret' })
    enqueue({ data: [] })
    expect(await sendBackSubmission(supabase as never, 'y', 'Redan hanterad')).toBe(false)
  })

  it('approves the exact file the server builds when the reviewer opens it as a pull request', async () => {
    enqueue({ data: [row('00000000-0000-4000-8000-000000000001', 'Bankkoll')] })
    enqueue({ data: [] })
    const [submission] = await loadSubmissionsForReview(supabase as never)
    reset()
    enqueue({ data: [row('00000000-0000-4000-8000-000000000001', 'Bankkoll')] })
    enqueue({ data: [] })
    enqueue({ data: [{ id: '00000000-0000-4000-8000-000000000001' }] })
    expect(await approveSubmission(supabase as never, '00000000-0000-4000-8000-000000000001')).toBe(true)
    expect(findCall('company_skills', 'update')?.[0]).toEqual({ approved_body_sha: communityBodySha(submission.skill_md) })
    enqueue({ data: [] })
    enqueue({ data: [] })
    expect(await approveSubmission(supabase as never, 'gone')).toBe(false)
  })

  it('lists merged texts waiting for approval, with their fingerprint', async () => {
    enqueue({ data: [{ id: 'community/fran-github', title: 'Från GitHub', description: 'd', body: '---\nname: fran-github\n---\n\nMejla a@b.se', trigger_signals: { kind: 'analysis', author: 'someone' } }] })
    const [item] = await loadPendingItems(supabase as never)
    expect(item).toMatchObject({ slug: 'fran-github', kind: 'analysis', author: 'someone', sha: communityBodySha('---\nname: fran-github\n---\n\nMejla a@b.se') })
    expect(item.privacy.map((p) => p.kind)).toEqual(['email'])
  })

  it('publishes a pending text only if it is still the one the reviewer read', async () => {
    const atom = { id: 'community/x', body: '# X', trigger_signals: { kind: 'workflow', submission: 'sub-1' } }
    enqueue({ data: atom })
    expect(await approvePendingItem(supabase as never, 'x', 'f'.repeat(64))).toBe(false)
    expect(findCall('agent_atom_registry', 'update')).toBeUndefined()
    enqueue({ data: atom })
    enqueue({ data: null }) // expose
    enqueue({ data: null }) // link submission
    expect(await approvePendingItem(supabase as never, 'x', communityBodySha('# X'))).toBe(true)
    expect(findCall('agent_atom_registry', 'update')?.[0]).toMatchObject({ mcp_exposed: true, trigger_signals: { approved_sha: communityBodySha('# X'), submission: 'sub-1' } })
    expect(findCall('company_skills', 'update')?.[0]).toMatchObject({ share_status: 'published', published_atom_id: 'community/x' })
  })
})
