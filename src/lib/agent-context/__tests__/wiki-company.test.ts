/**
 * What decides where an address of the wiki ends for a company: the two
 * switches from the environment, and the installation's extensions as the
 * caller names them.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { wikiCompany } from '../wiki-company'

const COMPANY = 'aaaaaaaa-0000-4000-8000-000000000001'
const WITH_CONNECTION: ReadonlySet<string> = new Set(['mcp-server', 'stripe'])
const WITHOUT_CONNECTION: ReadonlySet<string> = new Set(['stripe'])

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('wikiCompany', () => {
  it('has neither the picture nor Fakta while the switches are unset', () => {
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', '')
    vi.stubEnv('ARKIV_BRAIN_COMPANY_IDS', '')
    expect(wikiCompany(COMPANY, WITH_CONNECTION)).toEqual({ picture: false, facts: false, agentConnection: true })
  })

  it('reads the picture and Fakta each from its own switch', () => {
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', COMPANY)
    vi.stubEnv('ARKIV_BRAIN_COMPANY_IDS', 'another-company')
    expect(wikiCompany(COMPANY, WITH_CONNECTION)).toEqual({ picture: true, facts: false, agentConnection: true })
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', 'another-company')
    vi.stubEnv('ARKIV_BRAIN_COMPANY_IDS', COMPANY)
    expect(wikiCompany(COMPANY, WITH_CONNECTION)).toEqual({ picture: false, facts: true, agentConnection: true })
  })

  it('has the agent connection where the installation is built with the MCP server extension, whatever the switches say', () => {
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', '*')
    expect(wikiCompany(COMPANY, WITH_CONNECTION).agentConnection).toBe(true)
    expect(wikiCompany(COMPANY, WITHOUT_CONNECTION).agentConnection).toBe(false)
    expect(wikiCompany(COMPANY, new Set<string>()).agentConnection).toBe(false)
    // The picture's switch is the company's; the connection is the installation's.
    expect(wikiCompany(COMPANY, WITHOUT_CONNECTION).picture).toBe(true)
  })

  it('has nothing without a company', () => {
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', COMPANY)
    vi.stubEnv('ARKIV_BRAIN_COMPANY_IDS', COMPANY)
    expect(wikiCompany(null, WITH_CONNECTION)).toEqual({ picture: false, facts: false, agentConnection: true })
    expect(wikiCompany(undefined, WITHOUT_CONNECTION)).toEqual({ picture: false, facts: false, agentConnection: false })
  })
})
