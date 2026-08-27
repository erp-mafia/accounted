'use client'

import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
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
  /** Layout context: 'page' navigates with push (real route), 'modal' swaps
   *  the URL shallowly (history.replaceState) so section-switching keeps a
   *  single back-stack entry AND never re-renders the intercepted modal
   *  route: a router navigation would remount the Dialog and replay its
   *  open animation on every tab click. */
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
  const searchParams = useSearchParams()
  const t = useTranslations('settings_nav')
  const { items, groups } = useSettingsNavItems()

  const resolvedActiveId =
    activeId ??
    items.find((i) => pathname.startsWith(i.href))?.id ??
    items[0]?.id

  // Byrå settings scope travels as ?ctx=byra: section switches must carry it
  // along or the rail would snap back to the full company section list.
  const withCtx = (href: string) =>
    searchParams.get('ctx') === 'byra' ? `${href}?ctx=byra` : href

  function navigate(href: string) {
    // Shallow update: Next syncs usePathname() from the native History API,
    // so SettingsModal re-resolves the section without a route transition.
    if (variant === 'modal') window.history.replaceState(null, '', withCtx(href))
    else router.push(withCtx(href))
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
                      href={withCtx(i.href)}
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
