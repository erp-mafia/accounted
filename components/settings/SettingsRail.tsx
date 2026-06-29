'use client'

import Link from 'next/link'
import { usePathname, useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSettingsNavItems } from './useSettingsNavItems'

interface SettingsRailProps {
  /** Layout context: 'page' navigates with push (real route), 'modal' replaces
   *  the URL so section-switching keeps a single back-stack entry. */
  variant: 'page' | 'modal'
  /** 'rail' = grouped vertical list (desktop); 'select' = grouped dropdown (mobile). */
  display: 'rail' | 'select'
  /** Explicit active section id. Falls back to the current pathname when omitted
   *  (used by the page variant where the URL is the source of truth). */
  activeId?: string
}

export function SettingsRail({ variant, display, activeId }: SettingsRailProps) {
  const router = useRouter()
  const pathname = usePathname()
  const t = useTranslations('settings_nav')
  const { items, groups } = useSettingsNavItems()

  const resolvedActiveId =
    activeId ??
    items.find((i) => pathname.startsWith(i.href))?.id ??
    items[0]?.id

  function navigate(href: string) {
    if (variant === 'modal') router.replace(href)
    else router.push(href)
  }

  if (display === 'select') {
    const activeHref =
      items.find((i) => i.id === resolvedActiveId)?.href ?? items[0]?.href
    return (
      <Select value={activeHref} onValueChange={navigate}>
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
    <nav aria-label={t('aria_label')} className="space-y-6">
      {groups.map((g) => (
        <div key={g.key} className="space-y-1">
          <p className="px-3 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {g.label}
          </p>
          <ul className="space-y-0.5">
            {g.items.map((i) => {
              const isActive = i.id === resolvedActiveId
              const rowClass = cn(
                'flex min-h-10 items-center rounded-lg px-3 py-2 text-sm transition-colors duration-150',
                isActive
                  ? 'bg-secondary font-medium text-foreground'
                  : 'text-muted-foreground hover:bg-secondary/60 hover:text-foreground',
              )
              return (
                <li key={i.id}>
                  {variant === 'modal' ? (
                    <button
                      type="button"
                      onClick={() => navigate(i.href)}
                      aria-current={isActive ? 'page' : undefined}
                      className={cn(rowClass, 'w-full text-left')}
                    >
                      {i.label}
                    </button>
                  ) : (
                    <Link
                      href={i.href}
                      aria-current={isActive ? 'page' : undefined}
                      className={rowClass}
                    >
                      {i.label}
                    </Link>
                  )}
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </nav>
  )
}
