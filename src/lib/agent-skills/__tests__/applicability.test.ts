import { describe, expect, it } from 'vitest'
import { ENTITY_TYPES } from '@/lib/company/entity-type'
import { skillAppliesToCompany, type SkillCompanyContext } from '../applicability'
import type { SkillApplicability } from '../types'
import { workflowSkills } from '../workflows'

const company = (entityType: unknown, overrides: Partial<SkillCompanyContext> = {}): SkillCompanyContext => ({
  entityType,
  hasEmployees: true,
  vatRegistered: true,
  ...overrides,
})

describe('skillAppliesToCompany: legal form', () => {
  // Rows: the stored form (company_settings.entity_type). Columns: the skill's tag.
  it.each([
    ['aktiebolag', { AB: true, EF: false, both: true, none: true }],
    ['enskild_firma', { AB: false, EF: true, both: true, none: true }],
    // An ideell förening is neither AB nor EF: form-specific skills stay hidden,
    // 'both' and untagged skills show.
    ['ideell_forening', { AB: false, EF: false, both: true, none: true }],
    // So is an ekonomisk förening, although it files INK2 like an aktiebolag:
    // AB skills speak of aktiekapital, ABL and aktieägare.
    ['ekonomisk_forening', { AB: false, EF: false, both: true, none: true }],
  ] as const)('%s', (entityType, expected) => {
    const verdict = (tag: SkillApplicability['entity_type']) =>
      skillAppliesToCompany({ entity_type: tag }, company(entityType))
    expect({ AB: verdict('AB'), EF: verdict('EF'), both: verdict('both'), none: verdict(undefined) }).toEqual(expected)
  })

  it('covers every legal form in the registry', () => {
    expect([...ENTITY_TYPES].sort()).toEqual(['aktiebolag', 'ekonomisk_forening', 'enskild_firma', 'ideell_forening'])
  })

  // 'AB' and 'EF' are skill tags, never stored forms: the pre-fix filter
  // compared them literally, so tests that mocked entity_type as 'AB' passed
  // while every real company lost its form-specific skills.
  it.each([null, undefined, '', 'handelsbolag', 42, 'AB', 'EF'])(
    'does not filter on an unresolved form (%s)',
    (entityType) => {
      expect(skillAppliesToCompany({ entity_type: 'AB' }, company(entityType))).toBe(true)
      expect(skillAppliesToCompany({ entity_type: 'EF' }, company(entityType))).toBe(true)
    },
  )

  it('applies a skill without applicability everywhere', () => {
    for (const entityType of ENTITY_TYPES) {
      expect(skillAppliesToCompany(undefined, company(entityType, { hasEmployees: false, vatRegistered: false }))).toBe(true)
      expect(skillAppliesToCompany(null, company(entityType, { hasEmployees: false, vatRegistered: false }))).toBe(true)
    }
  })
})

describe('skillAppliesToCompany: requirements', () => {
  it('hides an employees skill until the company has an employee', () => {
    const a: SkillApplicability = { entity_type: 'both', requires: ['employees'] }
    expect(skillAppliesToCompany(a, company('aktiebolag', { hasEmployees: false }))).toBe(false)
    expect(skillAppliesToCompany(a, company('aktiebolag', { hasEmployees: true }))).toBe(true)
  })

  it('hides a VAT skill for a company that is not VAT registered', () => {
    const a: SkillApplicability = { entity_type: 'both', requires: ['vat_registered'] }
    expect(skillAppliesToCompany(a, company('enskild_firma', { vatRegistered: false }))).toBe(false)
    expect(skillAppliesToCompany(a, company('enskild_firma', { vatRegistered: true }))).toBe(true)
  })

  it('ANDs the form with the requirements', () => {
    const a: SkillApplicability = { entity_type: 'AB', requires: ['employees'] }
    expect(skillAppliesToCompany(a, company('aktiebolag', { hasEmployees: false }))).toBe(false)
    expect(skillAppliesToCompany(a, company('enskild_firma', { hasEmployees: true }))).toBe(false)
    expect(skillAppliesToCompany(a, company('aktiebolag', { hasEmployees: true }))).toBe(true)
  })
})

describe('skillAppliesToCompany: shipped workflow skills', () => {
  const yearEnd = workflowSkills.find((s) => s.slug === 'year-end-close')!

  it('shows the AB year-end close to an aktiebolag only', () => {
    expect(yearEnd.applicability?.entity_type).toBe('AB')
    expect(skillAppliesToCompany(yearEnd.applicability, company('aktiebolag'))).toBe(true)
    expect(skillAppliesToCompany(yearEnd.applicability, company('enskild_firma'))).toBe(false)
    expect(skillAppliesToCompany(yearEnd.applicability, company('ideell_forening'))).toBe(false)
  })

  it('shows every shipped skill to at least one legal form of a fully set-up company', () => {
    for (const skill of workflowSkills) {
      const shown = ENTITY_TYPES.some((entityType) => skillAppliesToCompany(skill.applicability, company(entityType)))
      expect(shown, skill.slug).toBe(true)
    }
  })
})
