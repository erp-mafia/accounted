'use client'

import { TaxSettingsForm } from '@/components/settings/TaxSettingsForm'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { useSettings } from '@/components/settings/useSettings'
import type { CompanySettings } from '@/types'

export default function TaxSettingsPage() {
  const { settings, isLoading, updateSettings } = useSettings()

  if (isLoading || !settings) return <SettingsLoadingSkeleton />

  function handleSave(formData: FormData) {
    const updates: Record<string, unknown> = {
      preliminary_tax_monthly: parseFloat(formData.get('preliminary_tax_monthly') as string) || null,
    }
    updateSettings(updates as Partial<CompanySettings>)
    return updates
  }

  return (
    <SettingsFormWrapper onSave={handleSave} className="space-y-8">
      <TaxSettingsForm settings={settings} />
    </SettingsFormWrapper>
  )
}
