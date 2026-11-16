'use client'

import { useId, useMemo, useRef, useState } from 'react'
import { NavLink } from '@/components/dashboard/NavLink'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import {
  AdjustmentsHorizontalIcon,
  BanknotesIcon,
  BellIcon,
  BookOpenIcon,
  BuildingOfficeIcon,
  CalendarIcon,
  CheckCircleIcon,
  CreditCardIcon,
  DocumentTextIcon,
  EnvelopeIcon,
  KeyIcon,
  LinkIcon,
  MagnifyingGlassIcon,
  PercentBadgeIcon,
  QuestionMarkCircleIcon,
  ShieldCheckIcon,
  SparklesIcon,
  Square2StackIcon,
  TagIcon,
  UserCircleIcon,
  UsersIcon,
  type Icon,
} from '@/components/icons'
import { NAV_GROUP_LABEL_CLASS, NAV_ROW_ICON_CLASS, navRowClass } from '@/components/dashboard/nav-row-class'
import { cn } from '@/lib/utils'
import { FIELD_CLASS, FIELD_LINE_CLASS } from '@/components/ui/field-classes'
import { POPOVER_ENTER_CLASS, POPOVER_SURFACE_CLASS } from '@/components/ui/popover-surface'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { settingsMessageKey } from '@/lib/navigation/settings-sections'
import { SETTINGS_SECTION_PARENT, useSettingsNavItems, type SettingsNavItem } from './useSettingsNavItems'

interface SettingsRailProps {
  /**
   * 'rail' = search plus the grouped list, drawn as the Inställningar area's
   * sidebar by the shell (DashboardNav); 'select' = grouped dropdown in the
   * page on a phone, where the shell has no sidebar.
   */
  display: 'rail' | 'select'
}

/** The glyph of each section's row, in the same hand as the other areas' rows. */
const SECTION_ICON: Readonly<Record<string, Icon>> = {
  company: BuildingOfficeIcon,
  anpassa: AdjustmentsHorizontalIcon,
  members: UsersIcon,
  billing: CreditCardIcon,
  bookkeeping: BookOpenIcon,
  'fiscal-years': CalendarIcon,
  tax: PercentBadgeIcon,
  salary: BanknotesIcon,
  attest: CheckCircleIcon,
  templates: Square2StackIcon,
  invoicing: DocumentTextIcon,
  sending: EnvelopeIcon,
  collections: BellIcon,
  connections: LinkIcon,
  api: KeyIcon,
  'data-sharing': SparklesIcon,
  account: UserCircleIcon,
  security: ShieldCheckIcon,
  team: UsersIcon,
  brand: TagIcon,
  help: QuestionMarkCircleIcon,
}

/** Case- and diacritic-insensitive match key ("Löner" matches "loner"). */
function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/**
 * The section of the current URL: /settings/<id>/..., mapped to its hub for
 * a page without a row of its own. Undefined outside settings (the sidebar
 * also shows on /help and /extensions, where no section is the current one).
 */
function useActiveSettingsSection(items: SettingsNavItem[]): string | undefined {
  const pathname = usePathname()
  const [, root, segment] = pathname.split('/')
  // Tillägg and an extension's own page are reached from Kopplingar.
  if (root === 'extensions' || root === 'e') return items.find((i) => i.id === 'connections')?.id
  if (root === 'help') return 'help'
  if (root !== 'settings') return undefined
  const id = segment ? (SETTINGS_SECTION_PARENT[segment] ?? segment) : undefined
  return items.find((i) => i.id === id)?.id
}

