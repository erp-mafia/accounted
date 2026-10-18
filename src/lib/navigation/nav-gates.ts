import type { NavGateFlags, NavV2Item } from '@/components/dashboard/nav-v2'
import type { CapabilitySurface } from '@/lib/modules/capabilities'
import type { ModuleId } from '@/lib/modules/manifest'
import type { EntityType } from '@/types'

/**
 * Everything the sidebar's visibility gates depend on, for one company.
 *
 * The sidebar (DashboardNav) builds it from the layout's props and the client
 * context; the assistant's UI map (lib/agent/ask/ui-map.ts) builds it on the
 * server from the same columns. Both resolve the capabilities surface with
 * the same function (capabilityInputsFromEntitlements) and then run
 * passesNavGates, so the map the assistant is given hides a surface for
 * exactly the reason the sidebar does.
 */
export interface NavGateContext {
  entityType: EntityType
  /**
   * The company's resolved capabilities as a surface reads them
   * (capabilitySurface in lib/modules/capabilities.ts): which modules are
   * hidden by their package or country, and which the legal form does not
   * offer. The same object MCP's tools/list and the agent briefing read.
   */
  surface: CapabilitySurface
  dimensionsEnabled: boolean
  salesOrdersEnabled: boolean
  quotesEnabled: boolean
  hasWebshop: boolean
  hasMileage: boolean
  hasExpenseClaims: boolean
  /** A POS connection exists, live or ended (lib/dashboard/nav-flags.ts). */
  hasPosSales: boolean
  arkivEnabled: boolean
  agentsEnabled: boolean
  /** The company is in the new Inkorg page's rollout (lib/inkorg/flag.ts). */
  inkorgV2Enabled: boolean
  capabilities: readonly string[]
  hiddenNavHrefs: ReadonlySet<string>
}

/** `entityOnly` accepts one form or a list of forms. */
function entityGateAllows(gate: EntityType | readonly EntityType[], entityType: EntityType): boolean {
  return Array.isArray(gate) ? gate.includes(entityType) : gate === entityType
}

/** Whether the menu shows a surface of this module, by the resolved capabilities. */
export function menuShowsModule(surface: CapabilitySurface, moduleId: ModuleId): boolean {
  return !surface.hidden.includes(moduleId) && !surface.notForLegalForm.includes(moduleId)
}

/** One gate for every navigation: a surface hides for the same reason everywhere. */
export function passesNavGates(item: NavGateFlags, ctx: NavGateContext): boolean {
  if (item.hidden) return false
  if (ctx.hiddenNavHrefs.has(item.href)) return false
  // The resolved capabilities: a module whose package is switched off or not
  // in the company's country is hidden, as its tools are in MCP's
  // tools/list; so is a module the legal form does not offer (payroll until
  // the company is an employer by form or has flagged pays_salaries, #782).
  if (!menuShowsModule(ctx.surface, item.module)) return false
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
  // Kassarapporter is hidden until a POS venue has been connected.
  if (item.requiresPosSales && !ctx.hasPosSales) return false
  // Arkiv rolls out per company; outside the rollout the pages 404.
  if (item.requiresArkiv && !ctx.arkivEnabled) return false
  // The Agenter page is hidden in production while it is finished.
  if (item.requiresAgents && !ctx.agentsEnabled) return false
  // The new Inkorg page rolls out per company, and Underlag under Inköp
  // hides for the same companies: the inbox has one place either way.
  if (item.requiresInkorgV2 && !ctx.inkorgV2Enabled) return false
  if (item.hiddenWithInkorgV2 && ctx.inkorgV2Enabled) return false
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
  // The Assistent (/chat) entry has no gate: before the agent is built it
  // leads to building it (chat/layout), so a new account always sees it.
  return true
}

/** The nav tree with the same gates applied to sections and their sub-items. */
export function gateNavTree(items: NavV2Item[], ctx: NavGateContext): NavV2Item[] {
  return items
    .filter((i) => passesNavGates(i, ctx))
    .map((i) => ({ ...i, sub: i.sub?.filter((s) => passesNavGates(s, ctx)) }))
}
