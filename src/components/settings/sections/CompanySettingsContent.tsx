'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { useCompany } from '@/contexts/CompanyContext'
import { CompanyDangerZone } from '@/components/settings/CompanyDangerZone'
import type { CompanyDeleteDoor } from '@/components/settings/company-deletion'
import { CompanyInfoForm } from '@/components/settings/CompanyInfoForm'
import { CompanyProfileSection } from '@/components/settings/CompanyProfileSection'
import { LogoUpload } from '@/components/settings/LogoUpload'
import { SettingsFormWrapper } from '@/components/settings/SettingsFormWrapper'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import { SettingsLoadingSkeleton } from '@/components/settings/SettingsLoadingSkeleton'
import { SettingsSectionHeader } from '@/components/settings/SettingsRows'
import { ShareCapitalForm } from '@/components/settings/ShareCapitalForm'
import { useSettings } from '@/components/settings/useSettings'
import type { CompanySettings } from '@/types'

export function CompanySettingsContent() {
  const router = useRouter()
  const tNav = useTranslations('settings_nav')
  const tIntro = useTranslations('settings_intro')
  const { settings, isLoading, updateSettings, refetch } = useSettings()
  const { role, isSandbox, company } = useCompany()
  // The delete-company dialog lives in the danger zone at the foot of the
  // page and has two doors: its own row, and the locked org number row at the
  // top, where an owner who set up the wrong company looks for a way out.
  const [deleteDoor, setDeleteDoor] = useState<CompanyDeleteDoor | null>(null)
  // "Delete this company and add the right one" needs both halves: deleting
  // is the owner's alone (CompanyDangerZone renders nothing for anyone else),
  // and a sandbox has no "Lägg till företag" to continue to.
  const canReplaceCompany = role === 'owner' && !isSandbox

  // Members moved to their own section (2026-09-24): old links to
  // /settings/company#members land there instead.
  useEffect(() => {
    if (window.location.hash === '#members') router.replace('/settings/members')
  }, [router])

  // Deep-link target for "Arkivera / börja om" (/settings/company#archive-start-fresh):
  // a ref callback rather than an effect because this content mounts late
  // (settings fetch); the callback fires exactly when the section exists. The
  // hash is cleared after scrolling so returning to Företag doesn't scroll again.
  const scrollToArchive = useCallback((node: HTMLDivElement | null) => {
    if (!node || window.location.hash !== '#archive-start-fresh') return
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
      // Säte is its own field (not the postal town); empty clears it.
      ...(formData.has('registered_office') && {
        registered_office: String(formData.get('registered_office') ?? '').trim() || null,
      }),
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
        <CompanyInfoForm
          settings={settings}
          companyOrgNumber={company?.org_number ?? null}
          onWrongCompany={canReplaceCompany ? () => setDeleteDoor('wrong_company') : undefined}
        />
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

      <CompanyProfileSection />

      <div id="archive-start-fresh" ref={scrollToArchive}>
        <CompanyDangerZone deleteDoor={deleteDoor} onDeleteDoorChange={setDeleteDoor} />
      </div>
    </div>
  )
}
