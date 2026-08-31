'use client'

import { useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { CompanyDangerZone } from '@/components/settings/CompanyDangerZone'
import { CompanyInfoForm } from '@/components/settings/CompanyInfoForm'
import { CompanyMembersSection } from '@/components/settings/CompanyMembersSection'
import { CompanyProfileSection } from '@/components/settings/CompanyProfileSection'
import { DataAnalysisToggle } from '@/components/settings/DataAnalysisToggle'
import { FiscalPeriodEditor } from '@/components/settings/FiscalPeriodEditor'
import { LogoUpload } from '@/components/settings/LogoUpload'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { SettingsGroup, SettingsSectionHeader } from '@/components/settings/SettingsRows'
import { ShareCapitalForm } from '@/components/settings/ShareCapitalForm'
import { useSettings } from '@/components/settings/useSettings'
import type { CompanySettings } from '@/types'

export function CompanySettingsContent() {
  const router = useRouter()
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const tData = useTranslations('data_analysis')
  const { settings, isLoading, updateSettings, refetch } = useSettings()

  // Deep-link target for "Medlemmar och roller" (/settings/company#members):
  // a ref callback rather than an effect because this content mounts late
  // (settings fetch + dynamic import); the callback fires exactly when the
  // section exists. The hash is cleared after scrolling so switching tabs
  // and returning to Företag doesn't scroll again.
  const scrollToMembers = useCallback((node: HTMLDivElement | null) => {
    if (!node || window.location.hash !== '#members') return
    node.scrollIntoView({ block: 'start' })
    history.replaceState(null, '', window.location.pathname + window.location.search)
  }, [])

  if (isLoading) return <SettingsLoadingSkeleton />
  if (!settings) return <SettingsLoadError onRetry={refetch} />

  function handleSave(formData: FormData) {
    // Empty string clears the value (schema accepts null, not '').
    const numberOrNull = (name: string) => {
      const raw = String(formData.get(name) ?? '').trim()
      if (raw === '') return null
      const parsed = Number(raw)
      // NaN would serialize to null in JSON and silently clear the value.
      return Number.isFinite(parsed) ? parsed : null
    }
    const updates: Record<string, unknown> = {
      ...(formData.has('company_name') && { company_name: formData.get('company_name') as string }),
      ...(formData.has('org_number') && { org_number: formData.get('org_number') as string }),
      address_line1: formData.get('address_line1') as string,
      postal_code: formData.get('postal_code') as string,
      city: formData.get('city') as string,
      phone: (formData.get('phone') as string) || '',
      email: (formData.get('email') as string) || '',
      website: (formData.get('website') as string) || '',
      ...(formData.has('aktiekapital') && { aktiekapital: numberOrNull('aktiekapital') }),
      ...(formData.has('antal_aktier') && { antal_aktier: numberOrNull('antal_aktier') }),
    }
    return {
      updates,
      onSuccess: (data: Record<string, unknown>) => {
        updateSettings(data as Partial<CompanySettings>)
        // Refresh server components so the company switcher and DashboardNav
        // pick up the new company_name (rendered from server in the dashboard layout).
        if ('company_name' in updates) {
          router.refresh()
        }
      },
    }
  }

  return (
    <div>
      <SettingsSectionHeader title={tNav('company')} intro={tIntro('company')} />

      <SettingsFormWrapper onSave={handleSave}>
        <CompanyInfoForm settings={settings} />
        {settings.entity_type === 'aktiebolag' && (
          <ShareCapitalForm
            settings={{ aktiekapital: settings.aktiekapital, antal_aktier: settings.antal_aktier }}
          />
        )}
      </SettingsFormWrapper>

      <LogoUpload
        logoUrl={settings.logo_url}
        onUpdate={(url) => updateSettings({ logo_url: url })}
      />

      <div id="members" ref={scrollToMembers} className="scroll-mt-6">
        <CompanyMembersSection />
      </div>

      <FiscalPeriodEditor />

      <CompanyProfileSection />

      <SettingsGroup label={tData('group_label')}>
        <DataAnalysisToggle />
      </SettingsGroup>

      <CompanyDangerZone />
    </div>
  )
}
