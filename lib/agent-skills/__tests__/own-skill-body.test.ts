import { describe, expect, it } from 'vitest'
import { buildOwnSkill, type OwnSkillCopy } from '../own-skill-body'
import { SkillBodySchema } from '../validation'

const copy: OwnSkillCopy = {
  intro: 'Företagets egna instruktioner.',
  taskHeading: 'Uppgift',
  stepsHeading: 'Steg',
  rulesHeading: 'Regler',
  approvalLine: 'Inget bokförs utan att användaren godkänt det.',
  lockedLine: 'Rör aldrig låsta eller stängda perioder.',
  toldHeading: 'Så beskrev användaren det',
  addedLabel: 'Tillagt:',
}

const summary = {
  kind: 'summary' as const,
  name: 'Månadens leverantörsfakturor',
  lede: 'Varje månad går Claude igenom leverantörsfakturorna.',
  steps: ['Hämta fakturorna.', 'Kolla momsen.'],
  rules: ['Flagga fel moms.'],
  facts: ['Varje månad'],
}
const told = { description: 'Gå igenom fakturorna varje månad.', turns: [{ question: 'Alla leverantörer?', answer: 'Bara återkommande.' }], extra: ['Hyran kommer den 25:e.'] }

describe('buildOwnSkill', () => {
  it('writes a body that passes the skill validator', () => {
    const skill = buildOwnSkill(summary, told, copy)
    expect(skill.name).toBe('Månadens leverantörsfakturor')
    expect(skill.description).toBe(summary.lede)
    expect(skill.body).toContain('1. Hämta fakturorna.\n2. Kolla momsen.')
    expect(skill.body).toContain('- Flagga fel moms.\n- Inget bokförs utan att användaren godkänt det.\n- Rör aldrig låsta eller stängda perioder.')
    expect(skill.body).toContain('- Alla leverantörer? Bara återkommande.')
    expect(skill.body).toContain('- Tillagt: Hyran kommer den 25:e.')
    expect(SkillBodySchema.safeParse(skill.body).success).toBe(true)
  })

  it('keeps the approval and locked-period rules when the summary has none', () => {
    const skill = buildOwnSkill({ ...summary, rules: [] }, { ...told, turns: [], extra: [] }, copy)
    expect(skill.body).toContain('## Regler\n\n- Inget bokförs utan att användaren godkänt det.')
  })

  it('strips what the validator rejects from what the user typed', () => {
    const skill = buildOwnSkill({ ...summary, name: 'Lön <b>{x}</b>' }, { ...told, description: 'Kör `rm` <script>' }, copy)
    expect(SkillBodySchema.safeParse(skill.body).success).toBe(true)
    expect(skill.name).toBe('Lön bx/b')
  })
})
