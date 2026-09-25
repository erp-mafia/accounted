import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getDashboardCompanyId } from '../../request-context'
import { isArkivSectionEnabled } from '@/lib/arkiv/flag'
import { PageHeader } from '@/components/ui/page-header'
import { HelpPopover } from '@/components/ui/help-popover'
import { ArkivDocuments } from '@/components/arkiv/ArkivDocuments'

/** /arkiv/myndighet: registrations, filings and decisions from Bolagsverket and Skatteverket. */
export default async function ArkivAuthorityPage() {
  const companyId = await getDashboardCompanyId()
  if (!companyId || !isArkivSectionEnabled(companyId)) notFound()
  const t = await getTranslations('arkiv')
  return (
    <div className="space-y-6">
      <PageHeader title={t('authority_title')} help={<HelpPopover>{t('authority_help')}</HelpPopover>} />
      <ArkivDocuments fixedType="authority" />
    </div>
  )
}
