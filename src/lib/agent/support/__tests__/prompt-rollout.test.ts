import { describe, it, expect } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { SEND_TO_SUPPORT_LABEL, supportSystemPrompt } from '../prompt'
import { PAGE_TEXT_ROLES } from '../page-text-index'
import { isSupportAssistantEnabled, supportAssistantEffort, supportAssistantRollout } from '../rollout'

const COMPANY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OTHER = '11111111-2222-4333-8444-555555555555'

describe('supportSystemPrompt', () => {
  const full = supportSystemPrompt({ locale: 'sv', hasLedgerTools: true, hasPageTexts: true, hasSkillTools: true })

  it('says it never books and where a bookkeeping assistant is connected', () => {
    expect(full).toContain('Du bokför inte')
    expect(full).toContain('Claude')
    expect(full).toContain('Agenter → Koppla en agent (/settings/api)')
    // Only when the page is in the company menu, and only when that is what the user asks for.
    expect(full).toContain('om den sidan står i menyn nedan')
    expect(full).toContain('Nämn det bara när frågan handlar om att få bokföringen gjord')
  })

  it('ties what it says about a page to read_page, and a missing page to find_in_app', () => {
    expect(full).toContain('anropa read_page')
    expect(full).toContain('find_in_app')
    expect(full).toContain('Hitta ALDRIG på en knapp')
  })

  it('tells it when to offer a person, and that it sends nothing itself', () => {
    expect(full).toContain('offer_human_support')
    expect(full).toContain('Du skickar ingenting själv')
    expect(full).toContain('Lova inte när eller vad supporten svarar')
  })

  it('names the hand-off button by the label the dialog gives it, in both languages', () => {
    expect(SEND_TO_SUPPORT_LABEL.sv).toBe(sv.support_link.ask_send_to_support)
    expect(SEND_TO_SUPPORT_LABEL.en).toBe(en.support_link.ask_send_to_support)
    expect(full).toContain(`knappen "${sv.support_link.ask_send_to_support}"`)
  })

  it('requires a page read behind every step it describes, also after it has declined to do the thing', () => {
    expect(full).toContain('ska bygga på ett read_page-anrop för just den sidan')
    expect(full).toContain('när du först säger nej')
  })

  it('names a text as a button or a tab only when read_page marks it so', () => {
    expect(full).toContain('Kalla bara en text för knapp, flik eller liknande när den är märkt så')
    expect(full).toContain('i stället för att välja bland de omärkta texterna')
    expect(full).toContain('Märkningen är till för dig')
    // Every role word the reader can attach is one the prompt explains.
    for (const word of Object.values(PAGE_TEXT_ROLES)) expect(full).toContain(`(${word})`)
  })

  it('answers a rule from the skill library, and says so when it has none to read', () => {
    expect(full).toContain('gnubok_list_skills')
    expect(full).toContain('gnubok_load_skill')
    const noSkills = supportSystemPrompt({ locale: 'sv', hasLedgerTools: true, hasPageTexts: true, hasSkillTools: false })
    expect(noSkills).not.toContain('gnubok_load_skill')
    expect(noSkills).toContain('allmänt hållet')
  })

  it('falls back to the menu-only rule when the build wrote no page texts', () => {
    const menuOnly = supportSystemPrompt({ locale: 'sv', hasLedgerTools: true, hasPageTexts: false, hasSkillTools: true })
    expect(menuOnly).not.toContain('read_page')
    expect(menuOnly).not.toContain('find_in_app')
    expect(menuOnly).toContain('Du ser menyn, inte innehållet på sidorna')
    expect(menuOnly).toContain('offer_human_support')
  })

  it('does not promise ledger tools an installation does not have', () => {
    const noLedger = supportSystemPrompt({ locale: 'sv', hasLedgerTools: false, hasPageTexts: true, hasSkillTools: true })
    expect(noLedger).not.toContain('ANROPA rätt verktyg')
    expect(noLedger).toContain('Du har inga verktyg för bolagets bokföring här')
  })

  it('answers in the language of the app', () => {
    expect(full).toContain('Du svarar alltid på svenska.')
    expect(supportSystemPrompt({ locale: 'en', hasLedgerTools: true, hasPageTexts: true, hasSkillTools: true })).toContain(
      'Du svarar alltid på engelska',
    )
  })

  it('is the same text for every company, so the prompt cache can share it', () => {
    expect(supportSystemPrompt({ locale: 'sv', hasLedgerTools: true, hasPageTexts: true, hasSkillTools: true })).toBe(full)
  })

  it('carries no em or en dash', () => {
    expect(full).not.toMatch(/[\u2013\u2014]/)
  })
})

describe('supportAssistantRollout', () => {
  it('is off for everyone until the variable is set', () => {
    expect(supportAssistantRollout({})).toEqual([])
    expect(supportAssistantRollout({ SUPPORT_ASSISTANT_COMPANY_IDS: '  ' })).toEqual([])
    expect(isSupportAssistantEnabled(COMPANY, {})).toBe(false)
  })

  it('opens for the listed companies, each once, spaces ignored', () => {
    const env = { SUPPORT_ASSISTANT_COMPANY_IDS: ` ${COMPANY}, ${COMPANY} ,` }
    expect(supportAssistantRollout(env)).toEqual([COMPANY])
    expect(isSupportAssistantEnabled(COMPANY, env)).toBe(true)
    expect(isSupportAssistantEnabled(OTHER, env)).toBe(false)
  })

  it('opens for every company with a star, and never for no company at all', () => {
    const env = { SUPPORT_ASSISTANT_COMPANY_IDS: '*' }
    expect(supportAssistantRollout(env)).toBe('all')
    expect(isSupportAssistantEnabled(OTHER, env)).toBe(true)
    expect(isSupportAssistantEnabled(null, env)).toBe(false)
    expect(isSupportAssistantEnabled(undefined, env)).toBe(false)
  })
})

describe('supportAssistantEffort', () => {
  it('is medium unless set', () => {
    expect(supportAssistantEffort({})).toBe('medium')
    expect(supportAssistantEffort({ SUPPORT_ASSISTANT_EFFORT: 'nonsense' })).toBe('medium')
  })

  it('takes a level, any case', () => {
    expect(supportAssistantEffort({ SUPPORT_ASSISTANT_EFFORT: 'LOW' })).toBe('low')
    expect(supportAssistantEffort({ SUPPORT_ASSISTANT_EFFORT: ' high ' })).toBe('high')
  })

  it('sends none at all with "default", for a model that does not take the setting', () => {
    expect(supportAssistantEffort({ SUPPORT_ASSISTANT_EFFORT: 'default' })).toBeUndefined()
  })
})
