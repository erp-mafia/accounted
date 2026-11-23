/**
 * The agent picture through navRollouts (AGENT_PICTURE_COMPANY_IDS) and into
 * the shell's Agenter area: the menu and the assistant's map of it read the
 * same answer, and a company outside the switch keeps the menu it had.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NAV_V3_AREAS, areaCreate, areaItems, gateAreas } from '@/components/dashboard/nav-v3'
import { passesNavGates, type NavGateContext } from '../nav-gates'
import { navRollouts } from '../nav-rollouts'

afterEach(() => {
  vi.unstubAllEnvs()
})

const COMPANY = 'aaaaaaaa-0000-4000-8000-000000000001'

/** A company with the Agenter page and Arkiv's reading on, so every row of the area has its other gates open. */
function shell(companyId: string): NavGateContext {
  return {
    entityType: 'aktiebolag',
    surface: { hidden: [], notForLegalForm: [] },
    dimensionsEnabled: false,
    salesOrdersEnabled: false,
    quotesEnabled: true,
    hasWebshop: false,
    hasMileage: false,
    hasExpenseClaims: false,
    hasPosSales: false,
    ...navRollouts(companyId),
    arkivBrainEnabled: true,
    agentsEnabled: true,
    mcpExtensionEnabled: true,
    capabilities: ['ai'],
    hiddenNavHrefs: new Set(),
  }
}

function agentsMenu(companyId: string) {
  const ctx = shell(companyId)
  const area = gateAreas(NAV_V3_AREAS, (item) => passesNavGates(item, ctx)).find((a) => a.id === 'agents')!
  return { create: areaCreate(area)?.href, groups: area.groups.map((g) => [g.labelKey ?? null, g.items.map((item) => item.href)]), rows: areaItems(area).map((item) => item.href) }
}

describe('navRollouts: the agent picture', () => {
  it('is off for every company while the switch is unset', () => {
    expect(navRollouts(COMPANY).agentPictureEnabled).toBe(false)
    expect(navRollouts(null).agentPictureEnabled).toBe(false)
  })

  it('is on for the companies the switch names, and for all with *', () => {
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', COMPANY)
    expect(navRollouts(COMPANY).agentPictureEnabled).toBe(true)
    expect(navRollouts('another-company').agentPictureEnabled).toBe(false)
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', '*')
    expect(navRollouts('another-company').agentPictureEnabled).toBe(true)
  })
})

describe('the Agenter area', () => {
  it('is unchanged for a company outside the switch', () => {
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', 'another-company')
    expect(agentsMenu(COMPANY)).toEqual({
      create: '/settings/api',
      groups: [
        ['v3_group_steer', ['/rules', '/skills']],
        ['v3_group_knowledge', ['/wiki', '/wiki?view=map', '/wiki?view=facts', '/wiki?view=memory']],
        [null, ['/chat']],
      ],
      rows: ['/rules', '/skills', '/wiki', '/wiki?view=map', '/wiki?view=facts', '/wiki?view=memory', '/chat'],
    })
  })

  it('is Koppla en agent, Kontext and Bokföringsregler with no group label where the picture is on, then Chatt while the chat is on', () => {
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', COMPANY)
    expect(agentsMenu(COMPANY)).toEqual({
      create: '/settings/api',
      groups: [
        [null, ['/wiki', '/rules']],
        [null, ['/chat']],
      ],
      rows: ['/wiki', '/rules', '/chat'],
    })
  })

  it('keeps Chatt by the chat switch alone where the picture is on', () => {
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', COMPANY)
    // Unset and on: the row is there.
    for (const chat of [undefined, 'true']) {
      if (chat !== undefined) vi.stubEnv('ASSISTANT_CHAT_ENABLED', chat)
      expect(agentsMenu(COMPANY).rows, String(chat)).toEqual(['/wiki', '/rules', '/chat'])
    }
    // Switched off with no company keeping the chat: the row goes, and the group with it.
    vi.stubEnv('ASSISTANT_CHAT_ENABLED', 'false')
    expect(agentsMenu(COMPANY)).toEqual({
      create: '/settings/api',
      groups: [[null, ['/wiki', '/rules']]],
      rows: ['/wiki', '/rules'],
    })
  })

  it('keeps the row for every company while some company keeps the chat, with the picture on or off', () => {
    vi.stubEnv('ASSISTANT_CHAT_ENABLED', 'false')
    vi.stubEnv('ASSISTANT_CHAT_COMPANY_IDS', 'another-company')
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', COMPANY)
    expect(agentsMenu(COMPANY).rows).toEqual(['/wiki', '/rules', '/chat'])
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', 'another-company')
    expect(agentsMenu(COMPANY).rows).toContain('/chat')
  })

  it('keeps Chatt by the chat switch alone for a company outside the switch', () => {
    vi.stubEnv('AGENT_PICTURE_COMPANY_IDS', 'another-company')
    expect(agentsMenu(COMPANY).rows).toContain('/chat')
    vi.stubEnv('ASSISTANT_CHAT_ENABLED', 'false')
    expect(agentsMenu(COMPANY).rows).toEqual(['/rules', '/skills', '/wiki', '/wiki?view=map', '/wiki?view=facts', '/wiki?view=memory'])
  })
})
