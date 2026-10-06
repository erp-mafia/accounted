import type { NavGateFlags, NavV2Item } from '@/components/dashboard/nav-v2'
import type { EntityType } from '@/types'

/**
 * Everything the sidebar's visibility gates depend on, for one company.
 *
 * The sidebar (DashboardNav) builds it from the layout's props and the client
 * context; the assistant's UI map (lib/agent/ask/ui-map.ts) builds it on the
 * server from the same columns. Both then run passesNavGates, so the map the
 * assistant is given hides a surface for exactly the reason the sidebar does.
 */
export interface NavGateContext {
  entityType: EntityType
  /** offersPayroll (lib/company/offers-payroll.ts) for this company. */
  isEmployer: boolean
  dimensionsEnabled: boolean
  salesOrdersEnabled: boolean
  quotesEnabled: boolean
  hasWebshop: boolean
  hasMileage: boolean
  hasExpenseClaims: boolean
  arkivEnabled: boolean
  agentsEnabled: boolean
  capabilities: readonly string[]
  hiddenNavHrefs: ReadonlySet<string>
  agentVerified: boolean
}

/** `entityOnly` accepts one form or a list of forms. */
function entityGateAllows(gate: EntityType | readonly EntityType[], entityType: EntityType): boolean {
  return Array.isArray(gate) ? gate.includes(entityType) : gate === entityType
}

/** One gate for every navigation: a surface hides for the same reason everywhere. */
export function passesNavGates(item: NavGateFlags, ctx: NavGateContext): boolean {
  if (item.hidden) return false
  if (ctx.hiddenNavHrefs.has(item.href)) return false
  // Payroll (employerOnly) is hidden until the company is an employer by
  // form or has flagged pays_salaries. #782
  if (item.employerOnly && !ctx.isEmployer) return false
  // Dimension surfaces are hidden until the company opts in via the
  // bookkeeping settings toggle (company_settings.dimensions_enabled).
  if (item.requiresDimensions && !ctx.dimensionsEnabled) return false
  if (item.requiresSalesOrders && !ctx.salesOrdersEnabled) return false
  if (item.requiresQuotes && !ctx.quotesEnabled) return false
  // Webshop surfaces are hidden until a store is connected (or order rows
  // already exist from a since-disconnected store).
  if (item.requiresWebshop && !ctx.hasWebshop) return false
  // Körjournal is hidden until the company opts in via the bookkeeping
  // settings toggle (or trips already exist, e.g. created via MCP).
  if (item.requiresMileage && !ctx.hasMileage) return false
  // Utlägg is hidden until a claim exists (registered from Underlag).
  if (item.requiresExpenses && !ctx.hasExpenseClaims) return false
  // Arkiv rolls out per company; outside the rollout the pages 404.
  if (item.requiresArkiv && !ctx.arkivEnabled) return false
  // The Agenter page is hidden in production while it is finished.
  if (item.requiresAgents && !ctx.agentsEnabled) return false
  // Paywalled surfaces (e.g. the AI-only Dokumentinkorg) are hidden unless
  // the active company holds the capability. The page + API gates enforce
  // the paywall; this keeps the sidebar from advertising a dead workspace.
  if (item.requiredCapability && !ctx.capabilities.includes(item.requiredCapability)) return false
  // Entity-gated statutory surfaces: INK2/ÅR for aktiebolag and ekonomisk
  // förening, NE for enskild firma; the page for the other forms doesn't exist.
  if (item.entityOnly && !entityGateAllows(item.entityOnly, ctx.entityType)) return false
  // Byrå cockpit: the Klienter entry lives in the lean cockpit sidebar
  // (cockpitNavItems); in company mode the pinned back-to-clients link
  // replaces it, and non-byrå users never see it (WL-14).
  if (item.byraOnly) return false
  // Hide the Assistent (/chat) tab until the agent is built: mirrors the
  // floating AgentTrigger and avoids a nav entry that only bounces to the
  // home checklist (chat/layout redirects unverified users to /).
  if (item.href === '/chat' && !ctx.agentVerified) return false
  return true
}

/** The nav tree with the same gates applied to sections and their sub-items. */
export function gateNavTree(items: NavV2Item[], ctx: NavGateContext): NavV2Item[] {
  return items
    .filter((i) => passesNavGates(i, ctx))
    .map((i) => ({ ...i, sub: i.sub?.filter((s) => passesNavGates(s, ctx)) }))
}
