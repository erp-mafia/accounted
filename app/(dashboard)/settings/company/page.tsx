'use client'

import { CompanyInfoForm } from '@/components/settings/CompanyInfoForm'
import { CompanyMembersSection } from '@/components/settings/CompanyMembersSection'
import { LogoUpload } from '@/components/settings/LogoUpload'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { useSettings } from '@/components/settings/useSettings'
import type { CompanySettings } from '@/types'

export default function CompanySettingsPage() {
  const { settings, isLoading, updateSettings } = useSettings()

  if (isLoading || !settings) return <SettingsLoadingSkeleton />

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
    updateSettings(updates as Partial<CompanySettings>)
    return updates
  }

  return (
    <div className="space-y-8">
      <SettingsFormWrapper onSave={handleSave} className="space-y-8">
        <CompanyInfoForm settings={settings} />
      </SettingsFormWrapper>

      <div className="border-t border-border/8 pt-8">
        <LogoUpload
          logoUrl={settings.logo_url}
          onUpdate={(url) => updateSettings({ logo_url: url })}
        />
      </div>

      <div className="border-t border-border/8 pt-8">
        <CompanyMembersSection />
      </div>
    </div>
  )
}
