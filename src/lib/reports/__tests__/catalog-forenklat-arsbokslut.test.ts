import { describe, expect, it } from 'vitest'
import { getLibrarySections, getReport } from '../catalog'
import { ENTITY_TYPES } from '@/lib/company/entity-type'

describe('report catalog: förenklat årsbokslut', () => {
  const slugsFor = (entityType: (typeof ENTITY_TYPES)[number]) =>
    getLibrarySections(entityType, true, true).flatMap((s) => s.items.map((i) => i.slug))

  it('is shown to the forms whose profile prepares one, an ideell förening, and to no other', () => {
    expect(ENTITY_TYPES.filter((form) => slugsFor(form).includes('forenklat-arsbokslut'))).toEqual(['ideell_forening'])
  })

  it('opens its own page in the year-end flow, under Bokslut', () => {
    expect(getReport('forenklat-arsbokslut')).toMatchObject({
      category: 'year_end',
      params: 'fiscal',
      route: '/bookkeeping/year-end/forenklat-arsbokslut',
      labelKey: 'name_forenklat_arsbokslut',
    })
  })
})
