'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useRouter } from 'next/navigation'
import { useCompany } from '@/contexts/CompanyContext'
import { useAgentSheet } from '@/components/agent/AgentSheetProvider'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'

interface NavItem {
  href: string
  label: string
  show: boolean
}

export function SettingsNav({ isSandbox }: { isSandbox?: boolean }) {
  const pathname = usePathname()
  const router = useRouter()
  const { company } = useCompany()
  const { identity } = useAgentSheet()
  const t = useTranslations('settings_nav')

  const hasCompany = !!company
  const hasBankingExtension = ENABLED_EXTENSION_IDS.has('enable-banking')
  const hasMcpExtension = ENABLED_EXTENSION_IDS.has('mcp-server')

  const items: NavItem[] = [
    // Företagsprofil (TIC-snapshot) lives under Företag; Skatteverket under Skatt;
    // assistentens minne + kunskap under Assistenten; säkerhetsbackup under Importera/Exportera.
    { href: '/settings/company', label: t('company'), show: hasCompany },
    { href: '/settings/invoicing', label: t('invoicing'), show: hasCompany },
    { href: '/settings/bookkeeping', label: t('bookkeeping'), show: hasCompany },
    { href: '/settings/tax', label: t('tax'), show: hasCompany },
    { href: '/settings/team', label: t('team'), show: false },
    { href: '/settings/banking', label: t('banking'), show: hasCompany && !isSandbox && hasBankingExtension },
    { href: '/settings/salary', label: t('salary'), show: hasCompany && company?.entity_type === 'aktiebolag' },
    { href: '/settings/templates', label: t('templates'), show: hasCompany },
    { href: '/settings/assistant', label: t('assistant'), show: hasCompany && identity.isVerified },
    { href: '/settings/account', label: t('account'), show: true },
    { href: '/settings/api', label: t('api'), show: hasCompany && hasMcpExtension },
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
        aria-label={t('aria_label')}
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
