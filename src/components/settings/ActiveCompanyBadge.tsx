'use client'

import { Briefcase } from 'lucide-react'
import { useTranslations } from 'next-intl'
import { cn } from '@/lib/utils'
import { useCompany } from '@/contexts/CompanyContext'
import { Badge } from '@/components/ui/badge'
import { useByraSettingsScope } from './useSettingsNavItems'

/**
 * Quiet chip naming the active company. Settings surfaces (the routed modal
 * and the full-page fallback) cover or dim the sidebar's CompanySwitcher, so
 * without this the user edits company-scoped settings with no visible answer
 * to "which company am I on?" (support feedback 2026-07-19).
 *
 * Byrå scope (?ctx=byra): no chip. The cockpit sits above the companies and
 * only account-level sections show, so naming a technically-active client
 * here would read as "you are inside this company" (mirrors SettingsModal).
 */
export function ActiveCompanyBadge({ className }: { className?: string }) {
  const { company } = useCompany()
  const byraScope = useByraSettingsScope()
  const t = useTranslations('common')

  if (!company || byraScope) return null

  return (
    <Badge
      variant="outline"
      className={cn(
        'max-w-full min-w-0 gap-1.5 font-normal text-muted-foreground',
        className,
      )}
      title={`${t('active_company')}: ${company.name}`}
    >
      <Briefcase className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="sr-only">{t('active_company')}: </span>
      <span className="truncate">{company.name}</span>
    </Badge>
  )
}
