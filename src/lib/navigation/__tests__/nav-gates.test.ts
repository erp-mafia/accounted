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
    ['requiresAgents', item({ requiresAgents: true }), { agentsEnabled: false }],
    ['requiresInkorgV2', item({ requiresInkorgV2: true }), { inkorgV2Enabled: false }],
    ['requiresAutogiro', item({ requiresAutogiro: true }), { autogiroEnabled: false }],
    ['requiredCapability', item({ requiredCapability: 'ai' }), { capabilities: [] }],
    ['entityOnly', item({ entityOnly: 'aktiebolag' }), { entityType: 'enskild_firma' }],
    ['entityOnly list', item({ entityOnly: ['aktiebolag', 'ekonomisk_forening'] }), { entityType: 'enskild_firma' }],
    ['branding hidden href', item({ href: '/kpi' }), { hiddenNavHrefs: new Set(['/kpi']) }],
  ]

  it.each(cases)('%s: shown when the company has it, hidden when not', (_name, flags, off) => {
    expect(passesNavGates(flags, ctx())).toBe(true)
    expect(passesNavGates(flags, ctx(off))).toBe(false)
  })

  it('a list of forms shows for every form in it', () => {
    const flags = item({ entityOnly: ['aktiebolag', 'ekonomisk_forening'] })
    expect(passesNavGates(flags, ctx({ entityType: 'ekonomisk_forening' }))).toBe(true)
  })

  it('always shows the Assistent entry: before the agent is built it leads to building it (crm#1135)', () => {
    expect(passesNavGates(item({ href: '/chat' }), ctx())).toBe(true)
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
