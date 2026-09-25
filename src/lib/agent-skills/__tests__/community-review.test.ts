import { beforeEach, describe, expect, it } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { loadSubmissionsForReview, sendBackSubmission } from '../community-review'

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
})
