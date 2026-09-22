import { describe, expect, it } from 'vitest'
import { buildOwnSkill, type OwnSkillCopy } from '../own-skill-body'
import { SkillBodySchema } from '../validation'

const copy: OwnSkillCopy = {
  name: (area) => `${area} hos oss`,
  intro: 'Företagets egna instruktioner.',
  scopeHeading: 'Gäller',
  scope: (area) => `Gäller ${area} i det här företaget.`,
  contextHeading: 'Så arbetar vi',
  askHeading: 'Fråga alltid först',
  askLine: (item) => `Fråga användaren innan du ska: ${item}.`,
  lockedLine: 'Rör aldrig låsta eller stängda perioder.',
  rulesHeading: 'Regler',
  rules: 'Varje skrivning föreslås och godkänns av användaren.',
  noContext: 'Inga särskilda rutiner angivna.',
}

describe('buildOwnSkill', () => {
  it('writes a body that passes the skill validator', () => {
    const skill = buildOwnSkill({ area: 'Bokföra inköp', context: ['Privata utlägg förekommer'], askFirst: ['Bokföra över 10 000 kr'] }, copy)
    expect(skill.name).toBe('Bokföra inköp hos oss')
    expect(skill.body).toContain('- Fråga användaren innan du ska: bokföra över 10 000 kr.')
    expect(skill.body).toContain('Rör aldrig låsta eller stängda perioder.')
    expect(skill.description).toBe('Privata utlägg förekommer')
    expect(SkillBodySchema.safeParse(skill.body).success).toBe(true)
  })

  it('keeps the locked-period rule and a scope line when nothing else is chosen', () => {
    const skill = buildOwnSkill({ area: 'Moms', context: [], askFirst: [] }, copy)
    expect(skill.body).toContain('- Inga särskilda rutiner angivna.')
    expect(skill.body).toContain('- Rör aldrig låsta eller stängda perioder.')
    expect(skill.description).toBe('Gäller moms i det här företaget.')
  })

  it('strips characters the validator rejects from labels', () => {
    const skill = buildOwnSkill({ area: 'Lön <b>{x}</b>', context: ['a `b`'], askFirst: [] }, copy)
    expect(SkillBodySchema.safeParse(skill.body).success).toBe(true)
    expect(skill.name).toBe('Lön bx/b hos oss')
  })
})
