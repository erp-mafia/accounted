import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { loadCompanySkillRows, resolveOwnSkill, ownSkill, type CompanySkillRow } from '../company-skills'
import { loadReferenceById, loadAtomsAsSkills } from '../atoms'

const { supabase, enqueue, reset, findCalls } = createQueuedMockSupabase()
const own: CompanySkillRow = { id: 'own-id', company_id: 'company-a', team_id: null, atom_id: null, name: 'Own', description: 'D', body: 'B', share_status: 'private', created_by: 'user', updated_at: '', reviewed_at: null, published_atom_id: null }
beforeEach(() => { vi.clearAllMocks(); reset() })

describe('tenant-scoped skill resolution', () => {
  it('unions only the selected company and its attached firm', async () => {
    enqueue({ data: { team_id: 'firm-a' } }); enqueue({ data: [own] }); enqueue({ data: [{ ...own, id: 'team-skill', company_id: null, team_id: 'firm-a' }] })
    expect((await loadCompanySkillRows(supabase as never, 'company-a')).map((row) => row.id)).toEqual(['team-skill', 'own-id'])
    expect(findCalls('companies', 'eq')).toEqual([['id', 'company-a']])
    expect(findCalls('company_skills', 'eq')).toEqual([['company_id', 'company-a'], ['team_id', 'firm-a']])
  })
  it('does not resolve a guessed private slug from another tenant', async () => {
    enqueue({ data: null }); enqueue({ data: [own] })
    expect(await resolveOwnSkill(supabase as never, 'company-a', 'own/other-tenant')).toBeNull()
  })
  it('does not expose withdrawn private content', () => {
    expect(ownSkill({ ...own, share_status: 'withdrawn' })).toBeNull()
    expect(ownSkill(own)?.slug).toBe('own/own-id')
  })
})

describe('registry kill switch', () => {
  it('checks current active state on every load', async () => {
    enqueue({ data: [{ id: 'community/test', tier: 'community', description: 'D', body: 'B' }] })
    expect(await loadAtomsAsSkills(supabase as never)).toHaveLength(1)
    enqueue({ data: [] })
    expect(await loadAtomsAsSkills(supabase as never)).toHaveLength(0)
    expect(findCalls('agent_atom_registry', 'eq').filter((call) => call[0] === 'is_active')).toHaveLength(2)
  })
  it('does not allow a reference to bypass a disabled parent', async () => {
    enqueue({ data: { id: 'horizontal/test/ref', parent_atom_id: 'horizontal/test', is_active: true, mcp_exposed: true, body: 'B' } })
    enqueue({ data: null })
    expect(await loadReferenceById(supabase as never, 'horizontal/test/ref')).toBeNull()
    expect(findCalls('agent_atom_registry', 'eq')).toContainEqual(['id', 'horizontal/test'])
  })
})
