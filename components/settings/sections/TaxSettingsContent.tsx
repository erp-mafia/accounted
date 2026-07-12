'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { useSearchParams, useRouter } from 'next/navigation'
import { TaxSettingsForm } from '@/components/settings/TaxSettingsForm'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { SkatteverketConnectPanel } from '@/components/settings/SkatteverketConnectPanel'
import { useSettings } from '@/components/settings/useSettings'
import { useToast } from '@/components/ui/use-toast'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import type { CompanySettings } from '@/types'

export function TaxSettingsContent() {
  const { settings, isLoading, updateSettings, refetch } = useSettings()
  const t = useTranslations('settings_skatteverket')
  const searchParams = useSearchParams()
  const router = useRouter()
  const { toast } = useToast()

  const hasSkatteverketExtension = ENABLED_EXTENSION_IDS.has('skatteverket')

  // Skatteverket OAuth callback: the connect flow returns to /settings/tax with
  // a status query param (returnTo set in SkatteverketConnectPanel).
  useEffect(() => {
    const connected = searchParams.get('skv_connected')
    const error = searchParams.get('skv_error')
    if (connected === 'true') {
      toast({ title: t('connected_title'), description: t('connected_description') })
      router.replace('/settings/tax')
    } else if (error) {
      let msg: string
      try {
        msg = decodeURIComponent(error)
      } catch {
        msg = error
      }
      toast({ title: t('connect_failed_title'), description: msg, variant: 'destructive' })
      router.replace('/settings/tax')
    }
  }, [searchParams, router, toast, t])

  if (isLoading) return <SettingsLoadingSkeleton />
  if (!settings) return <SettingsLoadError onRetry={refetch} />

  function handleSave(formData: FormData) {
    const vatRegistered = formData.get('vat_registered') === 'true'

    const updates: Record<string, unknown> = {
      f_skatt: formData.get('f_skatt') === 'true',
      vat_registered: vatRegistered,
      vat_number: vatRegistered ? ((formData.get('vat_number') as string) || null) : null,
      moms_period: vatRegistered ? ((formData.get('moms_period') as string) || null) : null,
      periodisk_sammanstallning_period:
        (formData.get('periodisk_sammanstallning_period') as string) || 'monthly',
      tax_contact_name: (formData.get('tax_contact_name') as string) || null,
      tax_contact_phone: (formData.get('tax_contact_phone') as string) || null,
      tax_contact_email: (formData.get('tax_contact_email') as string) || null,
      fiscal_year_start_month: parseInt(formData.get('fiscal_year_start_month') as string) || 1,
      pays_salaries: formData.get('pays_salaries') === 'true',
      preliminary_tax_monthly: parseFloat(formData.get('preliminary_tax_monthly') as string) || null,
    }
    return {
      updates,
      onSuccess: (data: Record<string, unknown>) => {
        updateSettings(data as Partial<CompanySettings>)
      },
    }
  }

  // Sandbox companies don't connect to the real Skatteverket: hide the panel,
  // matching the old Skatteverket tab's visibility gate. Read straight off the
  // already-loaded settings row (no separate query needed).
  const showSkatteverket = hasSkatteverketExtension && !settings.is_sandbox

  return (
    <div className="space-y-8">
      {/* Connection panel first: the skattekonto and momsdeklaration pages
          send users here specifically to (re)connect — below the long tax
          form it sat out of view. */}
      {showSkatteverket && <SkatteverketConnectPanel />}

      <SettingsFormWrapper onSave={handleSave} className="space-y-0">
        <TaxSettingsForm settings={settings} />
      </SettingsFormWrapper>
    </div>
  )
}
