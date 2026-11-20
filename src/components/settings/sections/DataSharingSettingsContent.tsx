'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useLocale, useTranslations } from 'next-intl'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { SettingsLoadError } from '@/components/settings/SettingsLoadError'
import { SettingsGroup, SettingsRow, SettingsSectionHeader } from '@/components/settings/SettingsRows'
import { useCompany } from '@/contexts/CompanyContext'
import { getErrorMessage, type ErrorLocale } from '@/lib/errors/get-error-message'
import { DATA_CHOICES, type CompanyDataChoices, type DataChoice } from '@/lib/legal/data-choices'

/**
 * Kopplingar → Datadelning och AI: three company switches, each saved
 * the moment it moves (PATCH /api/settings/data-sharing), each change a dated
 * line in behandlingshistorik. Owners and admins switch; everyone else sees
 * the same states read-only.
 */
export function DataSharingSettingsContent({ initialChoices }: { initialChoices: CompanyDataChoices | null }) {
  const t = useTranslations('settings_data_sharing')
  const locale = useLocale() as ErrorLocale
  const router = useRouter()
  const { toast } = useToast()
  const { role, company } = useCompany()
  const canSwitch = role === 'owner' || role === 'admin'
  const [choices, setChoices] = useState<CompanyDataChoices | null>(initialChoices)
  const [busy, setBusy] = useState<DataChoice | null>(null)

  if (!choices) return <SettingsLoadError onRetry={() => router.refresh()} />

  async function change(choice: DataChoice, enabled: boolean) {
    setBusy(choice)
    try {
      const res = await fetch('/api/settings/data-sharing', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [choice]: enabled }),
      })
      const body = await res.json().catch(() => null)
      if (!res.ok) {
        toast({ title: t('save_failed'), description: getErrorMessage(body, { statusCode: res.status, locale }), variant: 'destructive' })
        return
      }
      setChoices(body.data as CompanyDataChoices)
      toast({ title: t(enabled ? `${choice}_on_toast` : `${choice}_off_toast`) })
      // The menu and the assistant's entry points read the AI switch.
      if (choice === 'ai') router.refresh()
    } catch (error) {
      toast({ title: t('save_failed'), description: getErrorMessage(error, { locale }), variant: 'destructive' })
    } finally {
      setBusy(null)
    }
  }

  const companyName = company?.name ?? ''

  return (
    <div>
      <SettingsSectionHeader title={t('title')} intro={t('intro')} />
      <SettingsGroup label={t('group_label')} help={canSwitch ? undefined : t('read_only_help')}>
        {DATA_CHOICES.map((choice) => (
          <SettingsRow
            key={choice}
            label={
              <span className="flex flex-col gap-1">
                <span>{t(`${choice}_label`)}</span>
                <span className="text-xs text-muted-foreground">{t(`${choice}_help`, { company: companyName })}</span>
              </span>
            }
          >
            <Switch
              checked={choices[choice]}
              disabled={!canSwitch || busy !== null}
              aria-label={t(`${choice}_label`)}
              onCheckedChange={(next) => void change(choice, next)}
            />
          </SettingsRow>
        ))}
      </SettingsGroup>
    </div>
  )
}
