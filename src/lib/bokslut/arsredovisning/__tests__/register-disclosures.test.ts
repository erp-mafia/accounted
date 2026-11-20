import { describe, expect, it } from 'vitest'
import { effectiveDisclosureTexts, registerOverrideWarnings, type RegisterDisclosureTexts } from '../register-disclosures'

const registers: RegisterDisclosureTexts = {
  securities_pledged: 'Företagsinteckningar 500 000 kr.',
  contingent_liabilities: 'Borgensförbindelser 300 000 kr.',
  parent_company: { name: 'Ägarbolaget AB', org_number: '559000-0000', city: 'Stockholm' },
}

const empty = {
  securities_pledged: null,
  contingent_liabilities: null,
  parent_company_name: null,
  parent_company_org_number: null,
  parent_company_city: null,
}

describe('effectiveDisclosureTexts', () => {
  it('reads the narrative alone when no register says anything (the document as before)', () => {
    expect(effectiveDisclosureTexts({ ...empty, securities_pledged: ' Pant 1 kr. ' }, null)).toEqual({ ...empty, securities_pledged: 'Pant 1 kr.' })
    expect(effectiveDisclosureTexts(null, null)).toEqual(empty)
  })

  it('uses the registers when the narrative is empty or blank', () => {
    expect(effectiveDisclosureTexts({ ...empty, securities_pledged: '   ' }, registers)).toEqual({
      securities_pledged: 'Företagsinteckningar 500 000 kr.',
      contingent_liabilities: 'Borgensförbindelser 300 000 kr.',
      parent_company_name: 'Ägarbolaget AB',
      parent_company_org_number: '559000-0000',
      parent_company_city: 'Stockholm',
    })
  })

  it('keeps the manual text as an override, the parent as one unit', () => {
    const manual = {
      securities_pledged: 'Inga.',
      contingent_liabilities: null,
      parent_company_name: 'Annan Ägare AB',
      parent_company_org_number: null,
      parent_company_city: 'Göteborg',
    }
    expect(effectiveDisclosureTexts(manual, registers)).toEqual({
      securities_pledged: 'Inga.',
      contingent_liabilities: 'Borgensförbindelser 300 000 kr.',
      parent_company_name: 'Annan Ägare AB',
      parent_company_org_number: null,
      parent_company_city: 'Göteborg',
    })
  })
})

describe('registerOverrideWarnings', () => {
  it('warns when a manual text differs from what the register says', () => {
    const warnings = registerOverrideWarnings({ ...empty, securities_pledged: 'Inga.', parent_company_name: 'Annan Ägare AB' }, registers)
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(/^Ställda säkerheter: den manuella texten/)
    expect(warnings[1]).toMatch(/^Moderföretag:/)
  })

  it('stays silent without registers, or when the texts agree', () => {
    expect(registerOverrideWarnings({ ...empty, securities_pledged: 'Inga.' }, null)).toEqual([])
    expect(registerOverrideWarnings({ ...empty, securities_pledged: 'Företagsinteckningar 500 000 kr.' }, registers)).toEqual([])
  })
})
