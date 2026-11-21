import { describe, expect, it } from 'vitest'
import { companyQuestionsRollout, isCompanyQuestionsEnabled } from '../company-questions-switch'

const A = 'AAAAAAAA-0000-4000-8000-000000000001'

describe('company questions switch (COMPANY_QUESTIONS_COMPANY_IDS)', () => {
  it('is off for everybody while unset or blank', () => {
    expect(companyQuestionsRollout({})).toEqual([])
    expect(isCompanyQuestionsEnabled(A, {})).toBe(false)
    expect(isCompanyQuestionsEnabled(A, { COMPANY_QUESTIONS_COMPANY_IDS: '  ' })).toBe(false)
  })

  it('opens for the listed companies only, whatever the case', () => {
    const env = { COMPANY_QUESTIONS_COMPANY_IDS: `${A.toLowerCase()}, other , other` }
    expect(companyQuestionsRollout(env)).toEqual([A.toLowerCase(), 'other'])
    expect(isCompanyQuestionsEnabled(A, env)).toBe(true)
    expect(isCompanyQuestionsEnabled('third', env)).toBe(false)
    expect(isCompanyQuestionsEnabled(null, env)).toBe(false)
    expect(isCompanyQuestionsEnabled(undefined, env)).toBe(false)
  })

  it('opens for everyone with *', () => {
    expect(companyQuestionsRollout({ COMPANY_QUESTIONS_COMPANY_IDS: '*' })).toBe('all')
    expect(isCompanyQuestionsEnabled(A, { COMPANY_QUESTIONS_COMPANY_IDS: '*' })).toBe(true)
    expect(isCompanyQuestionsEnabled('', { COMPANY_QUESTIONS_COMPANY_IDS: '*' })).toBe(false)
  })
})
