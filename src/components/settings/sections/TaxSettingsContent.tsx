'use client'

import { useEffect, useState } from 'react'
import { useTranslations } from 'next-intl'
import { useSearchParams, useRouter } from 'next/navigation'
import { TaxSettingsForm } from '@/components/settings/TaxSettingsForm'
import { TaxAssessmentNoticesPanel } from '@/components/settings/TaxAssessmentNoticesPanel'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import Link from 'next/link'
import { Button } from '@/components/ui/button'
import {
  SettingsGroup,
  SettingsRow,
  SettingsRowEnd,
  SettingsSectionHeader,
} from '@/components/settings/SettingsRows'
import { useSettings } from '@/components/settings/useSettings'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import type { KuSignalTrigger } from '@/lib/tax/ku-signal'
import type { CompanySettings } from '@/types'

export function TaxSettingsContent() {
  const { settings, isLoading, updateSettings, refetch } = useSettings()
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const searchParams = useSearchParams()
  const router = useRouter()

  const hasSkatteverketExtension = ENABLED_EXTENSION_IDS.has('skatteverket')

  // Derived EU-trade signal, read from the declaration's rutor: EU sales
  // (35/38/39) imply a periodisk sammanställning obligation, and EU sales or
  // purchases (20/21/37) an earlier helårsmoms date, which the opt-in flags
  // may not reflect. Suggestion only; the user confirms via the ordinary
  // checkboxes.
  const [euSalesDetected, setEuSalesDetected] = useState(false)
  const [euPurchasesDetected, setEuPurchasesDetected] = useState(false)
  // Same pattern for kontrolluppgifter: utdelning (2898) or interest on an
  // ägarlån (84xx beside 2393/2893) implies a KU obligation on 31 January
  // that AGI never covers. The triggers name the postings, so the line can
  // say what it is about. Suggestion only; the user confirms via the checkbox.
  const [kuTriggers, setKuTriggers] = useState<KuSignalTrigger[]>([])
  // And for ROT/RUT: invoices with deductions mean a begäran om utbetalning
  // must reach Skatteverket by 31 January after the payment year.
  const [rotRutSignalDetected, setRotRutSignalDetected] = useState(false)
  useEffect(() => {
    let cancelled = false
    fetch('/api/settings/eu-trade-signal')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (cancelled) return
        if (json?.data?.has_eu_sales) setEuSalesDetected(true)
        if (json?.data?.has_eu_purchases) setEuPurchasesDetected(true)
      })
      .catch(() => {
        // Best-effort signal: a failed fetch just hides the suggestion.
      })
    fetch('/api/settings/ku-signal')
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (!cancelled && json?.data?.has_ku_signal && Array.isArray(json.data.triggers)) {
          setKuTriggers(json.data.triggers as KuSignalTrigger[])
        }
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

  // The Skatteverket connection moved to its own page under Kopplingar
  // (2026-09-24). A connect flow started before the move still returns here
  // with its status param: hand it on so the toast shows where it belongs.
  useEffect(() => {
    if (searchParams.has('skv_connected') || searchParams.has('skv_error')) {
      router.replace(`/settings/skatteverket?${searchParams.toString()}`)
    }
  }, [searchParams, router])

  if (isLoading) return <SettingsLoadingSkeleton />
  if (!settings) return <SettingsLoadError onRetry={refetch} />

  function handleSave(formData: FormData) {
    const vatRegistered = formData.get('vat_registered') === 'true'

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

      {/* The connection itself lives under Kopplingar; pages that send users
          here to (re)connect find the way on from this first row. */}
      {showSkatteverket && (
        <SettingsGroup label={tNav('skatteverket')}>
          <SettingsRow label={tNav('skatteverket_row')} help={tIntro('skatteverket')}>
            <SettingsRowEnd>
              <Button variant="outline" size="sm" asChild>
                <Link href="/settings/skatteverket">{tNav('manage_connection')}</Link>
              </Button>
            </SettingsRowEnd>
          </SettingsRow>
        </SettingsGroup>
      )}

      <SettingsFormWrapper onSave={handleSave} className="space-y-0">
        <TaxSettingsForm
          settings={settings}
          euSalesDetected={euSalesDetected}
          euPurchasesDetected={euPurchasesDetected}
          kuTriggers={kuTriggers}
          rotRutSignalDetected={rotRutSignalDetected}
        />
      </SettingsFormWrapper>

      <TaxAssessmentNoticesPanel />
    </div>
  )
}
