import { describe, it, expect } from 'vitest'
import type { NavGateFlags } from '@/components/dashboard/nav-v2'
import { gateNavTree, passesNavGates, type NavGateContext } from '../nav-gates'

// The sidebar and the assistant's UI map share this gate, so a surface hides
// for the same reason in both. Each case: the flag that hides it, off vs on.

function ctx(overrides: Partial<NavGateContext> = {}): NavGateContext {
  return {
    entityType: 'aktiebolag',
    surface: { hidden: [], notForLegalForm: [] },
    dimensionsEnabled: true,
    salesOrdersEnabled: true,
    quotesEnabled: true,
    hasWebshop: true,
    hasMileage: true,
    hasExpenseClaims: true,
    hasPosSales: true,
    arkivEnabled: true,
    signingEnabled: true,
    agentsEnabled: true,
    inkorgV2Enabled: true,
    autogiroEnabled: true,
    capabilities: ['ai'],
    hiddenNavHrefs: new Set(),
    ...overrides,
  }
}

const item = (flags: Partial<NavGateFlags>): NavGateFlags => ({ href: '/x', module: 'ledger', ...flags })

describe('passesNavGates', () => {
  const cases: Array<[string, NavGateFlags, Partial<NavGateContext>]> = [
    ['module hidden by its package or country', item({ module: 'payroll' }), { surface: { hidden: ['payroll'], notForLegalForm: [] } }],
    ['module not offered for the legal form', item({ module: 'payroll' }), { surface: { hidden: [], notForLegalForm: ['payroll'] } }],
    ['requiresDimensions', item({ requiresDimensions: true }), { dimensionsEnabled: false }],
    ['requiresSalesOrders', item({ requiresSalesOrders: true }), { salesOrdersEnabled: false }],
    ['requiresQuotes', item({ requiresQuotes: true }), { quotesEnabled: false }],
    ['requiresWebshop', item({ requiresWebshop: true }), { hasWebshop: false }],
    ['requiresMileage', item({ requiresMileage: true }), { hasMileage: false }],
    ['requiresExpenses', item({ requiresExpenses: true }), { hasExpenseClaims: false }],
    ['requiresPosSales', item({ requiresPosSales: true }), { hasPosSales: false }],
    ['requiresArkiv', item({ requiresArkiv: true }), { arkivEnabled: false }],
    ['requiresSigning', item({ requiresSigning: true }), { signingEnabled: false }],
    ['requiresAgents', item({ requiresAgents: true }), { agentsEnabled: false }],
    ['requiresInkorgV2', item({ requiresInkorgV2: true }), { inkorgV2Enabled: false }],
    ['requiresAutogiro', item({ requiresAutogiro: true }), { autogiroEnabled: false }],
    ['requiredCapability', item({ requiredCapability: 'ai' }), { capabilities: [] }],
    ['entityOnly', item({ entityOnly: 'aktiebolag' }), { entityType: 'enskild_firma' }],
    ['entityOnly list', item({ entityOnly: ['aktiebolag', 'ekonomisk_forening'] }), { entityType: 'enskild_firma' }],
    ['branding hidden href', item({ href: '/kpi' }), { hiddenNavHrefs: new Set(['/kpi']) }],
    ['branding hidden href, a view or create link of the page', item({ href: '/kpi?new' }), { hiddenNavHrefs: new Set(['/kpi']) }],
  ]

  it.each(cases)('%s: shown when the company has it, hidden when not', (_name, flags, off) => {
    expect(passesNavGates(flags, ctx())).toBe(true)
    expect(passesNavGates(flags, ctx(off))).toBe(false)
  })

  it('a list of forms shows for every form in it', () => {
    const flags = item({ entityOnly: ['aktiebolag', 'ekonomisk_forening'] })
    expect(passesNavGates(flags, ctx({ entityType: 'ekonomisk_forening' }))).toBe(true)
  })

  it('always shows the Assistent entry: without a built agent it leads to Koppla en agent (crm#1135)', () => {
    expect(passesNavGates(item({ href: '/chat' }), ctx())).toBe(true)
  })

  // ASSISTANT_CHAT_ENABLED: on unless switched off, so a context that does
  // not say reads as on, the opposite of the rollouts above.
  it('hides the chat entry only where the installation has switched the chat off', () => {
    const chat = item({ href: '/chat', requiresAssistantChat: true })
    expect(passesNavGates(chat, ctx())).toBe(true)
    expect(passesNavGates(chat, ctx({ assistantChatEnabled: true }))).toBe(true)
    expect(passesNavGates(chat, ctx({ assistantChatEnabled: false }))).toBe(false)
    expect(passesNavGates(item({ href: '/wiki' }), ctx({ assistantChatEnabled: false }))).toBe(true)
  })

  it('hides what the new Inkorg replaces for a company in its rollout, and only then', () => {
    const underlag = item({ href: '/e/general/invoice-inbox', hiddenWithInkorgV2: true })
    expect(passesNavGates(underlag, ctx({ inkorgV2Enabled: false }))).toBe(true)
    expect(passesNavGates(underlag, ctx({ inkorgV2Enabled: true }))).toBe(false)
  })

  it('never shows hidden or byrå-only entries in the company nav', () => {
    expect(passesNavGates(item({ hidden: true }), ctx())).toBe(false)
    expect(passesNavGates(item({ byraOnly: true }), ctx())).toBe(false)
  })
})

