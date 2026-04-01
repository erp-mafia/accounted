'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useRouter } from 'next/navigation'
import { useCompany } from '@/contexts/CompanyContext'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'

interface NavItem {
  href: string
  label: string
  show: boolean
}

export function SettingsNav({ isSandbox }: { isSandbox?: boolean }) {
  const pathname = usePathname()
  const router = useRouter()
  const { company, isTeamMember } = useCompany()

  const hasCompany = !!company
  const hasBankingExtension = ENABLED_EXTENSION_IDS.has('enable-banking')
  const hasMcpExtension = ENABLED_EXTENSION_IDS.has('mcp-server')

  const items: NavItem[] = [
    { href: '/settings/company', label: 'Företag', show: hasCompany },
    { href: '/settings/invoicing', label: 'Fakturering', show: hasCompany },
    { href: '/settings/bookkeeping', label: 'Bokföring', show: hasCompany },
    { href: '/settings/tax', label: 'Skatt', show: hasCompany },
    { href: '/settings/team', label: 'Lag', show: isTeamMember },
    { href: '/settings/banking', label: 'Bank (PSD2)', show: hasCompany && !isSandbox && hasBankingExtension },
    { href: '/settings/templates', label: 'Mallar', show: hasCompany },
    { href: '/settings/account', label: 'Konto', show: true },
    { href: '/settings/api', label: 'API', show: hasCompany && hasMcpExtension },
  ].filter(item => item.show)

  const activeHref = items.find(item => pathname.startsWith(item.href))?.href || items[0]?.href

  return (
    <>
      {/* Mobile: select dropdown */}
      <div className="sm:hidden">
        <Select value={activeHref} onValueChange={(v) => router.push(v)}>
          <SelectTrigger className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map(item => (
              <SelectItem key={item.href} value={item.href}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Desktop: horizontal tabs with bottom border */}
      <nav
        className="hidden sm:block overflow-x-auto scrollbar-none border-b border-border"
        aria-label="Inställningar"
      >
        <ul className="flex gap-0 -mb-px">
          {items.map(item => {
            const isActive = pathname.startsWith(item.href)
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={`block whitespace-nowrap px-3 py-2 text-sm transition-colors border-b-2 ${
                    isActive
                      ? 'font-medium text-foreground border-foreground'
                      : 'text-muted-foreground border-transparent hover:text-foreground hover:border-border'
                  }`}
                >
                  {item.label}
                </Link>
              </li>
            )
          })}
        </ul>
      </nav>
    </>
  )
}

// Keep old name as alias for backward compat during transition
export const SettingsSidebar = SettingsNav
