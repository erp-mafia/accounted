'use client'

import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import {
  SETTINGS_GROUP_ORDER,
  SETTINGS_SECTIONS_IN_AGENTS,
  settingsMessageKey,
  settingsOpenForRole,
  visibleSettingsSections,
  type SettingsGroupKey,
} from '@/lib/navigation/settings-sections'

/**
 * Byrå settings scope: settings opened from the cockpit carry ?ctx=byra
 * (links in the user menu / mobile nav). In that scope only personal and
 * byrå-level sections show (the Du group, and API och MCP, whose connections
 * belong to the person): everything company-scoped (bokföring, skatt,
 * fakturering, mallar, ...) is edited from inside the client company, never
 * from the cockpit. Honored only for byrå team members; cosmetic only, the
 * section pages keep their own auth.
 */
export function useByraSettingsScope(): boolean {
  const searchParams = useSearchParams()
  const { byraTeam } = useCompany()
  return searchParams.get('ctx') === 'byra' && !!byraTeam
}

export type { SettingsGroupKey } from '@/lib/navigation/settings-sections'
export { SETTINGS_SECTION_PARENT } from '@/lib/navigation/settings-sections'

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

/**
 * The settings sections (lib/navigation/settings-sections.ts, shared with the
 * assistant's UI map), labelled for the rail (desktop list and the grouped
 * mobile select) and its search.
 *
 * Visibility is derived from client context (no extra fetch): `isSandbox`
 * comes from CompanyContext and extension availability from the generated
 * enabled-extensions set.
 */
export function useSettingsNavItems(): {
  items: SettingsNavItem[]
  groups: SettingsNavGroup[]
  /**
   * Every visible section, grouped: the phone's section picker, which has no
   * area sidebar beside it and so also lists a section the shell files under
   * Agenter.
   */
  allGroups: SettingsNavGroup[]
  /** Search-only entries that link out of settings (import, export). */
  searchLinks: SettingsNavItem[]
} {
  const { company, byraTeam, role } = useCompany()
  const byraScope = useByraSettingsScope()
  const t = useTranslations('settings_nav')

  const hasCompany = !!company

  const sections: SettingsNavItem[] = visibleSettingsSections({
    hasCompany,
    byraScope,
    byraRole: byraTeam?.role ?? null,
    hasMcpExtension: ENABLED_EXTENSION_IDS.has('mcp-server'),
    role,
  }).map((section) => ({
    ...section,
    label: t(settingsMessageKey(section.id)),
    keywords: t(`keywords_${settingsMessageKey(section.id)}`),
  }))
  // A section the shell lists under Agenter (Koppla en agent) is left to that
  // area inside a company: one place in the menu per page. The search still
  // finds it. In byrå scope the cockpit has no Agenter area, so it stays.
  const elsewhere = (section: SettingsNavItem) => !byraScope && SETTINGS_SECTIONS_IN_AGENTS.has(section.id)
  // Hjälp och ordlista (/help) is a page of its own, open to everyone like the
  // page: a quiet last row of the Du group, on the rail and in the picker.
  const help: SettingsNavItem = { id: 'help', href: '/help', group: 'account', label: t('help'), keywords: t('keywords_help') }
  // The invoicing-only role is listed nothing that would bounce it to Fakturor.
  const open = (item: SettingsNavItem) => settingsOpenForRole(role, item.href)
  const items = [...sections.filter((section) => !elsewhere(section)), help].filter(open)

  // Pages outside settings that people look for in settings: import and
  // export live under Bokföring (the same page also takes bank files and
  // SIE, which are bookkeeping), so the rail search finds them and links
  // there instead of answering "no setting by that name". Search only, never
  // on the rail. Company-scoped, so hidden in byrå scope like the sections.
  const searchLink = (id: string, href: string): SettingsNavItem => ({
    id,
    href,
    group: 'accounting',
    label: t(id),
    keywords: t(`keywords_${id}`),
  })
  const searchLinks: SettingsNavItem[] = [
    ...sections.filter(elsewhere),
    ...(hasCompany && !byraScope ? [searchLink('import', '/import'), searchLink('export', '/import?view=export')] : []),
  ].filter(open)

  const groupLabels: Record<SettingsGroupKey, string> = {
    account: t('group_account'),
    company: t('group_company'),
    accounting: t('group_accounting'),
    sales: t('group_sales'),
    tools: t('group_tools'),
    byra: t('group_byra'),
  }

  const grouped = (list: SettingsNavItem[]): SettingsNavGroup[] =>
    SETTINGS_GROUP_ORDER.map((key) => ({
      key,
      label: groupLabels[key],
      items: list.filter((i) => i.group === key),
    })).filter((g) => g.items.length > 0)

  return { items, groups: grouped(items), allGroups: grouped([...sections, help].filter(open)), searchLinks }
}
