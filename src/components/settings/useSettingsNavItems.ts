'use client'

import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'

/**
 * Byrå settings scope: settings opened from the cockpit carry ?ctx=byra
 * (links in the user menu / mobile nav). In that scope only account-level
 * and byrå-level sections show: everything company-scoped (bokföring, skatt,
 * fakturering, mallar, ...) is edited from inside the client company, never
 * from the cockpit. Honored only for byrå team members; cosmetic only, the
 * section pages keep their own auth.
 */
export function useByraSettingsScope(): boolean {
  const searchParams = useSearchParams()
  const { byraTeam } = useCompany()
  return searchParams.get('ctx') === 'byra' && !!byraTeam
}

export type SettingsGroupKey = 'account' | 'company' | 'accounting' | 'sales' | 'tools'

export interface SettingsNavItem {
  id: string
  href: string
  label: string
  group: SettingsGroupKey
  /** Extra search terms (the rows inside the section) for the rail search. */
  keywords: string
}

export interface SettingsNavGroup {
  key: SettingsGroupKey
  label: string
  items: SettingsNavItem[]
}

// Rail group order: personal first (Du), then company-scoped buckets.
const GROUP_ORDER: SettingsGroupKey[] = ['account', 'company', 'accounting', 'sales', 'tools']

/**
 * Sections that have a page but no rail entry: each is reached from a hub
 * section and highlights that hub in the rail. Kopplingar lists the bank,
 * WhatsApp, Skatteverket and Peppol connections and links to their pages,
 * which stay at their own URLs because OAuth callbacks and deep links
 * (bank consent renewal, ?select_accounts=, ?skv_connected=) land there.
 * The assistant section is off the rail for now (founder 2026-09-24) but its
 * page stays reachable from the assistant's own "manage memory" links.
 */
export const SETTINGS_SECTION_PARENT: Record<string, string> = {
  banking: 'connections',
  whatsapp: 'connections',
  skatteverket: 'connections',
  peppol: 'connections',
  assistant: 'connections',
}

/**
 * Single source of truth for the settings sections, their conditional
 * visibility, and their grouping, consumed by the rail (desktop list and the
 * grouped mobile select) and its search.
 *
 * Visibility is derived from client context (no extra fetch): `isSandbox`
 * comes from CompanyContext and extension availability from the generated
 * enabled-extensions set.
 */
export function useSettingsNavItems(): { items: SettingsNavItem[]; groups: SettingsNavGroup[] } {
  const { company, byraTeam } = useCompany()
  const byraScope = useByraSettingsScope()
  const t = useTranslations('settings_nav')

  const hasCompany = !!company
  const hasMcpExtension = ENABLED_EXTENSION_IDS.has('mcp-server')

  const item = (id: string, href: string, group: SettingsGroupKey, show: boolean) => ({
    id,
    href,
    group,
    show,
    label: t(id.replace('-', '_')),
    keywords: t(`keywords_${id.replace('-', '_')}`),
  })

  // Löner shows for every company: "Företaget betalar löner" lives at the top
  // of the section, so hiding the section for a form without default payroll
  // would leave that switch unreachable. The rest of the section folds away
  // while the switch is off.
  const defs: Array<SettingsNavItem & { show: boolean }> = [
    item('account', '/settings/account', 'account', true),
    item('security', '/settings/security', 'account', true),
    // Byrå scope: members & roles is the one byrå-level section; billing is
    // company-scoped (team-billed byråer have no per-company subscription).
    item('team', '/settings/team', 'account', byraScope),
    // Varumärke (WL-17): byrå owner/admin edits the brand logo; members see
    // nothing (the section would be read-only noise for them).
    item('brand', '/settings/brand', 'account', byraScope && !!byraTeam && (byraTeam.role === 'owner' || byraTeam.role === 'admin')),
    item('company', '/settings/company', 'company', hasCompany),
    item('members', '/settings/members', 'company', hasCompany),
    item('billing', '/settings/billing', 'company', !byraScope),
    item('bookkeeping', '/settings/bookkeeping', 'accounting', hasCompany),
    item('fiscal-years', '/settings/fiscal-years', 'accounting', hasCompany),
    item('tax', '/settings/tax', 'accounting', hasCompany),
    item('salary', '/settings/salary', 'accounting', hasCompany),
    item('templates', '/settings/templates', 'accounting', hasCompany),
    item('invoicing', '/settings/invoicing', 'sales', hasCompany),
    item('sending', '/settings/sending', 'sales', hasCompany),
    item('connections', '/settings/connections', 'tools', hasCompany),
    item('api', '/settings/api', 'tools', hasCompany && hasMcpExtension),
  ]

  const items: SettingsNavItem[] = defs
    .filter((d) => d.show)
    // Byrå scope hides every company-scoped section: those are edited from
    // inside the client company where it is obvious WHICH company they hit.
    .filter((d) => !byraScope || d.group === 'account')
    .map(({ show: _show, ...item }) => item)

  const groupLabels: Record<SettingsGroupKey, string> = {
    account: t('group_account'),
    company: t('group_company'),
    accounting: t('group_accounting'),
    sales: t('group_sales'),
    tools: t('group_tools'),
  }

  const groups: SettingsNavGroup[] = GROUP_ORDER.map((key) => ({
    key,
    label: groupLabels[key],
    items: items.filter((i) => i.group === key),
  })).filter((g) => g.items.length > 0)

  return { items, groups }
}
