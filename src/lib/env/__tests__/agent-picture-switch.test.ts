import { describe, expect, it } from 'vitest'
import { agentPictureRollout, isAgentPictureEnabled } from '../agent-picture-switch'

const A = 'AAAAAAAA-0000-4000-8000-000000000001'

describe('agent picture switch (AGENT_PICTURE_COMPANY_IDS)', () => {
  it('is off for everybody while unset or blank', () => {
    expect(agentPictureRollout({})).toEqual([])
    expect(isAgentPictureEnabled(A, {})).toBe(false)
    expect(isAgentPictureEnabled(A, { AGENT_PICTURE_COMPANY_IDS: '  ' })).toBe(false)
  })

  it('opens for the listed companies only, whatever the case', () => {
    const env = { AGENT_PICTURE_COMPANY_IDS: `${A.toLowerCase()}, other , other` }
    expect(agentPictureRollout(env)).toEqual([A.toLowerCase(), 'other'])
    expect(isAgentPictureEnabled(A, env)).toBe(true)
    expect(isAgentPictureEnabled('third', env)).toBe(false)
    expect(isAgentPictureEnabled(null, env)).toBe(false)
    expect(isAgentPictureEnabled(undefined, env)).toBe(false)
  })

  it('opens for everyone with *', () => {
    expect(agentPictureRollout({ AGENT_PICTURE_COMPANY_IDS: '*' })).toBe('all')
    expect(isAgentPictureEnabled(A, { AGENT_PICTURE_COMPANY_IDS: '*' })).toBe(true)
    expect(isAgentPictureEnabled('', { AGENT_PICTURE_COMPANY_IDS: '*' })).toBe(false)
  })
})
