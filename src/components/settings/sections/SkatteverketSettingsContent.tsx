'use client'

import { useEffect } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { SkatteverketConnectPanel } from '@/components/settings/SkatteverketConnectPanel'
import { SkattekontoAccountSetting } from '@/components/settings/SkattekontoAccountSetting'
import { SettingsBackLink } from '@/components/settings/SettingsRows'
import { useToast } from '@/components/ui/use-toast'
import { useCompanyOptional } from '@/contexts/CompanyContext'

/**
 * Kopplingar → Skatteverket: the connection (ombud, BankID consent) on its own
 * page. It sat at the top of Skatt until 2026-09-24; Moms och skatt keeps a
 * row that links here, so the pages that send users to /settings/tax to
 * (re)connect still find it. Below the connection: the skattekonto's ledger
 * account (an enskild firma chooses 1630 or 2012), so the choice sits where
 * the skattekonto is connected.
 */
export function SkatteverketSettingsContent() {
  const t = useTranslations('settings_skatteverket')
  const tNav = useTranslations('settings_nav')
  const searchParams = useSearchParams()
  const router = useRouter()
  const { toast } = useToast()
  const companyContext = useCompanyOptional()

  // A link that named a company (an agent's connect link) stored the session
  // for that company, which need not be the one this browser has open: the
  // panel below shows the open one, so the toast says which got it.
  const connectedId = searchParams.get('skv_company')
  const activeName = companyContext?.company?.name ?? null
  const otherCompanyName =
    connectedId && companyContext?.company && connectedId !== companyContext.company.id
      ? companyContext.companies.find((m) => m.company.id === connectedId)?.company.name ?? null
      : null

  // Skatteverket OAuth callback: the full-page connect flow returns here with
  // a status query param (returnTo set in SkatteverketConnectPanel).
  useEffect(() => {
    const connected = searchParams.get('skv_connected')
    const error = searchParams.get('skv_error')
    if (connected === 'true') {
      if (otherCompanyName && activeName) {
        toast({
          title: t('connected_other_company_title', { company: otherCompanyName }),
          description: t('connected_other_company_description', { company: otherCompanyName, active: activeName }),
        })
      } else {
        toast({ title: t('connected_title'), description: t('connected_description') })
      }
      router.replace('/settings/skatteverket')
    } else if (error) {
      let msg: string
      try {
        msg = decodeURIComponent(error)
      } catch {
        msg = error
      }
      toast({ title: t('connect_failed_title'), description: msg, variant: 'destructive' })
      router.replace('/settings/skatteverket')
    }
  }, [searchParams, router, toast, t, otherCompanyName, activeName])

  return (
    <div>
      <SettingsBackLink href="/settings/connections" label={tNav('connections')} />
      {/* The panel draws the header: what the "?" explains depends on whether the ombud step is there. */}
      <SkatteverketConnectPanel title={tNav('skatteverket')} />
      <SkattekontoAccountSetting />
    </div>
  )
}
