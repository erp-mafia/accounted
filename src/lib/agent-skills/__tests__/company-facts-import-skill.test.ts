/**
 * The onboarding import saves facts the user confirmed. Its last step tells
 * the user where in Accounted those facts are, so they can find them: Arkiv
 * has its own Fakta, a different list, and an agent that names no place
 * leaves the user looking there.
 */
import { describe, expect, it } from 'vitest'
import { companyFactsImportSkill } from '../workflows/company-facts-import'
import { MEMORY_PLACE_IN_APP } from '@/lib/agent-context/wiki-views'

describe('company-facts-import skill', () => {
  it('says where the user sees the saved facts', () => {
    expect(MEMORY_PLACE_IN_APP).toContain('Agenter > Minne')
    expect(MEMORY_PLACE_IN_APP).toContain('/wiki?view=memory')
    expect(companyFactsImportSkill.body).toContain(MEMORY_PLACE_IN_APP)
  })
})
