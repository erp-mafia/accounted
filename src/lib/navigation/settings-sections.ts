import { isInvoicerPagePath, isInvoicerRole } from '@/lib/auth/invoicer-role'

export type SettingsGroupKey = 'company' | 'accounting' | 'sales' | 'tools' | 'account' | 'byra'

/**
 * Group order of the Inställningar sidebar (the V7 shell, 2026-11-14): the
 * company first (Företaget, Bokföring, Försäljning, Kopplingar), then the
 * person (Du), then the byrå's own sections (Byrå, byrå scope only).
 */
export const SETTINGS_GROUP_ORDER: SettingsGroupKey[] = ['company', 'accounting', 'sales', 'tools', 'account', 'byra']

/**
 * Sections that the shell lists under another area as well: Koppla en agent,
 * the create button of Agenter, opens /settings/api. Inside a company the Inställningar sidebar
 * leaves such a section to that area (its search still finds it); in byrå
 * scope, where the cockpit has no Agenter area, it stays in the list.
 */
export const SETTINGS_SECTIONS_IN_AGENTS: ReadonlySet<string> = new Set(['api'])

/**
 * Sections that have a page but no rail entry: each is reached from a hub
 * section and highlights that hub in the rail. Kopplingar lists the bank,
 * WhatsApp, Skatteverket, Peppol and Gmail connections and links to their
 * pages, which stay at their own URLs because OAuth callbacks and deep links
 * (bank consent renewal, ?select_accounts=, ?skv_connected=, ?mail=) land
 * there.
 */
export const SETTINGS_SECTION_PARENT: Record<string, string> = {
  banking: 'connections',
  whatsapp: 'connections',
  skatteverket: 'connections',
  peppol: 'connections',
  'bank-payments': 'connections',
  mail: 'connections',
  pos: 'connections',
  spend: 'connections',
}

export interface SettingsSection {
  id: string
  href: string
  group: SettingsGroupKey
}

export interface SettingsSectionScope {
  hasCompany: boolean
  /** Settings opened from the byrå cockpit (?ctx=byra), honored only for byrå team members. */
  byraScope: boolean
  byraRole: 'owner' | 'admin' | 'member' | null
  hasMcpExtension: boolean
  /**
   * The person's role in the company, when the caller knows it: the
   * invoicing-only role is listed only the sections it may open.
   */
  role?: string | null
}

/**
 * Whether a settings destination opens for this role. The invoicing-only
 * role opens one settings page, its own account (lib/auth/invoicer-role.ts):
 * every other section would send it back to Fakturor.
 */
export function settingsOpenForRole(role: string | null | undefined, href: string): boolean {
  return !isInvoicerRole(role) || isInvoicerPagePath(href.split(/[?#]/)[0])
}

/** The settings_nav message key for a section id ("fiscal-years" -> "fiscal_years"). */
export function settingsMessageKey(id: string): string {
  return id.replace('-', '_')
}

/**
 * Single source of truth for the settings sections, their conditional
 * visibility, and their grouping. The rail (useSettingsNavItems) labels them
 * with its translations; the assistant's UI map does the same on the server.
 */
export function visibleSettingsSections(scope: SettingsSectionScope): SettingsSection[] {
  const { hasCompany, byraScope, byraRole, hasMcpExtension } = scope
  // `personal`: the section edits something that belongs to the person, not
  // to the active company, so it also shows in byrå scope. Every section in
  // the Du group is personal; a section filed in another group opts in.
  const section = (
    id: string,
    href: string,
    group: SettingsGroupKey,
    show: boolean,
    personal = group === 'account' || group === 'byra',
  ) => ({ id, href, group, show, personal })

  // Löner shows for every company: "Företaget betalar löner" lives at the top
  // of the section, so hiding the section for a form without default payroll
  // would leave that switch unreachable. The rest of the section folds away
  // while the switch is off.
  const defs = [
    section('account', '/settings/account', 'account', true),
    section('security', '/settings/security', 'account', true),
    // Byrå scope: members & roles is the one byrå-level section; billing is
    // company-scoped (team-billed byråer have no per-company subscription).
    section('team', '/settings/team', 'byra', byraScope),
    // Varumärke (WL-17): byrå owner/admin edits the brand logo; members see
    // nothing (the section would be read-only noise for them).
    section('brand', '/settings/brand', 'byra', byraScope && (byraRole === 'owner' || byraRole === 'admin')),
    section('company', '/settings/company', 'company', hasCompany),
    // Anpassa: the company's packages (Lön, Kundfakturor, ...) with their
    // status and switch (Profiles and Suggestions, winding down and Anpassa).
    section('anpassa', '/settings/anpassa', 'company', hasCompany),
    section('members', '/settings/members', 'company', hasCompany),
    section('billing', '/settings/billing', 'company', !byraScope),
    section('bookkeeping', '/settings/bookkeeping', 'accounting', hasCompany),
    section('fiscal-years', '/settings/fiscal-years', 'accounting', hasCompany),
    section('tax', '/settings/tax', 'accounting', hasCompany),
    section('salary', '/settings/salary', 'accounting', hasCompany),
    // Attest of supplier invoices (who attests, from what amount, one or all).
    section('attest', '/settings/attest', 'accounting', hasCompany),
    section('templates', '/settings/templates', 'accounting', hasCompany),
    section('invoicing', '/settings/invoicing', 'sales', hasCompany),
    section('sending', '/settings/sending', 'sales', hasCompany),
    // Påminnelser och inkasso: a sales setting with a row of its own (it was
    // reached only through Fakturor and Kopplingar before the V7 shell).
    section('collections', '/settings/collections', 'sales', hasCompany),
    section('connections', '/settings/connections', 'tools', hasCompany),
    // API och MCP is personal: a connection belongs to the person who made it
    // and reaches the companies picked when it was made, whichever company is
    // open. A byrå user connects their clients from the cockpit, without
    // opening one of them first.
    section('api', '/settings/api', 'tools', hasCompany && hasMcpExtension, true),
    // Datadelning och AI: the company's AI switch and what it lets us do with
    // its data (lib/legal/data-choices.ts). Company-scoped like Kopplingar.
    section('data-sharing', '/settings/data-sharing', 'tools', hasCompany),
  ]

  return (
    defs
      .filter((d) => d.show)
      // Byrå scope hides every company-scoped section: those are edited from
      // inside the client company where it is obvious WHICH company they hit.
      .filter((d) => !byraScope || d.personal)
      .filter((d) => settingsOpenForRole(scope.role, d.href))
      .map(({ show: _show, personal: _personal, ...s }) => s)
  )
}
