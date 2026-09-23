import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/agent-skills/atoms', () => ({ loadAtomsAsSkills: vi.fn(), loadReferenceById: vi.fn() }))
vi.mock('@/lib/agent-skills/company-skills', () => ({ loadCompanySkillRows: vi.fn(), ownSkill: vi.fn() }))

import { loadAtomsAsSkills, loadReferenceById } from '@/lib/agent-skills/atoms'
import { loadCompanySkillRows } from '@/lib/agent-skills/company-skills'
import { loadCatalogSkill } from '@/lib/agent-skills/catalog'
import type { SupabaseClient } from '@supabase/supabase-js'

const supabase = {
  from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }) }) }),
} as unknown as SupabaseClient

describe('loadCatalogSkill', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(loadAtomsAsSkills).mockResolvedValue([])
    vi.mocked(loadCompanySkillRows).mockResolvedValue([])
    vi.mocked(loadReferenceById).mockResolvedValue(null)
  })

  it('loads each Kvittojakten body by its client slug, so the page can copy it', async () => {
    const skill = await loadCatalogSkill(supabase, 'company-a', 'kvittojakten-claude')
    expect(skill?.slug).toBe('kvittojakten-claude')
    expect(skill?.body).toContain('## Your harness: Claude')
    expect(loadReferenceById).not.toHaveBeenCalled()
  })

  it('still falls back to references for unknown slugs', async () => {
    expect(await loadCatalogSkill(supabase, 'company-a', 'horizontal/x/ref')).toBeNull()
    expect(loadReferenceById).toHaveBeenCalledWith(supabase, 'horizontal/x/ref')
  })
})
