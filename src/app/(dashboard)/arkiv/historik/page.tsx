import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getDashboardCompanyId } from '../../request-context'
import { isArkivSectionEnabled } from '@/lib/arkiv/flag'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { ArkivHistory } from '@/components/arkiv/ArkivHistory'

/** /arkiv/historik: what has happened to the documents, when and by whom. */
export default async function ArkivHistoryPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !isArkivSectionEnabled(companyId)) notFound()
  const [t, tNav] = await Promise.all([getTranslations('arkiv'), getTranslations('nav')])
  return (
    <div className="space-y-6">
      <PageHeader parent={{ label: tNav('v3_archive'), href: '/arkiv' }} title={t('history_title')} help={<HelpPopover>{t('history_help')}</HelpPopover>} />
      <ArkivHistory />
    </div>
  )
}
