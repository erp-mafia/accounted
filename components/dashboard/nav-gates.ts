import type { CapabilityKey } from '@/lib/entitlements/keys'
import type { EntityType } from '@/types'
import type { NavGateFlags } from './nav-v2'

/**
 * What a navigation surface needs to decide whether a destination shows.
 * DashboardNav (the v1 rail and the v2 section tree) and the command
 * palette build one of these from the same layout flags, so a surface
 * hides for exactly the same reason everywhere it is listed. A page that
 * the sidebar does not show must not come back through ⌘K.
 */
export interface NavGateContext {
  entityType: EntityType
  /**
   * Payroll surfaces show for employers only: every aktiebolag, plus any
   * company that registered as an employer via company_settings.pays_salaries
   * (e.g. an enskild firma with staff). #782
   */
  isEmployer: boolean
  /** company_settings.dimensions_enabled (UI gate only; pages and APIs work regardless). */
  dimensionsEnabled: boolean
  /** company_settings.sales_orders_enabled (UI gate only). */
  salesOrdersEnabled: boolean
  /** An active WooCommerce/Shopify connection, or order rows already imported. */
  hasWebshop: boolean
  /** The mileage toggle, or trips that already exist (e.g. created via MCP). */
  hasMileage: boolean
  /** Expense claims already exist (new ones start from the Underlag pane). */
  hasExpenseClaims: boolean
  /** PAID capability keys the active company holds (entitled + enabled). */
  capabilities: readonly CapabilityKey[]
  /** Hrefs the host's branding hides (getBranding().hiddenNavHrefs). */
  hiddenNavHrefs: ReadonlySet<string>
  /** The agent onboarding is done, so /chat and its sub-pages may show. */
  assistantVerified: boolean
}

export function isEmployerCompany(entityType: EntityType, paysSalaries: boolean): boolean {
  return entityType === 'aktiebolag' || paysSalaries
}

/**
 * One gate for every shell. Cosmetic only: the page and API gates enforce
 * paywalls, entity forms and roles; this keeps the surfaces from
 * advertising a dead destination.
 */
export function passesNavGates(item: NavGateFlags, ctx: NavGateContext): boolean {
  if (item.hidden) return false
  if (ctx.hiddenNavHrefs.has(item.href)) return false
  if (item.employerOnly && !ctx.isEmployer) return false
  if (item.requiresDimensions && !ctx.dimensionsEnabled) return false
  if (item.requiresSalesOrders && !ctx.salesOrdersEnabled) return false
  if (item.requiresWebshop && !ctx.hasWebshop) return false
  if (item.requiresMileage && !ctx.hasMileage) return false
  if (item.requiresExpenses && !ctx.hasExpenseClaims) return false
  if (item.requiredCapability && !ctx.capabilities.includes(item.requiredCapability)) return false
  // Entity-gated statutory surfaces: INK2/ÅR for aktiebolag, NE for enskild
  // firma; the page for the other form does not exist.
  if (item.entityOnly && item.entityOnly !== ctx.entityType) return false
  // Byrå cockpit entries live in the lean cockpit sidebar (cockpitNavItems);
  // in company mode the pinned back-to-clients link replaces them (WL-14).
  if (item.byraOnly) return false
  // No Assistent until the agent is built: chat/layout bounces unverified
  // users to the home checklist, so the entry would only bounce too.
  if (item.href === '/chat' && !ctx.assistantVerified) return false
  return true
}

/**
 * Byrå-scope surfaces stay reachable without an active company; everything
 * else needs one.
 */
const ALWAYS_ENABLED_HREFS: ReadonlySet<string> = new Set([
  '/settings',
  '/clients',
  '/byra',
  '/byra/automations',
  '/byra/kpi',
])

export function isNavHrefEnabled(href: string, hasCompany: boolean): boolean {
  // The back-to-clients link may be absolute (cross-host cockpit); judge it
  // by its path so it stays as reachable as the relative form.
  const path = href.startsWith('https://') ? new URL(href).pathname : href
  const base = path.split('?')[0]
  return hasCompany || ALWAYS_ENABLED_HREFS.has(base) || base.startsWith('/settings')
}
