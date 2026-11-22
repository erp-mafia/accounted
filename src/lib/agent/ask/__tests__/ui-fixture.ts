import sv from '@/messages/sv.json'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { NavGateContext } from '@/lib/navigation/nav-gates'
import { menuTrail, type UiLabels } from '../ui-map'

// Shared by the tests that check a prompt's UI wording against the real menu
// (nav-v3.ts + the settings sections, labelled from sv.json), so a renamed or
// moved page fails the test instead of reaching a user as a dead direction.

function table(t: Record<string, unknown>): (key: string) => string {
  return (key) => {
    const value = t[key]
    return typeof value === 'string' ? value : key
  }
}

export const SV_LABELS: UiLabels = {
  nav: table(sv.nav as Record<string, unknown>),
  settings: table(sv.settings_nav as Record<string, unknown>),
  switcher: table(sv.company_switcher as Record<string, unknown>),
}

/**
 * An aktiebolag with every opt-in surface on: the widest menu there is. The
 * new Inkorg rollout is off: it moves the inbox rather than adding a page.
 */
export function gateContext(overrides: Partial<NavGateContext> = {}): NavGateContext {
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
    commitmentsEnabled: true,
    agentsEnabled: true,
    inkorgV2Enabled: false,
    autogiroEnabled: true,
    bolagetEnabled: true,
    bolagetMoneyEnabled: true,
    companyQuestionsEnabled: true,
    capabilities: [CAPABILITY.ai],
    hiddenNavHrefs: new Set(),
    ...overrides,
  }
}

/** The real Swedish menu path to a page ("Dokument → Inkommande"); throws when no menu entry leads there. */
export function svMenuPath(route: string, ctx: NavGateContext = gateContext()): string {
  const trail = menuTrail(route, { ctx, labels: SV_LABELS, hasMcpExtension: true })
  if (!trail) throw new Error(`no menu entry leads to ${route}`)
  return trail.join(' → ')
}
