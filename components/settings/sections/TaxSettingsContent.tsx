'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useSearchParams, useRouter } from 'next/navigation'
import { TaxSettingsForm } from '@/components/settings/TaxSettingsForm'
import { TaxAssessmentNoticesPanel } from '@/components/settings/TaxAssessmentNoticesPanel'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { SettingsSectionHeader } from '@/components/settings/SettingsRows'
import { SkatteverketConnectPanel } from '@/components/settings/SkatteverketConnectPanel'
import { useSettings } from '@/components/settings/useSettings'
import { useToast } from '@/components/ui/use-toast'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import type { CompanySettings } from '@/types'

export function TaxSettingsContent() {
  const { settings, isLoading, updateSettings, refetch } = useSettings()
  const t = useTranslations('settings_skatteverket')
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const searchParams = useSearchParams()
  const router = useRouter()
  const { toast } = useToast()

  const hasSkatteverketExtension = ENABLED_EXTENSION_IDS.has('skatteverket')

  // Derived EU-sales signal: postings on 3108/3308/3107 imply a periodisk
  // sammanställning obligation the opt-in flags may not reflect. Suggestion
  // only; the user confirms via the ordinary checkboxes.
  const [euSalesDetected, setEuSalesDetected] = useState(false)
  // Same pattern for kontrolluppgifter: postings on 2898 (utdelning) or
  // 2393/2893 (ägarlån) imply a KU obligation on 31 January that AGI never
  // covers. Suggestion only; the user confirms via the checkbox.
  const [kuSignalDetected, setKuSignalDetected] = useState(false)
  // And for ROT/RUT: invoices with deductions mean a begäran om utbetalning
  // must reach Skatteverket by 31 January after the payment year.
  const [rotRutSignalDetected, setRotRutSignalDetected] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch('/api/settings/eu-trade-signal')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json?.data?.has_eu_sales) setEuSalesDetected(true)
      })
      .catch(() => {
        // Best-effort signal: a failed fetch just hides the suggestion.
      })
    fetch('/api/settings/ku-signal')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json?.data?.has_ku_signal) setKuSignalDetected(true)
      })
      .catch(() => {
        // Best-effort signal: a failed fetch just hides the suggestion.
      })
    fetch('/api/settings/rot-rut-signal')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json?.data?.has_rot_rut) setRotRutSignalDetected(true)
      })
      .catch(() => {
        // Best-effort signal: a failed fetch just hides the suggestion.
      })
    return () => {
      cancelled = true
    }
  }, [])

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
    const paysSalaries = formData.get('pays_salaries') === 'true'
    const employerRegistered = formData.get('employer_registered') === 'true'

    const updates: Record<string, unknown> = {
      f_skatt: formData.get('f_skatt') === 'true',
      vat_registered: vatRegistered,
      vat_number: vatRegistered ? ((formData.get('vat_number') as string) || null) : null,
      moms_period: vatRegistered ? ((formData.get('moms_period') as string) || null) : null,
      vat_taxable_base_over_40m:
        vatRegistered && formData.get('vat_taxable_base_over_40m') === 'true',
      vat_has_eu_trade: vatRegistered && formData.get('vat_has_eu_trade') === 'true',
      // The filing-method and PS selects are conditionally rendered: when a
      // control is unmounted its FormData key is absent, and defaulting would
      // silently overwrite the saved preference. Fall back to the stored
      // value first, then the default.
      vat_filing_method:
        (formData.get('vat_filing_method') as string) ||
        settings?.vat_filing_method ||
        'electronic',
      periodisk_sammanstallning_enabled:
        vatRegistered && formData.get('periodisk_sammanstallning_enabled') === 'true',
      periodisk_sammanstallning_period:
        (formData.get('periodisk_sammanstallning_period') as string) ||
        settings?.periodisk_sammanstallning_period ||
        'monthly',
      periodisk_sammanstallning_filing_method:
        (formData.get('periodisk_sammanstallning_filing_method') as string) ||
        settings?.periodisk_sammanstallning_filing_method ||
        'electronic',
      tax_contact_name: (formData.get('tax_contact_name') as string) || null,
      tax_contact_phone: (formData.get('tax_contact_phone') as string) || null,
      tax_contact_email: (formData.get('tax_contact_email') as string) || null,
      fiscal_year_start_month: parseInt(formData.get('fiscal_year_start_month') as string) || 1,
      pays_salaries: paysSalaries,
      employer_registered: employerRegistered,
      // The seasonal switch stays mounted inside its reveal, but the
      // employer_registered gate still forces false when not registered.
      employer_seasonal: employerRegistered && formData.get('employer_seasonal') === 'true',
      preliminary_tax_monthly: parseFloat(formData.get('preliminary_tax_monthly') as string) || null,
      kontrolluppgifter_enabled: formData.get('kontrolluppgifter_enabled') === 'true',
      rot_rut_enabled: formData.get('rot_rut_enabled') === 'true',
      // OSS/IOSS/Intrastat presuppose VAT registration; retire them with it.
      oss_enabled: vatRegistered && formData.get('oss_enabled') === 'true',
      ioss_enabled: vatRegistered && formData.get('ioss_enabled') === 'true',
      intrastat_enabled: vatRegistered && formData.get('intrastat_enabled') === 'true',
      punktskatt_enabled: formData.get('punktskatt_enabled') === 'true',
      fyllnadsinbetalning_enabled: formData.get('fyllnadsinbetalning_enabled') === 'true',
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
    <div>
      <SettingsSectionHeader title={tNav('tax')} intro={tIntro('tax')} />

      {/* Connection panel first: the skattekonto and momsdeklaration pages
          send users here specifically to (re)connect; below the long tax
          form it sat out of view. */}
      {showSkatteverket && <SkatteverketConnectPanel />}

      <SettingsFormWrapper onSave={handleSave} className="space-y-0">
        <TaxSettingsForm
          settings={settings}
          euSalesDetected={euSalesDetected}
          kuSignalDetected={kuSignalDetected}
          rotRutSignalDetected={rotRutSignalDetected}
        />
      </SettingsFormWrapper>

      <TaxAssessmentNoticesPanel />
    </div>
  )
}