export function SettingsRail({ display }: SettingsRailProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const t = useTranslations('settings_nav')
  const tNav = useTranslations('nav')
  const pathname = usePathname()
  const { items, groups, allGroups, searchLinks } = useSettingsNavItems()
  const allItems = allGroups.flatMap((g) => g.items)
  const activeId = useActiveSettingsSection(display === 'select' ? allItems : items)

  // Byrå settings scope travels as ?ctx=byra: section switches must carry it
  // along or the rail would snap back to the full company section list.
  // Search links that leave settings (/import) never take it.
  const withCtx = (href: string) =>
    searchParams.get('ctx') === 'byra' && href.startsWith('/settings/') ? `${href}?ctx=byra` : href

  if (display === 'select') {
    // The picker names the page as the top bar does. Koppla en agent belongs
    // to Agenter inside a company, and a page with no row in this scope (a
    // byrå section opened inside a company) names itself.
    const byraScope = searchParams.get('ctx') === 'byra'
    const [, root, segment] = pathname.split('/')
    const ownKey = segment ? settingsMessageKey(segment) : null
    const own =
      root === 'settings' && segment && !allItems.some((i) => i.id === segment) && !(segment in SETTINGS_SECTION_PARENT)
        ? { href: `/settings/${segment}`, label: ownKey && t.has(ownKey as never) ? t(ownKey as never) : null }
        : null
    const labelOf = (i: SettingsNavItem) => (i.id === 'api' && !byraScope ? tNav('v3_connect_agent') : i.label)
    const activeHref = (own?.label ? own.href : undefined) ?? allItems.find((i) => i.id === activeId)?.href ?? allItems[0]?.href
    return (
      <Select value={activeHref} onValueChange={(href) => router.push(withCtx(href))}>
        <SelectTrigger className="w-full" aria-label={t('aria_label')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {own?.label && <SelectItem value={own.href}>{own.label}</SelectItem>}
          {allGroups.map((g) => (
            <SelectGroup key={g.key}>
              <SelectLabel>{g.label}</SelectLabel>
              {g.items.map((i) => (
                <SelectItem key={i.id} value={i.href}>
                  {labelOf(i)}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    )
  }

  return (
    <nav aria-label={t('aria_label')}>
      <div className="pb-2">
        <SettingsSearch
          items={[...items, ...searchLinks]}
          groupLabel={(key) => groups.find((g) => g.key === key)?.label ?? ''}
          onPick={(href) => router.push(withCtx(href))}
        />
      </div>
      {groups.map((g, index) => (
        <div key={g.key} className={index > 0 ? 'pt-3.5' : undefined}>
          <p className={NAV_GROUP_LABEL_CLASS}>{g.label}</p>
          <ul className="space-y-px">
            {g.items.map((i) => {
              const isActive = i.id === activeId
              const SectionIcon = SECTION_ICON[i.id]
              return (
                <li key={i.id}>
                  <NavLink href={withCtx(i.href)} aria-current={isActive ? 'page' : undefined} className={navRowClass(isActive)}>
                    {SectionIcon && <SectionIcon className={NAV_ROW_ICON_CLASS} />}
                    <span className="min-w-0 flex-1 truncate">{i.label}</span>
                  </NavLink>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}

/**
 * Search across the sections: matches the section name and the names of the
 * rows inside it (the `keywords_*` strings), so "Momsperiod" finds Moms och
 * skatt and "Påminnelser" finds Utskick without the user knowing where a
 * setting lives. The search-only links (Importera, Exportera) are matched
 * the same way and lead out of settings to their page.
 */
function SettingsSearch({
  items,
  groupLabel,
  onPick,
}: {
  items: SettingsNavItem[]
  groupLabel: (key: SettingsNavItem['group']) => string
  onPick: (href: string) => void
}) {
  const t = useTranslations('settings_nav')
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [cursor, setCursor] = useState(0)
  const listId = useId()
  const inputRef = useRef<HTMLInputElement>(null)

  const hits = useMemo(() => {
    const q = fold(query.trim())
    if (!q) return []
    return items
      .map((item) => {
        const inLabel = fold(item.label).includes(q)
        const term = item.keywords
          .split(',')
          .map((k) => k.trim())
          .find((k) => k && fold(k).includes(q))
        return inLabel || term ? { item, term: inLabel ? null : (term ?? null) } : null
      })
      .filter((hit): hit is { item: SettingsNavItem; term: string | null } => hit !== null)
      .slice(0, 8)
  }, [items, query])

  function pick(index: number) {
    const hit = hits[index]
    if (!hit) return
    setQuery('')
    setOpen(false)
    inputRef.current?.blur()
    onPick(hit.item.href)
  }

  const showList = open && query.trim().length > 0

  return (
    <div className="relative">
      <MagnifyingGlassIcon aria-hidden="true" className="pointer-events-none absolute left-2.5 top-2 z-10 h-4 w-4 text-muted-foreground pointer-coarse:top-3" />
      <input
        ref={inputRef}
        type="search"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={t('search_label')}
        placeholder={t('search_placeholder')}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value)
          setCursor(0)
          setOpen(true)
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault()
            const step = e.key === 'ArrowDown' ? 1 : -1
            setCursor((c) => Math.max(0, Math.min(hits.length - 1, c + step)))
          } else if (e.key === 'Enter') {
            e.preventDefault()
            pick(cursor)
          } else if (e.key === 'Escape') {
            setQuery('')
            setOpen(false)
          }
        }}
        className={cn(FIELD_CLASS, FIELD_LINE_CLASS, 'pl-8')}
      />
      {showList ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={t('search_label')}
          className={cn(POPOVER_SURFACE_CLASS, POPOVER_ENTER_CLASS, 'absolute inset-x-0 top-10 z-20 max-h-80 overflow-y-auto p-1')}
        >
          {hits.length === 0 ? (
            <li className="px-2 py-2 text-[13px] text-muted-foreground">{t('search_empty')}</li>
          ) : (
            hits.map((hit, index) => (
              <li
                key={hit.item.id}
                role="option"
                aria-selected={index === cursor}
                // mousedown, not click: the input's blur would close the list first.
                onMouseDown={(e) => {
                  e.preventDefault()
                  pick(index)
                }}
                onMouseEnter={() => setCursor(index)}
                className={cn(
                  'cursor-pointer rounded-sm px-2 py-1 text-[13px]',
                  index === cursor && 'bg-secondary/60',
                )}
              >
                <span className="block text-foreground">{hit.term ?? hit.item.label}</span>
                <span className="block text-xs text-muted-foreground">
                  {groupLabel(hit.item.group)} · {hit.item.label}
                </span>
              </li>
            ))
          )}
        </ul>
      ) : null}
    </div>
  )
}
