'use client'

import { useId, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Search } from 'lucide-react'
import { cn } from '@/lib/utils'
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
import { SETTINGS_SECTION_PARENT, useSettingsNavItems, type SettingsNavItem } from './useSettingsNavItems'

interface SettingsRailProps {
  /** 'rail' = search plus grouped vertical list (desktop); 'select' = grouped dropdown (mobile). */
  display: 'rail' | 'select'
}

/** Case- and diacritic-insensitive match key ("Löner" matches "loner"). */
function fold(value: string): string {
  return value.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase()
}

/** The rail item for the current URL: /settings/<id>/..., mapped to its hub for off-rail pages. */
function useActiveSettingsSection(items: SettingsNavItem[]): string | undefined {
  const pathname = usePathname()
  const segment = pathname.split('/')[2]
  const id = segment ? (SETTINGS_SECTION_PARENT[segment] ?? segment) : undefined
  return items.find((i) => i.id === id)?.id ?? items[0]?.id
}

export function SettingsRail({ display }: SettingsRailProps) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const t = useTranslations('settings_nav')
  const { items, groups } = useSettingsNavItems()
  const activeId = useActiveSettingsSection(items)

  // Byrå settings scope travels as ?ctx=byra: section switches must carry it
  // along or the rail would snap back to the full company section list.
  const withCtx = (href: string) =>
    searchParams.get('ctx') === 'byra' ? `${href}?ctx=byra` : href

  if (display === 'select') {
    const activeHref = items.find((i) => i.id === activeId)?.href ?? items[0]?.href
    return (
      <Select value={activeHref} onValueChange={(href) => router.push(withCtx(href))}>
        <SelectTrigger className="w-full" aria-label={t('aria_label')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {groups.map((g) => (
            <SelectGroup key={g.key}>
              <SelectLabel>{g.label}</SelectLabel>
              {g.items.map((i) => (
                <SelectItem key={i.id} value={i.href}>
                  {i.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    )
  }

  return (
    <nav aria-label={t('aria_label')} className="space-y-4">
      <SettingsSearch
        items={items}
        groupLabel={(key) => groups.find((g) => g.key === key)?.label ?? ''}
        onPick={(href) => router.push(withCtx(href))}
      />
      {groups.map((g) => (
        <div key={g.key} className="space-y-1">
          <p className="px-3 pt-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {g.label}
          </p>
          <ul className="space-y-0.5">
            {g.items.map((i) => {
              const isActive = i.id === activeId
              return (
                <li key={i.id}>
                  <Link
                    href={withCtx(i.href)}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex h-8 items-center rounded-lg px-3 text-[13px] transition-colors duration-150',
                      isActive
                        ? 'bg-secondary font-medium text-foreground'
                        : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
                    )}
                  >
                    {i.label}
                  </Link>
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
 * setting lives.
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
      <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-2 h-4 w-4 text-muted-foreground" />
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
        className="h-8 w-full rounded-full border border-border bg-background pl-9 pr-3 text-[13px] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/20"
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
                <span className="block text-[11px] text-muted-foreground">
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
