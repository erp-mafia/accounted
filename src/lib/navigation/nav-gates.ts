import type { NavGateFlags, NavV2Item } from '@/components/dashboard/nav-v2'
import type { CapabilitySurface } from '@/lib/modules/capabilities'
import type { ModuleId } from '@/lib/modules/manifest'
import { isInvoicerPagePath, isInvoicerRole } from '@/lib/auth/invoicer-role'
import { keepsShareRegister } from '@/lib/company/entity-type'
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
  /**
   * BankID document signing is switched on here (lib/navigation/nav-rollouts.ts):
   * the Signeringar page under Dokument. Absent reads as off.
   */
  signingEnabled?: boolean
  /** The company is in the Bolaget rollout (lib/env/commitments-switch.ts): Avtal och åtaganden. Absent reads as off. */
  commitmentsEnabled?: boolean
  agentsEnabled: boolean
  /** Arkiv reads the company's documents here (lib/arkiv/flag.ts): the Fakta view of the wiki. Absent reads as off. */
  arkivBrainEnabled?: boolean
  /** The company is in the new Inkorg page's rollout (lib/inkorg/flag.ts). */
  inkorgV2Enabled: boolean
  /** The company is in the booking screen's rollout (lib/env/booking-screen-switch.ts). Absent reads as off. */
  bookingScreenEnabled?: boolean
  /** The company is in the Autogiro rollout (lib/invoices/autogiro/flag.ts). */
  autogiroEnabled: boolean
  /**
   * The Bolaget registers are open: the rollout (lib/env/bolaget-switch.ts) or
   * a company set up from a formation. Absent reads as off.
   */
  bolagetEnabled?: boolean
  /** The rest of Bolaget (meetings, capital, owner tax): the rollout alone. Absent reads as off. */
  bolagetMoneyEnabled?: boolean
  /** The question list is switched on for the company (lib/env/company-questions-switch.ts). Absent reads as off. */
  companyQuestionsEnabled?: boolean
  /** The agent picture is switched on for the company (lib/env/agent-picture-switch.ts): the Agenter area is then the picture and the rules, with Chatt by its own switch. Absent reads as off. */
  agentPictureEnabled?: boolean
  /** The MCP server extension is built in (ENABLED_EXTENSION_IDS): the Koppla en agent row. Absent reads as off. */
  mcpExtensionEnabled?: boolean
  /**
   * The Chatt row (lib/env/assistant-chat-switch.ts assistantChatRowShown):
   * there until the built-in chat is gone for every company. Absent reads as
   * ON, unlike the rollouts above: the chat is there until someone switches
   * it off.
   */
  assistantChatEnabled?: boolean
  capabilities: readonly string[]
  hiddenNavHrefs: ReadonlySet<string>
  /**
   * The caller's role in the company, when the surface knows it. The
   * invoicing-only role sees only the pages it may open
   * (lib/auth/invoicer-role.ts); every other role, and an unknown one, is
   * gated as before.
   */
  role?: string | null
}

/**
 * What the dashboard layout resolves for the gates and hands to the sidebar
 * and the command palette, which add what the browser knows: the company's
 * capabilities, the caller's role, the brand's hidden pages and the build's
 * extensions.
 */
export type ShellNavGate = Omit<NavGateContext, 'capabilities' | 'hiddenNavHrefs' | 'role' | 'mcpExtensionEnabled'>

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
  // A row that opens one view of a page (/?vy=gjort) or a create link that
  // opens its drawer (/salary/employees?new) is hidden with the page.
  if (ctx.hiddenNavHrefs.has(item.href) || ctx.hiddenNavHrefs.has(item.href.split(/[?#]/)[0])) return false
  if (isInvoicerRole(ctx.role) && !isInvoicerPagePath(item.href)) return false
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
  // Signeringar follows the signing switch, as every other signing affordance does.
  if (item.requiresSigning && !ctx.signingEnabled) return false
  // Bolaget is one row over two halves that roll out per company
  // (BOLAGET_COMPANY_IDS): Avtal och åtaganden for every form, the
  // registers for a form that keeps an aktiebok. The row shows where either
  // half is open; outside both the /bolaget pages 404. The same form rule
  // as the pages' gate (lib/bolaget/gate.ts).
  if (item.requiresBolagetHub && !ctx.commitmentsEnabled && !(ctx.bolagetEnabled && keepsShareRegister(ctx.entityType))) return false
  // The two halves of Bolaget, for a row that opens one of them (the new
  // shell's Företaget area): the same rule as the tab bar (lib/bolaget/hub.ts).
  if (item.requiresBolagetRegisters && !(ctx.bolagetEnabled && keepsShareRegister(ctx.entityType))) return false
  if (item.requiresBolagetMoney && !(ctx.bolagetMoneyEnabled && keepsShareRegister(ctx.entityType))) return false
  if (item.requiresCommitments && !ctx.commitmentsEnabled) return false
  // The question list rolls out per company; outside the rollout its page 404s.
  if (item.requiresCompanyQuestions && !ctx.companyQuestionsEnabled) return false
  if (item.requiresMcpExtension && !ctx.mcpExtensionEnabled) return false
  // The Agenter page is hidden in production while it is finished.
  if (item.requiresAgents && !ctx.agentsEnabled) return false
  if (item.hiddenWithAgents && ctx.agentsEnabled) return false
  // Where the agent picture is on, the Agenter area is the picture (Kontext)
  // and Bokföringsregler, listed without a group label: the rows the picture
  // replaces hide, and the hidden pages keep their addresses. Chatt is not
  // one of them: it has its own gate, below.
  if (item.requiresAgentPicture && !ctx.agentPictureEnabled) return false
  if (item.hiddenWithAgentPicture && ctx.agentPictureEnabled) return false
  // Fakta exists only where Arkiv reads the documents; elsewhere the view is not offered.
  if (item.requiresArkivBrain && !ctx.arkivBrainEnabled) return false
  // The new Inkorg page rolls out per company, and Underlag under Inköp
  // hides for the same companies: the inbox has one place either way.
  if (item.requiresInkorgV2 && !ctx.inkorgV2Enabled) return false
  if (item.requiresBookingScreen && !ctx.bookingScreenEnabled) return false
  if (item.hiddenWithInkorgV2 && ctx.inkorgV2Enabled) return false
  // Autogiro rolls out per company; outside it the page shows only what the
  // company already holds, so the menu does not advertise it.
  if (item.requiresAutogiro && !ctx.autogiroEnabled) return false
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
  // The Chatt (/chat) entry has one gate, the installation's chat switch
  // (ASSISTANT_CHAT_ENABLED): switched off, the chat is not offered. While it
  // is on, every account sees the entry: for a company without a built
  // assistant it leads to Koppla en agent (chat/layout).
  if (item.requiresAssistantChat && ctx.assistantChatEnabled === false) return false
  return true
}

/** The nav tree with the same gates applied to sections and their sub-items. */
export function gateNavTree(items: NavV2Item[], ctx: NavGateContext): NavV2Item[] {
  return items
    .filter((i) => passesNavGates(i, ctx))
    .map((i) => ({ ...i, sub: i.sub?.filter((s) => passesNavGates(s, ctx)) }))
}
