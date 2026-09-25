import { describe, expect, it } from 'vitest'
import { buildOwnSkill, ownSkillSteps, OWN_SKILL_COPY, type OwnSkillCopy } from '../own-skill-body'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
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

  it('leaves out the "how the user described it" heading when the user said nothing', () => {
    const skill = buildOwnSkill(summary, { description: '', turns: [], extra: [] }, copy)
    expect(skill.body).not.toContain(copy.toldHeading)
    expect(skill.body.endsWith('\n')).toBe(true)
  })

  it('strips what the validator rejects from what the user typed', () => {
    const skill = buildOwnSkill({ ...summary, name: 'Lön <b>{x}</b>' }, { ...told, description: 'Kör `rm` <script>' }, copy)
    expect(SkillBodySchema.safeParse(skill.body).success).toBe(true)
    expect(skill.name).toBe('Lön bx/b')
  })
})

describe('ownSkillSteps', () => {
  it('reads the numbered steps back out of a built body', () => {
    expect(ownSkillSteps(buildOwnSkill(summary, told, copy).body)).toEqual(['Hämta fakturorna.', 'Kolla momsen.'])
  })

  it('returns nothing for a body without a numbered list', () => {
    expect(ownSkillSteps('# Namn\n\n- En regel.')).toEqual([])
  })
})

describe('OWN_SKILL_COPY', () => {
  it.each([['sv', sv], ['en', en]] as const)('matches the %s creator strings', (locale, messages) => {
    const c = messages.skills_registry.creator
    expect(OWN_SKILL_COPY[locale]).toEqual({
      intro: c.body_intro, taskHeading: c.body_task_heading, stepsHeading: c.body_steps_heading, rulesHeading: c.body_rules_heading,
      approvalLine: c.body_approval, lockedLine: c.body_locked, toldHeading: c.body_told_heading, addedLabel: c.body_added,
    })
  })
})
