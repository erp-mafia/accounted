'use client'

import { useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { useAgentSheet } from '@/components/agent/AgentSheetProvider'
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
}

export interface SettingsNavGroup {
  key: SettingsGroupKey
  label: string
  items: SettingsNavItem[]
}

// Rail group order: personal first (Konto), then company-scoped buckets.
const GROUP_ORDER: SettingsGroupKey[] = ['account', 'company', 'accounting', 'sales', 'tools']

/**
 * Single source of truth for the settings sections, their conditional
 * visibility, and their grouping. Consumed by both the full-page rail and the
 * routed settings modal so the two can never drift on which sections show for
 * AB vs EF, sandbox, identity-verified, or enabled extensions.
 *
 * Visibility is derived from client context (no extra fetch): `isSandbox`
 * comes from CompanyContext, identity from the agent sheet, and extension
 * availability from the generated enabled-extensions set.
 */
export function useSettingsNavItems(): { items: SettingsNavItem[]; groups: SettingsNavGroup[] } {
  const { company, isSandbox, byraTeam } = useCompany()
  const { identity } = useAgentSheet()
  const byraScope = useByraSettingsScope()
  const t = useTranslations('settings_nav')

  const hasCompany = !!company
  const hasBankingExtension = ENABLED_EXTENSION_IDS.has('enable-banking')
  const hasMcpExtension = ENABLED_EXTENSION_IDS.has('mcp-server')
  const hasWhatsAppExtension = ENABLED_EXTENSION_IDS.has('whatsapp-inbox')
  const hasMailExtension = ENABLED_EXTENSION_IDS.has('mail')

  // Företagsprofil (TIC-snapshot) lives under Företag; Skatteverket under Skatt;
  // assistentens minne + kunskap under Assistenten; säkerhetsbackup under
  // Importera/Exportera. Team stays hidden (show:false) until enabled.
  const defs: Array<SettingsNavItem & { show: boolean }> = [
    { id: 'account', href: '/settings/account', label: t('account'), group: 'account', show: true },
    // Byrå scope: members & roles is the one byrå-level section; billing is
    // company-scoped (team-billed byråer have no per-company subscription).
    { id: 'team', href: '/settings/team', label: t('team'), group: 'account', show: byraScope },
    // Varumärke (WL-17): byrå owner/admin edits the brand logo; members see
    // nothing (the section would be read-only noise for them).
    { id: 'brand', href: '/settings/brand', label: t('brand'), group: 'account', show: byraScope && !!byraTeam && (byraTeam.role === 'owner' || byraTeam.role === 'admin') },
    { id: 'billing', href: '/settings/billing', label: t('billing'), group: 'account', show: !byraScope },
    { id: 'company', href: '/settings/company', label: t('company'), group: 'company', show: hasCompany },
    { id: 'bookkeeping', href: '/settings/bookkeeping', label: t('bookkeeping'), group: 'accounting', show: hasCompany },
    { id: 'tax', href: '/settings/tax', label: t('tax'), group: 'accounting', show: hasCompany },
    // Lön settings follow the sidebar: every aktiebolag, plus any company that
    // has registered as an employer (pays_salaries): e.g. an enskild firma
    // with staff. #782
    { id: 'salary', href: '/settings/salary', label: t('salary'), group: 'accounting', show: hasCompany && (company?.entity_type === 'aktiebolag' || !!company?.pays_salaries) },
    { id: 'invoicing', href: '/settings/invoicing', label: t('invoicing'), group: 'sales', show: hasCompany },
    { id: 'templates', href: '/settings/templates', label: t('templates'), group: 'sales', show: hasCompany },
    { id: 'banking', href: '/settings/banking', label: t('banking'), group: 'tools', show: hasCompany && !isSandbox && hasBankingExtension },
    { id: 'whatsapp', href: '/settings/whatsapp', label: t('whatsapp'), group: 'tools', show: hasCompany && !isSandbox && hasWhatsAppExtension },
    { id: 'mail', href: '/settings/mail', label: t('mail'), group: 'tools', show: hasCompany && !isSandbox && hasMailExtension },
    { id: 'assistant', href: '/settings/assistant', label: t('assistant'), group: 'tools', show: hasCompany && identity.isVerified },
    { id: 'api', href: '/settings/api', label: t('api'), group: 'tools', show: hasCompany && hasMcpExtension },
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
