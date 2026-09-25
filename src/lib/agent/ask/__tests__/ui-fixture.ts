import sv from '@/messages/sv.json'
import { CAPABILITY } from '@/lib/entitlements/keys'
import type { NavGateContext } from '@/lib/navigation/nav-gates'
import { menuTrail, type UiLabels } from '../ui-map'

// Shared by the tests that check a prompt's UI wording against the real menu
// (nav-v2.ts + the settings sections, labelled from sv.json), so a renamed or
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
}

/** An aktiebolag with every opt-in surface on: the widest menu there is. */
export function gateContext(overrides: Partial<NavGateContext> = {}): NavGateContext {
  return {
    entityType: 'aktiebolag',
    isEmployer: true,
    dimensionsEnabled: true,
    salesOrdersEnabled: true,
    quotesEnabled: true,
    hasWebshop: true,
    hasMileage: true,
    hasExpenseClaims: true,
    arkivEnabled: true,
    agentsEnabled: true,
    capabilities: [CAPABILITY.ai],
    hiddenNavHrefs: new Set(),
    agentVerified: true,
    ...overrides,
  }
}

/** The real Swedish menu path to a page ("Inköp → Underlag"); throws when no menu entry leads there. */
export function svMenuPath(route: string, ctx: NavGateContext = gateContext()): string {
  const trail = menuTrail(route, { ctx, labels: SV_LABELS, hasMcpExtension: true })
  if (!trail) throw new Error(`no menu entry leads to ${route}`)
  return trail.join(' → ')
}
