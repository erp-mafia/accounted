import { describe, expect, it } from 'vitest'
import { getLibrarySections, getReport, reportAppliesToForm } from '../catalog'

describe('report catalog: legal-form gates', () => {
  it('shows INK2 to the forms that file it and the NE-bilaga to the enskild firma only', () => {
    const slugsFor = (entityType: Parameters<typeof getLibrarySections>[0]) =>
      getLibrarySections(entityType, true, true).flatMap((s) => s.items.map((i) => i.slug))

    expect(slugsFor('aktiebolag')).toContain('ink2-declaration')
    expect(slugsFor('ekonomisk_forening')).toContain('ink2-declaration')
    expect(slugsFor('ekonomisk_forening')).not.toContain('ne-declaration')
    expect(slugsFor('enskild_firma')).toContain('ne-declaration')
    expect(slugsFor('enskild_firma')).not.toContain('ink2-declaration')
    expect(slugsFor('ideell_forening')).not.toContain('ink2-declaration')
    // BFL 6 kap. 1 §: an ekonomisk förening prepares an årsredovisning too.
    expect(slugsFor('ekonomisk_forening')).toContain('arsredovisning')
    expect(slugsFor('ideell_forening')).not.toContain('arsredovisning')
  })

  it('reportAppliesToForm handles a single form, a list, and an unknown company', () => {
    expect(reportAppliesToForm('aktiebolag', 'aktiebolag')).toBe(true)
    expect(reportAppliesToForm('aktiebolag', 'ekonomisk_forening')).toBe(false)
    expect(reportAppliesToForm(['aktiebolag', 'ekonomisk_forening'], 'ekonomisk_forening')).toBe(true)
    expect(reportAppliesToForm(['aktiebolag', 'ekonomisk_forening'], undefined)).toBe(false)
    expect(getReport('ink2-declaration')?.entityType).toEqual(['aktiebolag', 'ekonomisk_forening'])
  })
})
