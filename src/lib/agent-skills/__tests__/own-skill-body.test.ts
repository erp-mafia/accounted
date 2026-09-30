import { describe, expect, it } from 'vitest'
import { buildOwnSkill, editedFlowBody, ownItemText, ownSkillSteps, OWN_SKILL_COPY, type OwnSkillCopy } from '../own-skill-body'
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

describe('editedFlowBody', () => {
  // The shape Skriv själv saves (CreateItem.tsx body()).
  const written = '# Påminn om fakturor\n\nPåminner om obetalda fakturor\n\n## Steg\n\n1. Hämta fakturorna\n2. Välj de sena\n'
  const edit = { name: 'Påminn om kundfakturor', description: 'Påminner efter 14 dagar', previousDescription: 'Påminner om obetalda fakturor', steps: ['Hämta kundfakturorna', 'Välj de som är 14 dagar sena', 'Föreslå en påminnelse'], stepsHeading: 'Steg' }

  it('rewrites the name, the description and the steps of a hand-written flow', () => {
    expect(editedFlowBody(written, edit)).toBe('# Påminn om kundfakturor\n\nPåminner efter 14 dagar\n\n## Steg\n\n1. Hämta kundfakturorna\n2. Välj de som är 14 dagar sena\n3. Föreslå en påminnelse\n')
  })

  it('keeps what the form does not show: the rules and what the user said in an AI-written flow', () => {
    const built = buildOwnSkill(summary, told, copy)
    const next = editedFlowBody(built.body, { ...edit, previousDescription: built.description })
    expect(ownSkillSteps(next)).toEqual(edit.steps)
    expect(next.startsWith('# Påminn om kundfakturor\n')).toBe(true)
    expect(next).toContain('## Uppgift\n\nPåminner efter 14 dagar\n')
    expect(next).toContain('## Regler\n\n- Flagga fel moms.')
    expect(next).toContain('- Alla leverantörer? Bara återkommande.')
    expect(next).not.toContain(built.description)
    expect(SkillBodySchema.safeParse(next).success).toBe(true)
  })

  it('reads back the same steps it wrote, with fewer steps than before', () => {
    const next = editedFlowBody(written, { ...edit, steps: ['Bara ett steg'] })
    expect(ownSkillSteps(next)).toEqual(['Bara ett steg'])
    expect(next).not.toMatch(/\n{3,}/)
  })

  it('adds a steps section and a heading to a body that had neither', () => {
    expect(editedFlowBody('Gör så här.', { ...edit, previousDescription: '' })).toBe('# Påminn om kundfakturor\n\nGör så här.\n\n## Steg\n\n1. Hämta kundfakturorna\n2. Välj de som är 14 dagar sena\n3. Föreslå en påminnelse\n')
  })

  it('leaves the text alone when the old description is not in it', () => {
    expect(editedFlowBody(written, { ...edit, previousDescription: 'Något annat' })).toContain('\n\nPåminner om obetalda fakturor\n\n')
  })
})

describe('ownItemText', () => {
  it('drops the heading and the description Skriv själv puts above the text', () => {
    expect(ownItemText('# Representation\n\nSå bokför vi representation\n\nMoms dras på högst 300 kr.\n\n- Källa: ML\n', 'Så bokför vi representation')).toBe('Moms dras på högst 300 kr.\n\n- Källa: ML')
  })

  it('round-trips what Skriv själv saves', () => {
    const text = '## Konton\n\n3001 och 3041 räknas.\n\nMarginalen läses per månad.'
    expect(ownItemText(`# Bruttomarginal\n\nMarginal per månad\n\n${text}\n`, 'Marginal per månad')).toBe(text)
  })

  it('keeps a first paragraph that is not the description, and a body without a heading', () => {
    expect(ownItemText('# Namn\n\nEn annan rad\n\nText', 'Beskrivning')).toBe('En annan rad\n\nText')
    expect(ownItemText('Bara text', 'Beskrivning')).toBe('Bara text')
    expect(ownItemText('\n\n', 'Beskrivning')).toBe('')
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
