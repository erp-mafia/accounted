'use client'

import { useRouter } from 'next/navigation'
import { CompanyDangerZone } from '@/components/settings/CompanyDangerZone'
import { CompanyInfoForm } from '@/components/settings/CompanyInfoForm'
import { CompanyMembersSection } from '@/components/settings/CompanyMembersSection'
import { CompanyProfileSection } from '@/components/settings/CompanyProfileSection'
import { FiscalPeriodEditor } from '@/components/settings/FiscalPeriodEditor'
import { LogoUpload } from '@/components/settings/LogoUpload'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { useSettings } from '@/components/settings/useSettings'
import type { CompanySettings } from '@/types'

export function CompanySettingsContent() {
  const router = useRouter()
  const { settings, isLoading, updateSettings, refetch } = useSettings()

  if (isLoading) return <SettingsLoadingSkeleton />
  if (!settings) return <SettingsLoadError onRetry={refetch} />

  function handleSave(formData: FormData) {
    const updates: Record<string, unknown> = {
      ...(formData.has('company_name') && { company_name: formData.get('company_name') as string }),
      ...(formData.has('org_number') && { org_number: formData.get('org_number') as string }),
      address_line1: formData.get('address_line1') as string,
      postal_code: formData.get('postal_code') as string,
      city: formData.get('city') as string,
      phone: (formData.get('phone') as string) || '',
      email: (formData.get('email') as string) || '',
      website: (formData.get('website') as string) || '',
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
    <div className="space-y-8">
      <SettingsFormWrapper onSave={handleSave} className="space-y-8">
        <CompanyInfoForm settings={settings} />
      </SettingsFormWrapper>

      <div className="border-t border-border pt-8">
        <LogoUpload
          logoUrl={settings.logo_url}
          onUpdate={(url) => updateSettings({ logo_url: url })}
        />
      </div>

      <div className="border-t border-border pt-8">
        <CompanyMembersSection />
      </div>

      <FiscalPeriodEditor />

      <CompanyProfileSection />

      <CompanyDangerZone />
    </div>
  )
}
