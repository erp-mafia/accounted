export type SettingsGroupKey = 'account' | 'company' | 'accounting' | 'sales' | 'tools'

/** Rail group order: personal first (Du), then company-scoped buckets. */
export const SETTINGS_GROUP_ORDER: SettingsGroupKey[] = ['account', 'company', 'accounting', 'sales', 'tools']

/**
 * Sections that have a page but no rail entry: each is reached from a hub
 * section and highlights that hub in the rail. Kopplingar lists the bank,
 * WhatsApp, Skatteverket, Peppol and Gmail connections and links to their
 * pages, which stay at their own URLs because OAuth callbacks and deep links
 * (bank consent renewal, ?select_accounts=, ?skv_connected=, ?mail=) land
 * there.
 * The assistant section is off the rail for now (founder 2026-09-24) but its
 * page stays reachable from the assistant's own "manage memory" links.
 */
export const SETTINGS_SECTION_PARENT: Record<string, string> = {
  banking: 'connections',
  whatsapp: 'connections',
  skatteverket: 'connections',
  peppol: 'connections',
  mail: 'connections',
  assistant: 'connections',
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
  const section = (id: string, href: string, group: SettingsGroupKey, show: boolean) => ({ id, href, group, show })

  // Löner shows for every company: "Företaget betalar löner" lives at the top
  // of the section, so hiding the section for a form without default payroll
  // would leave that switch unreachable. The rest of the section folds away
  // while the switch is off.
  const defs = [
    section('account', '/settings/account', 'account', true),
    section('security', '/settings/security', 'account', true),
    // Byrå scope: members & roles is the one byrå-level section; billing is
    // company-scoped (team-billed byråer have no per-company subscription).
    section('team', '/settings/team', 'account', byraScope),
    // Varumärke (WL-17): byrå owner/admin edits the brand logo; members see
    // nothing (the section would be read-only noise for them).
    section('brand', '/settings/brand', 'account', byraScope && (byraRole === 'owner' || byraRole === 'admin')),
    section('company', '/settings/company', 'company', hasCompany),
    section('members', '/settings/members', 'company', hasCompany),
    section('billing', '/settings/billing', 'company', !byraScope),
    section('bookkeeping', '/settings/bookkeeping', 'accounting', hasCompany),
    section('fiscal-years', '/settings/fiscal-years', 'accounting', hasCompany),
    section('tax', '/settings/tax', 'accounting', hasCompany),
    section('salary', '/settings/salary', 'accounting', hasCompany),
    section('templates', '/settings/templates', 'accounting', hasCompany),
    section('invoicing', '/settings/invoicing', 'sales', hasCompany),
    section('sending', '/settings/sending', 'sales', hasCompany),
    section('connections', '/settings/connections', 'tools', hasCompany),
    section('api', '/settings/api', 'tools', hasCompany && hasMcpExtension),
  ]

  return (
    defs
      .filter((d) => d.show)
      // Byrå scope hides every company-scoped section: those are edited from
      // inside the client company where it is obvious WHICH company they hit.
      .filter((d) => !byraScope || d.group === 'account')
      .map(({ show: _show, ...s }) => s)
  )
}
