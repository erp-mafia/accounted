'use client'

import { createContext, useContext, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { ChevronRightIcon } from '@/components/icons'
import { PageHeaderParent } from '@/components/ui/page-header'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import {
  SETTINGS_SECTIONS_IN_AGENTS,
  SETTINGS_SECTION_PARENT,
  settingsMessageKey,
  visibleSettingsSections,
  type SettingsGroupKey,
} from '@/lib/navigation/settings-sections'
import { ActiveCompanyBadge } from './ActiveCompanyBadge'
import { useByraSettingsScope } from './useSettingsNavItems'

/**
 * The top bar of every settings page (V7 shell, design convention 2): it
 * names the section as the sidebar does, with the group it sits in before it
 * ("Bokföring › Räkenskapsår"), the section's help behind the "?" and the
 * section's own action at the right end. The section draws no second title:
 * its SettingsSectionHeader hands its help and action up here through the
 * slots below (SettingsRows.tsx).
 *
 * The title comes from the URL and the sections' own map, so it is on the
 * server render and can never differ from the sidebar's label. A page reached
 * from a hub (the bank under Kopplingar) names its hub as a link before it. A
 * section the shell files under Agenter (Koppla en agent, Instruktioner)
 * carries that area's label, without a group.
 */

interface TopBarSlots {
  help: HTMLElement | null
  action: HTMLElement | null
}

const SettingsTopBarContext = createContext<TopBarSlots | null>(null)

/** The top bar's slots, or null outside the settings layout (a section embedded elsewhere draws its own header). */
export function useSettingsTopBarSlots(): TopBarSlots | null {
  return useContext(SettingsTopBarContext)
}

/** Renders `children` into a slot of the settings top bar once the bar is mounted. */
export function SettingsTopBarPortal({ slot, children }: { slot: keyof TopBarSlots; children: React.ReactNode }) {
  const target = useContext(SettingsTopBarContext)?.[slot]
  return target ? createPortal(children, target) : null
}

/** Settings sections that are rows of the Agenter area: the nav label they carry there. */
const AGENTS_ROW_LABEL: Record<string, string> = { api: 'v3_connect_agent', assistant: 'v3_instructions' }

const GROUP_MESSAGE_KEY: Record<SettingsGroupKey, string> = {
  account: 'group_account',
  company: 'group_company',
  accounting: 'group_accounting',
  sales: 'group_sales',
  tools: 'group_tools',
  byra: 'group_byra',
}

/** Every section's group, whatever the scope hides (a hidden section's page still names itself). */
const SECTION_GROUP = new Map(
  [
    ...visibleSettingsSections({ hasCompany: true, byraScope: false, byraRole: 'owner', hasMcpExtension: true }),
    ...visibleSettingsSections({ hasCompany: true, byraScope: true, byraRole: 'owner', hasMcpExtension: true }),
  ].map((section) => [section.id, section.group]),
)

export function SettingsTopBarProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname()
  const byraScope = useByraSettingsScope()
  const t = useTranslations('settings_nav')
  const tNav = useTranslations('nav')
  const [help, setHelp] = useState<HTMLElement | null>(null)
  const [action, setAction] = useState<HTMLElement | null>(null)
  const slots = useMemo(() => ({ help, action }), [help, action])

  const id = /^\/settings\/([^/]+)/.exec(pathname)?.[1] ?? null
  // Inside a company the shell lists these under Agenter; in byrå scope the
  // cockpit has no Agenter area and the section keeps its settings name.
  const inAgents =
    !!id && !byraScope && id in AGENTS_ROW_LABEL && (id !== 'api' || ENABLED_EXTENSION_IDS.has('mcp-server')) &&
    (SETTINGS_SECTIONS_IN_AGENTS.has(id) || id === 'assistant')
  // A segment without a section name (a redirecting route such as /settings/backup) falls back to "Inställningar".
  const sectionKey = id ? settingsMessageKey(id) : null
  const title = inAgents && id
    ? tNav(AGENTS_ROW_LABEL[id] as never)
    : sectionKey && t.has(sectionKey as never)
      ? t(sectionKey as never)
      : t('aria_label')
  const hub = id && !inAgents ? SETTINGS_SECTION_PARENT[id] : undefined
  const sectionGroup = id && !inAgents && !hub ? SECTION_GROUP.get(id) : undefined
  // A section named as its group (Kopplingar in Kopplingar) is not said twice.
  const group = sectionGroup && t(GROUP_MESSAGE_KEY[sectionGroup] as never) !== title ? sectionGroup : undefined

  return (
    <SettingsTopBarContext.Provider value={slots}>
      <div className="page-header mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="page-header-lead">
          <div className="flex items-center gap-2">
            {hub ? (
              <PageHeaderParent label={t(settingsMessageKey(hub) as never)} href={`/settings/${hub}${byraScope ? '?ctx=byra' : ''}`} />
            ) : group ? (
              <span className="hidden shrink-0 items-center gap-1 sm:flex">
                <span data-ph-unmask="" className="whitespace-nowrap text-[13px] text-muted-foreground">
                  {t(GROUP_MESSAGE_KEY[group] as never)}
                </span>
                <ChevronRightIcon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
              </span>
            ) : null}
            <h1 data-ph-unmask="" className="page-header-title">
              {title}
            </h1>
            <span ref={setHelp} className="contents" />
          </div>
        </div>
        <div className="page-header-action ml-auto">
          <span ref={setAction} className="contents" />
          {/* On a phone the chip leaves the bar so the title and the action stay on one row. */}
          <ActiveCompanyBadge className="hidden sm:inline-flex" />
        </div>
      </div>
      {children}
    </SettingsTopBarContext.Provider>
  )
}