describe('gateNavTree', () => {
  it('gates sections and their sub-items alike', () => {
    const tree = gateNavTree(
      [
        {
          href: '/a',
          module: 'invoicing',
          labelKey: 'a',
          sub: [
            { href: '/a/1', module: 'invoicing', labelKey: 'a1' },
            { href: '/a/2', module: 'invoicing', labelKey: 'a2', requiresQuotes: true },
            { href: '/a/3', module: 'pos', labelKey: 'a3' },
          ],
        },
        { href: '/b', module: 'payroll', labelKey: 'b' },
      ],
      ctx({ quotesEnabled: false, surface: { hidden: ['pos'], notForLegalForm: ['payroll'] } }),
    )
    expect(tree).toEqual([
      { href: '/a', module: 'invoicing', labelKey: 'a', sub: [{ href: '/a/1', module: 'invoicing', labelKey: 'a1' }] },
    ])
  })
})

describe('the invoicer role', () => {
  it('sees only the invoicing pages in the real menu, and every other role sees the menu as before', async () => {
    const { NAV_V2_COMPANY, NAV_V2_TOP } = await import('@/components/dashboard/nav-v2')
    const hrefs = (role: string | undefined) => {
      const tree = gateNavTree([...NAV_V2_TOP, ...NAV_V2_COMPANY], ctx({ role }))
      return tree.flatMap((i) => [i.href, ...(i.sub ?? []).map((s) => s.href)])
    }
    const invoicer = new Set(hrefs('invoicer'))
    expect([...invoicer].sort()).toEqual(['/articles', '/customers', '/invoices', '/quotes', '/sales-orders'])
    for (const role of ['owner', 'member', 'viewer', undefined]) {
      expect(hrefs(role), String(role)).toEqual(hrefs('owner'))
    }
    expect(hrefs('owner')).toEqual(expect.arrayContaining(['/salary', '/bookkeeping', '/transactions']))
  })
})

