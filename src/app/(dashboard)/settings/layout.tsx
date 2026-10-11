import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/ui/page-header'
import { SettingsShell } from '@/components/settings/SettingsShell'
import { ActiveCompanyBadge } from '@/components/settings/ActiveCompanyBadge'

export default async function SettingsLayout({ children }: { children: React.ReactNode }) {
  const t = await getTranslations('settings_nav')

  return (
    <div className="space-y-8">
      <PageHeader title={t('aria_label')} action={<ActiveCompanyBadge />} />
      <SettingsShell>{children}</SettingsShell>
    </div>
  )
}