describe('the rows the agent picture moves', () => {
  const pictureRow = item({ href: '/wiki', module: 'agent', requiresAgentPicture: true })
  const replacedRow = item({ href: '/wiki?view=memory', module: 'agent', hiddenWithAgentPicture: true })

  it('shows a picture row only where the picture is switched on for the company', () => {
    expect(passesNavGates(pictureRow, ctx())).toBe(false)
    expect(passesNavGates(pictureRow, ctx({ agentPictureEnabled: false }))).toBe(false)
    expect(passesNavGates(pictureRow, ctx({ agentPictureEnabled: true }))).toBe(true)
  })

  it('hides what the picture replaces only there', () => {
    expect(passesNavGates(replacedRow, ctx())).toBe(true)
    expect(passesNavGates(replacedRow, ctx({ agentPictureEnabled: false }))).toBe(true)
    expect(passesNavGates(replacedRow, ctx({ agentPictureEnabled: true }))).toBe(false)
  })

  it('keeps a row\'s other gates', () => {
    const skills = item({ href: '/skills', module: 'agent', requiresAgents: true, hiddenWithAgentPicture: true })
    expect(passesNavGates(skills, ctx({ agentsEnabled: false }))).toBe(false)
    expect(passesNavGates(skills, ctx({ agentsEnabled: true }))).toBe(true)
    expect(passesNavGates(skills, ctx({ agentsEnabled: true, agentPictureEnabled: true }))).toBe(false)
  })
})

describe('the Frågor row', () => {
  const questions = item({ href: '/questions', module: 'platform', requiresCompanyQuestions: true })

  it('shows only where the question list is switched on for the company', () => {
    expect(passesNavGates(questions, ctx())).toBe(false)
    expect(passesNavGates(questions, ctx({ companyQuestionsEnabled: false }))).toBe(false)
    expect(passesNavGates(questions, ctx({ companyQuestionsEnabled: true }))).toBe(true)
  })

  it('is not offered to the invoicing-only role', () => {
    expect(passesNavGates(questions, ctx({ companyQuestionsEnabled: true, role: 'invoicer' }))).toBe(false)
  })
})

describe('the one Bolaget row (product decision 2026-10-30)', () => {
  const hub = item({ href: '/bolaget', module: 'corporate', requiresBolagetHub: true })

  it('is hidden outside the rollout, for every form', () => {
    for (const entityType of ['aktiebolag', 'enskild_firma'] as const) {
      expect(passesNavGates(hub, ctx({ entityType, bolagetEnabled: false, commitmentsEnabled: false }))).toBe(false)
      expect(passesNavGates(hub, ctx({ entityType }))).toBe(false)
    }
  })

  it('shows where Avtal och åtaganden is open, for any form', () => {
    expect(passesNavGates(hub, ctx({ entityType: 'enskild_firma', commitmentsEnabled: true }))).toBe(true)
  })

  it('shows where the registers are open: the rollout and an aktiebolag', () => {
    expect(passesNavGates(hub, ctx({ bolagetEnabled: true }))).toBe(true)
    expect(passesNavGates(hub, ctx({ entityType: 'enskild_firma', bolagetEnabled: true }))).toBe(false)
  })

  it('is one row with no sub-items in the real menu, and nothing else names a Bolaget page', async () => {
    const { NAV_V2_COMPANY, NAV_V2_TOP } = await import('@/components/dashboard/nav-v2')
    const tree = (overrides: Partial<NavGateContext>) => gateNavTree([...NAV_V2_TOP, ...NAV_V2_COMPANY], ctx(overrides))
    const all = (overrides: Partial<NavGateContext>) => tree(overrides).flatMap((i) => [i.href, ...(i.sub ?? []).map((s) => s.href)])

    const open = tree({ bolagetEnabled: true, commitmentsEnabled: true }).filter((i) => i.href.startsWith('/bolaget'))
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ href: '/bolaget', labelKey: 'bolaget' })
    expect(open[0].sub ?? []).toEqual([])
    expect(all({ bolagetEnabled: true, commitmentsEnabled: true }).filter((h) => h.startsWith('/bolaget') || h === '/commitments')).toEqual(['/bolaget'])

    expect(all({ bolagetEnabled: false, commitmentsEnabled: false }).filter((h) => h.startsWith('/bolaget') || h === '/commitments')).toEqual([])
  })
})
